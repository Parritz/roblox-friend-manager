// Bulk-accept incoming friend requests.
//
// Replaces legacy/friends.js, which clicked ".accept-friend btn-cta-md
// btn-min-width" buttons on a 2s interval - coupled to Roblox's CSS, iterating a
// live HTMLCollection while mutating it, and impossible to stop.

import { STATUS } from '../../shared/messages.js';
import { AbortError, isAbort } from '../errors.js';

// Accepting mutates the list, so page 1 refills. Stop once it stops refilling.
const MAX_BARREN_ROUNDS = 3;
// Identical terminal errors in a row that mean "stop, this won't get better".
const SAME_ERROR_LIMIT = 5;

export async function runAcceptJob(ctx) {
	const { api, state, signal, log, commit } = ctx;

	const processed = new Set(state.processedIds || []);
	let barrenRounds = 0;
	let lastCode = null;
	let sameCodeRun = 0;

	// Best-effort total for the progress bar; the count endpoint is not critical.
	try {
		const pending = await api.getPendingRequestCount(signal);
		if (pending > 0) {
			state.total = state.done + state.skipped + state.failed + pending;
			await commit();
		}
	} catch (err) {
		if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
	}

	while (!signal.aborted) {
		const page = await api.getIncomingRequests('', signal);
		const items = page?.data || [];

		if (items.length === 0) {
			log('info', 'No friend requests left.');
			break;
		}

		const fresh = items.filter((u) => !processed.has(u.id));
		if (fresh.length === 0) {
			// Everything on page 1 has already been tried and refused to go away.
			if (++barrenRounds >= MAX_BARREN_ROUNDS) {
				log(
					'warn',
					`Stopping: ${items.length} request(s) remain that could not be accepted.`
				);
				break;
			}
			continue; // the limiter paces this, so it can't spin hot
		}
		barrenRounds = 0;

		for (const user of fresh) {
			if (signal.aborted) throw new AbortError();

			processed.add(user.id);
			state.processedIds = [...processed];
			const label = user.name || `User ${user.id}`;

			try {
				await api.acceptFriendRequest(user.id, signal);
				state.done++;
				sameCodeRun = 0;
				lastCode = null;
				log('info', `Accepted ${label}`);
			} catch (err) {
				if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;

				if (err.kind === 'terminal') {
					state.skipped++;
					log('warn', `Skipped ${label}: ${err.message}${err.code != null ? ` (code ${err.code})` : ''}`);

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
						return;
					}
				} else {
					state.failed++;
					log('error', `Failed ${label}: ${err.message}`);
				}
			}

			if (state.total < state.done + state.skipped + state.failed) {
				state.total = state.done + state.skipped + state.failed;
			}
			await commit();
		}
	}

	if (signal.aborted) throw new AbortError();
}
