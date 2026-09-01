import { MSG } from '../shared/messages.js';
import { initTheme, themeSwitchHtml } from '../shared/theme.js';

const $ = (id) => document.getElementById(id);
/** Delay settings are stored as ms; the options UI edits them in seconds. */
const DELAY_FIELDS = ['baseDelayMs', 'floorDelayMs', 'ceilDelayMs', 'readDelayMs'];
/** Plain integer settings, stored exactly as typed. */
const COUNT_FIELDS = ['maxRetries', 'autoTrimThreshold', 'autoTrimCount', 'minAccountAgeDays'];
const SAVE_DEBOUNCE_MS = 400;

/**
 * One list, one meaning: every current friend plus everyone already on the
 * keep-list, each a row whose tick means "never unfriend this person".
 *
 * people: [{ id, name, displayName, avatarUrl, resolved, isFriend }]
 */
let people = [];
/** Ids currently ticked. The keep-list is exactly this set. */
let protectedIds = new Set();
/** Avatar URLs aren't persisted (they go stale), so cache them per page view. */
const avatarCache = new Map();

let saveTimer = null;
let friendsLoaded = false;
/** Guards against overlapping loads from the refresh button and the Retry link. */
let loadingFriends = false;
/** Roblox's friend total for the load in flight, once known. */
let expectedFriends = null;
/** Coalesces the many small renders a streaming load would otherwise trigger. */
let renderQueued = false;

function send(message) {
	return chrome.runtime.sendMessage(message);
}

function flash(el, text, ms = 2500) {
	el.textContent = text;
	setTimeout(() => {
		if (el.textContent === text) el.textContent = '';
	}, ms);
}

function cacheAvatars(cards) {
	for (const card of cards) {
		if (card.avatarUrl) avatarCache.set(card.id, card.avatarUrl);
	}
}

// -- rendering -----------------------------------------------------------------

function personRow(person) {
	// A <label> wrapper means the whole row toggles, not just the 16px box.
	const row = document.createElement('label');
	row.className = 'user-row';
	// `pending` means the id is known and the name is still on its way, which is
	// not the same as a lookup that failed - don't mark it as a problem.
	if (!person.resolved && !person.pending) row.classList.add('is-unresolved');

	const box = document.createElement('input');
	box.type = 'checkbox';
	box.className = 'check';
	box.checked = protectedIds.has(person.id);
	box.addEventListener('change', () => {
		if (box.checked) protectedIds.add(person.id);
		else protectedIds.delete(person.id);
		updateCount();
		queueSave();
	});
	row.appendChild(box);

	const avatar = document.createElement('img');
	avatar.className = 'avatar';
	avatar.alt = '';
	avatar.loading = 'lazy';
	// alt="" means a failed load renders nothing, leaving the placeholder behind it.
	const src = person.avatarUrl || avatarCache.get(person.id);
	if (src) avatar.src = src;
	row.appendChild(avatar);

	const text = document.createElement('span');
	text.className = 'user-text';

	const display = document.createElement('span');
	display.className = 'user-display';
	if (person.resolved) display.textContent = person.displayName || person.name;
	else display.textContent = person.pending ? `User ${person.id}` : `Unknown user ${person.id}`;

	const sub = document.createElement('span');
	sub.className = 'user-sub';
	if (person.resolved) {
		sub.append(`@${person.name}`, ' · ');
	} else {
		sub.append(person.pending ? 'looking up name...' : 'name unavailable', ' · ');
	}
	const id = document.createElement('span');
	id.className = 'user-id';
	id.textContent = person.id;
	sub.appendChild(id);

	text.append(display, sub);
	row.appendChild(text);

	if (friendsLoaded && !person.isFriend) {
		const tag = document.createElement('span');
		tag.className = 'tag';
		tag.textContent = 'not a friend';
		row.appendChild(tag);
	}

	return row;
}

function skeletonRow() {
	const row = document.createElement('div');
	row.className = 'skeleton-row';
	const box = document.createElement('span');
	box.className = 'skeleton skeleton-box';
	const avatar = document.createElement('span');
	avatar.className = 'skeleton skeleton-avatar';
	const text = document.createElement('span');
	text.className = 'user-text';
	const wide = document.createElement('span');
	wide.className = 'skeleton skeleton-line';
	wide.style.width = '140px';
	const narrow = document.createElement('span');
	narrow.className = 'skeleton skeleton-line';
	narrow.style.width = '90px';
	narrow.style.marginTop = '4px';
	text.append(wide, narrow);
	row.append(box, avatar, text);
	return row;
}

