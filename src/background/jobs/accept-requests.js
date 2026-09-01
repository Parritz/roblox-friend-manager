// Bulk-accept incoming friend requests.

import { STATUS } from '../../shared/messages.js';
import { AbortError, isAbort, sleep } from '../errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Identical terminal errors in a row that mean "stop, this won't get better".
const SAME_ERROR_LIMIT = 5;

// Full-list passes before giving up. A pass must accept at least one request to
// earn another, so this only caps pathological cases.
const MAX_PASSES = 10;

// Runaway guard on the cursor walk, matching the friends-list walk.
const MAX_PAGES_PER_PASS = 60;

// Gap between watch polls. Starts responsive and eases out while nothing turns
// up, so an extension left armed all evening isn't asking for the count every
// 30s for hours. Anything accepted snaps it back to the minimum.
const WATCH_MIN_MS = 30_000;
const WATCH_MAX_MS = 3 * 60_000;

// Ceiling on the remembered-id set. Strictly, only ids that *couldn't* be
// accepted need to stay - an accepted request leaves the list - but the set
// can't tell those apart without risking a re-attempt on a request Roblox hasn't
// finished removing yet. So it's bounded oldest-first rather than trusted to
// stay small over a session that can now run for hours.
const PROCESSED_LIMIT = 5000;

function namesMatch(name, displayName) {
	if (!name || !displayName) return false;
	return name.trim().toLowerCase() === displayName.trim().toLowerCase();
}

