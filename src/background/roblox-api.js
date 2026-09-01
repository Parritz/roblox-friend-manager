// Roblox endpoint wrappers plus the one place that owns CSRF and decides what
// every HTTP status means.
//
// Endpoint URLs and the `accept` header are carried over from the original
// console scripts (legacy/unaddfriends.js), which were proven against live
// Roblox. The control flow around them is not.

import { getTransport, sendWithoutCredentials, NoRobloxTabError } from './transport.js';
import { ApiError, AbortError, isAbort, sleep } from './errors.js';
import { PROXY_TIMEOUT_MS } from './roproxy.js';
import { ensureProxyAuthHeaders } from './credentials.js';

const FRIENDS = 'https://friends.roblox.com/v1';
const USERS = 'https://users.roblox.com/v1';
const THUMBNAILS = 'https://thumbnails.roblox.com/v1';
const PROFILES = 'https://apis.roblox.com/user-profile-api/v1/user/profiles/get-profiles';

// Both /v1/users and the thumbnails API top out around 100 ids per call.
const BATCH = 100;

// get-profiles takes 250, and past that it answers 200 with an empty
// profileDetails and an empty errors array - no status, no message, just a batch
// that comes back nameless. So the cap is enforced on the way out, and an empty
// body for a non-empty request is read as a failure rather than as "none of these
// people have names".
const PROFILE_BATCH = 250;

// Asking for only the two name fields; isVerified/isDeleted come back regardless
// and nothing here uses them.
const PROFILE_FIELDS = ['names.username', 'names.combinedName'];

// Ceiling on the one-request-per-user fallback. At the paced request rate this
// is the difference between a slow load and a five minute one.
const SINGLE_LOOKUP_CAP = 25;

// /v1/users/{id}/friends silently truncates at 200 rows - it predates Roblox
// raising the friend cap to 1000 and was never updated. A response of exactly
// this length therefore can't be trusted to be complete.
const FRIENDS_ENDPOINT_CAP = 200;

// Runaway guard on cursor pagination. 1000 friends is 20 pages at limit=50;
// this leaves a wide margin and still terminates if a cursor ever cycles.
const MAX_FRIEND_PAGES = 60;

// Page size for /friends/find. Roblox doesn't document a maximum, so ask for the
// larger one and fall back on a 400 - see getFriendsSnapshot.
const FIND_PAGE_SIZE_MAX = 100;
const FIND_PAGE_SIZE_SAFE = 50;

/**
 * A get-profiles row in the shape applyDetails and the cache already speak.
 *
 * Unknown, deleted and terminated ids still come back as rows, with both names
 * null, where /v1/users simply omits them. Those are dropped here so a batch of
 * 250 nulls can't be counted as 250 answers.
 */
function profileToUser(detail) {
	const id = Number(detail?.userId);
	const name = detail?.names?.username || '';
	if (!Number.isFinite(id) || !name) return null;
	return { id, name, displayName: detail.names.combinedName || name };
}

/** Fills a card from a /v1/users row. Both endpoints return the same shape. */
function applyDetails(card, user) {
	if (!card || !user) return;
	if (user.name) card.name = user.name;
	card.displayName = user.displayName || user.name || card.displayName;
	if (user.name) card.resolved = true;
}

// /friends/find answers in PascalCase (PageItems/NextCursor/HasMore) while the
// rest of friends.roblox.com is camelCase, and the cursor field has been spelled
// both NextCursor and nextPageCursor over time. Reading these case-insensitively
// costs nothing and means a casing change can't silently truncate a list again -
// the previous code matched `PageItems` but missed `NextCursor`, so pagination
// stopped after the first page.
function pickKey(obj, names) {
	if (!obj || typeof obj !== 'object') return undefined;
	const wanted = new Set(names.map((n) => n.toLowerCase()));
	for (const [key, value] of Object.entries(obj)) {
		if (wanted.has(key.toLowerCase()) && value != null) return value;
	}
	return undefined;
}

function pageItems(page) {
	const items = pickKey(page, ['PageItems', 'data']);
	return Array.isArray(items) ? items : [];
}

function pageCursor(page) {
	const cursor = pickKey(page, ['NextCursor', 'nextPageCursor']);
	return typeof cursor === 'string' ? cursor : '';
}

/**
 * Which limiter pace gates a call. Writes share one key; reads get one per host,
 * so users.roblox.com refusing batch lookups doesn't slow the friends-list walk.
 */
function paceKey(url, kind) {
	if (kind !== 'read') return 'write';
	try {
		return `read:${new URL(url).host}`;
	} catch {
		return 'read:unknown';
	}
}

/** Compact one-line description of an ApiError, for the diagnostics steps. */
function describe(err) {
	return [err.status || null, err.code != null ? `code ${err.code}` : null, err.message]
		.filter(Boolean)
		.join(' ');
}

/** Hands finished cards to a streaming callback without letting it break the run. */
async function emitCards(onBatch, session, batch) {
	if (!onBatch) return;
	try {
		await onBatch(session.pick(batch));
	} catch (err) {
		if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
		console.warn('[RFM] cards onBatch callback threw:', err?.message || err);
	}
}

