// Forward .ROBLOSECURITY to the owned proxies - the Workers and the relays.
// This is NEVER stored on disk.
//
// fetch() cannot set the Cookie header (forbidden), and the cookie is scoped to
// .roblox.com so credentials:'include' will not attach it to workers.dev. Session
// rules rewrite outbound requests to the proxy hosts and inject Cookie there.
// The workers already forward that header to Roblox.

import { PROXY_ORIGINS, BUILTIN_RELAYS } from './roproxy.js';

/** Every host allowed to receive the session cookie. */
const AUTH_HOSTS = [...new Set([...PROXY_ORIGINS, ...BUILTIN_RELAYS].map((o) => new URL(o).hostname))];

const RULE_ID_BASE = 100;

let lastCookieHeader = null;

/** @returns {Promise<string|null>} */
export async function getRobloxSecurityCookie() {
	const cookie = await chrome.cookies.get({
		url: 'https://www.roblox.com',
		name: '.ROBLOSECURITY',
	});
	return cookie?.value || null;
}

/**
 * Ensure declarativeNetRequest session rules attach .ROBLOSECURITY to proxy hosts.
 * @returns {Promise<boolean>} true if a cookie was available and rules are in place
 */
export async function ensureProxyAuthHeaders() {
	const value = await getRobloxSecurityCookie();
	if (!value) {
		lastCookieHeader = null;
		return false;
	}

	const cookieHeader = `.ROBLOSECURITY=${value}`;
	if (cookieHeader === lastCookieHeader) return true;

	const removeRuleIds = AUTH_HOSTS.map((_, i) => RULE_ID_BASE + i);
	const addRules = AUTH_HOSTS.map((hostname, i) => ({
		id: RULE_ID_BASE + i,
		priority: 1,
		action: {
			type: 'modifyHeaders',
			requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookieHeader }],
		},
		condition: {
			requestDomains: [hostname],
			resourceTypes: ['xmlhttprequest', 'other'],
		},
	}));

	await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
	lastCookieHeader = cookieHeader;
	return true;
}
