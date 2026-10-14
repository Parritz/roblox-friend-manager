// Accept incoming friend requests, optionally declining filter matches.

import { STATUS } from '../../shared/messages.js';
import { normalizeJobState } from '../../shared/storage.js';
import { AbortError, isAbort, sleep } from '../errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Identical terminal errors in a row that mean "stop, this won't get better".
const SAME_ERROR_LIMIT = 5;

// Full-list passes before giving up. A pass must accept or decline at least
// one request to earn another, so this only caps pathological cases.
const MAX_PASSES = 10;

// Runaway guard on the cursor walk, matching the friends-list walk.
const MAX_PAGES_PER_PASS = 60;

// Gap between watch polls. Starts responsive and eases out while nothing turns
// up, so an extension left armed all evening isn't asking for the count every
// 30s for hours. Anything accepted or declined snaps it back to the minimum.
const WATCH_MIN_MS = 30_000;
const WATCH_MAX_MS = 3 * 60_000;

// Ceiling on the remembered-id set. Strictly, only ids that *couldn't* be
// processed need to stay - accepted and declined requests leave the list - but the set
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
 * Why this requester matches a filter, or null when no match is known.
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
 * Drain the request list until a pass makes no accept/decline progress or the
 * count says the queue is empty.
 *
 * @returns {Promise<{accepted:number, declined:number, paused:boolean, stuck:number}>}
 *          `paused` means a terminal condition has already set STATUS.PAUSED and
 *          the caller must not carry on. `stuck` counts requests still listed
 *          that have been tried and refused.
 */