function chunk(items, size) {
	const out = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

// Bail out of an item after this many 429s in a row on the same request.
// The limiter is already backing off exponentially by this point, so hitting
// this means something is structurally wrong, not just busy.
const MAX_CONSECUTIVE_429 = 20;

function parseJson(text) {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Wait up to `timeoutMs` for a proxy response. On timeout, return immediately so
 * the caller can use roblox.com, but leave the proxy fetch running - aborting it
 * would cancel a cold start that is otherwise about to finish warming the worker.
 */
async function raceProxySend(send, request, timeoutMs, signal) {
	let timedOut = false;
	const proxyPromise = send(request).then(
		(res) => {
			if (timedOut && res && !res.networkError && res.status >= 200 && res.status < 300) {
				console.info('[RFM] proxy responded after timeout - worker likely warm now.');
			}
			return res;
		},
		(err) => ({ networkError: String(err?.message || err) })
	);

	const winner = await Promise.race([
		proxyPromise,
		sleep(timeoutMs, signal).then(() => {
			timedOut = true;
			return { timedOut: true, networkError: `proxy timeout after ${timeoutMs}ms` };
		}),
	]);

	return winner;
}

function firstError(res) {
	const body = parseJson(res.text);
	const err = body?.errors?.[0];
	return { code: err?.code ?? null, message: err?.message || err?.userFacingMessage || null };
}

/** Retry-After is either delta-seconds or an HTTP-date. Handle both. */
function parseRetryAfter(value) {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const when = Date.parse(value);
	return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

export class RobloxApi {
	/**
	 * @param {import('./limiter.js').Limiter} limiter
	 * @param {{maxRetries?:number, onEvent?:(e:object)=>void,
	 *          cache?:import('../shared/user-cache.js').UserCache|null}} [opts]
	 *        `cache` is shared with every other caller, so a name the unfriend job
	 *        looked up is one the keep-list no longer has to. `proxy` is the optional
	 *        public API mirror for session-free endpoints.
	 */
	constructor(limiter, { maxRetries = 3, onEvent = () => {}, cache = null, proxy = null } = {}) {
		this.limiter = limiter;
		this.maxRetries = maxRetries;
		this.onEvent = onEvent;
		this.cache = cache;
		this.proxy = proxy;

		// Learned lazily from the 403 Roblox uses to reject an unstamped POST.
		// There is deliberately no "primer" request - the old code POSTed to
		// /v2/logout for this, which would have ended the session had it succeeded.
		this.csrf = null;

		// Also learned lazily: /friends/find's real maximum page size. Starts
		// optimistic and drops to FIND_PAGE_SIZE_SAFE the first time Roblox rejects
		// it, so the probe costs one request per session rather than one per load.
		this._findPageSize = FIND_PAGE_SIZE_MAX;
	}

	/**
	 * @param {{method?:string, json?:object|null, signal?:AbortSignal, kind?:'read'|'write',
	 *          sessionFree?:boolean, proxyAuth?:boolean}} [opts]
	 *        `kind` picks which limiter pace gates the call. It is not derived from
	 *        the method: POST /v1/users is a bulk *lookup*, while the only real
	 *        mutations are unfriend and accept-friend-request. Defaults to 'write',
	 *        so a call site that forgets to say ends up cautious rather than fast.
	 *
	 *        `sessionFree` - name/avatar lookups: proxies without cookies/CSRF.
	 *        `proxyAuth` - accept/unfriend: owned proxies with .ROBLOSECURITY + CSRF.
	 *        Friends list reads stay on roblox.com either way.
	 */
	async request(url, opts = {}) {
		const wantProxy = (opts.sessionFree || opts.proxyAuth) && this.proxy?.usable;
		if (wantProxy) {
			const routes = this.proxy.routesFor(url);
			if (routes.length) {
				const [primary, ...rest] = routes;
				try {
					return await this._send(primary.url, {
						...opts,
						viaProxy: primary.viaProxy,
						routeId: primary.id,
						alternates: rest,
					});
				} catch (err) {
					// Only the user's own Stop is allowed to end things here. Anything else
					// on a proxy path - including a 401 or a 403, which a public endpoint
					// has no business returning - means that mirror is misbehaving, so try
					// remaining routes (usually roblox.com) once more if _send didn't.
					if (isAbort(err)) throw err;
					if (primary.viaProxy) {
						this.proxy.noteFailure(primary.id, primary.url, err);
						const leftover = rest.filter((r) => r.id === 'origin' || r.viaProxy);
						for (const next of leftover) {
							try {
								return await this._send(next.url, {
									...opts,
									viaProxy: next.viaProxy,
									routeId: next.id,
								});
							} catch (inner) {
								if (isAbort(inner)) throw inner;
								if (next.viaProxy) this.proxy.noteFailure(next.id, next.url, inner);
								else throw inner;
							}
						}
					}
					throw err;
				}
			}
		}
		return this._send(url, opts);
	}

	async _send(
		url,
		{
			method = 'GET',
			json = null,
			signal,
			kind = 'write',
			viaProxy = false,
			routeId = null,
			alternates = null,
			proxyAuth = false,
			sessionFree = false,
		} = {}
	) {
		let attempt = 0;
		let csrfRetries = 0;
		let consecutive429 = 0;
		let key = paceKey(url, kind);
		const multiRoute = Array.isArray(alternates) && alternates.length > 0;
		/** @type {import('./roproxy.js').ProxyRoute[]} */
		let alts = multiRoute ? [...alternates] : [];
		let currentRoute = routeId || (viaProxy ? url : 'origin');
		// Authenticated proxy calls need the session on the worker; session-free must not.
		const authedProxy = Boolean(proxyAuth) && !sessionFree;

		for (;;) {
			if (signal?.aborted) throw new AbortError();

			const headers = { accept: 'application/json, text/plain, */*' };
			if (method !== 'GET') {
				// CSRF is required for mutations on both roblox.com and owned proxies.
				// Session-free mirrors never see it.
				if (this.csrf && (!viaProxy || authedProxy)) headers['x-csrf-token'] = this.csrf;
				if (json !== null) headers['content-type'] = 'application/json';
			}
			const request = { url, method, headers, body: json === null ? null : JSON.stringify(json) };

			let res;
			try {
				if (viaProxy && authedProxy) {
					const ok = await ensureProxyAuthHeaders();
					if (!ok) {
						// No cookie to forward - skip straight to the next route (usually origin).
						if (alts.length) {
							const next = alts.shift();
							url = next.url;
							viaProxy = next.viaProxy;
							currentRoute = next.id;
							key = paceKey(url, kind);
							attempt = 0;
							consecutive429 = 0;
							continue;
						}
						throw new ApiError('auth', 'Not signed in to Roblox.');
					}
				}
				// Owned-proxy hosts always go direct from the service worker. Session-free
				// omits credentials; authed mutations get .ROBLOSECURITY via DNR rules.
				const send = viaProxy ? sendWithoutCredentials : await getTransport();
				res = await this.limiter.run(
					() =>
						viaProxy
							? raceProxySend(
									send,
									request,
									this.proxy?.timeoutFor(currentRoute) ?? PROXY_TIMEOUT_MS,
									signal
								)
							: send(request),
					signal,
					key
				);
			} catch (err) {
				if (isAbort(err)) throw err;
				if (err instanceof NoRobloxTabError) throw new ApiError('notab', err.message);
				if (err instanceof ApiError) throw err;
				res = { networkError: String(err?.message || err) };
			}

			// --- transport-level failure -------------------------------------
			if (!res || res.networkError) {
				// Proxy too slow: move on immediately. Leave the request running so a
				// cold start can still warm the worker for a later probe.
				if (res?.timedOut && alts.length) {
					this.proxy?.noteTimeout(currentRoute, url);
					const next = alts.shift();
					url = next.url;
					viaProxy = next.viaProxy;
					currentRoute = next.id;
					key = paceKey(url, kind);
					attempt = 0;
					consecutive429 = 0;
					continue;
				}
				if (res?.timedOut && viaProxy) {
					this.proxy?.noteTimeout(currentRoute, url);
					throw Object.assign(new ApiError('network', res.networkError), { timedOut: true });
				}
				console.warn('[RFM]', method, url, '-> transport error:', res?.networkError);
				if (++attempt > this.maxRetries) {
					if (viaProxy && alts.length) {
						this.proxy?.noteFailure(
							currentRoute,
							url,
							new Error(res?.networkError || 'network')
						);
						const next = alts.shift();
						url = next.url;
						viaProxy = next.viaProxy;
						currentRoute = next.id;
						key = paceKey(url, kind);
						attempt = 0;
						consecutive429 = 0;
						continue;
					}
					throw new ApiError('network', res?.networkError || 'No response from Roblox.');
				}
				this.limiter.pauseFor(Math.min(1000 * 2 ** attempt, 60000));
				continue;
			}

			const { status } = res;

			// One place that sees every response, so a failure can never be silent
			// no matter which caller swallows the error further up.
			this.onEvent({ type: 'response', method, url, status });
			if (status < 200 || status >= 300) {
				console.warn('[RFM]', method, url, '->', status, (res.text || '').slice(0, 200));
			}

			// --- success ------------------------------------------------------
			if (status >= 200 && status < 300) {
				this.limiter.onSuccess(key);
				if (multiRoute || viaProxy) this.proxy?.noteSuccess(currentRoute);
				return parseJson(res.text);
			}

			// --- rate limited ---------------------------------------------------
			if (status === 429) {
				const info = res.rateLimit || null;
				const retryAfterMs = parseRetryAfter(res.retryAfter);
				const resetMs = Number.isFinite(info?.resetSeconds) ? info.resetSeconds * 1000 : null;

				// Session-free multi-route: switch to the next path immediately instead of
				// parking behind a global pause while another budget is still free.
				if (alts.length) {
					const waitMs = this.limiter.onRateLimit(retryAfterMs, resetMs, key, {
						global: false,
					});
					this.proxy?.noteRateLimit(currentRoute, waitMs);
					this.onEvent({
						type: 'ratelimit',
						waitMs,
						url,
						rateLimit: info,
						kind,
						paceKey: key,
						switched: true,
					});
					const next = alts.shift();
					url = next.url;
					viaProxy = next.viaProxy;
					currentRoute = next.id;
					key = paceKey(url, kind);
					consecutive429 = 0;
					continue;
				}

				if (++consecutive429 > MAX_CONSECUTIVE_429) {
					throw new ApiError('network', 'Still rate limited after many retries.', { status });
				}
				const waitMs = this.limiter.onRateLimit(retryAfterMs, resetMs, key);
				if (multiRoute || viaProxy) this.proxy?.noteRateLimit(currentRoute, waitMs);
				this.onEvent({ type: 'ratelimit', waitMs, url, rateLimit: info, kind, paceKey: key });
				continue; // never drop the item - retry it in place
			}

			// --- CSRF ------------------------------------------------------------
			if (status === 403) {
				if (res.csrfToken) {
					this.csrf = res.csrfToken;
					// One retry covers both "we never had a token" and "the token rotated".
					if (++csrfRetries <= 1) continue;
				}
				const { code, message } = firstError(res);
				throw new ApiError('terminal', message || 'Forbidden by Roblox.', { status, code });
			}

			// --- session is gone ---------------------------------------------------
			if (status === 401) {
				// On an owned proxy a 401 often means the cookie didn't forward - try
				// roblox.com before declaring the whole session dead.
				if (viaProxy && alts.length) {
					this.proxy?.noteFailure(
						currentRoute,
						url,
						Object.assign(new Error('Unauthorized via proxy'), { status: 401 })
					);
					const next = alts.shift();
					url = next.url;
					viaProxy = next.viaProxy;
					currentRoute = next.id;
					key = paceKey(url, kind);
					attempt = 0;
					consecutive429 = 0;
					csrfRetries = 0;
					continue;
				}
				throw new ApiError('auth', 'Not signed in to Roblox.', { status });
			}

			// --- this item can never succeed ----------------------------------------
			if (status === 400 || status === 404) {
				const { code, message } = firstError(res);
				throw new ApiError('terminal', message || `Roblox rejected the request (${status}).`, {
					status,
					code,
				});
			}

			// --- Roblox is having a moment --------------------------------------------
			if (status >= 500) {
				if (++attempt > this.maxRetries) {
					if (viaProxy && alts.length) {
						this.proxy?.noteFailure(
							currentRoute,
							url,
							Object.assign(new Error(`HTTP ${status}`), { status })
						);
						const next = alts.shift();
						url = next.url;
						viaProxy = next.viaProxy;
						currentRoute = next.id;
						key = paceKey(url, kind);
						attempt = 0;
						consecutive429 = 0;
						continue;
					}
					throw new ApiError('network', `Roblox returned ${status}.`, { status });
				}
				this.limiter.pauseFor(Math.min(1000 * 2 ** attempt, 60000));
				continue;
			}

			throw new ApiError('terminal', `Unexpected status ${status}.`, { status });
		}
	}

	// -- endpoints ---------------------------------------------------------------

	/** Replaces the old meta[data-userid] scrape, so no page is required. */
	async getAuthenticatedUser(signal) {
		const user = await this.request(`${USERS}/users/authenticated`, { signal, kind: 'read' });
		// Every path that touches user data goes through here first, which makes it
		// the natural place to notice an account switch and drop a stale cache.
		if (user?.id) this.cache?.claim(user.id);
		return user;
	}

	async getPendingRequestCount(signal) {
		const data = await this.request(`${FRIENDS}/user/friend-requests/count`, {
			signal,
			kind: 'read',
		});
		return Number(data?.count) || 0;
	}

	/** One page of incoming friend requests: { data: [{id, name, ...}], nextPageCursor }. */
	getIncomingRequests(cursor = '', signal) {
		const url =
			`${FRIENDS}/my/friends/requests?limit=50&sortOrder=Asc` +
			(cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
		return this.request(url, { signal, kind: 'read' });
	}

	/**
	 * User records including account created dates.
	 *
	 * POST /v1/users used to return `created` and no longer does - it only has
	 * id/name/displayName. GET /v1/users/{id} still carries the signup date, so
	 * that's what accept's "too new" filter has to use. One call per id, paced.
	 *
	 * @returns {Promise<Map<number, {id:number, name:string, displayName:string, created:string|null}>>}
	 */
	async getUsersById(ids, signal) {
		const map = new Map();
		const unique = [...new Set(ids.map(Number).filter(Number.isFinite))];
		if (!unique.length) return map;

		for (const id of unique) {
			try {
				const user = await this.request(`${USERS}/users/${id}`, {
					signal,
					kind: 'read',
					sessionFree: true,
				});
				const uid = Number(pickKey(user, ['id', 'userId']));
				if (!Number.isFinite(uid)) continue;
				const name = pickKey(user, ['name']) || '';
				const displayName = pickKey(user, ['displayName']) || name;
				const created = pickKey(user, ['created', 'createdAt']) || null;
				map.set(uid, { id: uid, name, displayName, created });
				if (name) this.cache?.putName(uid, name, displayName);
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
				console.warn('[RFM] GET /v1/users/' + id, 'failed:', err.message);
			}
		}
		return map;
	}

	acceptFriendRequest(userId, signal) {
		return this.request(`${FRIENDS}/users/${userId}/accept-friend-request`, {
			method: 'POST',
			signal,
			proxyAuth: true,
		});
	}

	unfriend(userId, signal) {
		return this.request(`${FRIENDS}/users/${userId}/unfriend`, {
			method: 'POST',
			signal,
			proxyAuth: true,
		});
	}

	/** Roblox's own friend total. Cheap, and the authority on how much is missing. */
	async getFriendCount(userId, signal) {
		const data = await this.request(`${FRIENDS}/users/${userId}/friends/count`, {
			signal,
			kind: 'read',
		});
		const count = Number(data?.count);
		return Number.isFinite(count) ? count : null;
	}

	/**
	 * The friends list, plus what Roblox says the total should be.
	 *
	 * @returns {Promise<{friends:Array, expected:number|null, complete:boolean|null}>}
	 *
	 * /friends answers in one call *with usernames*, but caps at 200 rows and gives
	 * no hint that it did. /friends/count settles it: if the account has 200 friends
	 * or fewer and /friends returned all of them, one request is the whole job. Only
	 * a genuine shortfall pages /friends/find, whose PageItems carry ids alone - so
	 * the names /friends did return are kept as seeds and the rest is the caller's
	 * to resolve (see fillMissingNames).
	 *
	 * `onPage(records, expected)` fires as each batch of records becomes known, so a
	 * caller can render a 1000-friend list as it arrives instead of after the walk.
	 */
	async getFriendsSnapshot(userId, signal, onPage = null) {
		// Best-effort: a null count just means the walk falls back to its own
		// heuristics, exactly as it did before this endpoint was consulted.
		let expected = null;
		try {
			expected = await this.getFriendCount(userId, signal);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			console.warn('[RFM] /friends/count failed:', err.message);
		}

		// Awaited, so a caller can do real work per page - getFriendCards hangs its
		// name/avatar lookups off this to interleave them with the walk. Control-flow
		// errors have to propagate or an abort mid-flush would be silently swallowed.
		const emit = async (records) => {
			if (onPage && records.length) {
				try {
					await onPage(records, expected);
				} catch (err) {
					if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
					console.warn('[RFM] friends onPage callback threw:', err?.message || err);
				}
			}
		};
		// `unlistable` is the gap between what /friends/count claims and what the
		// endpoints will actually hand over. It is not always a failure: Roblox counts
		// friendships with deleted and moderated accounts that /friends/find omits, so
		// a small permanent gap is normal and no amount of paging closes it.
		const done = (friends, notes = {}) => ({
			friends,
			expected,
			complete: expected == null ? null : friends.length >= expected,
			unlistable: expected == null ? 0 : Math.max(0, expected - friends.length),
			...notes,
		});

		// id -> named record, from /friends. Covers at most FRIENDS_ENDPOINT_CAP ids.
		const named = new Map();

		try {
			const data = await this.request(`${FRIENDS}/users/${userId}/friends`, {
				signal,
				kind: 'read',
			});
			if (Array.isArray(data?.data)) {
				for (const u of data.data) {
					const id = Number(u.id);
					if (!Number.isFinite(id)) continue;
					named.set(id, {
						id,
						name: u.name || '',
						displayName: u.displayName || u.name || '',
					});
				}
				// The count is the authority when we have it; the length-vs-cap test is
				// only the fallback for when /friends/count didn't answer.
				const whole =
					expected != null ? named.size >= expected : data.data.length < FRIENDS_ENDPOINT_CAP;
				if (whole) {
					const all = dedupeById([...named.values()]);
					this._noteSeen(all);
					await emit(all);
					return done(all, { source: 'friends', duplicates: 0 });
				}
				console.info(
					`[RFM] /friends returned ${data.data.length} of ${expected ?? '?'} friends -` +
						' paging /friends/find for the rest.'
				);
			} else {
				console.warn('[RFM] /friends returned an unexpected shape, falling back:', data);
			}
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			// Used to be swallowed silently, which is how the "User 293778114" rows
			// got all the way to the UI with nobody able to say why.
			console.warn('[RFM] /friends failed, falling back to /friends/find:', err.message);
		}

		const out = [];
		const walked = new Set();
		const seenCursors = new Set();
		let duplicates = 0;
		let cursor = '';
		let pages = 0;

		const findUrl = (size, cur) =>
			`${FRIENDS}/users/${userId}/friends/find?limit=${size}&userSort=1` +
			(cur ? `&cursor=${encodeURIComponent(cur)}` : '');

		do {
			let page;
			try {
				page = await this.request(findUrl(this._findPageSize, cursor), { signal, kind: 'read' });
			} catch (err) {
				if (this._findPageSize > FIND_PAGE_SIZE_SAFE && err.status === 400) {
					// Remembered on the instance, so this is probed once per session
					// rather than once per load.
					console.info(
						`[RFM] /friends/find rejected limit=${this._findPageSize} -` +
							` using ${FIND_PAGE_SIZE_SAFE} from here on.`
					);
					this._findPageSize = FIND_PAGE_SIZE_SAFE;
					page = await this.request(findUrl(this._findPageSize, cursor), { signal, kind: 'read' });
				} else {
					throw err;
				}
			}

			const batch = [];
			for (const item of pageItems(page)) {
				const id = Number(pickKey(item, ['id']));
				if (!Number.isFinite(id)) continue;
				// A cursor that shifts under us hands back rows we have already had.
				// Counting them is how a caller can tell a moving list (real skips,
				// worth retrying) from a list Roblox simply won't return in full.
				if (walked.has(id)) {
					duplicates++;
					continue;
				}
				walked.add(id);
				batch.push(
					named.get(id) || {
						id,
						name: pickKey(item, ['name']) || '',
						displayName: pickKey(item, ['displayName']) || '',
					}
				);
			}
			out.push(...batch);
			this._noteSeen(batch);
			await emit(batch);

			cursor = pageCursor(page);
			// A repeated cursor would page forever. Stop rather than spin.
			if (cursor && seenCursors.has(cursor)) {
				console.warn('[RFM] /friends/find repeated a cursor - stopping pagination.');
				cursor = '';
				break;
			}
			seenCursors.add(cursor);
			// Deliberately not stopping at `out.length >= expected`: the count can be a
			// little stale, and trusting it over the cursor is how a list gets silently
			// truncated. The cursor decides when the walk is over; the count only says
			// whether the result looks short afterwards.
		} while (cursor && ++pages < MAX_FRIEND_PAGES);

		if (cursor) {
			console.warn(
				`[RFM] Stopped at the ${MAX_FRIEND_PAGES}-page guard with ${out.length} friends read` +
					' and more still pending.'
			);
		}

		// /friends and /friends/find do not always agree, and until now the walk threw
		// away the difference: `out` was built purely from find's pages, so a friend
		// /friends had already named but find never returned was dropped outright.
		// Union them - a confirmed friend from either endpoint is a friend.
		const missedByFind = [];
		for (const [id, record] of named) {
			if (!walked.has(id)) missedByFind.push(record);
		}
		if (missedByFind.length) {
			console.info(
				`[RFM] ${missedByFind.length} friend(s) came from /friends but never appeared` +
					' in the /friends/find walk - keeping them.'
			);
			out.push(...missedByFind);
			this._noteSeen(missedByFind);
			await emit(missedByFind);
		}

		const friends = dedupeById(out);
		if (expected != null && friends.length < expected) {
			console.warn(
				`[RFM] Walk ended with ${friends.length} of ${expected} friends.` +
					` /friends contributed ${named.size}, find returned ${walked.size} unique` +
					` (${duplicates} duplicate row(s)), ${missedByFind.length} recovered by union.` +
					(duplicates
						? ' Duplicates mean the list shifted mid-walk, so a refresh may find more.'
						: ' No duplicates seen, so the remainder is most likely deleted or moderated' +
							' accounts that /friends/count includes but neither list endpoint returns.')
			);
		}
		return done(friends, { source: 'find', duplicates, recovered: missedByFind.length });
	}

	/**
	 * Records that these ids are friends right now. First sighting wins, so the
	 * timestamp is "how long we have known about them" - the closest thing to a
	 * friendship date, since Roblox exposes none. Used by auto-trim to pick the
	 * oldest friends.
	 */
	_noteSeen(records) {
		if (!this.cache) return;
		for (const record of records) this.cache.noteSeen(record.id);
	}


	/**
	 * Best-effort batch name fill for records from /friends/find, which carry ids
	 * only. Mutates and returns `records`. Never throws for lookup failures - an
	 * unnamed record still has a usable id, and callers label it "User <id>".
	 *
	 * This is the lean sibling of getUserCards: no avatars, no per-user fallback,
	 * because its callers work in ids and only want names for the log.
	 */
	async fillMissingNames(records, signal) {
		let missing = records.filter((r) => !r.name);
		if (!missing.length) return records;

		// The keep-list editor has very likely already named these. Same cache, so
		// the unfriend job inherits that work instead of repeating it.
		if (this.cache) {
			for (const record of missing) {
				const hit = this.cache.name(record.id);
				if (hit) {
					record.name = hit.name;
					record.displayName = record.displayName || hit.displayName;
				}
			}
			missing = missing.filter((r) => !r.name);
			if (!missing.length) return records;
		}

		const byId = new Map(missing.map((r) => [Number(r.id), r]));

		for (const batch of chunk([...byId.keys()], PROFILE_BATCH)) {
			try {
				for (const user of await this._lookupProfiles(batch, signal)) {
					applyDetails(byId.get(user.id), user);
					this.cache?.putName(user.id, user.name, user.displayName);
				}
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
				console.warn('[RFM] get-profiles failed for a batch of', batch.length, '-', err.message);
			}
		}

		// Whatever get-profiles didn't name falls through to the documented endpoint.
		const unnamed = [...byId.keys()].filter((id) => !byId.get(id).name);

		for (const batch of chunk(unnamed, BATCH)) {
			try {
				const data = await this.request(`${USERS}/users`, {
					method: 'POST',
					json: { userIds: batch, excludeBannedUsers: false },
					signal,
					kind: 'read',
					sessionFree: true,
				});
				for (const user of data?.data || []) {
					applyDetails(byId.get(Number(user.id)), user);
					this.cache?.putName(user.id, user.name, user.displayName);
				}
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
				console.warn('[RFM] name lookup failed for a batch of', batch.length, '-', err.message);
			}
		}

		return records;
	}

	/**
	 * Shared state for one card-building session: the cards, the ids in input
	 * order, and the diagnostics that every lookup step records into.
	 *
	 * A card is { id, name, displayName, avatarUrl, resolved }, and `resolved` is
	 * false when every source failed for that id - the UI shows that as an error
	 * rather than rendering the "User 293778114" placeholder as if it were a name.
	 */
	_cardSession({ bypassCache = false } = {}) {
		const cache = bypassCache ? null : this.cache;
		const cards = new Map();
		const ids = [];
		// Every source records what it did, pass or fail, and the options page prints
		// these verbatim. Reading the service-worker console should be optional, not
		// the only way to find out why a name is missing.
		const diagnostics = { unresolved: 0, thumbsOk: true, steps: [] };
		return {
			cards,
			ids,
			diagnostics,
			seeded: 0,
			fromCache: 0,
			step(source, ok, detail) {
				diagnostics.steps.push({ source, ok, detail });
				if (!ok) console.warn(`[RFM] ${source}: ${detail}`);
			},
			/** Seeds a card from an id or a partial record. Returns the id, or null. */
			add(entry) {
				const seed = typeof entry === 'object' && entry !== null ? entry : { id: entry };
				const id = Number(seed.id);
				if (!Number.isFinite(id) || cards.has(id)) return null;
				ids.push(id);

				// Source 1: whatever the friends list already told us. Free.
				let name = seed.name || '';
				let displayName = seed.displayName || '';
				if (name) this.seeded++;

				// Source 1b: what we learned last time. Also free, and the whole point
				// of the cache - an id named from here costs no users.roblox.com call.
				const hit = name ? null : cache?.name(id);
				if (hit) {
					name = hit.name;
					displayName = displayName || hit.displayName;
					this.fromCache++;
				}

				cards.set(id, {
					id,
					name: name || `User ${id}`,
					displayName: displayName || name || `User ${id}`,
					avatarUrl: cache?.avatar(id) || null,
					resolved: Boolean(name),
				});
				return id;
			},
			unresolvedIds() {
				return ids.filter((id) => !cards.get(id).resolved);
			},
			pick(batch) {
				return batch.map((id) => cards.get(id)).filter(Boolean);
			},
			finish() {
				if (this.fromCache) {
					diagnostics.steps.unshift({
						source: 'cache',
						ok: true,
						detail: `${this.fromCache} of ${ids.length} named from the cache`,
					});
				}
				if (this.seeded) {
					// Unshifted so it reads first, ahead of the per-batch entries.
					diagnostics.steps.unshift({
						source: 'friends list',
						ok: true,
						detail: `${this.seeded} of ${ids.length} named directly`,
					});
				}
				diagnostics.unresolved = this.unresolvedIds().length;
				return { cards: ids.map((id) => cards.get(id)), diagnostics };
			},
		};
	}

	/**
	 * The bulk lookup the Roblox friends page itself makes. Public - no cookie and
	 * no CSRF - so it proxies session-free like every other lookup here, and it
	 * lives on apis.roblox.com, which means both a separate Roblox quota from
	 * users.roblox.com and a separate limiter pace key (see paceKey).
	 *
	 * Throws rather than returning empty, so callers can fall through to /v1/users.
	 * @returns {Promise<Array<{id:number,name:string,displayName:string}>>}
	 */
	async _lookupProfiles(ids, signal) {
		if (ids.length > PROFILE_BATCH) {
			throw new ApiError(
				'http',
				`get-profiles asked for ${ids.length} ids, over its ${PROFILE_BATCH} cap`
			);
		}
		const data = await this.request(PROFILES, {
			method: 'POST',
			json: { userIds: ids, fields: PROFILE_FIELDS },
			signal,
			kind: 'read',
			sessionFree: true,
		});
		const rows = data?.profileDetails;
		if (!Array.isArray(rows) || !rows.length) {
			const reported = Array.isArray(data?.errors) && data.errors.length
				? JSON.stringify(data.errors).slice(0, 120)
				: 'no errors reported';
			throw new ApiError('http', `get-profiles returned nothing for ${ids.length} ids - ${reported}`);
		}
		return rows.map(profileToUser).filter(Boolean);
	}

	/**
	 * Source 2: get-profiles. Tried ahead of /v1/users because it answers 250 ids
	 * per call instead of 100, on the host that isn't the one throttling this
	 * extension.
	 */
	async _fillNamesProfiles(session, batch, signal) {
		try {
			const users = await this._lookupProfiles(batch, signal);
			for (const user of users) {
				applyDetails(session.cards.get(user.id), user);
				this.cache?.putName(user.id, user.name, user.displayName);
			}
			// Named, not returned: a row with null names is a row, and counting those
			// would report a full batch while every card stayed unresolved.
			session.step(
				'POST get-profiles',
				users.length > 0,
				`${users.length} of ${batch.length} named`
			);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			session.step('POST get-profiles', false, describe(err));
		}
	}

	/**
	 * Source 2b: the documented batch endpoint, for anything get-profiles didn't
	 * name. /v1/users/{id}/friends is known to return empty name/displayName, and
	 * get-profiles is undocumented, so this stays in the ladder as the fallback.
	 */
	async _fillNamesBatch(session, batch, signal) {
		try {
			const data = await this.request(`${USERS}/users`, {
				method: 'POST',
				json: { userIds: batch, excludeBannedUsers: false },
				signal,
				kind: 'read',
				sessionFree: true,
			});
			const rows = data?.data || [];
			for (const user of rows) {
				applyDetails(session.cards.get(Number(user.id)), user);
				this.cache?.putName(user.id, user.name, user.displayName);
			}
			session.step(
				'POST /v1/users',
				rows.length > 0,
				`${rows.length} of ${batch.length} returned` +
					(rows.length ? '' : ` (body: ${JSON.stringify(data).slice(0, 120)})`)
			);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			session.step('POST /v1/users', false, describe(err));
		}
	}

	/**
	 * Source 3: one plain GET per user. No CSRF, no request body, no batch
	 * semantics, so it sidesteps whatever the batch call trips on. Capped because
	 * at the paced request rate this is slow. Returns the ids it attempted.
	 */
	async _fillNamesIndividually(session, missing, signal) {
		const attempts = missing.slice(0, SINGLE_LOOKUP_CAP);
		if (!attempts.length) return attempts;

		let resolved = 0;
		let lastError = null;
		for (const id of attempts) {
			try {
				const user = await this.request(`${USERS}/users/${id}`, {
					signal,
					kind: 'read',
					sessionFree: true,
				});
				if (user?.id) {
					applyDetails(session.cards.get(Number(user.id)), user);
					this.cache?.putName(user.id, user.name, user.displayName);
					resolved++;
				} else {
					lastError = `200 but no id in body for ${id}`;
				}
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
				lastError = `${id}: ${describe(err)}`;
			}
		}
		const skipped = missing.length - attempts.length;
		session.step(
			'GET /v1/users/{id}',
			resolved > 0,
			`${resolved} of ${attempts.length} resolved` +
				(lastError ? ` - last error: ${lastError}` : '') +
				(skipped ? ` - ${skipped} skipped over the ${SINGLE_LOOKUP_CAP} cap` : '')
		);
		return attempts;
	}

	/** Avatars, batched. Cosmetic, so a failure is recorded but never thrown. */
	async _fillAvatarsBatch(session, batch, signal) {
		try {
			const data = await this.request(
				`${THUMBNAILS}/users/avatar-headshot` +
					`?userIds=${batch.join(',')}&size=48x48&format=Png&isCircular=false`,
				{ signal, kind: 'read', sessionFree: true }
			);
			const rows = data?.data || [];
			let withUrl = 0;
			for (const thumb of rows) {
				const card = session.cards.get(Number(thumb.targetId));
				// Deliberately not gated on state === 'Completed': a usable URL is a
				// usable URL, and the state field has more values than that.
				if (card && thumb.imageUrl) {
					card.avatarUrl = thumb.imageUrl;
					this.cache?.putAvatar(card.id, thumb.imageUrl);
					withUrl++;
				}
			}
			if (!withUrl) session.diagnostics.thumbsOk = false;
			session.step(
				'avatar-headshot',
				withUrl > 0,
				`${withUrl} of ${batch.length} avatars` +
					(withUrl ? '' : ` (states: ${rows.map((r) => r.state).join(',') || 'none'})`)
			);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			session.diagnostics.thumbsOk = false;
			session.step('avatar-headshot', false, describe(err));
		}
	}

	/**
	 * Turn user ids into display-ready cards, from whichever source answers.
	 *
	 * @param {Array<number|{id:number,name?:string,displayName?:string}>} input
	 *        Bare ids, or partial records from the friends list to seed from.
	 * @param {AbortSignal} [signal]
	 * @param {(cards:Array)=>void} [onBatch] fires after each lookup batch lands.
	 * @param {{bypassCache?:boolean}} [opts]
	 */
	async getUserCards(input, signal, onBatch = null, { bypassCache = false } = {}) {
		const session = this._cardSession({ bypassCache });
		for (const entry of input) session.add(entry);
		const emit = (batch) => emitCards(onBatch, session, batch);

		for (const batch of chunk(session.unresolvedIds(), PROFILE_BATCH)) {
			await this._fillNamesProfiles(session, batch, signal);
			await emit(batch);
		}

		for (const batch of chunk(session.unresolvedIds(), BATCH)) {
			await this._fillNamesBatch(session, batch, signal);
			await emit(batch);
		}

		const attempted = await this._fillNamesIndividually(session, session.unresolvedIds(), signal);
		if (attempted.length) await emit(attempted);

		// Only the ids whose avatar didn't come from the cache need fetching.
		const needAvatars = session.ids.filter((id) => !session.cards.get(id).avatarUrl);
		for (const batch of chunk(needAvatars, BATCH)) {
			await this._fillAvatarsBatch(session, batch, signal);
			await emit(batch);
		}

		return session.finish();
	}

	/**
	 * The friends list as display-ready cards, for the keep-list.
	 *
	 * The two request streams are interleaved rather than run back to back: as soon
	 * as the walk has accumulated a full batch of ids, that batch's names and
	 * avatars are fetched before the walk carries on. So rows fill in from the top
	 * while the list is still loading, instead of every row sitting on "looking up
	 * name..." until all 20 pages are in. Identical request count either way - only
	 * the order changes.
	 *
	 * onPage fires per friends-list page; onBatch fires per completed lookup batch.
	 */
	async getFriendCards(userId, signal, { onPage = null, onBatch = null, bypassCache = false } = {}) {
		const session = this._cardSession({ bypassCache });
		const emit = (batch) => emitCards(onBatch, session, batch);

		// Ids waiting their turn. Flushed at PROFILE_BATCH so every name lookup is a
		// full one: keeping that request count down matters more than making names
		// appear a page sooner. Avatars keep their own 100 cap, and rows are still
		// emitted 100 at a time, so the list fills in at the granularity it always did.
		const queued = [];
		const flush = async (drain) => {
			while (queued.length >= PROFILE_BATCH || (drain && queued.length)) {
				const unit = queued.splice(0, PROFILE_BATCH);
				const missing = unit.filter((id) => !session.cards.get(id).resolved);
				if (missing.length) {
					await this._fillNamesProfiles(session, missing, signal);
					const stillMissing = unit.filter((id) => !session.cards.get(id).resolved);
					for (const batch of chunk(stillMissing, BATCH)) {
						await this._fillNamesBatch(session, batch, signal);
					}
				}
				// Both lookups are skipped outright for ids the cache already knows,
				// which is what makes a warm refresh cost nothing but the list walk.
				for (const part of chunk(unit, BATCH)) {
					const needAvatars = part.filter((id) => !session.cards.get(id).avatarUrl);
					if (needAvatars.length) await this._fillAvatarsBatch(session, needAvatars, signal);
					await emit(part);
				}
			}
		};

		// Whole records go in, not just ids, so any names /friends returned for free
		// are reused instead of looked up again.
		const { expected, complete } = await this.getFriendsSnapshot(
			userId,
			signal,
			async (page, total) => {
				for (const record of page) {
					const id = session.add(record);
					if (id != null) queued.push(id);
				}
				if (onPage) {
					try {
						await onPage(page, total);
					} catch (err) {
						if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
						console.warn('[RFM] friends onPage callback threw:', err?.message || err);
					}
				}
				await flush(false);
			}
		);
		await flush(true);

		// One last per-user attempt for whatever the batches still couldn't name.
		const attempted = await this._fillNamesIndividually(session, session.unresolvedIds(), signal);
		if (attempted.length) await emit(attempted);

		return { ...session.finish(), expected, complete };
	}

	/** Usernames -> [{ id, name }]. Used only by the keep-list editor. */
	async resolveUsernames(usernames, signal) {
		const data = await this.request(`${USERS}/usernames/users`, {
			method: 'POST',
			json: { usernames, excludeBannedUsers: false },
			signal,
			kind: 'read',
			sessionFree: true,
		});
		return (data?.data || []).map((u) => ({ id: u.id, name: u.name || String(u.id) }));
	}
}

function dedupeById(list) {
	const seen = new Set();
	return list.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}
