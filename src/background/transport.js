// How HTTP actually leaves the extension.
//
// Two implementations behind one interface:
//   DirectTransport - service worker fetches roblox.com itself. Needs no tab.
//   ProxyTransport  - a content script on a roblox.com tab does the fetch, so
//                     it is same-origin with the page and the session cookie
//                     is definitely attached.
//
// Which one works depends on whether Chrome attaches .ROBLOSECURITY to
// cross-site requests from an extension origin, which varies by version. So we
// probe once at startup instead of assuming. Nothing above this module cares
// which one is live.

import { MSG } from '../shared/messages.js';

const AUTHENTICATED_URL = 'https://users.roblox.com/v1/users/authenticated';
const CONTENT_SCRIPT = 'src/content/fetch-proxy.js';

export class NoRobloxTabError extends Error {
	constructor() {
		super('No roblox.com tab is open. Open one and try again.');
		this.name = 'NoRobloxTabError';
	}
}

/**
 * @typedef {{remaining:number|null, resetSeconds:number|null, limit:string|null}} RateLimitInfo
 * @typedef {{status:number, ok:boolean, csrfToken:string|null, retryAfter:string|null,
 *            rateLimit:RateLimitInfo|null, text:string}
 *           | {networkError:string}} TransportResponse
 */

/**
 * Roblox sends one x-ratelimit-* header per bucket, and fetch joins duplicates
 * into a single comma-separated string. Values may also carry IETF policy syntax
 * ("1000;w=1" = 1000 per 1s window). A real 429 response looks like:
 *
 *   x-ratelimit-limit:     1000, 1000;w=1, 1000;w=1, 70000
 *   x-ratelimit-remaining: 999, 70000
 *   x-ratelimit-reset:     1, 0
 *
 * Only three things are worth extracting: the tightest remaining budget, the
 * longest reset, and the raw limit text for the log.
 */
export function parseRateLimit(headers) {
	const limit = headers.get('x-ratelimit-limit');
	const remainingRaw = headers.get('x-ratelimit-remaining');
	const resetRaw = headers.get('x-ratelimit-reset');
	if (!limit && !remainingRaw && !resetRaw) return null;

	// "999, 70000" -> [999, 70000]; "1000;w=1" -> [1000]; missing -> [].
	// The empty-string filter matters: Number('') is 0, so without it an absent
	// header would read as a real budget of zero rather than "unknown".
	const numbers = (value) =>
		String(value || '')
			.split(',')
			.map((part) => part.trim().split(';')[0].trim())
			.filter((part) => part !== '')
			.map(Number)
			.filter((n) => Number.isFinite(n));

	const remaining = numbers(remainingRaw);
	const reset = numbers(resetRaw);
	return {
		// The bucket closest to empty is the one that will reject us.
		remaining: remaining.length ? Math.min(...remaining) : null,
		// The longest window is the safest thing to wait out.
		resetSeconds: reset.length ? Math.max(...reset) : null,
		limit: limit || null,
	};
}

async function directSend(request) {
	try {
		const res = await fetch(request.url, {
			method: request.method || 'GET',
			headers: request.headers || {},
			body: request.body ?? null,
			mode: 'cors',
			// 'omit' is used for third-party mirrors, which must never see a cookie.
			credentials: request.credentials || 'include',
			signal: request.signal,
		});
		return {
			status: res.status,
			ok: res.ok,
			csrfToken: res.headers.get('x-csrf-token'),
			retryAfter: res.headers.get('retry-after'),
			rateLimit: parseRateLimit(res.headers),
			text: await res.text(),
		};
	} catch (err) {
		return { networkError: String(err?.message || err) };
	}
}

async function findRobloxTab() {
	const tabs = await chrome.tabs.query({ url: ['*://*.roblox.com/*'] });
	if (!tabs.length) return null;
	// Prefer a tab the user is actually looking at; it's least likely to be discarded.
	return tabs.find((t) => t.active && !t.discarded) || tabs.find((t) => !t.discarded) || tabs[0];
}

async function proxySend(request) {
	const tab = await findRobloxTab();
	if (!tab) throw new NoRobloxTabError();

	const message = { type: MSG.PROXY_FETCH, request };
	try {
		return await chrome.tabs.sendMessage(tab.id, message);
	} catch {
		// Tab predates the install, or navigated and dropped the script. Re-inject.
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
		return await chrome.tabs.sendMessage(tab.id, message);
	}
}

let mode = null;

/** @returns {Promise<(req:object) => Promise<TransportResponse>>} */
export async function getTransport() {
	if (!mode) {
		const probe = await directSend({ url: AUTHENTICATED_URL });

		// 200 means cookies came along. Anything else (401, CORS failure, network
		// error) means we can't trust the direct path - go through the page.
		mode = probe.status === 200 ? 'direct' : 'proxy';
		console.info(`[RFM] transport = ${mode}`, probe.status ?? probe.networkError);
	}
	return mode === 'direct' ? directSend : proxySend;
}

/**
 * The service worker's own fetch, bypassing the transport probe entirely.
 *
 * Used for owned-proxy hosts: session-free calls omit credentials; authenticated
 * mutation calls still use omit here because .ROBLOSECURITY is injected onto the
 * proxy request via declarativeNetRequest (see credentials.js).
 */
export function sendWithoutCredentials(request) {
	return directSend({ ...request, credentials: 'omit' });
}

/** Alias for clarity at authenticated-proxy call sites. Same wire path. */
export const sendViaOwnedProxy = sendWithoutCredentials;

export function transportMode() {
	return mode;
}

/** Force the next call to re-probe - e.g. after the user logs back in. */
export function resetTransport() {
	mode = null;
}
