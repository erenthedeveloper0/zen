# Changelog

All notable changes to Zen. The packages are versioned together; every entry
applies to all six. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Zen is an alpha: until `1.0`, any prerelease may change the API.

## [0.1.0-alpha.4] — 2026-10-05

Nothing silent. An audit of the alpha.3 build wrote fourteen probes, each a
sentence the docs said in the present tense, and every one found the code
saying something else: a hook accepted and never called, an options schema
read by nothing, metadata written where no reader could look, a check
described as built that let every request through to a 400. Seven of those are
fixed here; the other seven are now admitted where the docs made them, and the
build watches all fourteen. Every "Working today" bullet in the README and
every "Status: built" block in the architecture carries an id that
`scripts/claims.ts` maps to a probe against the built packages, in CI — so a
sentence cannot claim what the code does not do, and a gap that closes fails
the build until the docs stop calling it missing.

### Added

- **Plugin options are validated at boot** (§10.5 step 2), before any plugin's
  `setup` runs and for every plugin in one boot: the schema's own verdict,
  awaited when it is async, and every key its JSON Schema does not declare,
  named with the one it was probably meant to be —
  `"limt" is not an option of rate-limit — did you mean "limit"?`. An options
  object is a closed vocabulary, so an absent `additionalProperties` reads as
  closed. A refusal names keys, never values. `ZEN_PLUGIN_OPTIONS` is produced
  for the first time for what its entry always said it meant.
- `Plugin.boundOptions` — the options a factory plugin was built with, checked
  against `Plugin.options` exactly as `app.use(plugin, options)`'s second
  argument is; an explicit second argument wins.
- **Options schemas for the four first-party middleware factories** —
  `cors`, `securityHeaders`, `requestId`, `rateLimit` — hand-written Standard
  Schemas, so the pack stays dependency-free. `rateLimit({ limt: 100 })` fails
  at startup with a spelling suggestion, which is §8.6's sentence verbatim.
- **A `params` schema is checked against its path at boot** (§5.2):
  `params: { userId }` on `/users/:id` is `ZEN_PARAM_MISMATCH` with
  *did you mean to name it "id"?*, where it used to boot and answer every
  request 400. A required key only an optional segment supplies, and a path
  parameter a closed schema refuses, are errors too; a parameter an open
  schema would drop is a warning; an `integer` schema on an untyped segment is
  reported once, as information.
- **A response field its own schema marks `writeOnly` is refused at boot**
  (`ZEN_RESPONSE_WRITE_ONLY`, naming route, status, media type and JSON path),
  in the plain form, every negotiated representation and every schema handed
  to a media encoder, through arrays, records, unions and `$ref`s.
  `format: 'password'` is a warning. The OpenAPI response projection withholds
  `writeOnly` properties, strict mode or not.
- **Conditional collections** (§6.2):
  `app.collection('/debug', { when: (env) => … }, …)`, evaluated once at boot
  against the validated environment. A subtree that is off is absent from the
  router, the graph and the OpenAPI document. A `when` that throws, or answers
  with anything but a boolean, is `ZEN_CONFIG_INVALID`.
- **Route-scoped middleware** (§8.3): `{ use: [checkOwnership] }` on a route,
  after the app's and every enclosing collection's, labelled `[route]` by
  `explainRoute`. The README has called middleware route-scoped since the first
  release; until now nothing could put one there.
- **`ctx.ips` and `ctx.protocol`** (§7.2), getters on both context classes, so
  neither gains a field. `ips` is the trusted forwarding chain, client first and
  socket peer last, so `ips[0]` is `ip`; `protocol` is `secure` as a scheme.
  Both believe the headers exactly as far as `trustProxy` does.
- **`Symbol.dispose` and `Symbol.asyncDispose`** (§15.3): a singleton, a scoped
  service or a slot value with no `dispose` of its own is released through the
  protocol — at shutdown, or at stage 10 — `asyncDispose` preferred. An
  explicit `dispose` wins; `dispose: () => {}` opts out.
