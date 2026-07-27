// The popup is a pure view. It renders whatever the service worker says the
// state is and sends START / STOP - it never holds job state of its own,
// because popups get torn down the moment they lose focus.

import { MSG, JOB, STATUS, ACTIVE_STATUSES } from '../shared/messages.js';
import { initTheme, themeSwitchHtml } from '../shared/theme.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 700;

const el = {
	who: $('who'),
	actions: $('actions'),
	accept: $('btn-accept'),
	unfriend: $('btn-unfriend'),
	keepNote: $('keep-note'),
	confirm: $('confirm'),
	confirmText: $('confirm-text'),
	confirmYes: $('btn-confirm'),
	confirmNo: $('btn-cancel'),
	progress: $('progress'),
	barFill: $('bar-fill'),
	progressText: $('progress-text'),
	pace: $('pace'),
	backoff: $('backoff'),
	stop: $('btn-stop'),
	message: $('message'),
	log: $('log'),
};

function send(message) {
	return chrome.runtime.sendMessage(message);
}

// -- rendering ---------------------------------------------------------------

function render({ state, log, keepList }) {
	const active = ACTIVE_STATUSES.includes(state.status);
	const awaiting = state.status === STATUS.AWAITING_CONFIRM;
	// The accept button is a toggle, so while its own job is running it stays
	// enabled and turns into the off switch. Any *other* active job disables it.
	const accepting = active && state.jobType === JOB.ACCEPT;

	el.keepNote.textContent = keepList.length ? `(keeping ${keepList.length})` : '(keeping none)';
	el.accept.textContent = accepting
		? 'Stop accepting friend requests'
		: 'Start accepting friend requests';
	el.accept.classList.toggle('btn-primary', !accepting);
	el.accept.classList.toggle('btn-ghost', accepting);
	el.accept.classList.toggle('is-watching', accepting);
	el.accept.disabled = (active && !accepting) || awaiting;
	el.unfriend.disabled = active || awaiting;

	el.confirm.classList.toggle('hidden', !awaiting);
	if (awaiting) {
		el.confirmText.textContent =
			`This will remove ${state.total} friend${state.total === 1 ? '' : 's'} ` +
			`and keep ${state.keptCount}. This cannot be undone.`;
	}

	el.progress.classList.toggle('hidden', !active);
	if (active) {
		const attempted = state.done + state.skipped + state.failed;

		const counts = [`${state.done} done`];
		if (state.skipped) counts.push(`${state.skipped} skipped`);
		if (state.failed) counts.push(`${state.failed} failed`);

		// Accepting has stood aside for something else. The bar follows that instead:
		// the accept totals are frozen for the duration, so tracking them would show a
		// stalled bar during the one part of the run that is actually moving.
		const yielded = state.pausedFor === JOB.AUTO_TRIM;
		const sub = state.subProgress;
		// While the watch loop is idling there is no work in flight to measure, so
		// the bar would just sit at whatever it reached. Say what it's actually doing.
		const untilCheck = state.nextCheckAt ? state.nextCheckAt - Date.now() : 0;

		const pct = yielded
			? sub?.total > 0
				? Math.min(100, (sub.done / sub.total) * 100)
				: 0
			: state.total > 0
				? Math.min(100, (attempted / state.total) * 100)
				: 0;
		el.barFill.style.width = `${pct}%`;

		if (yielded) {
			const detail = sub?.total
				? `${sub.done} / ${sub.total} removed`
				: state.message || 'starting';
			el.progressText.textContent = `Accepting paused · auto-trim: ${detail}`;
		} else if (state.status === STATUS.SCANNING) {
			el.progressText.textContent = 'Reading your friends list...';
		} else if (untilCheck > 0) {
			el.progressText.textContent =
				`Watching - next check in ${Math.ceil(untilCheck / 1000)}s  ·  ${counts.join(', ')}`;
		} else {
			el.progressText.textContent =
				`${attempted} / ${state.total || '?'}  ·  ${counts.join(', ')}`;
		}
		el.barFill.classList.toggle('idle', !yielded && untilCheck > 0);
		el.progressText.classList.toggle('is-yielded', yielded);

		el.pace.textContent = `1 request per ${(state.currentDelayMs / 1000).toFixed(1)}s` +
			(state.rateLimitHits ? `  ·  ${state.rateLimitHits} rate-limit pause(s)` : '');

		const remaining = state.backoffUntil ? state.backoffUntil - Date.now() : 0;
		el.backoff.classList.toggle('hidden', remaining <= 0);
		if (remaining > 0) {
			el.backoff.textContent = `Rate limited - resuming in ${Math.ceil(remaining / 1000)}s`;
		}
	}

	const showMessage = !!state.message && !active && !awaiting;
	el.message.classList.toggle('hidden', !showMessage);
	el.message.classList.toggle('is-error', state.status === STATUS.ERROR);
	el.message.classList.toggle('is-done', state.status === STATUS.DONE);
	if (showMessage) el.message.textContent = state.message;

	renderLog(log);
}