function render() {
	const list = $('people');
	list.replaceChildren();

	if (!friendsLoaded && !people.length) {
		for (let i = 0; i < 4; i++) list.appendChild(skeletonRow());
		return;
	}

	const query = $('filter').value.trim().toLowerCase();
	const visible = people.filter(
		(person) =>
			!query ||
			person.name.toLowerCase().includes(query) ||
			(person.displayName || '').toLowerCase().includes(query) ||
			String(person.id).includes(query)
	);

	if (!visible.length) {
		const empty = document.createElement('p');
		empty.className = 'empty sub';
		empty.textContent = people.length
			? 'Nobody matches that filter.'
			: 'No friends found. Add someone by username below.';
		list.appendChild(empty);
	}

	for (const person of visible) list.appendChild(personRow(person));
	updateCount();
}

function updateCount() {
	const friends = people.filter((p) => p.isFriend).length;
	$('keep-count').textContent = friendsLoaded
		? `${protectedIds.size} protected of ${friends} friends`
		: `${protectedIds.size} protected`;
}

function showNotice(text, { isError = false, retry = false, steps = [] } = {}) {
	const notice = $('notice');
	notice.replaceChildren();
	notice.classList.remove('hidden');
	notice.classList.toggle('is-error', isError);

	const body = document.createElement('div');
	body.className = 'notice-body';

	const span = document.createElement('span');
	span.textContent = text;
	body.appendChild(span);

	// Verbatim per-source results, so diagnosing a lookup failure doesn't require
	// opening devtools.
	for (const entry of steps) {
		const line = document.createElement('span');
		line.className = 'notice-step mono';
		line.dataset.ok = String(entry.ok);
		line.textContent = `${entry.ok ? 'ok' : 'fail'}  ${entry.source} - ${entry.detail}`;
		body.appendChild(line);
	}

	notice.appendChild(body);

	if (retry) {
		const button = document.createElement('button');
		button.className = 'btn-sm user-spacer';
		button.textContent = 'Retry';
		button.addEventListener('click', () => loadFriends());
		notice.appendChild(button);
	}
}

function hideNotice() {
	$('notice').classList.add('hidden');
}

// -- persistence ----------------------------------------------------------------

/**
 * Auto-save. The keep-list is exactly the ticked set, so it's rebuilt from
 * `people` rather than patched, which keeps names and ids in sync.
 */
function queueSave() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(async () => {
		const keepList = people
			.filter((person) => protectedIds.has(person.id))
			.map((person) => ({ id: person.id, name: person.name, displayName: person.displayName }));
		await send({ type: MSG.SAVE_KEEP_LIST, keepList });
		flash($('add-status'), 'Saved', 1600);
	}, SAVE_DEBOUNCE_MS);
}

function upsertPerson(person) {
	const existing = people.findIndex((p) => p.id === person.id);
	if (existing >= 0) people[existing] = { ...people[existing], ...person };
	else people.push(person);
}

function sortPeople() {
	people.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
}

// -- loading ----------------------------------------------------------------------

/** Batched re-render, so a 20-page stream doesn't rebuild the list 20 times. */
function queueRender() {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		sortPeople();
		render();
	});
}

/**
 * A partial result pushed mid-load by the service worker.
 *
 * 'list' carries ids (with names only for the first 200, which /friends gives
 * away free); 'details' carries names and avatars as the lookup batches land.
 */
function applyFriendsChunk({ stage, friends, expected }) {
	if (!loadingFriends || !Array.isArray(friends) || !friends.length) return;

	if (stage === 'list' && Number.isFinite(expected)) expectedFriends = expected;
	cacheAvatars(friends);

	for (const card of friends) {
		const named = Boolean(card.name) && card.resolved !== false;
		upsertPerson({
			...card,
			isFriend: true,
			resolved: card.resolved ?? named,
			// A row from the list stage with no name yet is waiting on a lookup, not
			// broken. The details stage clears this either way.
			pending: stage === 'list' ? !named : false,
		});
	}

	// Something real is on screen now, so stop showing skeletons.
	friendsLoaded = true;
	// One message for both stages. They interleave, so switching wording per stage
	// would just flicker between two lines every few seconds.
	const shown = people.filter((p) => p.isFriend).length;
	const waiting = people.filter((p) => p.isFriend && p.pending).length;
	showNotice(
		`Loading your friends list... ${shown}${expectedFriends ? ` of ${expectedFriends}` : ''}` +
			(waiting ? ` (${waiting} still resolving)` : '')
	);
	queueRender();
}

chrome.runtime.onMessage.addListener((msg) => {
	if (msg?.type === MSG.FRIENDS_CHUNK) applyFriendsChunk(msg);
});

