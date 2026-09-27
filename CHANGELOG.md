# Changelog

All notable changes to Zen. The packages are versioned together; every entry
applies to all six. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Zen is pre-alpha: until `1.0`, any prerelease may change the API.

## [0.1.0-alpha.1] — unreleased

The first published version. Everything built before it is described in
[README.md](./README.md) and specified in [ARCHITECTURE.md](./ARCHITECTURE.md);
this entry records what changed in preparing it for release.

### Packaging

- **Published under `@erenthedeveloper0`.** The `@zenjs` npm scope belongs to
  someone else, and `zen` and `zenjs` are taken, so the packages are
  `@erenthedeveloper0/zen` (install this one), `@erenthedeveloper0/zen-core`,
  `zen-router`, `zen-adapter-node`, `zen-openapi` and `zen-middleware`, from the
  repository at
  [github.com/erenthedeveloper0/zen](https://github.com/erenthedeveloper0/zen).
- Every tarball now ships `README.md`, `LICENSE` and the TypeScript sources its
  source maps point at, and no longer ships the build cache (which held
  absolute paths from the build machine). `exports` includes
  `./package.json`; manifests carry `repository`, `homepage`, `bugs` and
  `publishConfig.access: public`; TypeScript ≥ 5.0 is an optional peer —
  checked in CI by compiling a consumer against the published declarations on
  TypeScript 5.0.
- Release tooling: `scripts/version.ts`, `scripts/check-release.ts`,
  `scripts/check-pack.ts`, `.github/workflows/release.yml` (trusted publishing,
  provenance, dependency order, prerelease dist-tags), and
  [RELEASING.md](./RELEASING.md).

### Added

- **Server-sent events** — `ctx.sse()` (§13.5). It was declared on the context
  type and implemented by neither context class, so it type-checked and threw
  at runtime. Framing per the event-stream grammar, heartbeats, backpressure,
  a bound on what a slow client can make the server hold, disconnect detection,
  and a final `shutdown` event for open streams when the app closes.
- **File responses that work** — `ctx.file(path, { root })`: a 404 for a
  missing file, refusal of any path resolving outside `root` (symlinks
  included), `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, 304 on
  revalidation, 206 for a single byte range, and `HEAD`.
- **Signal and crash handling** in `@erenthedeveloper0/zen` (§4.5, §12.8): `SIGTERM`
  and `SIGINT` run the graceful shutdown and exit; an uncaught exception or
  unhandled rejection is logged at `fatal` and shuts down with exit code 1.
  Installed at `listen()`; `lifecycle: false` opts out. Core gains the
  `HostLifecycle` seam this plugs into.
- **`app.paramType()`** (§5.2) — application path-parameter types, used by the
  router, `ctx.params` and the OpenAPI document. The router's own diagnostic
  had always told users to call it.
- **`trustProxy` as a hop count** (§19.4) — `trustProxy: 1` for one proxy.
  `ctx.ip` is then the address the outermost trusted proxy saw, which a client
  cannot forge.
- **Every failing request source reported at once** (§4.2 stage 7): a bad query
  and a bad body produce one problem document listing both. Each issue now
  carries a `source` field.
- `docs/errors.md` — an entry for every error code, and the target of every
  problem document's `type` and every diagnostic's `docs:` link.
- `CONTEXT_MEMBERS`, `withoutStack`, `forwardedClient`, `forwardedProtocol`,
  `combineValidators`, `diagnoseUnknown`, `diagnoseMisplaced`, `createSseChannel`
  and friends are exported from `@erenthedeveloper0/zen-core`.
- `app.all()` and `Collection#all()` — one ordinary route per method (§22.1).
- `Collection#head`, `#options`, `#around` and `#after`, which the app had and
  a collection did not; a collection handle also refuses middleware after boot
  instead of accepting it and never compiling it.
- `decodeComponent`, `trackDisposal`, `requestUrl` and `ALL_METHODS` exported
  from `@erenthedeveloper0/zen-core`.
- `benchmarks/request-path` — what these fixes cost on the request path, with
  structural gates: a route without `around` stays byte-identical, and the
  `next()` wrapper appears only where the downstream compiled synchronous.
- Eighteen negative controls, one for each fix under **Fixed** below that a
  regression could undo silently — 44 in all.

### Fixed

- **Every request with a body ran with an aborted `ctx.signal`** on the Node
  adapter, and on a route with a deadline **every such request was answered
  499**. Node closes an incoming message once its body is read; the adapter took
  that for a disconnect. Disconnects are now read from the response.
- **A client disconnecting mid-stream crashed the process** — an error thrown
  from a `.catch` handler became an unhandled rejection. The adapter now never
  throws once a response has started, and tells a departed client apart from a
  source that failed.
- **`app.close()` waited out the whole `shutdownTimeout`** whenever a keep-alive
  connection finished a response just after shutdown began (§4.5 step 2 was
  unimplemented). Responses during shutdown now close their connection.
- **Async singletons were built once per concurrent caller** — two connection
  pools behind one "singleton" — and `close()` then crashed disposing it.
  Builds are now single-flight, and one failing disposer no longer stops the
  rest.
- A throwing `onClose` hook no longer abandons the rest of shutdown (§12.8).
- A hook for a phase that does not exist (`onReqest`), or an application phase
  declared on a route, was silently never called. Both are boot errors now
  (`ZEN_HOOK_PHASE_UNKNOWN`), with a suggestion.
- `decorate('json', …)` replaced `ctx.json()` on every route; decorating any
  name the context owns, or a non-identifier, is now refused at registration.
- `<int>` path parameters silently rounded ids past 2⁵³ to a different id; they
  no longer match.
- A 405's `Allow` header omitted dynamic routes' methods when a static route
  shared the path.
- A `;` in a cookie's name, `Path` or `Domain` injected cookie attributes; it is
  refused. Cookies default to `Secure` over HTTPS, and wherever a browser would
  otherwise drop them (`__Host-`, `__Secure-`, `SameSite=None`).
- Form bodies had no field limit; they are capped at `body.maxFields` (1000).
- On a route with a deadline, a streamed body's `ctx.signal` stopped hearing
  disconnects once the response started.
- `ctx.secure` read a comma-separated `X-Forwarded-Proto` as insecure.
- The development-mode stack filter matched one machine's checkout path only.
- The CI workflow was invalid YAML and could not have run.

A second audit pass, reproducing each defect against the built packages
before fixing it:

- **Two routes sharing a `name` answered each other's requests.** Compiled
  routes are keyed by their id — the name when there is one — so the second
  registration replaced the first and `GET /a` ran `GET /b`'s handler. A shared
  name is now `ZEN_ROUTE_DUPLICATE` at boot.
- **Concurrent `ready()` calls booted the application twice** — two `inject()`s
  started together ran every plugin's `setup` twice. Boot is now single-flight.
- **A boot that failed after compiling was forgotten.** When an `onBoot` check,
  an eager singleton or an `onReady` hook failed, the next `ready()` reported
  success and `inject()`/`listen()` served the half-booted app. The failure is
  now remembered and every later caller receives it.
- **Request-scoped services were never disposed.** `provide(token, { lifetime:
  'scoped', dispose })` accepted `dispose` and never called it, so a
  per-request transaction or connection was dropped rather than released. It
  now runs at stage 10, newest first, on every path — including a request that
  failed, one whose error reply could not be written either, and one whose
  deadline answered while the handler was still acquiring: what arrives after
  the request settled is released on arrival instead of leaked.
- **A disposable slot set twice leaked its first value** and disposed its
  second value twice. Every value a slot held is now released, once.
- **`next()` in `around` middleware could return a bare `Reply`** when the
  rest of the route compiled synchronous (§8.4), so `next().then(…)` failed
  with "then is not a function" on exactly the optimised routes. `next()` is
  always a Promise now, at the cost of one promise on that path only —
  `benchmarks/request-path` gates it.
- **`app.listen(3000)` ignored the port** — the RFC's own five-line app. The
  number form is supported (`listen(port, host?)`), and `ListenOptions.signal`,
  declared and never read, now aborts into the graceful shutdown.
- **Typed path parameters were resolved in registration order.**
  `/items/:id<int>` beside `/items/:key<slug>` sent `/items/42` to whichever was
  registered first. Parameter types that share a value are now
  `ZEN_ROUTE_AMBIGUOUS` at boot, naming the value; pairs nothing can decide
  (two application types without `jsonSchema.examples`) are ordered by type
  name and reported as `ZEN_ROUTE_TYPES_UNDECIDED`.
- A `+` in a cookie, and in a path segment beside a `%` escape, was decoded as
  a space — which is form encoding, not cookie or path syntax. Base64 session
  ids were corrupted.
- The default `ConsoleLogger` threw on a value `JSON.stringify` refuses (a
  cycle, a `bigint`), which on the error path lost the error response too. It
  never throws now; such a line is written with a tolerant replacer.
- An invalid `Host` header made `ctx.url` throw a `TypeError` — a 500. It is a
  400, as RFC 9112 §3.2 requires.
- An absolute-form request target (`GET http://host/path`, RFC 9112 §3.2.2)
  was matched as a path and answered 404.
- `HEAD` on a wildcard `GET` route answered 405, and a 405's `Allow` omitted
  `HEAD` wherever `GET` served it.
- `+json` request bodies (`application/merge-patch+json`,
  `application/vnd.api+json`) were refused with 415.
- `ServerHandle.url` was not a URL for an IPv6 host (`http://::1:3000`).
- A client disconnecting mid-upload was logged as an application 500.
- Error metadata could overwrite a log line's `code` and `status`; the
  last-resort 500 interpolated the request id into JSON unescaped.

Found by the first push to CI, on Windows:

- `TimeoutInfo.elapsedMs` could come out a fraction of a millisecond **below**
  `budgetMs` — the deadline's timer runs on the event loop's millisecond clock,
  `elapsedMs` on `performance.now()` — breaking its documented "always ≥
  `budgetMs`" and producing `ZEN_TIMEOUT` messages such as "exceeded its 20 ms
  budget (19.9 ms elapsed)". The budget is now its floor.

### Changed

- **Refusals are ~2.5× cheaper.** A 404, 405 or 406 the framework answers no
  longer captures a stack trace (it could only ever show the dispatcher), and
  every `ZenError` captures its stack once instead of twice. Measured on one
  machine: a 404 went from 5.6× a served request to 2.3×, a 406 from 9.5× to
  3.6×; an error a handler throws keeps its stack and got 30% cheaper.
  `benchmarks/refusals` gates it.
- The problem-document `type` URI is
  `https://github.com/erenthedeveloper0/zen/blob/main/docs/errors.md#<code>`. It
  was `https://zenjs.dev/errors/<CODE>`, a domain nobody had registered.
- `ctx.params` for an application-registered param type is typed `unknown`
  rather than `string`, because its `parse` may return anything.
- `Router.analyze` takes the same options as `Router.build`.
