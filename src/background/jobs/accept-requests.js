// Bulk-accept incoming friend requests.

import { STATUS } from '../../shared/messages.js';
import { AbortError, isAbort, sleep } from '../errors.js';

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
	const { api, state, signal, log, commit } = ctx;

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

			for (const user of items) {
				if (signal.aborted) throw new AbortError();
				if (processed.has(user.id)) continue;

				remember(user.id);
				const label = user.name || `User ${user.id}`;

				try {
					await api.acceptFriendRequest(user.id, signal);
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
			if (!watch) log('warn', `Stopping: ${stuck} request(s) remain that could not be accepted.`);
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
	const { state, signal, log, commit } = ctx;
	const processed = new Set(state.processedIds || []);

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
