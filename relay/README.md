# Rotating proxy relay

A small Node service that gives the extension an entry point to a pool of
Webshare (or any `host:port:user:pass`) HTTP proxies, rotating the egress IP on
every request.

## Why it isn't in the extension

Browser `fetch()` has no proxy option. That is why `curl --proxy` and
`request-promise`'s `proxy:` work but an extension can't do the same thing — they
are HTTP clients, and a page is not. The only in-browser mechanism is
`chrome.proxy`, which sets the proxy for the **entire browser profile**; a PAC can
scope by host but can't tell an extension fetch from your own tab, and Chrome
strips the path from HTTPS URLs before the PAC sees them. Turning that on would
put your own logged-in Roblox tabs behind a datacenter IP.

So the hop that needs a real HTTP client happens here, on a machine you control.

## What it does

It speaks the **same path-based scheme as the Cloudflare Workers**, so the
extension needs no new protocol — the relay is just another entry in its route
list, with the same failover, timeout and rate-limit handling wrapped around it.

```
GET  /k/<key>/users/v1/users/1
  -> https://users.roblox.com/v1/users/1

POST /k/<key>/apis/user-profile-api/v1/user/profiles/get-profiles
  -> https://apis.roblox.com/user-profile-api/v1/user/profiles/get-profiles
```

Mirrors: `users`, `thumbnails`, `friends`, `apis`. Anything else is rejected — an
allowlist, so a leaked key doesn't become an open proxy.

Each request goes out through the next proxy in the pool. A proxy that fails at
the transport level cools off for 60s and the request is retried through another,
up to three. A **429 is passed straight back** rather than retried elsewhere: the
extension's limiter needs to see it, and the rotation cursor has already moved on,
so the next request leaves from a different IP anyway.

`x-relay-proxy` on every response says which IP served it.

## Session-free only

Requests carrying `cookie`, `x-csrf-token` or `authorization` are refused with a
400. Sending a signed-in Roblox session out through a shared datacenter IP is a
louder flag than the rate-limiting this exists to avoid. The extension enforces
the same rule from its side — friend accepts and unfriends never route here.

## Setup

```sh
cd relay
npm install
cp .env.example .env      # then edit it
# put your Webshare list in proxies.txt, one host:port:user:pass per line
npm start
```

Generate a key:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

On boot it checks every proxy and prints its egress IP, so a bad list fails loudly
rather than at 3am mid-job:

```
Checking 10 proxies...
  ok    31.59.20.176:6754      -> 31.59.20.176
  ...
10/10 proxies live.

Relay listening on 0.0.0.0:8080
Base URL for the extension:  http://<this-server>:8080/k/<key>
```

### Environment

| Variable     | Default        | Notes                                              |
| ------------ | -------------- | -------------------------------------------------- |
| `RELAY_KEY`  | *(required)*   | ≥16 chars. The only thing gating access.            |
| `PORT`       | `8080`         |                                                     |
| `HOST`       | `0.0.0.0`      |                                                     |
| `PROXY_FILE` | `./proxies.txt`|                                                     |
| `PROXIES`    | —              | The list inline, instead of a file.                 |

## Point the extension at it

Settings → **Self-hosted relay**, paste the base URL including the key path:

```
http://203.0.113.9:8080/k/28eaf08721bade51242e23afe513395d
```

Saving prompts for access to that host — Chrome requires it, and the relay can't
be in the manifest because it lives wherever you run it. The relay is tried ahead
of the Workers; they stay behind it as failover.

Check it's healthy any time:

```sh
curl http://203.0.113.9:8080/k/<key>/_health
```

## Deployment notes

There is no TLS here. Either run it behind a reverse proxy that terminates HTTPS,
or keep it on a private network / tunnel. Over plain HTTP the key travels in the
URL, and anyone who can read your traffic can use your proxies — the request
bodies are only public Roblox lookups, but the key is worth protecting.
