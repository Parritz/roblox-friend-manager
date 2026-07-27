// Rotating-proxy relay for Roblox Friend Manager.
//
// Why this exists: the extension's other proxies are Cloudflare Workers, which
// are *origins* - you rewrite the URL and fetch it. Webshare sells transport-level
// HTTP proxies, reached by CONNECT, and browser fetch() has no proxy option. The
// only in-browser mechanism is chrome.proxy, which is browser-profile-wide and
// would put your own logged-in tabs behind a datacenter IP. So the hop that needs
// a real HTTP client happens here instead, on a machine you control.
//
// It deliberately speaks the *same path-based scheme as the Workers*, so the
// extension needs no new protocol - the relay is just another entry in its route
// list, with the same failover and rate-limit handling around it:
//
//   GET  /k/<key>/users/v1/users/1
//     -> https://users.roblox.com/v1/users/1        (via a rotating Webshare IP)
//   POST /k/<key>/apis/user-profile-api/v1/user/profiles/get-profiles
//     -> https://apis.roblox.com/user-profile-api/v1/user/profiles/get-profiles
//
// Session-free only, on purpose. Requests carrying a cookie or a CSRF token are
// refused: sending a signed-in Roblox session out through a shared datacenter IP
// is a louder flag than the rate-limiting this is here to avoid. Authenticated
// calls stay on roblox.com in the extension, which is where they already were.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, request } from 'undici';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const RELAY_KEY = process.env.RELAY_KEY || '';
// fileURLToPath, not URL.pathname - the latter hands back "/C:/..." on Windows.
const PROXY_FILE = process.env.PROXY_FILE || fileURLToPath(new URL('./proxies.txt', import.meta.url));

// Upstream hosts this will talk to. An allowlist, not a passthrough - without one
// this is an open proxy the moment the key leaks.
const MIRRORS = {
	users: 'users.roblox.com',
	thumbnails: 'thumbnails.roblox.com',
	friends: 'friends.roblox.com',
	apis: 'apis.roblox.com',
};

// Per-attempt ceiling. The extension's own timeout is 4s before it tries another
// route, so this only bounds the socket, it isn't what the caller waits on.
const UPSTREAM_TIMEOUT_MS = 15_000;

// How long a proxy sits out after a transport failure. Short: Webshare endpoints
// blip, and writing one off for the process lifetime wastes a paid IP.
const COOLDOWN_MS = 60_000;

// Headers worth carrying in each direction. Everything else is dropped, which is
// what keeps a stray Cookie or Authorization from being forwarded by accident.
const FORWARD_REQUEST = ['accept', 'content-type', 'accept-language'];
// content-encoding matters: the body is passed through verbatim, still compressed,
// so dropping the header would hand the caller gzip bytes labelled as JSON.
const FORWARD_RESPONSE = [
	'content-type',
	'content-encoding',
	'retry-after',
	'x-ratelimit-limit',
	'x-ratelimit-remaining',
	'x-ratelimit-reset',
];

// A signed-in request must never leave through a shared IP - see the note above.
const REFUSED = ['cookie', 'x-csrf-token', 'authorization'];

if (!RELAY_KEY || RELAY_KEY.length < 16) {
	console.error(
		'RELAY_KEY must be set to at least 16 characters. This is the only thing\n' +
			'standing between the open internet and a working Roblox proxy. Generate one:\n' +
			'  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"'
	);
	process.exit(1);
}

// -- proxy pool ---------------------------------------------------------------

/** Webshare's "Download as txt" format: one host:port:user:pass per line. */
function loadProxies(file) {
	let text = process.env.PROXIES || '';
	if (!text) {
		try {
			text = readFileSync(file, 'utf8');
		} catch (err) {
			console.error(`Could not read ${file}: ${err.message}`);
			console.error('Put your Webshare list there, or set PROXIES with the same content.');
			process.exit(1);
		}
	}

	const pool = [];
	for (const [i, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const parts = line.split(':');
		if (parts.length !== 4) {
			console.warn(`  line ${i + 1}: expected host:port:user:pass - skipped`);
			continue;
		}
		const [host, port, user, pass] = parts;
		pool.push({
			id: `${host}:${port}`,
			// One agent per proxy, created once: undici pools the CONNECT tunnels, so
			// a run of 40 lookups doesn't renegotiate TLS 40 times.
			agent: new ProxyAgent({
				uri: `http://${host}:${port}`,
				token: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
			}),
			failures: 0,
			cooldownUntil: 0,
			served: 0,
		});
	}
	if (!pool.length) {
		console.error('No usable proxies found.');
		process.exit(1);
	}
	return pool;
}

const pool = loadProxies(PROXY_FILE);
let cursor = 0;

/**
 * Next proxy in the rotation, skipping any cooling off. Rotation is per request,
 * which is the whole point: 40 name lookups leave from 10 different IPs instead
 * of hammering one.
 */
function nextProxy() {
	const now = Date.now();
	for (let i = 0; i < pool.length; i++) {
		const proxy = pool[(cursor + i) % pool.length];
		if (proxy.cooldownUntil <= now) {
			cursor = (cursor + i + 1) % pool.length;
			return proxy;
		}
	}
	// Everything is cooling off. Take the one that recovers soonest rather than
	// failing the request outright - a stale proxy beats no answer.
	return pool.reduce((best, p) => (p.cooldownUntil < best.cooldownUntil ? p : best));
}

// -- request handling ---------------------------------------------------------

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function cors(res) {
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
	res.setHeader('access-control-allow-headers', 'accept, content-type');
	res.setHeader('access-control-max-age', '86400');
}

function send(res, status, body, headers = {}) {
	cors(res);
	for (const [k, v] of Object.entries(headers)) if (v != null) res.setHeader(k, v);
	res.writeHead(status);
	res.end(body);
}

const json = (res, status, obj) =>
	send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });

