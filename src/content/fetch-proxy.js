// Same-origin fetch relay.
//
// The service worker runs on a chrome-extension:// origin, and depending on the
// Chrome version the .ROBLOSECURITY cookie may not be attached to cross-site
// requests from there. This content script performs the fetch from inside a
// roblox.com page instead - the exact context the original console snippets ran
// in, so the session cookie is guaranteed to flow.
//
// The service worker probes on startup and only routes through here if a direct
// fetch came back unauthenticated. See src/background/transport.js.
//
// Content scripts are not ES modules, hence no imports and the inline constant.

(() => {
	const PROXY_FETCH = 'PROXY_FETCH';

	// executeScript may re-inject this file into a page that already has it.
	// Bail out so we don't register a second listener.
	if (window.__rfmFetchProxyInstalled) return;
	window.__rfmFetchProxyInstalled = true;

	chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
		if (!msg || msg.type !== PROXY_FETCH) return undefined;
		proxyFetch(msg.request).then(sendResponse);
		return true; // keep the channel open for the async response
	});

	async function proxyFetch(request) {
		try {
			const res = await fetch(request.url, {
				method: request.method || 'GET',
				headers: request.headers || {},
				body: request.body ?? null,
				mode: 'cors',
				credentials: 'include',
				referrer: 'https://www.roblox.com/',
				referrerPolicy: 'strict-origin-when-cross-origin',
			});
			return {
				status: res.status,
				ok: res.ok,
				// Roblox hands out a fresh CSRF token on the 403 it uses to reject an
				// unstamped POST. Surfacing it here is what makes token rotation free.
				csrfToken: res.headers.get('x-csrf-token'),
				retryAfter: res.headers.get('retry-after'),
				text: await res.text(),
			};
		} catch (err) {
			return { networkError: String((err && err.message) || err) };
		}
	}
})();
