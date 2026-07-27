// Roblox endpoint wrappers plus the one place that owns CSRF and decides what
// every HTTP status means.
//
// Endpoint URLs and the `accept` header are carried over from the original
// console scripts (legacy/unaddfriends.js), which were proven against live
// Roblox. The control flow around them is not.

import { getTransport, NoRobloxTabError } from './transport.js';
import { ApiError, AbortError, isAbort } from './errors.js';

const FRIENDS = 'https://friends.roblox.com/v1';
const USERS = 'https://users.roblox.com/v1';
const THUMBNAILS = 'https://thumbnails.roblox.com/v1';

// Both /v1/users and the thumbnails API top out around 100 ids per call.
const BATCH = 100;

// Ceiling on the one-request-per-user fallback. At the paced request rate this
// is the difference between a slow load and a five minute one.
const SINGLE_LOOKUP_CAP = 25;

/** Fills a card from a /v1/users row. Both endpoints return the same shape. */
function applyDetails(card, user) {
	if (!card || !user) return;
	if (user.name) card.name = user.name;
	card.displayName = user.displayName || user.name || card.displayName;
	if (user.name) card.resolved = true;
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
	 * @param {{maxRetries?:number, onEvent?:(e:object)=>void}} [opts]
	 */
	constructor(limiter, { maxRetries = 3, onEvent = () => {} } = {}) {
		this.limiter = limiter;
		this.maxRetries = maxRetries;
		this.onEvent = onEvent;

		// Learned lazily from the 403 Roblox uses to reject an unstamped POST.
		// There is deliberately no "primer" request - the old code POSTed to
		// /v2/logout for this, which would have ended the session had it succeeded.
		this.csrf = null;
	}

	async request(url, { method = 'GET', json = null, signal } = {}) {
		let attempt = 0;
		let csrfRetries = 0;
		let consecutive429 = 0;

		for (;;) {
			if (signal?.aborted) throw new AbortError();

			const headers = { accept: 'application/json, text/plain, */*' };
			if (method !== 'GET') {
				if (this.csrf) headers['x-csrf-token'] = this.csrf;
				if (json !== null) headers['content-type'] = 'application/json';
			}
			const request = { url, method, headers, body: json === null ? null : JSON.stringify(json) };

			let res;
			try {
				const send = await getTransport();
				res = await this.limiter.run(() => send(request), signal);
			} catch (err) {
				if (isAbort(err)) throw err;
				if (err instanceof NoRobloxTabError) throw new ApiError('notab', err.message);
				res = { networkError: String(err?.message || err) };
			}

			// --- transport-level failure -------------------------------------
			if (!res || res.networkError) {
				console.warn('[RFM]', method, url, '-> transport error:', res?.networkError);
				if (++attempt > this.maxRetries) {
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
				this.limiter.onSuccess();
				return parseJson(res.text);
			}

			// --- rate limited ---------------------------------------------------
			if (status === 429) {
				if (++consecutive429 > MAX_CONSECUTIVE_429) {
					throw new ApiError('network', 'Still rate limited after many retries.', { status });
				}
				const waitMs = this.limiter.onRateLimit(parseRetryAfter(res.retryAfter));
				this.onEvent({ type: 'ratelimit', waitMs, url });
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
	getAuthenticatedUser(signal) {
		return this.request(`${USERS}/users/authenticated`, { signal });
	}

	async getPendingRequestCount(signal) {
		const data = await this.request(`${FRIENDS}/user/friend-requests/count`, { signal });
		return Number(data?.count) || 0;
	}

	/** One page of incoming friend requests: { data: [{id, name, ...}], nextPageCursor }. */
	getIncomingRequests(cursor = '', signal) {
		const url =
			`${FRIENDS}/my/friends/requests?limit=50&sortOrder=Asc` +
			(cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
		return this.request(url, { signal });
	}

	acceptFriendRequest(userId, signal) {
		return this.request(`${FRIENDS}/users/${userId}/accept-friend-request`, {
			method: 'POST',
			signal,
		});
	}

	unfriend(userId, signal) {
		return this.request(`${FRIENDS}/users/${userId}/unfriend`, { method: 'POST', signal });
	}

	/**
	 * Full friends list as [{ id, name, displayName }].
	 *
	 * /friends returns everyone in one call *with usernames*. /friends/find is the
	 * paginated fallback, but its PageItems only carry ids, so names come back
	 * empty and the caller has to resolve them separately.
	 */
	async getAllFriends(userId, signal) {
		try {
			const data = await this.request(`${FRIENDS}/users/${userId}/friends`, { signal });
			if (Array.isArray(data?.data)) {
				return dedupeById(
					data.data.map((u) => ({
						id: u.id,
						name: u.name || '',
						displayName: u.displayName || u.name || '',
					}))
				);
			}
			console.warn('[RFM] /friends returned an unexpected shape, falling back:', data);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			// Used to be swallowed silently, which is how the "User 293778114" rows
			// got all the way to the UI with nobody able to say why.
			console.warn('[RFM] /friends failed, falling back to /friends/find:', err.message);
		}

		const out = [];
		let cursor = '';
		do {
			const page = await this.request(
				`${FRIENDS}/users/${userId}/friends/find?limit=50&userSort=1` +
					(cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
				{ signal }
			);
			for (const item of page?.PageItems || []) {
				out.push({ id: item.id, name: item.name || '', displayName: item.displayName || '' });
			}
			// This endpoint has used both spellings over time.
			cursor = page?.nextCursor || page?.nextPageCursor || '';
		} while (cursor);

		return dedupeById(out);
	}

	/**
	 * Turn user ids into display-ready cards, from whichever source answers.
	 *
	 * Returns { cards, diagnostics }. A card is
	 * { id, name, displayName, avatarUrl, resolved } and `resolved` is false when
	 * every source failed for that id - the UI shows that as an error rather than
	 * rendering the "User 293778114" placeholder as if it were a real name.
	 *
	 * @param {Array<number|{id:number,name?:string,displayName?:string}>} input
	 *        Bare ids, or partial records from the friends list to seed from.
	 */
	async getUserCards(input, signal) {
		const seeds = input.map((entry) => (typeof entry === 'object' ? entry : { id: entry }));
		const ids = [];
		const cards = new Map();

		for (const seed of seeds) {
			const id = Number(seed.id);
			if (!Number.isFinite(id) || cards.has(id)) continue;
			ids.push(id);
			// Source 1: whatever the friends list already told us. Free.
			const name = seed.name || '';
			cards.set(id, {
				id,
				name: name || `User ${id}`,
				displayName: seed.displayName || name || `User ${id}`,
				avatarUrl: null,
				resolved: Boolean(name),
			});
		}

		// Every source records what it did, pass or fail, and the options page
		// prints these verbatim. Reading the service-worker console should be
		// optional, not the only way to find out why a name is missing.
		const diagnostics = { unresolved: 0, thumbsOk: true, steps: [] };
		const step = (source, ok, detail) => {
			diagnostics.steps.push({ source, ok, detail });
			if (!ok) console.warn(`[RFM] ${source}: ${detail}`);
		};
		const describe = (err) =>
			[err.status || null, err.code != null ? `code ${err.code}` : null, err.message]
				.filter(Boolean)
				.join(' ');

		const seeded = ids.length - ids.filter((id) => !cards.get(id).resolved).length;
		if (seeded) step('friends list', true, `${seeded} of ${ids.length} named directly`);

		// Source 2: the batch endpoint, for anything the friends list didn't name.
		// /v1/users/{id}/friends is known to return empty name/displayName, so in
		// practice this is where most lookups actually happen.
		const missing = ids.filter((id) => !cards.get(id).resolved);
		for (const batch of chunk(missing, BATCH)) {
			try {
				const data = await this.request(`${USERS}/users`, {
					method: 'POST',
					json: { userIds: batch, excludeBannedUsers: false },
					signal,
				});
				const rows = data?.data || [];
				for (const user of rows) applyDetails(cards.get(Number(user.id)), user);
				step(
					'POST /v1/users',
					rows.length > 0,
					`${rows.length} of ${batch.length} returned` +
						(rows.length ? '' : ` (body: ${JSON.stringify(data).slice(0, 120)})`)
				);
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
				step('POST /v1/users', false, describe(err));
			}
		}

		// Source 3: one plain GET per user. No CSRF, no request body, no batch
		// semantics, so it sidesteps whatever the batch call trips on. Capped
		// because at the paced request rate this is slow.
		const stillMissing = ids.filter((id) => !cards.get(id).resolved);
		const attempts = stillMissing.slice(0, SINGLE_LOOKUP_CAP);
		if (attempts.length) {
			let resolved = 0;
			let lastError = null;
			for (const id of attempts) {
				try {
					const user = await this.request(`${USERS}/users/${id}`, { signal });
					if (user?.id) {
						applyDetails(cards.get(Number(user.id)), user);
						resolved++;
					} else {
						lastError = `200 but no id in body for ${id}`;
					}
				} catch (err) {
					if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
					lastError = `${id}: ${describe(err)}`;
				}
			}
			const skipped = stillMissing.length - attempts.length;
			step(
				'GET /v1/users/{id}',
				resolved > 0,
				`${resolved} of ${attempts.length} resolved` +
					(lastError ? ` - last error: ${lastError}` : '') +
					(skipped ? ` - ${skipped} skipped over the ${SINGLE_LOOKUP_CAP} cap` : '')
			);
		}

		diagnostics.unresolved = ids.filter((id) => !cards.get(id).resolved).length;

		// Avatars, batched. Cosmetic, so a failure is recorded but never thrown.
		for (const batch of chunk(ids, BATCH)) {
			try {
				const data = await this.request(
					`${THUMBNAILS}/users/avatar-headshot` +
						`?userIds=${batch.join(',')}&size=48x48&format=Png&isCircular=false`,
					{ signal }
				);
				const rows = data?.data || [];
				let withUrl = 0;
				for (const thumb of rows) {
					const card = cards.get(Number(thumb.targetId));
					// Deliberately not gated on state === 'Completed': a usable URL is
					// a usable URL, and the state field has more values than that.
					if (card && thumb.imageUrl) {
						card.avatarUrl = thumb.imageUrl;
						withUrl++;
					}
				}
				if (!withUrl) diagnostics.thumbsOk = false;
				step(
					'avatar-headshot',
					withUrl > 0,
					`${withUrl} of ${batch.length} avatars` +
						(withUrl ? '' : ` (states: ${rows.map((r) => r.state).join(',') || 'none'})`)
				);
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
				diagnostics.thumbsOk = false;
				step('avatar-headshot', false, describe(err));
			}
		}

		return { cards: ids.map((id) => cards.get(id)), diagnostics };
	}

	/** The friends list as display-ready cards, for the keep-list. */
	async getFriendCards(userId, signal) {
		// Pass the whole records through, not just ids, so any names /friends
		// already returned are reused instead of re-fetched.
		const friends = await this.getAllFriends(userId, signal);
		return this.getUserCards(friends, signal);
	}

	/** Usernames -> [{ id, name }]. Used only by the keep-list editor. */
	async resolveUsernames(usernames, signal) {
		const data = await this.request(`${USERS}/usernames/users`, {
			method: 'POST',
			json: { usernames, excludeBannedUsers: false },
			signal,
		});
		return (data?.data || []).map((u) => ({ id: u.id, name: u.name || String(u.id) }));
	}
}

function dedupeById(list) {
	const seen = new Set();
	return list.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}
