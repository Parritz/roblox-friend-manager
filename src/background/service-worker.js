// Job orchestrator. Owns all state; the popup is a pure view.
//
// MV3 service workers get evicted when idle, so nothing important may live only
// in memory here: every processed item is checkpointed to chrome.storage.local,
// a keep-alive alarm pokes the worker while a job is running, and any wake-up
// re-enters an interrupted job from its checkpoint.

import { MSG, JOB, STATUS } from '../shared/messages.js';
import * as store from '../shared/storage.js';
import { UserCache } from '../shared/user-cache.js';
import { Limiter } from './limiter.js';
import { RobloxApi } from './roblox-api.js';
import { Roproxy } from './roproxy.js';
import { isAbort } from './errors.js';
import { transportMode, resetTransport } from './transport.js';
import { runAcceptJob } from './jobs/accept-requests.js';
import { scanUnfriendTargets, drainUnfriendQueue } from './jobs/unfriend.js';
import { runAutoTrimJob, trimPlan } from './jobs/auto-trim.js';

const KEEPALIVE_ALARM = 'rfm-keepalive';
const AUTOTRIM_ALARM = 'rfm-autotrim';
// How often to look at the friend count when auto-trim is enabled. Short enough
// to catch growth soon after accepts, but not so tight that idle accounts spam
// friend-count requests.
const AUTOTRIM_PERIOD_MIN = 3;

let limiter = null;
let api = null;
/** One instance, shared by the keep-list and both jobs. Survives worker eviction
 *  through chrome.storage.local; see shared/user-cache.js. */
let userCache = null;
/** Mirror for session-free endpoints. Rebuilt when the setting changes. */
let proxy = null;

/** Non-null while a job loop is actually executing in this worker instance. */
let activeJob = null;
let controller = null;

async function services() {
	const settings = await store.getSettings();
	if (!limiter) limiter = new Limiter(settings);
	if (!userCache) userCache = await UserCache.open();
	if (!proxy) proxy = new Roproxy(settings.useProxyForPublic);
	if (!api) {
		api = new RobloxApi(limiter, {
			maxRetries: settings.maxRetries,
			cache: userCache,
			proxy,
			onEvent: (e) => {
				if (e.type === 'ratelimit') onRateLimited(e.waitMs, e.rateLimit, e.kind, e.paceKey, e.switched);
				// Full request trace, visible in the service-worker console.
				if (e.type === 'response') console.debug('[RFM]', e.status, e.method, e.url);
			},
		});
	}
	// The toggle takes effect on the next call, without rebuilding the client. A
	// per-proxy session write-off is deliberately not undone by this: only a fresh
	// worker retries a mirror that has already proved unreliable.
	proxy.enabled = Boolean(settings.useProxyForPublic);

	return { settings, limiter, api, cache: userCache, proxy };
}

/** Persists whatever the last operation learned. Never worth failing a call over. */
async function flushCache() {
	try {
		await userCache?.flush();
	} catch (err) {
		console.warn('[RFM] user cache flush failed:', err?.message || err);
	}
}

// -- state plumbing ----------------------------------------------------------

let pendingState = null;

async function commitState(state) {
	pendingState = state;
	state.currentDelayMs = limiter ? limiter.currentDelayMs : state.currentDelayMs;
	state.rateLimitHits = limiter ? limiter.rateLimitHits : state.rateLimitHits;
	state.backoffUntil =
		limiter && limiter.backoffRemainingMs > 0 ? Date.now() + limiter.backoffRemainingMs : null;
	await store.saveJobState(state);
	updateBadge(state);
	broadcast(state);
}

function broadcast(state) {
	// Nobody is listening when the popup is closed; that's fine, not an error.
	chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, state }).catch(() => {});
}

async function log(level, message) {
	console[level === 'error' ? 'error' : 'log'](`[RFM] ${message}`);
	await store.appendLog(level, message);
}