/** Signup time in ms, or null. Friend-request rows and GET /v1/users/{id} both use `created`. */
function createdMs(obj) {
	if (!obj || typeof obj !== 'object') return null;
	const raw = obj.created ?? obj.Created ?? obj.createdAt ?? obj.CreatedAt;
	if (raw == null || raw === '') return null;
	const ms = typeof raw === 'number' ? (raw > 0 && raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
	return Number.isFinite(ms) ? ms : null;
}

function requesterId(item) {
	const id = Number(item?.id) || Number(item?.friendRequest?.senderId);
	return Number.isFinite(id) && id > 0 ? id : null;
}

/** Human-readable account age for the skip log, e.g. "5h" or "3 days". */
function formatAge(ageMs) {
	if (!(ageMs >= 0)) return 'unknown age';
	const hours = Math.floor(ageMs / (60 * 60 * 1000));
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(ageMs / DAY_MS);
	return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Why this requester should be left pending, or null to accept.
 * `details` is the /v1/users row when a lookup ran; name/displayName on the
 * request itself are enough for the matching-names filter.
 */
function skipReason(user, details, settings = {}, now = Date.now()) {
	const reasons = [];
	const name = details?.name || user.name || '';
	const displayName = details?.displayName || user.displayName || '';

	if (settings.skipSameDisplayName && namesMatch(name, displayName)) {
		reasons.push('display name matches username');
	}

	if (settings.skipNewAccounts) {
		const createdAt = createdMs(details) ?? createdMs(user);
		if (createdAt != null) {
			const ageMs = now - createdAt;
			const minMs = Math.max(1, Number(settings.minAccountAgeDays) || 0) * DAY_MS;
			if (ageMs < minMs) {
				reasons.push(`account is ${formatAge(ageMs)} old (minimum ${settings.minAccountAgeDays} days)`);
			}
		}
	}

	return reasons.length ? reasons.join('; ') : null;
}

function filterSummary(settings = {}) {
	const parts = [];
	if (settings.skipNewAccounts) {
		const n = settings.minAccountAgeDays;
		parts.push(`accounts younger than ${n} day${n === 1 ? '' : 's'}`);
	}
	if (settings.skipSameDisplayName) {
		parts.push('accounts whose display name matches their username');
	}
	return parts;
}

/**
 * One full drain of the request list: passes until a pass accepts nothing, or
 * the count says the queue is empty.
 *
 * @returns {Promise<{accepted:number, paused:boolean, stuck:number}>}
 *          `paused` means a terminal condition has already set STATUS.PAUSED and
 *          the caller must not carry on. `stuck` counts requests still listed
 *          that have been tried and refused.
 */
async function acceptQueued(ctx, processed, { watch }) {
	const { api, state, settings = {}, signal, log, commit } = ctx;

	let lastCode = null;
	let sameCodeRun = 0;
	/** Set by the friend-cap detector to unwind both loops. */
	let paused = false;
	let acceptedTotal = 0;

	const settled = () => state.done + state.skipped + state.failed;

	const remember = (id) => {
		processed.add(id);
		// A Set iterates in insertion order, so this drops the oldest ids first.
		for (const oldest of processed) {
			if (processed.size <= PROCESSED_LIMIT) break;
			processed.delete(oldest);
		}
		state.processedIds = [...processed];
	};

	// Best-effort total for the progress bar; the count endpoint is not critical.
	let pending = null;
	try {
		pending = await api.getPendingRequestCount(signal);
		if (pending > 0) {
			state.total = settled() + pending;
			await commit();
		}
	} catch (err) {
		if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
	}

	if (pending === 0) return { accepted: 0, paused: false, stuck: 0 };

	for (let pass = 1; pass <= MAX_PASSES && !paused; pass++) {
		if (signal.aborted) throw new AbortError();

		let accepted = 0;
		let seenThisPass = 0;
		let cursor = '';
		let pages = 0;
		const seenCursors = new Set();

		// One full walk of the request list. Ids already attempted are skipped, so a
		// request that can never be accepted costs one page read, not the whole job.
		do {
			if (signal.aborted) throw new AbortError();

			const page = await api.getIncomingRequests(cursor, signal);
			const items = page?.data || [];
			seenThisPass += items.length;

			// POST /v1/users no longer returns signup dates. Use `created` on the
			// request row when Roblox still sends it; otherwise GET /v1/users/{id}
			// for anyone the age filter needs and we don't already know.
			let detailsById = new Map();
			const fresh = items.filter((user) => requesterId(user) && !processed.has(requesterId(user)));
			const needLookup = fresh.filter(
				(user) =>
					(settings.skipNewAccounts && createdMs(user) == null) ||
					(settings.skipSameDisplayName && (!user.name || !user.displayName))
			);
			if (needLookup.length) {
				try {
					detailsById = await api.getUsersById(
						needLookup.map((user) => requesterId(user)),
						signal
					);
				} catch (err) {
					if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
					log('warn', `Could not look up requester details: ${err.message}`);
				}
			}

			for (const user of items) {
				if (signal.aborted) throw new AbortError();
				const id = requesterId(user);
				if (!id || processed.has(id)) continue;

				remember(id);
				const details = detailsById.get(id);
				const label = details?.name || user.name || `User ${id}`;

				if (settings.skipNewAccounts && createdMs(details) == null && createdMs(user) == null) {
					log('warn', `No creation date for ${label}; cannot apply age filter.`);
				}

				const reason = skipReason(user, details, settings);
				if (reason) {
					state.skipped++;
					log('info', `Skipped ${label}: ${reason}`);
					if (state.total < settled()) state.total = settled();
					await commit();
					continue;
				}

				try {
					await api.acceptFriendRequest(id, signal);
					state.done++;
					accepted++;
					acceptedTotal++;
					sameCodeRun = 0;
					lastCode = null;
					log('info', `Accepted ${label}`);
				} catch (err) {
					if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;

					if (err.kind === 'terminal') {
						state.skipped++;
						log(
							'warn',
							`Skipped ${label}: ${err.message}${err.code != null ? ` (code ${err.code})` : ''}`
						);

						// The friend cap is the case that matters here: once it's hit, every
						// remaining accept fails identically, and grinding through hundreds of
						// guaranteed failures is both pointless and a great way to get flagged.
						if (err.code != null && err.code === lastCode) sameCodeRun++;
						else {
							lastCode = err.code;
							sameCodeRun = 1;
						}
						if (sameCodeRun >= SAME_ERROR_LIMIT) {
							state.status = STATUS.PAUSED;
							state.message =
								`Paused: ${SAME_ERROR_LIMIT} accepts in a row failed the same way ` +
								`(code ${err.code}: ${err.message}). If you're at Roblox's friend limit, ` +
								`run Unfriend first.`;
							await commit();
							paused = true;
							break;
						}
					} else {
						state.failed++;
						log('error', `Failed ${label}: ${err.message}`);
					}
				}

				if (state.total < settled()) state.total = settled();
				await commit();
			}

			if (paused) return { accepted: acceptedTotal, paused: true, stuck: 0 };

			cursor = page?.nextPageCursor || page?.NextCursor || '';
			if (cursor && seenCursors.has(cursor)) {
				console.warn('[RFM] friend requests repeated a cursor - ending this pass.');
				break;
			}
			seenCursors.add(cursor);
		} while (cursor && ++pages < MAX_PAGES_PER_PASS);

		if (seenThisPass === 0) return { accepted: acceptedTotal, paused: false, stuck: 0 };

		// Accepting shifts the list under the cursor, so one clean walk isn't proof
		// the list is empty. The count settles it.
		let left = null;
		try {
			left = await api.getPendingRequestCount(signal);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			log('warn', `Could not verify the remaining request count: ${err.message}`);
		}

		if (left === 0) return { accepted: acceptedTotal, paused: false, stuck: 0 };

		if (accepted === 0) {
			// A whole pass with nothing accepted means everything still listed has
			// already been tried and refused. Repeating the walk would change nothing.
			const stuck = left == null ? seenThisPass : left;
			// In watch mode the caller says this once per idle streak instead - the
			// same warning every 30s would bury the accepts the log is there for.
			if (!watch) {
				log(
					'warn',
					state.skipped
						? `Stopping: ${stuck} request(s) remain that were skipped or could not be accepted.`
						: `Stopping: ${stuck} request(s) remain that could not be accepted.`
				);
			}
			return { accepted: acceptedTotal, paused: false, stuck };
		}

		if (left != null) {
			state.total = settled() + left;
			await commit();
			log('info', `Pass ${pass} accepted ${accepted}; ${left} still pending.`);
		}
	}

	if (!paused && !watch) {
		log('warn', `Stopped after ${MAX_PASSES} passes. Run Accept again to continue.`);
	}
	if (signal.aborted) throw new AbortError();
	return { accepted: acceptedTotal, paused: false, stuck: 0 };
}

/**
 * Abortable gap between watch polls. Publishes when the next check is due so the
 * popup can count down rather than look hung for three minutes.
 */
async function idleFor(ctx, ms) {
	const { state, signal, commit } = ctx;
	state.nextCheckAt = Date.now() + ms;
	await commit();
	try {
		await sleep(ms, signal);
	} finally {
		state.nextCheckAt = null;
	}
}

/**
 * @param {{watch?:boolean}} [opts] `watch` keeps the job armed after the queue
 *        empties. The popup always sets it; a one-shot run is still available for
 *        callers that want the queue drained once and then done.
 */
export async function runAcceptJob(ctx, { watch = false } = {}) {
	const { state, settings, signal, log, commit } = ctx;
	const processed = new Set(state.processedIds || []);

	const filters = filterSummary(settings);
	if (filters.length) log('info', `Skipping ${filters.join(', and ')}.`);

	if (!watch) {
		const round = await acceptQueued(ctx, processed, { watch: false });
		if (!round.paused && !round.accepted && !round.stuck) log('info', 'No friend requests to accept.');
		return;
	}

	state.watching = true;
	await commit();
	log('info', 'Watching for friend requests. This keeps going until you press Stop.');

	let idle = WATCH_MIN_MS;
	let announcedIdle = false;

	for (;;) {
		if (signal.aborted) throw new AbortError();

		// Trimming outranks accepting: there is nowhere to put a new friend once the
		// list is full, and the cap is exactly the moment a trim is worth doing. The
		// hook owns the "is it due" question and throttles its own checks; a true
		// return means one actually ran, so go straight back to accepting rather than
		// idling on a list that just freed up space.
		if (await ctx.maybeTrim?.()) {
			idle = WATCH_MIN_MS;
			announcedIdle = false;
		}
		if (signal.aborted) throw new AbortError();

		const round = await acceptQueued(ctx, processed, { watch: true });
		if (round.paused) return; // friend cap and friends: STATUS.PAUSED is already set

		if (round.accepted > 0) {
			idle = WATCH_MIN_MS;
			announcedIdle = false;
		} else {
			// Said once on the way into an idle streak, not on every poll.
			if (!announcedIdle) {
				log(
					'info',
					round.stuck
						? `Nothing new. ${round.stuck} request(s) here can't be accepted; still watching.`
						: 'No friend requests waiting; still watching.'
				);
				announcedIdle = true;
			}
			idle = Math.min(idle * 2, WATCH_MAX_MS);
		}

		await idleFor(ctx, idle);
	}
}