- `inject(method, url, { remote })` — the peer a request comes from, so
  `ctx.ip`-keyed behaviour and `trustProxy` hop counting are testable in
  process. `127.0.0.1` unless given.
- `Connection.inProcess` — set by `inject()`, left unset by an adapter: a
  request with no socket behind it, whose deadline must hold the event loop
  open itself (below).
- **`@erenthedeveloper0/zen-openapi` reads `graph.meta`**: a plugin declares
  its security schemes with `app.meta('openapi.securitySchemes', { … })` and
  they are merged into `components.securitySchemes`, the application's own
  option winning a name both declare. A misspelt `openapi.` field, a value that
  is not a record of schemes, and a name two plugins declare differently are
  `ZEN_OAS_META_INVALID` warnings.
- `ZEN_REGEX_UNSAFE`: in development, `app.paramType()` reports a regex in its
  `test` that can backtrack without bound. `regexHazards` and `regexLiterals`,
  the analyser behind it and behind the CI check, are exported.
- Error classes `BodyInvalid` (400, `ZEN_BODY_INVALID`) and
  `UnprocessableEntity` (422, `ZEN_UNPROCESSABLE_ENTITY`, from §12.2's
  taxonomy), and codes `ZEN_BAD_REQUEST`, `ZEN_SERVICE_UNAVAILABLE`,
  `ZEN_UNPROCESSABLE_ENTITY`, `ZEN_RESPONSE_WRITE_ONLY`, `ZEN_REGEX_UNSAFE` and
  `ZEN_OAS_META_INVALID`, each in [docs/errors.md](./docs/errors.md).
- `SEALED_STAGE`, `forwardedChain`, `trackIntrinsic` and `intrinsicDisposer`
  exported from `@erenthedeveloper0/zen-core`, for an alternative context
  implementation.

### Changed

- **`setup` receives the validated options** — the schema's *output*, with its
  defaults applied and its transforms run — rather than what was written. A
  plugin whose schema transforms its input now sees the transformed value; a
  plugin whose options were silently wrong now fails at boot instead of
  running on a default.
- **Two error codes moved** (I7: codes are semver-protected, so they move in an
  alpha, and here):
  - `ServiceUnavailable` is **`ZEN_SERVICE_UNAVAILABLE`**. It was `ZEN_INTERNAL`
    — the code for an *unclassified* error — so a 503 thrown on purpose was
    indistinguishable from a bug on every dashboard.
  - `BadRequest` is **`ZEN_BAD_REQUEST`**. It was `ZEN_BODY_INVALID`, so an
    invalid `Host` header reported an invalid body. A body that does not parse,
    or nests too deep, is the new `BodyInvalid` and keeps `ZEN_BODY_INVALID`.
- **An abort is classified by whose it was.** The request's own abort keeps
  `ZEN_TIMEOUT`. An upstream's `AbortSignal.timeout()` — a `TimeoutError`, or
  an `AbortError` caused by one — is a retryable 503,
  `ZEN_SERVICE_UNAVAILABLE`. Any other `AbortError`, the application's own
  `AbortController` around an upstream call, is `ZEN_INTERNAL` 500. Every one
  of them used to be a 408, telling the client it had been slow.
- **Capabilities come from the adapter**:
  `caps ?? adapter.caps ?? DEFAULT_CAPABILITIES`. And the Node adapter, and
  core's defaults, declare `compression: 'none'` and `websocket: 'none'` — they
  implement neither. A plugin requiring either now fails at boot, which is what
  `requires` is for.
- A write to `ctx.res` after the reply was sent throws `ZEN_REPLY_SENT` — from
  `onResponse`, or from a handler a deadline has already answered — where it
  used to be accepted and discarded.
- A response schema with a `writeOnly` field fails boot (above). An application
  that returned one was sending what its schema said must never be returned.