/** One attempt through one proxy. Throws on transport failure so the caller retries. */
async function forward(proxy, target, method, headers, body) {
	const response = await request(target, {
		method,
		headers,
		body: body?.length ? body : undefined,
		dispatcher: proxy.agent,
		headersTimeout: UPSTREAM_TIMEOUT_MS,
		bodyTimeout: UPSTREAM_TIMEOUT_MS,
		maxRedirections: 0,
	});
	return { status: response.statusCode, headers: response.headers, body: Buffer.from(await response.body.arrayBuffer()) };
}

async function handle(req, res) {
	if (req.method === 'OPTIONS') return send(res, 204, '');

	const url = new URL(req.url, `http://${req.headers.host || 'relay'}`);
	const segments = url.pathname.split('/').filter(Boolean);

	// /k/<key>/<mirror>/<rest...>
	if (segments[0] !== 'k' || segments[1] !== RELAY_KEY) return json(res, 404, { error: 'not found' });

	const mirror = segments[2];
	if (mirror === '_health') {
		return json(res, 200, {
			ok: true,
			proxies: pool.map((p) => ({
				id: p.id,
				served: p.served,
				failures: p.failures,
				coolingOff: p.cooldownUntil > Date.now(),
			})),
		});
	}

	const upstreamHost = MIRRORS[mirror];
	if (!upstreamHost) {
		return json(res, 400, { error: `unknown mirror "${mirror}"`, known: Object.keys(MIRRORS) });
	}

	for (const header of REFUSED) {
		if (req.headers[header]) {
			return json(res, 400, {
				error: `this relay is session-free; refusing a request carrying "${header}"`,
			});
		}
	}

	const target = `https://${upstreamHost}/${segments.slice(3).join('/')}${url.search}`;
	const headers = { 'accept-encoding': 'gzip, deflate' };
	for (const name of FORWARD_REQUEST) if (req.headers[name]) headers[name] = req.headers[name];
	if (!headers.accept) headers.accept = 'application/json, text/plain, */*';

	const body = await readBody(req);

	// Try a few different IPs before giving up: a dead Webshare endpoint should
	// cost this request a retry, not a failure the extension has to route around.
	const attempts = Math.min(3, pool.length);
	let lastError = null;

	for (let attempt = 0; attempt < attempts; attempt++) {
		const proxy = nextProxy();
		try {
			const upstream = await forward(proxy, target, req.method, headers, body);
			proxy.failures = 0;
			proxy.served++;

			// A 429 is passed straight back rather than retried elsewhere: the extension
			// has an adaptive limiter that needs to see it. The cursor has already moved
			// on, so the next request leaves from a different IP anyway.
			if (upstream.status === 429) {
				console.warn(`429 via ${proxy.id} for ${mirror}${url.pathname.replace(`/k/${RELAY_KEY}/${mirror}`, '')}`);
			}

			const out = { 'content-length': upstream.body.length };
			for (const name of FORWARD_RESPONSE) if (upstream.headers[name]) out[name] = upstream.headers[name];
			out['x-relay-proxy'] = proxy.id; // so a bad IP is identifiable from the extension log
			return send(res, upstream.status, upstream.body, out);
		} catch (err) {
			lastError = err;
			proxy.failures++;
			proxy.cooldownUntil = Date.now() + COOLDOWN_MS;
			console.warn(`proxy ${proxy.id} failed (${err.code || err.message}) - cooling off, trying another`);
		}
	}

	json(res, 502, { error: 'all proxy attempts failed', detail: String(lastError?.message || lastError) });
}

// -- startup ------------------------------------------------------------------

/** Proves each proxy works and prints its egress IP, so a bad list fails loudly. */
async function selfTest() {
	console.log(`Checking ${pool.length} proxies...`);
	const results = await Promise.all(
		pool.map(async (proxy) => {
			try {
				const res = await request('https://ipv4.webshare.io/', {
					dispatcher: proxy.agent,
					headersTimeout: 10_000,
					bodyTimeout: 10_000,
				});
				const ip = (await res.body.text()).trim();
				return `  ok    ${proxy.id.padEnd(22)} -> ${ip}`;
			} catch (err) {
				proxy.cooldownUntil = Date.now() + COOLDOWN_MS;
				return `  FAIL  ${proxy.id.padEnd(22)} -> ${err.code || err.message}`;
			}
		})
	);
	for (const line of results) console.log(line);
	const live = results.filter((r) => r.startsWith('  ok')).length;
	console.log(`${live}/${pool.length} proxies live.\n`);
}

await selfTest();

createServer((req, res) => {
	handle(req, res).catch((err) => {
		console.error('relay error:', err);
		json(res, 500, { error: String(err?.message || err) });
	});
}).listen(PORT, HOST, () => {
	console.log(`Relay listening on ${HOST}:${PORT}`);
	console.log(`Base URL for the extension:  http://<this-server>:${PORT}/k/${RELAY_KEY}`);
	console.log(`Health:                      http://<this-server>:${PORT}/k/${RELAY_KEY}/_health`);
});
