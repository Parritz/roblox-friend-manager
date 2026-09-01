// Thin wrapper over chrome.storage.local. Everything the extension remembers
// lives here: settings, the keep-list, the current job checkpoint, and the log.

import { STATUS } from './messages.js';

const KEYS = {
	SETTINGS: 'settings',
	KEEP_LIST: 'keepList',
	JOB: 'jobState',
	LOG: 'log',
};

const LOG_LIMIT = 200;

export const DEFAULT_SETTINGS = {
	// Starting pace. The limiter adapts up from here on 429s and creeps back down
	// after sustained success, so this is a seed value, not a hard rule.
	baseDelayMs: 1500,

	// Never go faster than this, no matter how well things are going.
	floorDelayMs: 800,

	// Never go slower than this from adaptation alone (429 backoff can still be longer).
	ceilDelayMs: 15000,

	// Reads (friend lists, name lookups, avatars) get their own, much faster pace.
	// They aren't what Roblox pushes back on: observed 429s arrive with the global
	// budget almost untouched, so they come from a per-endpoint limit on the
	// mutating calls. At this pace a 1000-friend keep-list load is ~29 requests in
	// well under 10s instead of a minute. It adapts upward on a 429 like any other
	// pace, so if reads ever do get limited, this corrects itself.
	readDelayMs: 300,

	// Retries for 5xx / network errors before an item is marked failed.
	maxRetries: 3,

	// Route name/avatar lookups and accept/unfriend through the owned Workers
	// proxies (with roblox.com failover). Lookups stay session-free; friend
	// actions forward .ROBLOSECURITY + CSRF. Friends list reads never go through
	// the proxy. See background/roproxy.js and credentials.js.
	useProxyForPublic: true,

	// Auto-trim keeps the friend count under a ceiling on its own. Off by default:
	// it removes people without asking each time, so turning it on is a deliberate
	// choice. The keep-list is always honoured. See background/jobs/auto-trim.js for
	// what "oldest" can and can't mean given Roblox exposes no friendship dates.
	autoTrimEnabled: false,

	// Trim once Roblox reports at least this many friends. Default is the Roblox cap.
	autoTrimThreshold: 1000,

	// How many to remove per run.
	autoTrimCount: 100,

	// Accept filters. Off by default so a fresh install keeps accepting everyone;
	// turning either on is a deliberate choice. Matching filters leave the request
	// pending rather than declining it. See background/jobs/accept-requests.js.
	skipNewAccounts: false,

	// Account younger than this many days is "too new". Only used when
	// skipNewAccounts is on.
	minAccountAgeDays: 7,

	// Skip requesters whose display name is the same as their username - a common
	// bot/alt default, since Roblox copies the username into the display name
	// until the user sets one.
	skipSameDisplayName: false,
};

export function emptyJobState() {
	return {
		status: STATUS.IDLE,
		jobType: null,
		message: '',
		total: 0,
		done: 0,
		skipped: 0,
		failed: 0,
		keptCount: 0,
		// Remaining unfriend targets: [{ id, name }]. null until a scan has run.
		queue: null,
		// Cached from the scan so a re-scan after eviction doesn't re-ask who we are.
		userId: null,
		// Friend-request ids already attempted this run, so a permanently failing
		// request can't be re-enqueued forever.
		processedIds: [],
		// Accept job only: armed to keep watching for new requests rather than
		// finishing when the queue empties. Persisted because it has to survive a
		// service-worker eviction - see resumeIfNeeded.
		watching: false,
		// When the watch loop will next look, while it is idling between polls.
		nextCheckAt: null,
		// Set to a JOB value while an armed accept session has stood aside for
		// something more important - currently only auto-trim. The accept job is
		// still running and still armed; it is just not accepting right now.
		pausedFor: null,
		// Progress of whatever pausedFor names, as { done, total }. Kept apart from
		// the job's own counters: friends removed and requests accepted are
		// different things and averaging them into one bar means neither is true.
		subProgress: null,
		rateLimitHits: 0,
		currentDelayMs: DEFAULT_SETTINGS.baseDelayMs,
		backoffUntil: null,
		startedAt: null,
		finishedAt: null,
	};
}

async function get(key, fallback) {
	const out = await chrome.storage.local.get(key);
	return out[key] === undefined ? fallback : out[key];
}

export async function getSettings() {
	return { ...DEFAULT_SETTINGS, ...(await get(KEYS.SETTINGS, {})) };
}

export async function saveSettings(patch) {
	const next = { ...(await getSettings()), ...patch };
	await chrome.storage.local.set({ [KEYS.SETTINGS]: next });
	return next;
}

/** Keep-list entries are { id, name }. `id` is the source of truth - usernames change. */
export async function getKeepList() {
	const list = await get(KEYS.KEEP_LIST, []);
	return Array.isArray(list) ? list : [];
}

export async function saveKeepList(list) {
	const seen = new Set();
	const clean = [];
	for (const entry of list) {
		const id = Number(entry.id);
		if (!Number.isFinite(id) || seen.has(id)) continue;
		seen.add(id);
		const name = String(entry.name || id);
		// Avatar URLs are deliberately not stored - they go stale. The options
		// page re-fetches them on open.
		clean.push({ id, name, displayName: String(entry.displayName || name) });
	}
	clean.sort((a, b) => a.displayName.localeCompare(b.displayName));
	await chrome.storage.local.set({ [KEYS.KEEP_LIST]: clean });
	return clean;
}

export async function getJobState() {
	return { ...emptyJobState(), ...(await get(KEYS.JOB, {})) };
}

export async function saveJobState(state) {
	await chrome.storage.local.set({ [KEYS.JOB]: state });
	return state;
}

export async function getLog() {
	return await get(KEYS.LOG, []);
}

export async function appendLog(level, message) {
	const log = await getLog();
	log.push({ t: Date.now(), level, message });
	const trimmed = log.slice(-LOG_LIMIT);
	await chrome.storage.local.set({ [KEYS.LOG]: trimmed });
	return trimmed;
}

export async function clearLog() {
	await chrome.storage.local.set({ [KEYS.LOG]: [] });
}