- Misspelt or mistyped options to `cors`, `securityHeaders`, `requestId` and
  `rateLimit` fail boot with `ZEN_PLUGIN_OPTIONS`; they used to be ignored.
- `RouterOptions.caseSensitive` and `ignoreTrailingSlash` are removed from the
  contract. Nothing read them; matching is case-sensitive and a trailing slash
  is normalised, which is now what the contract documents.
- The application phases of `HookFn` are typed: `onBoot` receives the
  `AppGraph`, `onListen` the `ServerHandle`, `onClose` the reason, `onReady`
  nothing. A hook written against the wrong signature is now a type error.
- `RouteSpec` has `use`, `CollectionOptions` has `when`, and `BaseContext` has
  `ips` and `protocol` — a hand-written context double needs the two getters.

### Fixed

- **`app.hook('onBoot', fn)` was accepted and never called.** It passed every
  phase check and was stored in a table boot never read; only
  `Registrar.onBoot` ran. The two are now one table, run in registration order.
- **`Registrar.meta` wrote into a map no reader could reach** — the graph was
  handed a fresh empty one. `graph.meta` carries it now, keyed `<plugin>.<key>`.
- `AppGraph.decorations` held the compiler's records, with a slot *index*,
  through an `as unknown as`; its type promised a `Slot`. Each decoration now
  carries its `Slot`.
- `Plugin.requires` with a string — `{ websocket: 'native' }` — was satisfied by
  any capability at all. It now asks for that exact one.
- A negotiated response whose schema drew only a *warning* lost its negotiation
  plan along with the warning, and answered JSON whatever was asked. Only an
  error drops it now.
- `@erenthedeveloper0/zen-core`'s DI container imported from its own `api/`
  layer, the one upward import between strata the rule did not excuse; the slot
  table moved down to `registry/`.
- **An `inject()` that only its deadline could answer let an idle process exit
  before the deadline did.** A request's deadline timer is unref'd, because a
  socket holds the event loop open for a real one; `inject()` has no socket, so
  a script awaiting an `inject()` whose handler waited on `ctx.signal` simply
  ended — no status, no error, exit code 13. A test runner keeps the loop alive
  itself, which is why no suite had seen it. An in-process request's deadline
  now holds the loop open, as a health probe's does; an adapter's requests are
  unchanged.

### Documentation

- Twenty-six sentences in the architecture that described the design as the
  code are corrected in place, and the gaps they hid are rows in §28.8: the
  router generates params builders but walks a trie to match; the sync fast
  path needs `markSync()`; `ctx.state`, `ws` and `hijack` are not built, and
  `state` is proposed for removal; development mode neither seals the context
  nor freezes request data; issue codes are inferred from message text; error
  mappers are global and error boundaries unbuilt; a returned WHATWG
  `Response` is a 500; cookie signing, ETag and compression in egress,
  pre-encoded bodies and frozen replies are design; the Node adapter is
  `node:http` only; header size and URL length are Node's limits; there is no SBOM and no
  continuous fuzzing; `typeof app` cannot drive a typed client; the repository
  tree and the package table are the target layout; the RFC's footer pointed
  at a directory that does not exist. And §5.1's route origin, §8.7's
  middleware `when` and §19.2's per-route body limit are marked not built.
- The README's "The idea" listing is the real output of
  `scripts/show-generated.ts`, with the note that it uses `markSync()`.
- `app.seal()` was to be deprecated in this release, on §28.2's measurement of
  −0.4% against a 7% spread. Re-measured first, it came out at −7.8% and
  −8.1% with spreads under 3% — above the noise for the first time — so it is
  not deprecated; §28.2 and Annex D question 5 record both results, and the CI
  matrix decides.

### Repository

- `scripts/claims.ts` — the claims ledger, a CI step. 44 claims and 7 admitted
  gaps, each a probe against `dist/`.
- `scripts/check-strata.ts` (§3.1) and `scripts/check-regex.ts` (§19.3), in
  the zero-dependencies job. Both rules were described as enforced in CI, by
  tools the repository did not have.
