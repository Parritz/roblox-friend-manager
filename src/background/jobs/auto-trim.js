// Auto-trim: keep the friend count under a ceiling without being asked.
//
// When Roblox reports at least `autoTrimThreshold` friends, remove
// `autoTrimCount` of them, oldest first, skipping the keep-list. Off by default,
// and every run re-checks the threshold immediately before removing anything.

import { STATUS } from '../../shared/messages.js';
import { AbortError, isAbort } from '../errors.js';
import { drainQueue } from './unfriend.js';

/**
 * Decides whether a trim is due, and by how much.
 * @returns {{due:boolean, count:number|null, reason:string}}
 */
export function trimPlan(friendCount, { autoTrimEnabled, autoTrimThreshold, autoTrimCount }) {
	if (!autoTrimEnabled) return { due: false, count: null, reason: 'auto-trim is off' };
	if (!Number.isFinite(friendCount)) {
		return { due: false, count: null, reason: 'friend count unavailable' };
	}
	if (friendCount < autoTrimThreshold) {
		return {
			due: false,
			count: friendCount,
			reason: `${friendCount} friends is under the ${autoTrimThreshold} threshold`,
		};
	}
	return {
		due: true,
		count: friendCount,
		reason: `${friendCount} friends is at or over the ${autoTrimThreshold} threshold`,
	};
}

/**
 * Oldest-known first. Anyone with no recorded sighting has only just appeared, so
 * they sort *last* - never trim someone purely because we have no history on them.
 */
export function orderByAge(friends, cache) {
	const now = Date.now();
	return friends
		.map((friend, index) => ({
			friend,
			// Position in the list Roblox returned, as the tiebreaker.
			index,
			seenAt: cache?.seenAt(friend.id) ?? now,
		}))
		.sort((a, b) => a.seenAt - b.seenAt || a.index - b.index)
		.map((entry) => entry.friend);
}

export async function runAutoTrimJob(ctx) {
	const { api, state, keepList, settings, cache, signal, log, commit } = ctx;

	state.status = STATUS.SCANNING;
	state.message = 'Checking your friend count...';
	await commit();

	const me = await api.getAuthenticatedUser(signal);
	if (!me?.id) throw new Error('Could not determine your Roblox user id.');
	state.userId = me.id;

	const before = await api.getFriendCount(me.id, signal);
	const plan = trimPlan(before, settings);
	if (!plan.due) {
		state.status = STATUS.DONE;
		state.message = `Nothing to trim: ${plan.reason}.`;
		await commit();
		log('info', state.message);
		return;
	}

	log('info', `Auto-trim: ${plan.reason}. Removing up to ${settings.autoTrimCount}.`);
	state.message = 'Reading your friends list...';
	await commit();

	const { friends } = await api.getFriendsSnapshot(me.id, signal, (_, total) => {
		if (total != null) {
			state.message = `Reading your friends list (${total} friends)...`;
			Promise.resolve(commit()).catch(() => {});
		}
	});

	const keep = new Set(keepList.map((k) => Number(k.id)));
	const eligible = friends.filter((f) => !keep.has(Number(f.id)));
	const targets = orderByAge(eligible, cache).slice(0, settings.autoTrimCount);

	if (!targets.length) {
		state.status = STATUS.DONE;
		state.message = `Nothing to trim: all ${friends.length} listed friends are on the keep-list.`;
		await commit();
		log('warn', state.message);
		return;
	}

	// The list walk takes a while, and an accept job may have run during it. Re-check
	// rather than trusting a count that is now minutes old - this is the last gate
	// before anything is removed.
	const nowCount = await api.getFriendCount(me.id, signal);
	if (!trimPlan(nowCount, settings).due) {
		state.status = STATUS.DONE;
		state.message = `Trim cancelled: down to ${nowCount} friends already.`;
		await commit();
		log('info', state.message);
		return;
	}

	if (targets.some((t) => !t.name)) {
		state.message = 'Looking up usernames...';
		await commit();
		await api.fillMissingNames(targets, signal);
	}

	state.queue = targets;
	state.total = targets.length;
	state.keptCount = friends.length - eligible.length;
	state.done = 0;
	state.skipped = 0;
	state.failed = 0;
	state.status = STATUS.RUNNING;
	state.message = `Auto-trim: removing ${targets.length} of ${nowCount}.`;
	await commit();

	const oldest = cache?.seenAt(targets[0]?.id);
	log(
		'info',
		`Auto-trim removing ${targets.length} friend(s), oldest first` +
			(oldest ? ` (first seen ${new Date(oldest).toISOString().slice(0, 10)})` : '') +
			`. ${state.keptCount} on the keep-list are excluded.`
	);

	await drainQueue(ctx);
	if (signal.aborted) throw new AbortError();

	let after = null;
	try {
		after = await api.getFriendCount(me.id, signal);
	} catch (err) {
		if (isAbort(err) || err.kind === 'auth' || err.kind === 'notab') throw err;
	}
	log(
		'info',
		`Auto-trim done: removed ${state.done}` +
			(after != null ? `, now at ${after} friends` : '') +
			(state.skipped ? `, ${state.skipped} skipped` : '') +
			(state.failed ? `, ${state.failed} failed` : '') +
			'.'
	);
}
