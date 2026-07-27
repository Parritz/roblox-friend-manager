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

	el.keepNote.textContent = keepList.length ? `(keeping ${keepList.length})` : '(keeping none)';
	el.accept.disabled = active || awaiting;
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
		const pct = state.total > 0 ? Math.min(100, (attempted / state.total) * 100) : 0;
		el.barFill.style.width = `${pct}%`;

		const counts = [`${state.done} done`];
		if (state.skipped) counts.push(`${state.skipped} skipped`);
		if (state.failed) counts.push(`${state.failed} failed`);
		el.progressText.textContent =
			state.status === STATUS.SCANNING
				? 'Reading your friends list...'
				: `${attempted} / ${state.total || '?'}  ·  ${counts.join(', ')}`;

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
	await send({ type: MSG.START_JOB, jobType: JOB.ACCEPT });
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
