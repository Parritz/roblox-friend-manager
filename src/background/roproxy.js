export const PROXY_ORIGINS = [
	'https://delicate-frost-56e9.parritz.workers.dev',
	'https://gentle-poetry-8595.parritz.workers.dev',
	'https://young-violet-d81f.parritz.workers.dev',
	'https://jolly-darkness-8177.parritz.workers.dev'
];

/**
 * Relay shipped with the extension, so rotation works on a fresh install with
 * nothing to configure. Same path scheme as the Workers; the difference is
 * upstream, where each request leaves through a different Webshare IP.
 *
 * The key is in the URL and this repo is public, so treat it as spendable: anyone
 * who reads it can use the proxy pool behind it. Rotate RELAY_KEY on the server
 * and change it here if that stops being acceptable. It grants nothing beyond
 * public Roblox lookups - the relay refuses any request carrying a session.
 */
export const BUILTIN_RELAYS = [
	'https://proxy.projectsoda.com/k/740b9e2fe2416f1efb7d781344695ca9608d9d4b51da471e',
];

/** Strip trailing slashes; a relay origin carries its key as a path prefix. */
function normalizeOrigins(list) {
	const out = [];
	for (const raw of list) {
		const text = String(raw || '').trim().replace(/\/+$/, '');
		if (!text) continue;
		try {
			new URL(text);
		} catch {
			console.warn(`[RFM] ignoring an unparseable relay origin: ${text}`);
			continue;
		}
		if (!out.includes(text)) out.push(text);
	}
	return out;
}

// Host → first path segment on the worker (subdomain of *.roblox.com).
const MIRRORS = {
	'users.roblox.com': 'users',
	'thumbnails.roblox.com': 'thumbnails',
	'friends.roblox.com': 'friends',
	'apis.roblox.com': 'apis',
};

// Consecutive hard failures before one proxy is written off for this session.
// Timeouts and 429s are temporary and do not count.
const MAX_FAILURES = 3;

// How long to treat a route as limited when the response had no Retry-After.
const DEFAULT_LIMIT_MS = 5000;

// How long to wait on a proxy before trying the next route for this call's result.
// Cold starts often finish after this; the in-flight request is left running so
// the worker can warm up for the next probe.
export const PROXY_TIMEOUT_MS = 4000;

// Relays get longer: measured round trips through the built-in one run ~0.3s for a
// single lookup and ~1.3s for a 250-id batch, so 4s is close enough to the real
// spread that an unlucky proxy pick would drop it for no good reason.
export const RELAY_TIMEOUT_MS = 10000;

/** @typedef {{id:string, url:string, viaProxy:boolean}} ProxyRoute */

export class Roproxy {
	constructor(enabled = false) {
		this.enabled = Boolean(enabled);
		/** @type {Record<string, number>} */
		this._limitedUntil = { origin: 0 };
		// Relays go first: a rotating egress IP is worth more against Roblox's
		// per-IP limits than a warm Worker, and the Workers stay as failover.
		this.relays = normalizeOrigins(BUILTIN_RELAYS);
		this.origins = [...this.relays, ...PROXY_ORIGINS];
		/** @type {Record<string, number>} */
		this._failures = Object.fromEntries(this.origins.map((o) => [o, 0]));
		/** @type {Record<string, string|null>} */
		this._disabled = Object.fromEntries(this.origins.map((o) => [o, null]));
		/** Last proxy that answered successfully - tried first while healthy. */
		this._preferred = this.origins[0];
	}

	get usable() {
		return this.enabled && this.origins.some((o) => !this._disabled[o]);
	}

	/** Sort tier: relays before Workers. */
	_rank(origin) {
		return this.relays.includes(origin) ? 0 : 1;
	}

	/**
	 * How long to wait on a route before moving on. A relay does a real second hop
	 * - CONNECT tunnel out to a proxy IP, then Roblox - so holding it to the same
	 * deadline as a Worker that only has a cold start to clear would skip it on
	 * exactly the requests it's most useful for.
	 */
	timeoutFor(routeId) {
		return this.relays.includes(routeId) ? RELAY_TIMEOUT_MS : PROXY_TIMEOUT_MS;
	}