async function acceptQueued(ctx, processed, { watch }) {
	const { api, state, signal, log, commit } = ctx;
	let settings;
	const syncFilters = async () => {
		settings = ctx.readSettings ? await ctx.readSettings() : ctx.settings || {};
		ctx.settings = settings;
		const key = JSON.stringify([
			Boolean(settings.skipNewAccounts), Number(settings.minAccountAgeDays),
			Boolean(settings.skipSameDisplayName), Boolean(settings.declineFilteredRequests),
		]);
		if (state.acceptFilterKey !== key) {
			// A request left pending under old settings must be eligible for
			// declining after the user changes the filters or the decline toggle.
			processed.clear();
			state.processedIds = [];
			state.acceptFilterKey = key;
			const filters = filterSummary(settings);
			log('info', filters.length
				? `${settings.declineFilteredRequests ? 'Declining' : 'Leaving pending'} ${filters.join(', and ')}.`
				: 'No request filters enabled; accepting all incoming requests.');
			await commit();
		}
	};
	await syncFilters();

	let lastCode = null;
	let sameCodeRun = 0;
	/** Set after repeated terminal errors to unwind both loops. */
	let paused = false;
	let acceptedTotal = 0;
	let declinedTotal = 0;

	const settled = () => state.done + state.declined + state.skipped + state.failed;

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

	if (pending === 0) return { accepted: 0, declined: 0, paused: false, stuck: 0 };

	for (let pass = 1; pass <= MAX_PASSES && !paused; pass++) {
		if (signal.aborted) throw new AbortError();

		let accepted = 0;
		let declined = 0;
		let seenThisPass = 0;
		let cursor = '';
		let pages = 0;
		const seenCursors = new Set();

		// One full walk of the request list. Ids already attempted are skipped, so a
		// request that can never be accepted costs one page read, not the whole job.
		do {
			if (signal.aborted) throw new AbortError();
			await syncFilters();

			const page = await api.getIncomingRequests(cursor, signal);
			const items = page?.data || [];
			seenThisPass += items.length;

			for (const user of items) {
				if (signal.aborted) throw new AbortError();
				const id = requesterId(user);
				if (!id || processed.has(id)) continue;

				// Any confirmed match is enough to skip/decline. Fetch missing
				// details only when needed, and act before looking up the next user.
				let details;
				const needsDetails = !skipReason(user, null, settings) && (
					(settings.skipNewAccounts && createdMs(user) == null) ||
					(settings.skipSameDisplayName && (!user.name || !user.displayName))
				);
				if (needsDetails) {
					try {
						details = (await api.getUsersById([id], signal)).get(id);
					} catch (err) {
						if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
						log('warn', `Could not look up requester ${id}: ${err.message}`);
					}
				}
				const label = details?.name || user.name || `User ${id}`;

				const reason = skipReason(user, details, settings);
				const missingAge =
					settings.skipNewAccounts && createdMs(details) == null && createdMs(user) == null;
				const missingNames =
					settings.skipSameDisplayName &&
					(!(details?.name || user.name) || !(details?.displayName || user.displayName));
				if ((reason && !settings.declineFilteredRequests) || (!reason && (missingAge || missingNames))) {
					state.skipped++;
					remember(id);
					log(
						reason ? 'info' : 'warn',
						reason
							? `Left pending ${label}: ${reason}`
							: `Left pending ${label}: missing account details for enabled filters.`
					);
					if (state.total < settled()) state.total = settled();
					await commit();
					continue;
				}

				const declining = Boolean(reason && settings.declineFilteredRequests);
				try {
					if (declining) {
						await api.declineFriendRequest(id, signal);
						state.declined++;
						declined++;
						declinedTotal++;
						log('info', `Declined ${label}: ${reason}`);
					} else {
						await api.acceptFriendRequest(id, signal);
						state.done++;
						accepted++;
						acceptedTotal++;
						log('info', `Accepted ${label}`);
					}
					sameCodeRun = 0;
					lastCode = null;
				} catch (err) {
					if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;

					// A listed request can disappear before we act on it. This is
					// an item to skip, not evidence that subsequent actions will fail.
					if (err.kind === 'terminal' &&
						(Number(err.code) === 10 || /\bthe friend request does not exist\b/i.test(err.message))) {
						state.skipped++;
						sameCodeRun = 0;
						lastCode = null;
						log('info', `Skipped ${label}: the friend request does not exist; continuing.`);
					} else if (err.kind === 'terminal') {
						if (declining) state.failed++;
						else state.skipped++;
						log(
							'warn',
							`Could not ${declining ? 'decline' : 'accept'} ${label}: ${err.message}` +
								`${err.code != null ? ` (code ${err.code})` : ''}`
						);

						// Do not grind through identical failures. Keep decline errors
						// separate from accept errors (which can mean the friend cap).
						const codeKey = err.code == null ? null : `${declining}:${err.code}`;
						if (codeKey != null && codeKey === lastCode) sameCodeRun++;
						else {
							lastCode = codeKey;
							sameCodeRun = 1;
						}
						if (sameCodeRun >= SAME_ERROR_LIMIT) {
							state.status = STATUS.PAUSED;
							state.message =
								`Paused: ${SAME_ERROR_LIMIT} ${declining ? 'declines' : 'accepts'} in a row failed the same way ` +
								`(code ${err.code}: ${err.message}).` +
								(declining ? ' Check the activity log before restarting.' :
									` If you're at Roblox's friend limit, run Unfriend first.`);
							paused = true;
						}
					} else {
						state.failed++;
						log('error', `Failed to ${declining ? 'decline' : 'accept'} ${label}: ${err.message}`);
					}
				}

				remember(id);
				if (state.total < settled()) state.total = settled();
				await commit();
				if (paused) break;
			}

			if (paused) return { accepted: acceptedTotal, declined: declinedTotal, paused: true, stuck: 0 };

			cursor = page?.nextPageCursor || page?.NextCursor || '';
			if (cursor && seenCursors.has(cursor)) {
				console.warn('[RFM] friend requests repeated a cursor - ending this pass.');
				break;
			}
			seenCursors.add(cursor);
		} while (cursor && ++pages < MAX_PAGES_PER_PASS);

		if (seenThisPass === 0) return { accepted: acceptedTotal, declined: declinedTotal, paused: false, stuck: 0 };

		// Accepting or declining shifts the list under the cursor. One clean walk
		// isn't proof the list is empty; the count settles it.
		let left = null;
		try {
			left = await api.getPendingRequestCount(signal);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			log('warn', `Could not verify the remaining request count: ${err.message}`);
		}

		if (left === 0) return { accepted: acceptedTotal, declined: declinedTotal, paused: false, stuck: 0 };

		if (accepted + declined === 0) {
			// A pass with nothing accepted or declined means the remaining requests
			// have already been handled. Repeating the walk would change nothing.
			const stuck = left == null ? seenThisPass : left;
			// In watch mode the caller says this once per idle streak instead - the
			// same warning every 30s would bury the accepts the log is there for.
			if (!watch) {
				log(
					'warn',
					state.skipped
						? `Stopping: ${stuck} request(s) remain that were skipped or could not be processed.`
						: `Stopping: ${stuck} request(s) remain that could not be processed.`
				);
			}
			return { accepted: acceptedTotal, declined: declinedTotal, paused: false, stuck };
		}

		if (left != null) {
			state.total = settled() + left;
			await commit();
			log('info', `Pass ${pass} accepted ${accepted}, declined ${declined}; ${left} still pending.`);
		}
	}

	if (!paused && !watch) {
		log('warn', `Stopped after ${MAX_PASSES} passes. Run Accept again to continue.`);
	}
	if (signal.aborted) throw new AbortError();
	return { accepted: acceptedTotal, declined: declinedTotal, paused: false, stuck: 0 };
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
	const { state, signal, log, commit } = ctx;
	Object.assign(state, normalizeJobState(state));
	const processed = new Set(state.processedIds || []);

	if (!watch) {
		const round = await acceptQueued(ctx, processed, { watch: false });
		if (!round.paused && !round.accepted && !round.declined && !round.stuck) log('info', 'No friend requests to process.');
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

		if (round.accepted + round.declined > 0) {
			idle = WATCH_MIN_MS;
			announcedIdle = false;
		} else {
			// Said once on the way into an idle streak, not on every poll.
			if (!announcedIdle) {
				log(
					'info',
					round.stuck
						? `Nothing new. ${round.stuck} request(s) remain pending; still watching.`
						: 'No friend requests waiting; still watching.'
				);
				announcedIdle = true;
			}
			idle = Math.min(idle * 2, WATCH_MAX_MS);
		}

		await idleFor(ctx, idle);
	}
}
