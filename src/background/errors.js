/** Thrown when the user presses Stop, or the job is otherwise cancelled. */
export class AbortError extends Error {
	constructor(message = 'Stopped.') {
		super(message);
		this.name = 'AbortError';
	}
}

/**
 * A classified Roblox API failure.
 *
 * kind:
 *   'auth'     - session is dead (401). Abort the whole job; retrying is pointless.
 *   'terminal' - this one item can never succeed (400 / genuine 403). Skip it.
 *   'network'  - transport or 5xx failure that survived every retry. Count as failed.
 *   'notab'    - the proxy transport needs a roblox.com tab and there isn't one.
 */
export class ApiError extends Error {
	constructor(kind, message, { status = 0, code = null } = {}) {
		super(message);
		this.name = 'ApiError';
		this.kind = kind;
		this.status = status;
		this.code = code;
	}
}

export function isAbort(err) {
	return err instanceof AbortError || err?.name === 'AbortError';
}

export function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new AbortError());
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new AbortError());
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