	/**
	 * Ordered routes to try for a mirrored Roblox URL: healthy proxies first
	 * (preferred sticky), then roblox.com, then rate-limited proxies as a last resort.
	 * Relays and Workers are both in the list for every call, authenticated or not:
	 * the relay forwards .ROBLOSECURITY on its friends mirror, and failover moves
	 * between the two on whichever is rate-limited. That does put a signed-in session
	 * behind a datacenter IP, so the relay pins one proxy per session for those rather
	 * than rotating per request - the session should not hop IPs mid-run.
	 *
	 * @param {string} url
	 * @returns {ProxyRoute[]}
	 */
	routesFor(url) {
		if (!this.enabled) return [];
		let segment;
		let pathname;
		let search;
		try {
			const parsed = new URL(url);
			segment = MIRRORS[parsed.host];
			if (!segment) return [];
			pathname = parsed.pathname;
			search = parsed.search;
		} catch {
			return [];
		}

		const now = Date.now();
		/** @type {ProxyRoute[]} */
		const available = [];
		/** @type {ProxyRoute[]} */
		const limited = [];
		for (const origin of this.origins) {
			if (this._disabled[origin]) continue;
			const route = {
				id: origin,
				url: `${origin}/${segment}${pathname}${search}`,
				viaProxy: true,
			};
			if ((this._limitedUntil[origin] || 0) > now) limited.push(route);
			else available.push(route);
		}
		if (!available.length && !limited.length) return [];

		// Relays outrank Workers, always. `_preferred` only breaks ties *within* a
		// tier - it used to be the sole sort key, which quietly undid this: one relay
		// timeout or passed-through 429 made a Worker preferred, and since that Worker
		// then kept answering, the relay sat in second place and was never reached
		// again for the life of the worker. A rotating egress IP is the whole point,
		// so it does not lose its place to a single bad response.
		available.sort(
			(a, b) =>
				this._rank(a.id) - this._rank(b.id) ||
				Number(b.id === this._preferred) - Number(a.id === this._preferred)
		);
		limited.sort(
			(a, b) => (this._limitedUntil[a.id] || 0) - (this._limitedUntil[b.id] || 0)
		);

		const originRoute = { id: 'origin', url, viaProxy: false };
		const originLimited = (this._limitedUntil.origin || 0) > now;
		/** @type {ProxyRoute[]} */
		const out = [...available];
		if (!originLimited) out.push(originRoute);
		out.push(...limited);
		if (originLimited) out.push(originRoute);
		return out;
	}

	/**
	 * @param {string} route route id (proxy origin URL or 'origin')
	 * @param {number|null} retryAfterMs
	 */
	noteRateLimit(route, retryAfterMs = null) {
		const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : DEFAULT_LIMIT_MS;
		const until = Date.now() + wait;
		this._limitedUntil[route] = Math.max(this._limitedUntil[route] || 0, until);
		const label = route === 'origin' ? 'roblox.com' : route.replace(/^https:\/\//, '');
		console.warn(`[RFM] ${label} rate-limited for ~${Math.ceil(wait / 1000)}s - trying next route.`);
	}

	/** Proxy was too slow; this call moves on, but the next one still probes it. */
	noteTimeout(route, url) {
		const label = String(route).replace(/^https:\/\//, '');
		console.warn(
			`[RFM] ${label} timed out after ${PROXY_TIMEOUT_MS}ms for ${url}` +
				' - trying next route; will probe again later.'
		);
	}

	/**
	 * @param {string} [route]
	 */
	noteSuccess(route = 'origin') {
		this._limitedUntil[route] = 0;
		if (route !== 'origin' && this.origins.includes(route)) {
			this._failures[route] = 0;
			this._preferred = route;
		}
	}

	/**
	 * A proxy hard-failed (not a 429/timeout). May write off only that proxy.
	 * @param {string} route
	 * @param {string} url
	 * @param {Error & {status?:number, timedOut?:boolean}} err
	 */
	noteFailure(route, url, err) {
		if (err?.status === 429 || err?.timedOut) return;
		if (route === 'origin' || !this.origins.includes(route)) return;
		this._failures[route] = (this._failures[route] || 0) + 1;
		const detail = err?.status ? `${err.status} ${err.message}` : err?.message || String(err);
		const label = route.replace(/^https:\/\//, '');
		console.warn(
			`[RFM] ${label} failed (${this._failures[route]}/${MAX_FAILURES}) for ${url}: ${detail}` +
				' - trying next route.'
		);
		if (this._failures[route] >= MAX_FAILURES) {
			this._disabled[route] = detail;
			console.warn(`[RFM] ${label} written off for this session.`);
			if (this._preferred === route) {
				this._preferred = this.origins.find((o) => !this._disabled[o]) || this.origins[0];
			}
		}
	}
}
