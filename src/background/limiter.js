// The rate limiter. This module is the whole point of the rewrite.
//
// The old console script paced *batches* on a 2s setInterval while firing up to
// 50 unfriend requests back-to-back inside each one. Here every single request
// to Roblox goes through Limiter.run(), one at a time, with a jittered gap, and
// the gap adapts to whatever Roblox is actually willing to accept today.

import { AbortError, sleep } from './errors.js';

// Grow the gap this much on every 429.
const GROW = 1.5;

// Shrink it this much after a clean streak.
const SHRINK = 0.9;

// Successes in a row before we try speeding back up.
const STREAK_TO_SHRINK = 20;
// The one pace key every mutating call shares.
const WRITE = 'write';
// 429 backoff schedule when Roblox doesn't send Retry-After.
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export class Limiter {
	constructor(settings) {
		this._install(settings);

		this._nextAllowedAt = 0;
		this._backoffUntil = 0;
		this._consecutive429 = 0;
		// Promise-chain mutex: guarantees exactly one request in flight, ever.
		this._chain = Promise.resolve();
	}

	/**
	 * One pace per traffic class, each adapting independently.
	 *
	 * Writes (unfriend, accept) share a single cautious pace. Reads get one pace
	 * *per host*, because Roblox's limits are clearly per-endpoint, not global:
	 * observed 429s arrive with the published budget almost untouched, and in
	 * practice users.roblox.com starts refusing batch lookups at a pace that
	 * friends.roblox.com serves without complaint. Sharing one read pace across
	 * hosts meant the strictest endpoint dragged every other one down with it.
	 *
	 * Keys are 'write' and 'read:<host>'. Read paces are created on first use.
	 */
	_install({ baseDelayMs, floorDelayMs, ceilDelayMs, readDelayMs }) {
		this.ceil = ceilDelayMs;
		this._readSeed = Number.isFinite(readDelayMs) ? readDelayMs : baseDelayMs;
		// Writes start above their floor, so a clean run earns some speed-up.
		this._paces = new Map([[WRITE, { base: baseDelayMs, floor: floorDelayMs, streak: 0 }]]);
		this.rateLimitHits = 0;
	}

	_pace(key) {
		let pace = this._paces.get(key);
		if (!pace) {
			// Read paces floor at their own seed rather than at floorDelayMs: the read
			// pace is already fast, so there is nothing to gain from adapting below
			// what was asked for. A 429 still grows it, and a clean streak still
			// brings it back down to exactly the configured value.
			pace = { base: this._readSeed, floor: this._readSeed, streak: 0 };
			this._paces.set(key, pace);
		}
		return pace;
	}

	/** Current gap for one pace key, in ms. */
	paceFor(key) {
		return Math.round(this._pace(key).base);
	}

	/** The job pace, i.e. writes. This is what the popup reports. */
	get currentDelayMs() {
		return this.paceFor(WRITE);
	}

	/** Read paces that have drifted above their seed, for the log. */
	slowedReads() {
		const out = [];
		for (const [key, pace] of this._paces) {
			if (key !== WRITE && pace.base > this._readSeed) {
				out.push({ host: key.slice('read:'.length), delayMs: Math.round(pace.base) });
			}
		}
		return out;
	}

	get backoffRemainingMs() {
		return Math.max(0, this._backoffUntil - Date.now());
	}

	/** Reset adaptive state at the start of a job, keeping the configured seed pace. */
	reset(settings) {
		this._install(settings);
		this._nextAllowedAt = 0;
		this._backoffUntil = 0;
		this._consecutive429 = 0;
	}

	/**
	 * Queue `fn` behind everything else, then run it once the pace allows.
	 * @param {string} key pace key - 'write' or 'read:<host>'. Defaults to the cautious one.
	 */
	run(fn, signal, key = WRITE) {
		const result = this._chain.then(() => this._gated(fn, signal, key));
		// Swallow rejections on the chain itself so one failure doesn't poison the queue.
		this._chain = result.then(
			() => {},
			() => {}
		);
		return result;
	}

	async _gated(fn, signal, key) {
		// Sleep in ≤1s slices so Stop feels instant even during a 5 minute backoff.
		for (;;) {
			if (signal?.aborted) throw new AbortError();
			const wait = Math.max(this._nextAllowedAt - Date.now(), this.backoffRemainingMs, 0);
			if (wait <= 0) break;
			await sleep(Math.min(wait, 1000), signal);
		}
		// Jitter: perfectly periodic traffic is itself a bot signal.
		this._nextAllowedAt = Date.now() + this._pace(key).base * (0.7 + Math.random() * 0.6);
		return fn();
	}

	onSuccess(key = WRITE) {
		this._consecutive429 = 0;
		const pace = this._pace(key);
		if (++pace.streak >= STREAK_TO_SHRINK) {
			pace.streak = 0;
			pace.base = Math.max(pace.base * SHRINK, pace.floor);
		}
	}

	/**
	 * @param {number|null} retryAfterMs value parsed from the Retry-After header, if any
	 * @param {number|null} resetMs x-ratelimit-reset, in ms, if Roblox sent it
	 * @param {string} key which pace key was rejected
	 * @param {{global?:boolean}} [opts]
	 *        `global: false` slows only this pace key - used when a session-free call
	 *        is about to switch to the other route, so a proxy 429 doesn't park the
	 *        origin attempt behind a multi-second pause.
	 */
	onRateLimit(retryAfterMs, resetMs = null, key = WRITE, { global = true } = {}) {
		this.rateLimitHits++;

		// Only the rejected key slows down - users.roblox.com refusing a batch lookup
		// says nothing about how fast friends.roblox.com will serve pages.
		for (const pace of this._paces.values()) pace.streak = 0;
		const pace = this._pace(key);
		pace.base = Math.min(pace.base * GROW, this.ceil);

		const fallback = Math.min(
			BACKOFF_BASE_MS * 2 ** (global ? this._consecutive429 : 0),
			BACKOFF_MAX_MS
		);
		const wait = retryAfterMs ?? fallback * (0.85 + Math.random() * 0.3);

		if (!global) return wait;

		this._consecutive429++;
		this.pauseFor(wait);

		// x-ratelimit-* describes Roblox's *global* buckets, and on observed 429s
		// those still report thousands of requests remaining - the rejection comes
		// from a per-endpoint limit they don't publish. So reset is only ever
		// allowed to extend a pause, never to cut one short. pauseFor already keeps
		// the later of the two deadlines.
		if (resetMs != null && resetMs > 0) this.pauseFor(resetMs);

		return this.backoffRemainingMs;
	}

	pauseFor(ms) {
		this._backoffUntil = Math.max(this._backoffUntil, Date.now() + ms);
	}
}