- `packages/core/test/leaks.test.ts` (§20.7 items 1–2): a real port served and
  closed with nothing left open, and 500 interleaved requests that never read
  one another's state.
- `packages/core/test/generated-source.test.ts`: everything the compilers emit
  for one fixture application, committed as a snapshot, so a compiler change is
  a reviewable diff of code. `UPDATE_SNAPSHOTS=1` regenerates it.
- `benchmarks/request-path`: three more byte-identical gates — a collection
  `when` turned off, a route without `use` beside one with it, and the
  `writeOnly` check emitting nothing — and the costs this release put on the
  request path.
- Thirty-seven negative controls, 126 in all; one control a refactor had made
  stale is updated, and the harness runs a script as a control's suite.

## [0.1.0-alpha.3] — 2026-10-03

URL generation, §5.7 of the architecture: `app.url()` builds the path of a
named route, and a path it returns is one that route answers with the values it
was given — or it throws. And `@erenthedeveloper0/zen-openapi`'s API diff now
compares what a schema says rather than how its converter spelled it, which is
what an update to zod 4.6 turned out to need.

### Added

- **`app.url(name, params?, query?)`** (§5.7) — the path of a named route:
  `app.url('notes.show', { id: 7 })` is `/notes/7`. Each value is
  percent-encoded as one segment and tested with its parameter's own type;
  `.`, `..` and an empty value, which no URL can carry to the route, are
  refused; and the compiled router is asked whether the path reaches the named
  route, so `/users/:id` given `me` beside a `GET /users/me` is refused rather
  than linked. The query is written the way the route parses it, lists
  included — repeated, comma-joined or bracketed, from its coercion plan. The
  result is always a path on the application's origin, which `ctx.redirect()`
  sends without consulting `redirect.allowExternal`. Checked when it is
  called: route names are not part of the app's type (§5.7 says why). A
  refusal names the parameter and the shape of the value, never the value —
  a link is where reset tokens live, and refusals are logged.
- `Collection#url` and `Registrar.url` — the same function, for a feature
  module that is handed a collection and for a plugin's handlers.
- Error code `ZEN_ROUTE_UNKNOWN`: `url()` named a route nothing registered, and
  the message suggests the name that was probably meant. `ZEN_PARAM_MISMATCH`,
  reserved since the first release, is now produced — by `url()`, for
  parameters its route cannot carry. Both are 500 and never exposed, and both
  are in [docs/errors.md](./docs/errors.md).
- `UrlTable`, `UrlParams`, `UrlQuery` and `UrlValue`, and `closest` /
  `editDistance` — the "did you mean" behind every suggestion — exported from
  `@erenthedeveloper0/zen-core`.
- `benchmarks/url`: two CI gates — a link never reaches another route, and
  naming or linking routes changes no generated byte — and what a link costs.
- `examples/middleware` answers `201 Created` with a `Location` built by
  `url()`, and its pages link with it.
- Eighteen negative controls, 89 in all.

### Fixed

- **The API diff reported equivalent schemas as breaking.** zod 4.6 writes a
  nullable string as `type: ['string', 'null']` where 4.4 wrote
  `anyOf: [{ type: 'string' }, { type: 'null' }]`. `diffDocuments` read types
  from `type` alone, so updating zod, which changed nothing on the wire,
  failed `openapi:check` with two `OAS_TYPE_WIDENED`. It now compares what a
  schema says: unions are read through, `null` branches set aside, and `const`
  is a one-value `enum`.
- **…and missed real changes inside a union.** Nothing looked inside `anyOf`,
  so a field removed from a nullable object, or a type added to a union, passed
  the gate. A nullable union is now compared as its one non-null branch, fields
  and all; a union of several is compared by the types it admits.
