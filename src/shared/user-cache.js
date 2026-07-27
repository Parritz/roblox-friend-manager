// Persistent id -> { name, displayName, avatarUrl } cache.
//
// One cache, shared by every path that has to put a face to a user id: the
// keep-list editor and the unfriend job both read and write it, so neither
// re-looks-up what the other already knows. It exists because users.roblox.com is
// the endpoint that actually rate-limits this extension - see the pace notes in
// limiter.js - and a friends list whose names are already known needs zero calls
// to it.
//
// Scoped to one Roblox account: claim() drops everything if the signed-in user
// changed, so switching accounts can't show you the previous account's names.
//
// Names are kept for a week. Avatar URLs get a day, because Roblox rotates them -
// and a stale one simply fails to load, which renders as the same empty
// placeholder the row already shows while a fresh one is on its way.

const KEY = 'userCache';
const NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

// Bound on stored entries. A 1000-friend account plus churn stays well inside
// this; eviction is most-recently-touched-first, so the useful half survives.
const MAX_ENTRIES = 5000;

const touchedAt = (entry) => Math.max(entry?.nameAt || 0, entry?.avatarAt || 0, entry?.seenAt || 0);

export class UserCache {
	constructor({ ownerId = null, users = {} } = {}) {
		this.ownerId = Number.isFinite(Number(ownerId)) ? Number(ownerId) : null;
		/** @type {Map<number, {name?:string, displayName?:string, avatarUrl?:string, nameAt?:number, avatarAt?:number}>} */
		this.users = new Map();
		for (const [id, entry] of Object.entries(users)) {
			const key = Number(id);
			if (Number.isFinite(key) && entry) this.users.set(key, entry);
		}
		this._dirty = false;
	}

	static async open() {
		try {
			const stored = await chrome.storage.local.get(KEY);
			return new UserCache(stored?.[KEY] || {});
		} catch (err) {
			// A cache that can't be read is not a reason to fail a job.
			console.warn('[RFM] could not read the user cache:', err?.message || err);
			return new UserCache();
		}
	}

	get size() {
		return this.users.size;
	}

	/**
	 * Binds the cache to an account, wiping it if that isn't who it was built for.
	 * Called from getAuthenticatedUser, so every path gets this for free.
	 */
	claim(ownerId) {
		const id = Number(ownerId);
		if (!Number.isFinite(id) || this.ownerId === id) return;
		if (this.ownerId != null) {
			console.info(`[RFM] user cache belonged to ${this.ownerId}, now ${id} - clearing.`);
			this.users.clear();
		}
		this.ownerId = id;
		this._dirty = true;
	}

	/** @returns {{name:string, displayName:string}|null} */
	name(id, now = Date.now()) {
		const entry = this.users.get(Number(id));
		if (!entry?.name) return null;
		if (now - (entry.nameAt || 0) > NAME_TTL_MS) return null;
		return { name: entry.name, displayName: entry.displayName || entry.name };
	}

	/** @returns {string|null} */
	avatar(id, now = Date.now()) {
		const entry = this.users.get(Number(id));
		if (!entry?.avatarUrl) return null;
		if (now - (entry.avatarAt || 0) > AVATAR_TTL_MS) return null;
		return entry.avatarUrl;
	}

	putName(id, name, displayName, now = Date.now()) {
		const key = Number(id);
		if (!Number.isFinite(key) || !name) return;
		const entry = this.users.get(key) || {};
		entry.name = name;
		entry.displayName = displayName || name;
		entry.nameAt = now;
		this.users.set(key, entry);
		this._dirty = true;
	}

	/**
	 * First time we ever saw this id as a friend. Only ever set once, so it acts as
	 * a stand-in for a friendship date - Roblox exposes no such field on any of the
	 * friends endpoints. Someone with no recorded sighting is therefore *new*, not
	 * old, and auto-trim treats them accordingly.
	 */
	noteSeen(id, now = Date.now()) {
		const key = Number(id);
		if (!Number.isFinite(key)) return;
		const entry = this.users.get(key) || {};
		if (entry.seenAt) return;
		entry.seenAt = now;
		this.users.set(key, entry);
		this._dirty = true;
	}

	/** @returns {number|null} */
	seenAt(id) {
		const entry = this.users.get(Number(id));
		return entry?.seenAt || null;
	}

	putAvatar(id, avatarUrl, now = Date.now()) {
		const key = Number(id);
		if (!Number.isFinite(key) || !avatarUrl) return;
		const entry = this.users.get(key) || {};
		entry.avatarUrl = avatarUrl;
		entry.avatarAt = now;
		this.users.set(key, entry);
		this._dirty = true;
	}

	clear() {
		if (!this.users.size) return;
		this.users.clear();
		this._dirty = true;
	}

	async flush() {
		if (!this._dirty) return;
		this._trim();
		const users = {};
		for (const [id, entry] of this.users) users[id] = entry;
		try {
			await chrome.storage.local.set({ [KEY]: { ownerId: this.ownerId, users } });
			this._dirty = false;
		} catch (err) {
			// Most likely the quota. Keep serving from memory rather than throwing.
			console.warn('[RFM] could not write the user cache:', err?.message || err);
		}
	}

	_trim() {
		if (this.users.size <= MAX_ENTRIES) return;
		const kept = [...this.users.entries()]
			.sort((a, b) => touchedAt(b[1]) - touchedAt(a[1]))
			.slice(0, MAX_ENTRIES);
		this.users = new Map(kept);
	}
}
