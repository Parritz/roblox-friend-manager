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
//
// One snapshot still isn't always the whole story - a 1000-friend walk is 20+
// paged requests, and a page can be missed if the list shifts underneath it. So
// after the queue drains, /friends/count is the authority on whether anything is
// left: if Roblox still reports more friends than the keep-list holds, the job
// scans again and drains again rather than reporting a false "done".

import { STATUS } from '../../shared/messages.js';
import { AbortError, isAbort } from '../errors.js';

// Scan+drain passes before giving up. Each pass must remove at least one person
// to earn another, so this only caps genuinely pathological cases.
const MAX_ROUNDS = 5;

const keepSet = (keepList) => new Set(keepList.map((k) => Number(k.id)));

/**
 * Reads the friends list and works out who is in scope for removal.
 * @returns {Promise<{targets:Array, kept:number, expected:number|null, complete:boolean|null}>}
 */
async function collectTargets(ctx, userId) {
	const { api, state, keepList, signal, log, commit } = ctx;

	const snapshot = await api.getFriendsSnapshot(userId, signal, (_, total) => {
		if (total != null) {
			state.message = `Reading your friends list (${total} friends)...`;
			// Progress only - not worth awaiting inside the walk, but a rejected write
			// must not surface as an unhandled rejection either.
			Promise.resolve(commit()).catch(() => {});
		}
	});
	const { friends, expected, complete, unlistable = 0, duplicates = 0 } = snapshot;

	if (complete === false) {
		// Not fatal, and often not fixable: Roblox counts friendships with deleted and
		// moderated accounts that neither list endpoint returns. Duplicate rows during
		// the walk are the tell that the list actually moved and a retry might help.
		log(
			'warn',
			`Roblox reports ${expected} friends, ${friends.length} could be listed` +
				` (${unlistable} short).` +
				(duplicates
					? ' The list shifted while being read, so another pass may find more.'
					: ' Most likely deleted or moderated accounts that cannot be listed at all.')
		);
	}

	const keep = keepSet(keepList);
	const targets = friends.filter((f) => !keep.has(Number(f.id)));

	// Past 200 friends the list comes from /friends/find, which returns ids with
	// no names. Fill them in before queueing so the log reads "Removed Someone"
	// rather than "Removed User 293778114". Only the targets need names, so this
	// skips anyone on the keep-list. Best-effort: a failure here costs labels, not
	// the run.
	if (targets.some((t) => !t.name)) {
		state.message = 'Looking up usernames...';
		await commit();
		await api.fillMissingNames(targets, signal);
	}

	return { targets, kept: friends.length - targets.length, expected, complete };
}

/** Builds state.queue. Does not remove anyone. */
export async function scanUnfriendTargets(ctx) {
	const { api, state, signal, log, commit } = ctx;

	state.status = STATUS.SCANNING;
	state.message = 'Reading your friends list...';
	await commit();

	const me = await api.getAuthenticatedUser(signal);
	if (!me?.id) throw new Error('Could not determine your Roblox user id.');
	state.userId = me.id;

	const { targets, kept } = await collectTargets(ctx, me.id);

	state.queue = targets;
	state.total = targets.length;
	state.keptCount = kept;
	state.done = 0;
	state.skipped = 0;
	state.failed = 0;
	state.status = STATUS.AWAITING_CONFIRM;
	state.message = `Remove ${targets.length}, keep ${kept}.`;
	await commit();

	log(
		'info',
		`Scan complete: ${targets.length + kept} friends, ${targets.length} to remove, ${kept} kept.`
	);
	return state;
}

/**
 * Removes everyone in state.queue. Checkpointed after every item.
 * Exported because auto-trim builds its own queue and drains it the same way.
 */
export async function drainQueue(ctx) {
	const { api, state, signal, log, commit } = ctx;
	let removed = 0;

	while (state.queue && state.queue.length > 0) {
		if (signal.aborted) throw new AbortError();

		const target = state.queue[0];
		const label = target.name || `User ${target.id}`;

		try {
			await api.unfriend(target.id, signal);
			state.done++;
			removed++;
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

	return removed;
}

/**
 * Works through state.queue, then keeps scanning and draining while Roblox still
 * reports more friends than the keep-list accounts for.
 */
export async function drainUnfriendQueue(ctx) {
	const { api, state, keepList, signal, log, commit } = ctx;

	const attempted = state.queue?.length || 0;
	const removedFirst = await drainQueue(ctx);
	if (signal.aborted) throw new AbortError();

	// Everything in the first queue failed or was skipped. A re-scan would return
	// the same people and fail the same way, so don't spend the requests finding out.
	if (attempted > 0 && removedFirst === 0) {
		log('warn', `Nothing could be removed (${state.skipped} skipped, ${state.failed} failed).`);
		return;
	}

	// The scan stored this; recover it if the service worker was evicted since.
	let userId = state.userId;
	if (!userId) {
		const me = await api.getAuthenticatedUser(signal);
		userId = me?.id;
		state.userId = userId;
	}
	if (!userId) return;

	const keptTotal = keepSet(keepList).size;

	for (let round = 2; round <= MAX_ROUNDS; round++) {
		if (signal.aborted) throw new AbortError();

		// The count is the authority on "is anything left?", and it costs one request
		// - far cheaper than a speculative 20-page re-walk that finds nothing.
		let remaining;
		try {
			remaining = await api.getFriendCount(userId, signal);
		} catch (err) {
			if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
			log('warn', `Could not verify the remaining friend count: ${err.message}`);
			return;
		}
		if (remaining == null) return;

		// Everyone left is accounted for by the keep-list, so the job really is done.
		// (`<=` rather than `===`: someone on the keep-list may have removed *you*.)
		if (remaining <= keptTotal) {
			log('info', `Verified: ${remaining} friend(s) left, all on the keep-list.`);
			return;
		}

		log(
			'info',
			`Roblox still reports ${remaining} friends against a ${keptTotal}-person keep-list -` +
				` starting pass ${round}.`
		);
		state.status = STATUS.SCANNING;
		state.message = `Re-checking your friends list (pass ${round})...`;
		await commit();

		const { targets, kept } = await collectTargets(ctx, userId);
		if (!targets.length) {
			// The count says friends remain, but none of them can be listed - so none of
			// them can be unfriended either. Nothing more to try.
			log(
				'warn',
				`Pass ${round} found nobody left to remove. Roblox counts ${remaining} friends but` +
					` will only list ${kept}; the difference cannot be removed through the API.`
			);
			return;
		}

		state.queue = targets;
		state.keptCount = kept;
		state.total = state.done + state.skipped + state.failed + targets.length;
		state.status = STATUS.RUNNING;
		state.message = `Pass ${round}: removing ${targets.length} more.`;
		await commit();

		const removed = await drainQueue(ctx);
		if (signal.aborted) throw new AbortError();
		// No progress means the remainder can't be removed - every one of them failed
		// or was skipped. Another identical pass would just repeat that.
		if (removed === 0) {
			log('warn', `Pass ${round} removed nobody; stopping rather than looping.`);
			return;
		}
	}

	log('warn', `Stopped after ${MAX_ROUNDS} passes. Run Unfriend again to continue.`);
}
