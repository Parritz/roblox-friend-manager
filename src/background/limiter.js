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
// 429 backoff schedule when Roblox doesn't send Retry-After.
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export class Limiter {
	constructor({ baseDelayMs, floorDelayMs, ceilDelayMs }) {
		this.base = baseDelayMs;
		this.floor = floorDelayMs;
		this.ceil = ceilDelayMs;
		this.rateLimitHits = 0;

		this._nextAllowedAt = 0;
		this._backoffUntil = 0;
		this._streak = 0;
		this._consecutive429 = 0;
		// Promise-chain mutex: guarantees exactly one request in flight, ever.
		this._chain = Promise.resolve();
	}

	get currentDelayMs() {
		return Math.round(this.base);
	}

	get backoffRemainingMs() {
		return Math.max(0, this._backoffUntil - Date.now());
	}

	/** Reset adaptive state at the start of a job, keeping the configured seed pace. */
	reset({ baseDelayMs, floorDelayMs, ceilDelayMs }) {
		this.base = baseDelayMs;
		this.floor = floorDelayMs;
		this.ceil = ceilDelayMs;
		this.rateLimitHits = 0;
		this._nextAllowedAt = 0;
		this._backoffUntil = 0;
		this._streak = 0;
		this._consecutive429 = 0;
	}

	/** Queue `fn` behind everything else, then run it once the pace allows. */
	run(fn, signal) {
		const result = this._chain.then(() => this._gated(fn, signal));
		// Swallow rejections on the chain itself so one failure doesn't poison the queue.
		this._chain = result.then(
			() => {},
			() => {}
		);
		return result;
	}

	async _gated(fn, signal) {
		// Sleep in ≤1s slices so Stop feels instant even during a 5 minute backoff.
		for (;;) {
			if (signal?.aborted) throw new AbortError();
			const wait = Math.max(this._nextAllowedAt - Date.now(), this.backoffRemainingMs, 0);
			if (wait <= 0) break;
			await sleep(Math.min(wait, 1000), signal);
		}
		// Jitter: perfectly periodic traffic is itself a bot signal.
		this._nextAllowedAt = Date.now() + this.base * (0.7 + Math.random() * 0.6);
		return fn();
	}

	onSuccess() {
		this._consecutive429 = 0;
		if (++this._streak >= STREAK_TO_SHRINK) {
			this._streak = 0;
			this.base = Math.max(this.base * SHRINK, this.floor);
		}
	}

	/** @param {number|null} retryAfterMs value parsed from the Retry-After header, if any */
	onRateLimit(retryAfterMs) {
		this.rateLimitHits++;
		this._streak = 0;
		this._consecutive429++;
		this.base = Math.min(this.base * GROW, this.ceil);

		const fallback = Math.min(
			BACKOFF_BASE_MS * 2 ** (this._consecutive429 - 1),
			BACKOFF_MAX_MS
		);
		const wait = retryAfterMs ?? fallback * (0.85 + Math.random() * 0.3);
		this.pauseFor(wait);
		return this.backoffRemainingMs;
	}

	pauseFor(ms) {
		this._backoffUntil = Math.max(this._backoffUntil, Date.now() + ms);
	}
}
