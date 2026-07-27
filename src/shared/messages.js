// Message types and enums shared by the popup, options page and service worker.
//
// NOTE: src/content/fetch-proxy.js cannot import this file - content scripts are
// not ES modules - so it hardcodes the one name it needs ("PROXY_FETCH"). If you
// rename that key, rename it there too.

export const MSG = {
	GET_STATE: 'GET_STATE',
	START_JOB: 'START_JOB',
	STOP_JOB: 'STOP_JOB',
	RESET_STATE: 'RESET_STATE',
	STATE_CHANGED: 'STATE_CHANGED',
	PROXY_FETCH: 'PROXY_FETCH',
	WHOAMI: 'WHOAMI',
	LIST_FRIENDS: 'LIST_FRIENDS',
	FRIENDS_CHUNK: 'FRIENDS_CHUNK',
	GET_USER_CARDS: 'GET_USER_CARDS',
	RESOLVE_USERNAMES: 'RESOLVE_USERNAMES',
	SAVE_SETTINGS: 'SAVE_SETTINGS',
	SAVE_KEEP_LIST: 'SAVE_KEEP_LIST',
	CLEAR_LOG: 'CLEAR_LOG',
};

export const JOB = {
	ACCEPT: 'accept',
	UNFRIEND: 'unfriend',
	// Started by the extension itself, not the popup: on a timer and after an accept
	// run. See background/jobs/auto-trim.js.
	AUTO_TRIM: 'auto-trim',
};

export const STATUS = {
	IDLE: 'idle',
	SCANNING: 'scanning',
	AWAITING_CONFIRM: 'awaiting-confirm',
	RUNNING: 'running',
	PAUSED: 'paused',
	DONE: 'done',
	ERROR: 'error',
};

export const ACTIVE_STATUSES = [STATUS.SCANNING, STATUS.RUNNING];
