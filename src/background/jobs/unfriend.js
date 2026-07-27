// Bulk-unfriend, minus a keep-list.
//
// Split into scan + drain so the popup can show a real "remove N, keep M" count
// and get an explicit confirmation before anything destructive happens.
//
// The old script re-fetched page 1 with a permanently empty cursor and only
// worked because the previous batch happened to delete those rows. With a
// keep-list that breaks outright: protected friends sit on page 1 forever and
// the loop never terminates. So: snapshot the whole list first, then work a
// fixed queue.

import { STATUS } from '../../shared/messages.js';
import { AbortError, isAbort } from '../errors.js';

/** Builds state.queue. Does not remove anyone. */
export async function scanUnfriendTargets(ctx) {
	const { api, state, keepList, signal, log, commit } = ctx;

	state.status = STATUS.SCANNING;
	state.message = 'Reading your friends list...';
	await commit();

	const me = await api.getAuthenticatedUser(signal);
	if (!me?.id) throw new Error('Could not determine your Roblox user id.');

	const friends = await api.getAllFriends(me.id, signal);
	const keep = new Set(keepList.map((k) => Number(k.id)));

	const targets = friends.filter((f) => !keep.has(Number(f.id)));
	const kept = friends.length - targets.length;

	state.queue = targets;
	state.total = targets.length;
	state.keptCount = kept;
	state.done = 0;
	state.skipped = 0;
	state.failed = 0;
	state.status = STATUS.AWAITING_CONFIRM;
	state.message = `Remove ${targets.length}, keep ${kept}.`;
	await commit();

	log('info', `Scan complete: ${friends.length} friends, ${targets.length} to remove, ${kept} kept.`);
	return state;
}

/** Works through state.queue. Resumable: the queue is checkpointed after every item. */
export async function drainUnfriendQueue(ctx) {
	const { api, state, signal, log, commit } = ctx;

	while (state.queue && state.queue.length > 0) {
		if (signal.aborted) throw new AbortError();

		const target = state.queue[0];
		const label = target.name || `User ${target.id}`;

		try {
			await api.unfriend(target.id, signal);
			state.done++;
			log('info', `Removed ${label}`);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			if (err.kind === 'terminal') {
				state.skipped++;
				log('warn', `Skipped ${label}: ${err.message}`);
			} else {
				state.failed++;
				log('error', `Failed ${label}: ${err.message}`);
			}
		}

		// Drop the item only after it has been resolved one way or the other, so a
		// service-worker eviction mid-request costs at most one duplicate call.
		state.queue = state.queue.slice(1);
		await commit();
	}

	if (signal.aborted) throw new AbortError();
}