/**
 * @param {{force?:boolean}} [opts] force skips the cached names and avatars and
 *        re-reads everything from Roblox. That is what the refresh button is for;
 *        opening the page, or retrying after an error, reuses the cache.
 */
async function loadFriends({ force = false } = {}) {
	if (loadingFriends) return;
	loadingFriends = true;
	expectedFriends = null;

	const refresh = $('btn-refresh');
	refresh.classList.add('is-spinning');
	refresh.disabled = true;

	friendsLoaded = false;
	render();
	// Rows stream in via FRIENDS_CHUNK as they're read, so this notice is only what
	// shows before the first page lands.
	showNotice('Loading your friends list...');

	try {
		const res = await send({ type: MSG.LIST_FRIENDS, refresh: force });
		if (res?.error) throw new Error(res.error);

		const friends = res.friends || [];
		cacheAvatars(friends);
		// The authoritative pass: clears `pending` on everyone, including the rows
		// whose lookups genuinely failed.
		for (const card of friends) upsertPerson({ ...card, isFriend: true, pending: false });

		// Reconcile, so a refresh reflects reality rather than only ever growing:
		// anyone no longer in the list loses the friend flag, and anyone who is
		// neither a friend nor protected drops off entirely.
		const friendIds = new Set(friends.map((card) => card.id));
		for (const person of people) person.isFriend = friendIds.has(person.id);
		people = people.filter((person) => person.isFriend || protectedIds.has(person.id));

		friendsLoaded = true;
		sortPeople();
		render();

		hideNotice();
		reportDiagnostics(res.diagnostics, friends.length, {
			expected: res.expected,
			complete: res.complete,
			unlistable: res.unlistable,
		});
	} catch (err) {
		friendsLoaded = true; // stop the skeletons; show what we do have
		// Whatever streamed in is all we're getting, so no row should still claim a
		// lookup is on its way.
		for (const person of people) person.pending = false;
		render();
		showNotice(`Could not load your friends list: ${err.message}`, {
			isError: true,
			retry: true,
		});
	} finally {
		loadingFriends = false;
		refresh.classList.remove('is-spinning');
		refresh.disabled = false;
	}
}

/** Enriches keep-list entries that aren't in the friends list. */
async function enrichStrays({ force = false } = {}) {
	const strays = people
		.filter((p) => !p.isFriend && (!p.resolved || !(p.avatarUrl || avatarCache.has(p.id))))
		.map((p) => p.id);
	if (!strays.length) return;
	try {
		const res = await send({ type: MSG.GET_USER_CARDS, userIds: strays, refresh: force });
		if (res?.error || !res?.cards) return;
		cacheAvatars(res.cards);
		for (const card of res.cards) upsertPerson({ ...card, isFriend: false });
		sortPeople();
		render();
	} catch {
		// Leave them as-is; the row already says the name is unavailable.
	}
}

function reportDiagnostics(diagnostics, total, { expected = null, complete = null, unlistable = 0 } = {}) {
	if (!diagnostics) return;
	const problems = [];
	const notes = [];

	// A gap between the friend count and the list is usually not a fault to fix.
	// Roblox counts friendships with deleted and moderated accounts but won't return
	// them from either list endpoint, so the shortfall is permanent - saying "only
	// 768 could be listed" in red on every load just trains you to ignore notices.
	if (complete === false && unlistable > 0) {
		notes.push(
			`${unlistable} of ${expected} friends can't be listed by Roblox` +
				' (usually deleted or moderated accounts). Everything else is here.'
		);
	}
	if (diagnostics.unresolved) {
		problems.push(`${diagnostics.unresolved} of ${total} names could not be loaded`);
	}
	if (!diagnostics.thumbsOk) problems.push('avatars are unavailable');

	if (problems.length) {
		showNotice(`${problems.join(' and ')}. Each lookup reported:`, {
			isError: true,
			retry: true,
			steps: diagnostics.steps || [],
		});
		return;
	}
	// Informational only: no error styling, and no Retry, because retrying can't help.
	if (notes.length) showNotice(notes.join(' '), { isError: false, retry: false });
}

// -- wiring -------------------------------------------------------------------------

$('filter').addEventListener('input', render);

$('btn-select-all').addEventListener('click', () => {
	protectedIds = new Set(people.map((p) => p.id));
	render();
	queueSave();
});

$('btn-select-none').addEventListener('click', () => {
	protectedIds.clear();
	render();
	queueSave();
});

$('btn-refresh').addEventListener('click', async () => {
	// The one place that deliberately ignores the cache: pressing refresh is how you
	// say "someone changed their username" or "this looks wrong".
	await loadFriends({ force: true });
	await enrichStrays({ force: true });
});