function onRateLimited(waitMs, rateLimit = null, kind = 'write', paceKey = 'write', switched = false) {
	if (!pendingState) return;
	const seconds = Math.ceil(waitMs / 1000);
	// Each host's reads adapt separately, so name the one that actually moved.
	const pace = limiter.paceFor(paceKey);
	const what = kind === 'read' ? `${paceKey.replace('read:', '')} pace` : 'pace';
	// Roblox's own numbers, verbatim. When `remaining` is still high on a 429 the
	// cap being hit is a per-endpoint one, not the global budget - worth being able
	// to see that from the log rather than guessing at the pacing settings.
	const budget = [
		Number.isFinite(rateLimit?.remaining) ? `${rateLimit.remaining} left` : null,
		Number.isFinite(rateLimit?.resetSeconds) ? `resets in ${rateLimit.resetSeconds}s` : null,
		rateLimit?.limit ? `limit ${rateLimit.limit}` : null,
	].filter(Boolean);
	if (switched) {
		store.appendLog(
			'warn',
			`Rate limited on ${what} - switched route (${pace}ms)` +
				(budget.length ? ` [${budget.join(', ')}]` : '') +
				'.'
		);
		return;
	}
	store.appendLog(
		'warn',
		`Rate limited - waiting ${seconds}s (${what} now ${pace}ms)` +
			(budget.length ? ` [${budget.join(', ')}]` : '') +
			'.'
	);
	pendingState.backoffUntil = Date.now() + waitMs;
	updateBadge(pendingState);
	broadcast(pendingState);
}