- **…and overflowed the stack on a recursive schema.** Its cycle guard was
  keyed on the location, which grows at every level and so never repeats, and
  any recursive component — a tree, a comment thread — crashed
  `openapi:check`. It now stops where a component repeats on the path being
  compared, and still reports a shared component's change once per use.
- The architecture described two things as built that were not: a collection's
  `name` prefixing its routes' names (§6.3) and a boot-time check of a `params`
  schema against its path (§5.2). Both are corrected in place — the first
  decided against, the second recorded as a gap (§28.8).

### Changed

- `Registrar`, the interface a plugin's `setup` receives, has a new member,
  `url`. Only Zen implements it; a hand-written test double needs the method.

### Repository

- zod 4.6.5 for the examples and @types/node 22.20 for the build — the update
  Dependabot proposed, which the API gate refused until the fix above.

## [0.1.0-alpha.2] — 2026-09-29

The two injection defences §19.5 of the architecture described for two
releases before either existed: HTML escaped by construction, and redirects
that stay on the application's origin. Both change existing behaviour, and the
change is the point — see **Changed** for what to do.

This version was first tagged on 2026-09-28, and its release run stopped at its
first `npm publish`, before anything reached the registry. Before it was
published, a review found that the new `html` tag could be misled by a template
HTML and SVG read differently — which a spec-conformant HTML parser confirmed,
and now checks over random pages — so the tag was moved to the commit that
fixes it, together with the header and release-workflow fixes below. Nothing
had been published under the first tag.

### Added

- **`html`, a tagged template that escapes by position** (§19.5.1). Every hole
  is escaped for where it sits: element content, a quoted attribute, a URL
  attribute — where `javascript:`, `data:`, or any scheme but http, https,
  mailto and tel is replaced with `about:invalid#zen-unsafe-url` — and
  `<script src>`, `<base href>`, `<form action>`, `formaction`, `<object data>`
  and `<embed src>`, whose origin a hole may not choose. A template that puts a
  hole where no escaping helps — inside `<script>` or `<style>`, in an `on*`
  handler, in `srcdoc`, in a tag or attribute name, in an unquoted value, in a
  comment, in an SVG animation value, in a `<meta http-equiv="refresh">` — is
  refused on its first render with `ZEN_HTML_UNSAFE`, naming the hole.
  Templates are analysed once per call site and cached.
- **Both readings of a page, HTML's and SVG's** (§19.5.1). HTML ends a
  `<title>`, `<textarea>`, `<noscript>`, `<iframe>`, `<xmp>`, `<noembed>` or
  `<noframes>` at the first `</name` in it, and reads `<script>` and `<style>`
  as script and text; inside `<svg>` or `<math>` all of them hold markup. A
  template on which the two readings disagree about where an element ends is
  refused — a text element's end tag inside an attribute value, a comment or a
  tag; a `<style>`, or a `<script>` inside `<svg>`, whose text SVG would read as
  markup; a CDATA section holding a `>`; a template that leaves a text element or
  an `<svg>` open. A fragment is refused where it is nested if it could end the
  text element it lands in, or carry a `<script>` only HTML can read into SVG.
  `<noscript><p title="</noscript><img src=x onerror=${x}>">` put `x` in an
  event handler under the first version of the tag.
- **`SafeHtml`**, the type `html` returns, and **`unsafeHtml(markup)`**, the
  explicit mark for markup the application vouches for. A handler may return
  `` html`…` `` directly, the way it returns a string. Also `escapeHtml(text)`,
  `isSafeHtml(value)` and `NEUTRAL_URL`.
- **`redirect.allowExternal`** (§19.5.2) — the origins `ctx.redirect()` may
  leave for: none by default, a list, or `true` for any http(s) target. A
  malformed entry is a `ZEN_CONFIG_INVALID` boot error with the spelling that
  would have matched.
- **`ctx.redirect(to, { status, allowExternal })`** — the second argument may
  be an object, and `allowExternal: true` lets one redirect leave for a target
  the application built itself. `ctx.redirect(to, 303)` still works.