$('btn-add-username').addEventListener('click', async () => {
	const input = $('username-input');
	const name = input.value.trim();
	if (!name) return;

	flash($('add-status'), 'Looking up...', 20000);
	try {
		const res = await send({ type: MSG.RESOLVE_USERNAMES, usernames: [name] });
		if (res?.error) throw new Error(res.error);
		if (!res.users?.length) {
			flash($('add-status'), `No Roblox user named "${name}".`, 5000);
			return;
		}

		for (const user of res.users) {
			const known = people.find((p) => p.id === user.id);
			upsertPerson({
				id: user.id,
				name: user.name,
				displayName: user.displayName || user.name,
				avatarUrl: null,
				resolved: true,
				isFriend: known ? known.isFriend : false,
			});
			protectedIds.add(user.id);
		}

		input.value = '';
		sortPeople();
		render();
		queueSave();
		flash($('add-status'), `Added ${res.users[0].name}.`);
		enrichStrays();
	} catch (err) {
		flash($('add-status'), String(err.message || err), 6000);
	}
});

$('username-input').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') $('btn-add-username').click();
});

function syncAcceptAgeField() {
	$('minAccountAgeDays').disabled = !$('skipNewAccounts').checked;
}
$('skipNewAccounts').addEventListener('change', syncAcceptAgeField);

$('btn-save').addEventListener('click', async () => {
	const settings = {
		autoTrimEnabled: $('autoTrimEnabled').checked,
		useProxyForPublic: $('useProxyForPublic').checked,
		skipNewAccounts: $('skipNewAccounts').checked,
		skipSameDisplayName: $('skipSameDisplayName').checked,
	};

	for (const field of COUNT_FIELDS) {
		settings[field] = Math.round(Number($(field).value));
	}

	for (const field of DELAY_FIELDS) {
		settings[field] = Math.round(Number($(field).value) * 1000);
	}

	if (settings.floorDelayMs > settings.baseDelayMs) {
		flash($('save-status'), 'Fastest delay cannot exceed the starting delay.', 5000);
		return;
	}
	if (settings.ceilDelayMs < settings.baseDelayMs) {
		flash($('save-status'), 'Slowest delay cannot be below the starting delay.', 5000);
		return;
	}
	if (!(settings.readDelayMs > 0)) {
		flash($('save-status'), 'Lookup delay must be greater than zero.', 5000);
		return;
	}
	if (!(settings.minAccountAgeDays >= 1)) {
		flash($('save-status'), 'Minimum account age must be at least 1 day.', 5000);
		return;
	}
	// Auto-trim removes people without asking, so refuse nonsense rather than
	// interpreting it generously.
	if (settings.autoTrimEnabled) {
		if (!(settings.autoTrimThreshold >= 1)) {
			flash($('save-status'), 'Auto-trim threshold must be at least 1 friend.', 5000);
			return;
		}
		if (!(settings.autoTrimCount >= 1)) {
			flash($('save-status'), 'Auto-trim has to remove at least 1 friend.', 5000);
			return;
		}
		if (settings.autoTrimCount > settings.autoTrimThreshold) {
			flash(
				$('save-status'),
				'Auto-trim would remove more than the threshold. Lower the number to remove.',
				6000
			);
			return;
		}
	}

	await send({ type: MSG.SAVE_SETTINGS, settings });
	flash($('save-status'), 'Saved. Takes effect on the next job.');
});

// -- init -----------------------------------------------------------------------------

$('theme-slot').innerHTML = themeSwitchHtml();
initTheme();

(async () => {
	const snapshot = await send({ type: MSG.GET_STATE });

	// Show the stored keep-list straight away, then fill in the friends list.
	for (const entry of snapshot.keepList || []) {
		upsertPerson({
			id: entry.id,
			name: entry.name || '',
			displayName: entry.displayName || entry.name || '',
			avatarUrl: null,
			resolved: Boolean(entry.name),
			isFriend: false,
		});
		protectedIds.add(entry.id);
	}
	sortPeople();

	for (const field of COUNT_FIELDS) $(field).value = snapshot.settings[field];
	for (const field of DELAY_FIELDS) $(field).value = snapshot.settings[field] / 1000;
	$('autoTrimEnabled').checked = Boolean(snapshot.settings.autoTrimEnabled);
	$('useProxyForPublic').checked = Boolean(snapshot.settings.useProxyForPublic);
	$('skipNewAccounts').checked = Boolean(snapshot.settings.skipNewAccounts);
	$('skipSameDisplayName').checked = Boolean(snapshot.settings.skipSameDisplayName);
	syncAcceptAgeField();

	await loadFriends();
	await enrichStrays();
})();
