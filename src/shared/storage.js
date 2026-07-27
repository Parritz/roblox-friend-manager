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
	// Retries for 5xx / network errors before an item is marked failed.
	maxRetries: 3,
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
		// Friend-request ids already attempted this run, so a permanently failing
		// request can't be re-enqueued forever.
		processedIds: [],
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