- **`isLocalUrl(target)`** — the framework's own "does this stay on the origin"
  check, for a `?next=` before redirecting to it. Also `classifyReference`,
  `UrlReference`, `compileRedirectPolicy`, `redirectRefusal` and
  `SAME_ORIGIN_ONLY`.
- Error codes `ZEN_HTML_UNSAFE` and `ZEN_REDIRECT_EXTERNAL` — both 500, never
  exposed — with their entries in [docs/errors.md](./docs/errors.md).
- `benchmarks/injection`: three CI gates — a hostile value never escapes its
  hole, a hostile redirect never reaches an origin its policy does not name, a
  redirect policy changes no generated byte — and what each defence costs.
- A property suite in which parse5, a spec-conformant HTML parser, parses 2,000
  random pages — HTML's text elements, SVG and MathML, fragments nested in
  fragments — and asserts every value landed as text or in an attribute that
  cannot run it. It is a dev dependency of the repository, not of any package.
- Twenty-seven negative controls, 71 in all.
- `examples/middleware` renders its notes as pages with `html`, follows `?next=`
  only when it stays on the origin, and redirects to an allowlisted identity
  provider.

### Changed

- **`ctx.html()` takes `SafeHtml`, not a string.** `ctx.html('<p>' + name)` is
  now a type error, and a `ZEN_HTML_UNSAFE` 500 for a caller without types.
  Build the page with `` html`…` ``, or mark markup that is already safe with
  `unsafeHtml()`. `htmlReply()` changes the same way.
- **`ctx.redirect()` no longer leaves the origin by default.** A target with a
  scheme or an authority — `https://…`, `//…`, and the spellings browsers treat
  alike, such as `/\evil.example` — is `ZEN_REDIRECT_EXTERNAL`, with no
  `Location` sent, unless its origin is in `redirect.allowExternal`. An
  application that redirects to an identity provider lists that origin; one
  that redirects to a URL from the request checks it with `isLocalUrl` first.
  `redirectReply()` called without a policy applies the same default.
- `@erenthedeveloper0/zen-openapi`'s viewer marks its page with `unsafeHtml` at
  boot — it escapes the document itself — and uses core's `escapeHtml`.
- **A header is checked against the grammar Node enforces, where it is set.** A
  name must be a token and a value may hold tabs, spaces, visible ASCII and
  obs-text — no other control character and nothing past U+00FF — or it is
  `ZEN_HEADER_INVALID`. Before, only CR, LF and NUL were refused, and Node's own
  error for the rest came later, outside the error path. Encode a value for its
  header — a download name as `filename*=UTF-8''${encodeURIComponent(name)}`.
- A redirect target past ASCII — `/café`, `/日本` — is sent percent-encoded as
  UTF-8, which is what a browser makes of it; it was a 500. The policy is
  decided on the target as written.

### Fixed

- **A header or cookie staged on `ctx.res` that could not be written escaped
  the error path.** It was checked only at egress, after the handler returned;
  the error reply carried the same staged header and failed the same way, so
  `inject()` threw and a socket got the adapter's last-resort 500, with no
  problem document and no `onResponse` hook. `ctx.res.header()`,
  `appendHeader()`, `removeHeader()`, `cookie()` and `clearCookie()` now throw
  `ZEN_HEADER_INVALID` where they are called, and the error reply goes out
  normally. Egress no longer checks what staging already did, so the middleware
  pack costs no more than before.

### Packaging

- The release workflow's publish job pins its actions to commits and npm to an
  exact version, restores nothing from the Actions cache, reads no npm token —
  only trusted publishing's short-lived one — and, when a publish is refused,
  says which package and what to check. A re-run finds an existing GitHub
  release instead of failing on it. [RELEASING.md](./RELEASING.md) documents
  `npm trust` and the *allow publish* permission a trusted publisher now needs.

## [0.1.0-alpha.1] — 2026-09-27

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

[0.1.0-alpha.4]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.1
