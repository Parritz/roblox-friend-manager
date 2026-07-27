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
 * @typedef {{status:number, ok:boolean, csrfToken:string|null, retryAfter:string|null, text:string}
 *           | {networkError:string}} TransportResponse
 */

async function directSend(request) {
	try {
		const res = await fetch(request.url, {
			method: request.method || 'GET',
			headers: request.headers || {},
			body: request.body ?? null,
			mode: 'cors',
			credentials: 'include',
		});
		return {
			status: res.status,
			ok: res.ok,
			csrfToken: res.headers.get('x-csrf-token'),
			retryAfter: res.headers.get('retry-after'),
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

export function transportMode() {
	return mode;
}

/** Force the next call to re-probe - e.g. after the user logs back in. */
export function resetTransport() {
	mode = null;
}