function updateBadge(state) {
	let text = '';
	let color = '#4b5563';

	if (state.backoffUntil && state.backoffUntil > Date.now()) {
		text = '...';
		color = '#d97706';
	} else if (state.status === STATUS.RUNNING || state.status === STATUS.SCANNING) {
		text = String(state.done || 0);
		color = '#2563eb';
	} else if (state.status === STATUS.AWAITING_CONFIRM) {
		text = '?';
		color = '#d97706';
	} else if (state.status === STATUS.ERROR) {
		text = '!';
		color = '#dc2626';
	} else if (state.status === STATUS.PAUSED) {
		text = '||';
		color = '#d97706';
	} else if (state.status === STATUS.DONE) {
		text = 'OK';
		color = '#16a34a';
	}

	chrome.action.setBadgeText({ text }).catch(() => {});
	if (text) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

// -- job lifecycle -----------------------------------------------------------

async function startJob(jobType, { confirmed = false, watch = false } = {}) {
	if (activeJob) return await store.getJobState();

	const { settings, api: client } = await services();
	let state = await store.getJobState();

	const resuming =
		state.jobType === jobType &&
		(state.status === STATUS.RUNNING ||
			(jobType === JOB.UNFRIEND && state.status === STATUS.AWAITING_CONFIRM && confirmed));

	if (!resuming) {
		state = store.emptyJobState();
		state.jobType = jobType;
		state.startedAt = Date.now();
		state.watching = jobType === JOB.ACCEPT && watch;
		limiter.reset(settings);
		await store.clearLog();
	}
	// On a resume the flag comes back off the checkpoint, so an evicted watch
	// session is re-armed rather than quietly downgraded to a one-shot run.
	const watching = Boolean(state.watching);

	controller = new AbortController();
	const ctx = {
		api: client,
		limiter,
		state,
		settings,
		cache: userCache,
		keepList: await store.getKeepList(),
		signal: controller.signal,
		log: (level, message) => log(level, message),
		commit: () => commitState(state),
		// Only an armed accept session yields to anything; every other job runs to
		// completion on its own terms.
		maybeTrim: jobType === JOB.ACCEPT ? () => trimWithinJob(state) : null,
	};

	state.status = jobType === JOB.UNFRIEND && !confirmed ? STATUS.SCANNING : STATUS.RUNNING;
	state.message = '';
	await commitState(state);
	await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

	activeJob = (async () => {
		try {
			if (jobType === JOB.AUTO_TRIM) {
				await runAutoTrimJob(ctx);
			} else if (jobType === JOB.ACCEPT) {
				await runAcceptJob(ctx, { watch: watching });
			} else if (!confirmed) {
				await scanUnfriendTargets(ctx);
				return; // stop at AWAITING_CONFIRM; the user has to say yes
			} else {
				state.status = STATUS.RUNNING;
				await commitState(state);
				await drainUnfriendQueue(ctx);
			}

			if (state.status !== STATUS.PAUSED) {
				state.status = STATUS.DONE;
				state.message = summarize(state);
			}
		} catch (err) {
			if (isAbort(err)) {
				state.status = STATUS.PAUSED;
				state.message = `Stopped. ${summarize(state)}`;
				await log('info', state.message);
			} else if (err?.kind === 'auth') {
				resetTransport();
				state.status = STATUS.ERROR;
				state.message = 'Not signed in to Roblox. Log in, then try again.';
				await log('error', state.message);
			} else if (err?.kind === 'notab') {
				state.status = STATUS.PAUSED;
				state.message = 'Open a roblox.com tab, then press Start again.';
				await log('error', state.message);
			} else {
				state.status = STATUS.ERROR;
				state.message = String(err?.message || err);
				await log('error', `Job failed: ${state.message}`);
			}
		} finally {
			state.finishedAt = Date.now();
			state.watching = false;
			state.nextCheckAt = null;
			await commitState(state);
			// Names this job looked up are names the keep-list won't have to. Written
			// here rather than per item so a 1000-person run isn't 1000 storage writes.
			await flushCache();
			await chrome.alarms.clear(KEEPALIVE_ALARM);
			activeJob = null;
			controller = null;
			// Accepting is the only thing that grows the friend count, so this is the
			// moment worth re-checking. It sits in the finally because a watch session's
			// normal ending is Stop, which arrives as an abort - checking only on a
			// clean return would mean it never ran for the mode people actually use.
			// After activeJob is released, because maybeAutoTrim declines to run while
			// a job is still in flight.
			if (jobType === JOB.ACCEPT && state.done > 0) queueAutoTrimCheck();
		}
	})();

	return state;
}

// How often an armed accept session stops to ask whether a trim is due. The check
// is two requests, so it deliberately does not ride along with the 30s watch poll.
const WATCH_TRIM_CHECK_MS = 60_000;
let lastTrimCheckAt = 0;

/**
 * Lets an armed accept session stand aside for auto-trim.
 *
 * maybeAutoTrim can't cover this: it declines whenever a job is running, and a
 * watch session never ends, so a trim would never fire for the mode most likely
 * to hit the friend cap. Accepting into a full list is pointless anyway - the cap
 * is exactly when trimming matters.
 *
 * Runs on a state object of its own. Auto-trim counts friends removed and the
 * accept session counts requests accepted; merging those into one set of totals
 * would make both meaningless. Only the message and a progress pair are shared,
 * so the popup can show what the pause is for.
 *
 * @returns {Promise<boolean>} true if a trim actually ran
 */
async function trimWithinJob(parentState) {
	const { settings, api: client } = await services();
	if (!settings.autoTrimEnabled) return false;

	const now = Date.now();
	if (now - lastTrimCheckAt < WATCH_TRIM_CHECK_MS) return false;
	lastTrimCheckAt = now;

	// Cheap gate first, so a session nowhere near the threshold costs one count
	// request a minute rather than the whole setup of a trim job.
	let count = null;
	try {
		const me = await client.getAuthenticatedUser();
		if (!me?.id) return false;
		count = await client.getFriendCount(me.id);
	} catch (err) {
		if (isAbort(err) || err?.kind === 'auth' || err?.kind === 'notab') throw err;
		console.warn('[RFM] trim check during accept failed:', err?.message || err);
		return false;
	}
	if (!trimPlan(count, settings).due) return false;

	const sub = store.emptyJobState();
	sub.jobType = JOB.AUTO_TRIM;
	sub.startedAt = Date.now();

	parentState.pausedFor = JOB.AUTO_TRIM;
	parentState.subProgress = { done: 0, total: 0 };
	await commitState(parentState);
	await log('info', `Accepting paused: ${count} friends is at the trim threshold.`);

	const subCtx = {
		api: client,
		limiter,
		state: sub,
		settings,
		cache: userCache,
		keepList: await store.getKeepList(),
		// Same controller, so Stop still ends everything at once.
		signal: controller.signal,
		log: (level, message) => log(level, message),
		commit: async () => {
			parentState.message = sub.message;
			parentState.subProgress = { done: sub.done, total: sub.total };
			await commitState(parentState);
		},
	};

	try {
		await runAutoTrimJob(subCtx);
		await log('info', 'Auto-trim finished - accepting friend requests again.');
	} catch (err) {
		if (isAbort(err) || err?.kind === 'auth' || err?.kind === 'notab') throw err;
		// A failed trim is not a reason to disarm the watch the user switched on.
		await log('warn', `Auto-trim failed: ${err?.message || err}. Still watching for requests.`);
	} finally {
		parentState.pausedFor = null;
		parentState.subProgress = null;
		parentState.message = '';
		await commitState(parentState);
	}
	return true;
}

/**
 * Runs the auto-trim check on the next turn, once the current job has released
 * activeJob. Silent when disabled or under threshold - it is a background chore,
 * not something to report on every accept.
 */
function queueAutoTrimCheck() {
	setTimeout(() => {
		maybeAutoTrim().catch((err) => console.warn('[RFM] auto-trim check failed:', err?.message || err));
	}, 0);
}

async function maybeAutoTrim() {
	const { settings, api: client } = await services();
	if (!settings.autoTrimEnabled) return;
	if (activeJob) return; // never interrupt a running job

	// Cheap pre-check so a disabled-by-threshold account costs one request an hour
	// rather than a whole friends-list walk.
	let count = null;
	try {
		const me = await client.getAuthenticatedUser();
		if (!me?.id) return;
		count = await client.getFriendCount(me.id);
	} catch (err) {
		if (err?.kind === 'auth' || err?.kind === 'notab') return; // nothing to do while signed out
		console.warn('[RFM] auto-trim count check failed:', err?.message || err);
		return;
	}
	await flushCache();

	const plan = trimPlan(count, settings);
	if (!plan.due) {
		console.debug(`[RFM] auto-trim not due: ${plan.reason}.`);
		return;
	}
	await startJob(JOB.AUTO_TRIM);
}

/** Keeps the hourly alarm in step with the setting. */
async function syncAutoTrimAlarm() {
	const settings = await store.getSettings();
	if (settings.autoTrimEnabled) {
		await chrome.alarms.create(AUTOTRIM_ALARM, {
			periodInMinutes: AUTOTRIM_PERIOD_MIN,
			delayInMinutes: 1,
		});
	} else {
		await chrome.alarms.clear(AUTOTRIM_ALARM);
	}
}

function summarize(state) {
	const parts = [`${state.done} done`];
	if (state.skipped) parts.push(`${state.skipped} skipped`);
	if (state.failed) parts.push(`${state.failed} failed`);
	if (state.rateLimitHits) parts.push(`${state.rateLimitHits} rate-limit pauses`);
	return parts.join(', ') + '.';
}

async function stopJob() {
	controller?.abort();
	const state = await store.getJobState();
	if (!activeJob && (state.status === STATUS.RUNNING || state.status === STATUS.SCANNING)) {
		// Worker was evicted mid-job and revived without the loop; just mark it stopped.
		state.status = STATUS.PAUSED;
		state.message = 'Stopped.';
		await commitState(state);
	}
	return state;
}

/** Re-enter an interrupted job after a service-worker eviction. */
async function resumeIfNeeded() {
	if (activeJob) return;

	const state = await store.getJobState();
	if (state.status !== STATUS.RUNNING || !state.jobType) return;

	await log('info', 'Resuming interrupted job from checkpoint.');
	await startJob(state.jobType, { confirmed: true });
}

// -- messaging ---------------------------------------------------------------

async function handle(msg) {
	switch (msg?.type) {
		case MSG.GET_STATE:
			return {
				state: await store.getJobState(),
				log: await store.getLog(),
				keepList: await store.getKeepList(),
				settings: await store.getSettings(),
				transport: transportMode(),
			};

		case MSG.START_JOB:
			// Deliberately not awaited - jobs run for minutes; the popup gets progress
			// through STATE_CHANGED and its own polling.
			startJob(msg.jobType, { confirmed: !!msg.confirmed, watch: !!msg.watch });
			return { ok: true };

		case MSG.STOP_JOB:
			return { state: await stopJob() };

		case MSG.RESET_STATE: {
			controller?.abort();

			const fresh = store.emptyJobState();
			await store.saveJobState(fresh);
			await store.clearLog();

			updateBadge(fresh);
			broadcast(fresh);
			return { state: fresh };
		}

		case MSG.WHOAMI: {
			const { api: client } = await services();
			const me = await client.getAuthenticatedUser();
			return { user: me, transport: transportMode() };
		}

		case MSG.LIST_FRIENDS: {
			const { api: client } = await services();
			const me = await client.getAuthenticatedUser();

			// Two streams, because they run at very different speeds. The list itself
			// comes off friends.roblox.com quickly; names and avatars come off
			// users.roblox.com, which rate-limits far more aggressively. Pushing each
			// as it lands means a slow lookup stage never holds up the rows.
			const chunk = (payload) => {
				chrome.runtime.sendMessage({ type: MSG.FRIENDS_CHUNK, ...payload }).catch(() => {});
			};

			// The refresh button means "don't trust what you remember" - everything
			// else reuses the cache, so reopening the options page costs no lookups.
			const result = await client.getFriendCards(me.id, undefined, {
				bypassCache: Boolean(msg.refresh),
				onPage: (friends, expected) => chunk({ stage: 'list', friends, expected }),
				onBatch: (friends) => chunk({ stage: 'details', friends }),
			});
			await flushCache();

			return {
				friends: result.cards,
				diagnostics: result.diagnostics,
				expected: result.expected,
				complete: result.complete,
				unlistable: result.unlistable,
			};
		}

		case MSG.GET_USER_CARDS: {
			const { api: client } = await services();
			const cards = await client.getUserCards(msg.userIds || [], undefined, null, {
				bypassCache: Boolean(msg.refresh),
			});
			await flushCache();
			return cards;
		}

		case MSG.RESOLVE_USERNAMES: {
			const { api: client } = await services();
			return { users: await client.resolveUsernames(msg.usernames) };
		}

		case MSG.SAVE_SETTINGS: {
			const saved = await store.saveSettings(msg.settings);
			// Turning auto-trim on or off has to take effect now, not at the next job.
			await syncAutoTrimAlarm();
			return { settings: saved };
		}

		case MSG.SAVE_KEEP_LIST:
			return { keepList: await store.saveKeepList(msg.keepList) };

		case MSG.CLEAR_LOG:
			await store.clearLog();
			return { ok: true };

		default:
			return { error: `Unknown message: ${msg?.type}` };
	}
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	// Ignore the content script's own traffic.
	if (msg?.type === MSG.PROXY_FETCH) return undefined;
	handle(msg)
		.then(sendResponse)
		.catch((err) => sendResponse({ error: String(err?.message || err), kind: err?.kind }));
	return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === KEEPALIVE_ALARM) resumeIfNeeded();
	if (alarm.name === AUTOTRIM_ALARM) {
		maybeAutoTrim().catch((err) => console.warn('[RFM] auto-trim alarm failed:', err?.message || err));
	}
});

chrome.runtime.onStartup.addListener(() => {
	resetTransport();
	resumeIfNeeded();
	syncAutoTrimAlarm().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
	chrome.action.setBadgeText({ text: '' }).catch(() => {});
	syncAutoTrimAlarm().catch(() => {});
});

// Runs on every worker wake-up, which is exactly when a checkpointed job needs
// picking back up.
resumeIfNeeded();
