<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/VisionPilot/Zen.js/main/.github/images/logo-with-text-white.png">
    <img alt="zen.js" src="https://raw.githubusercontent.com/VisionPilot/Zen.js/main/.github/images/logo-with-text-black.png" width="220">
  </picture>
</p>

# @visionpilot/zen-middleware

CORS, security headers, request ids and rate limiting for
[Zen](https://github.com/VisionPilot/Zen.js) — built so that they run on the
requests that matter most, which are the ones most middleware never sees.

> **Alpha.** Also re-exported by
> [`@visionpilot/zen`](https://www.npmjs.com/package/@visionpilot/zen).

```bash
npm install @visionpilot/zen-middleware@alpha
```

```ts
import { zen } from '@visionpilot/zen'
import { cors, rateLimit, requestId, securityHeaders } from '@visionpilot/zen-middleware'

const app = zen({ trustProxy: 1 })          // one load balancer in front — see below

app.use(securityHeaders())
app.use(cors({ origin: ['https://app.example.com'], credentials: true }))
app.use(rateLimit({ limit: 120, window: '1m' }))
app.use(requestId())
```

## The one thing this package is about

**Route middleware does not run on a request that matched no route.** A browser
sends `OPTIONS /api/notes` before any cross-origin write; almost no application
declares an `OPTIONS` route; so a CORS middleware registered on routes never
sees the preflight, and the browser reports the failure on the *next* request,
in code that is correct. Counted over a matched `GET`, an unmatched path and a
preflight: route middleware ran **1 of 3**. For rate limiting the same gap is a
bypass — request a path that does not exist, and nothing counts it.

So each of these is a plugin that registers a **global `onRequest` hook**, which
Zen runs on every request, matched or not: **3 of 3**. And each *stages* its
headers rather than writing them, so they appear on the 404, the 429, the 422
and the 500 as well as the 200 — which is the difference between an API that
works in the browser and one that works only in Postman.

## What each one decides

- **`cors()`** — the allowlist is required (the secure default is not
  registering the plugin at all). `Vary: Origin` is sent on every response,
  including those without an `Origin`, because a shared cache needs it.
  `Access-Control-Allow-Methods` is read from the routes you actually declared.
  `origin: '*'` with `credentials: true` is refused at boot. The allowlist can
  come from configuration (`config.cors.origin`).
- **`securityHeaders()`** — `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, conservative `Cross-Origin-*` policies. HSTS is
  off until you configure it, because it cannot be taken back. A CORS allowlist
  that contradicts `Cross-Origin-Resource-Policy` is a boot error naming both.
- **`requestId()`** — echoes the request's id. Adopting an inbound
  `X-Request-Id` is off by default, and validated when on.
- **`rateLimit()`** — a fixed-window counter keyed by `ctx.ip`, refusing with an
  ordinary 429 problem document *before* the body is read, with `RateLimit`
  headers. The in-memory store evicts a whole window at once, so memory is
  bounded even when the key is attacker-chosen; `Store` is the seam for Redis.

The pack orders itself: register them in any order and they run request id →
security headers → CORS → rate limit.

## Behind a proxy

`ctx.ip` — and so the rate limiter — reads `X-Forwarded-For` only when the app
sets `trustProxy`. Set it to **the number of proxies** in front of the process:
`trustProxy: 1` for one load balancer. That reads the address your proxy saw,
which no client can forge. `trustProxy: true` reads the leftmost entry, which
the client writes itself when a proxy appends to the header — and then a client
rotating a fake address gets a fresh rate-limit budget on every request.

## Documentation

[ARCHITECTURE.md §32](https://github.com/VisionPilot/Zen.js/blob/main/ARCHITECTURE.md#32-first-party-middleware) ·
[`examples/middleware`](https://github.com/VisionPilot/Zen.js/tree/main/examples/middleware).

[MIT](https://github.com/VisionPilot/Zen.js/blob/main/LICENSE) © [VisionPilot](https://github.com/VisionPilot) · created by [Eren Sümer](https://github.com/ErenSumer) · [contributors](https://github.com/VisionPilot/Zen.js/blob/main/CONTRIBUTORS.md)
