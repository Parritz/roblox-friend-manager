// Job orchestrator. Owns all state; the popup is a pure view.
//
// MV3 service workers get evicted when idle, so nothing important may live only
// in memory here: every processed item is checkpointed to chrome.storage.local,
// a keep-alive alarm pokes the worker while a job is running, and any wake-up
// re-enters an interrupted job from its checkpoint.

import { MSG, JOB, STATUS } from '../shared/messages.js';
import * as store from '../shared/storage.js';
import { Limiter } from './limiter.js';
import { RobloxApi } from './roblox-api.js';
import { isAbort } from './errors.js';
import { transportMode, resetTransport } from './transport.js';
import { runAcceptJob } from './jobs/accept-requests.js';
import { scanUnfriendTargets, drainUnfriendQueue } from './jobs/unfriend.js';

const KEEPALIVE_ALARM = 'rfm-keepalive';

let limiter = null;
let api = null;

/** Non-null while a job loop is actually executing in this worker instance. */
let activeJob = null;
let controller = null;

async function services() {
	const settings = await store.getSettings();
	if (!limiter) limiter = new Limiter(settings);
	if (!api) {
		api = new RobloxApi(limiter, {
			maxRetries: settings.maxRetries,
			onEvent: (e) => {
				if (e.type === 'ratelimit') onRateLimited(e.waitMs);
				// Full request trace, visible in the service-worker console.
				if (e.type === 'response') console.debug('[RFM]', e.status, e.method, e.url);
			},
		});
	}
	return { settings, limiter, api };
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

function onRateLimited(waitMs) {
	if (!pendingState) return;
	const seconds = Math.ceil(waitMs / 1000);
	store.appendLog('warn', `Rate limited - waiting ${seconds}s (pace now ${limiter.currentDelayMs}ms).`);
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

async function startJob(jobType, { confirmed = false } = {}) {
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
		limiter.reset(settings);
		await store.clearLog();
	}

	controller = new AbortController();
	const ctx = {
		api: client,
		limiter,
		state,
		keepList: await store.getKeepList(),
		signal: controller.signal,
		log: (level, message) => log(level, message),
		commit: () => commitState(state),
	};

	state.status = jobType === JOB.UNFRIEND && !confirmed ? STATUS.SCANNING : STATUS.RUNNING;
	state.message = '';
	await commitState(state);
	await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

	activeJob = (async () => {
		try {
			if (jobType === JOB.ACCEPT) {
				await runAcceptJob(ctx);
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
			await commitState(state);
			await chrome.alarms.clear(KEEPALIVE_ALARM);
			activeJob = null;
			controller = null;
		}
	})();

	return state;
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
			startJob(msg.jobType, { confirmed: !!msg.confirmed });
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
			const { cards, diagnostics } = await client.getFriendCards(me.id);
			return { friends: cards, diagnostics };
		}

		case MSG.GET_USER_CARDS: {
			const { api: client } = await services();
			return await client.getUserCards(msg.userIds || []);
		}

		case MSG.RESOLVE_USERNAMES: {
			const { api: client } = await services();
			return { users: await client.resolveUsernames(msg.usernames) };
		}

		case MSG.SAVE_SETTINGS:
			return { settings: await store.saveSettings(msg.settings) };

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
});

chrome.runtime.onStartup.addListener(() => {
	resetTransport();
	resumeIfNeeded();
});

chrome.runtime.onInstalled.addListener(() => {
	chrome.action.setBadgeText({ text: '' }).catch(() => {});
});

// Runs on every worker wake-up, which is exactly when a checkpointed job needs
// picking back up.
resumeIfNeeded();