let lastLogSignature = null;
function renderLog(entries) {
	// Cheap change-detection so we don't rebuild the list (and fight the user's
	// scroll position) on every poll.
	const signature = `${entries.length}:${entries[entries.length - 1]?.t ?? 0}`;
	if (signature === lastLogSignature) return;
	lastLogSignature = signature;

	el.log.replaceChildren(
		...entries.slice(-60).map((entry) => {
			const line = document.createElement('div');
			if (entry.level === 'warn') line.className = 'warn-line';
			if (entry.level === 'error') line.className = 'error-line';
			const time = new Date(entry.t).toLocaleTimeString([], {
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
			});
			line.textContent = `${time}  ${entry.message}`;
			return line;
		})
	);
	el.log.scrollTop = el.log.scrollHeight;
}

async function refresh() {
	try {
		const snapshot = await send({ type: MSG.GET_STATE });
		if (snapshot?.state) render(snapshot);
	} catch {
		/* worker restarting; the next poll will catch up */
	}
}

async function showWho() {
	try {
		// WHOAMI goes through the same paced queue as the job, so during a run (or a
		// long 429 backoff) it would sit behind everything else. Skip it and say so.
		const snapshot = await send({ type: MSG.GET_STATE });
		if (ACTIVE_STATUSES.includes(snapshot?.state?.status)) {
			el.who.textContent = snapshot.transport || 'busy';
			return;
		}
		const res = await send({ type: MSG.WHOAMI });
		if (res?.error) throw new Error(res.error);
		el.who.textContent = res.user?.name ? `${res.user.name} · ${res.transport}` : 'not signed in';
	} catch {
		el.who.textContent = 'not signed in to Roblox';
	}
}

// -- wiring ------------------------------------------------------------------

el.accept.addEventListener('click', async () => {
	// Read the state rather than trusting the label: the popup polls, so the job
	// could have paused itself between the last render and this click.
	const snapshot = await send({ type: MSG.GET_STATE });
	const accepting =
		ACTIVE_STATUSES.includes(snapshot?.state?.status) && snapshot.state.jobType === JOB.ACCEPT;

	await send(accepting ? { type: MSG.STOP_JOB } : { type: MSG.START_JOB, jobType: JOB.ACCEPT, watch: true });
	refresh();
});

el.unfriend.addEventListener('click', async () => {
	await send({ type: MSG.START_JOB, jobType: JOB.UNFRIEND, confirmed: false });
	refresh();
});

el.confirmYes.addEventListener('click', async () => {
	await send({ type: MSG.START_JOB, jobType: JOB.UNFRIEND, confirmed: true });
	refresh();
});

el.confirmNo.addEventListener('click', async () => {
	await send({ type: MSG.RESET_STATE });
	refresh();
});

el.stop.addEventListener('click', async () => {
	await send({ type: MSG.STOP_JOB });
	refresh();
});

$('open-options').addEventListener('click', (e) => {
	e.preventDefault();
	chrome.runtime.openOptionsPage();
});

$('btn-reset').addEventListener('click', async (e) => {
	e.preventDefault();
	await send({ type: MSG.RESET_STATE });
	refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
	if (msg?.type === MSG.STATE_CHANGED) refresh();
});

// Theme first, so there's no flash of the wrong palette before the data loads.
$('theme-slot').innerHTML = themeSwitchHtml();
initTheme();

refresh();
showWho();
setInterval(refresh, POLL_MS);
