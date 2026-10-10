# Changelog

All notable changes to Zen. The packages are versioned together; every entry
applies to all six. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Zen is an alpha: until `1.0`, any prerelease may change the API.

## [0.1.0-alpha.5] — 2026-10-09

The hot path, measured. Every benchmark here until now compared Zen with
itself — a feature against its absence — which is the right instrument for a
zero-cost claim and cannot test the thesis. RFC §1.4 says Zen's per-request
work should be within noise of a hand-written `http.createServer` handler doing
the same job, "and if that is not true in benchmarks, the thesis has failed and
we should say so". This release measures it, against `node:http`, Fastify, Hono
and Express on Annex C's first six workloads, before and after each of the
three fixes aimed at the request path — and says so: Zen serves 0.79–0.82× of
`node:http` on every workload without I/O, where Fastify serves ~1.0×.
[`benchmarks/results/competitors.md`](./benchmarks/results/competitors.md) has
the numbers, the losses first.

The fix that moved the number is the one the first run pointed at: a JSON body
paid for a reviver it almost never needed, and the POST workload went from
0.49× of `node:http` to 0.79×.

### Added

- **`benchmarks/competitors`** — Zen against `node:http`, Fastify 5, Hono 4 and
  Express 5, on Annex C workloads 1–6: static JSON, a response schema, five
  path parameters, a ~1 KB POST validated with Zod, ten middleware, and a
  realistic chain (JWT, rate limit, Zod, a 5 ms stubbed query, ~2 KB out).
  Correctness is checked before anything is timed. An npm project of its own,
  with its own lockfile, so the frameworks it compares against never enter the
  install the release publishes from. CI runs it as a smoke pass; it is not a
  CI timing gate.
- **Issue codes that survive a translated message** (I7, §11.2).
  `registerIssueMapper(vendor, issue => code | undefined)` reads a library's own
  issue fields — Zod's `code`, Valibot's `type`, ArkType's `code` — where the
  code used to be guessed from English message text. The vocabulary is the
  exported `IssueCode`: `required`, `type`, `format`, `min`, `max`, `custom`,
  `invalid`. Every example's `shared/zod.ts` registers the Zod mapper, and
  `examples/coercion` checks real Zod's codes in English and in Turkish.
- **Ingress limits in the Node adapter** (§4.2 stage 2, §19.2):
  `maxHeaderSize` (8 KB), `maxUrlLength` (8 KB) and `maxRequestsPerSocket`
  (0, no limit). A request target past `maxUrlLength` is answered 414
  `ZEN_URI_TOO_LONG` before dispatch — no hook runs, no context is built — with
  `Connection: close`. A limit that is not a whole number is
  `ZEN_CONFIG_INVALID` when the adapter is made.
- **`inspect: true`** keeps every compiled unit's source after boot, for
  `app.generatedSource()` (below). `dev: true` implies it.
- `explainRoute()` prints a `sync path` row — whether a request on the route can
  finish without a promise, and if not, which member makes it wait.
  `describeSyncPath()` and `MAX_SPECULATION` are exported.
- Two codes: `ZEN_URI_TOO_LONG` (414) and `ZEN_INSPECT_DISABLED`.

### Changed

- **Headers larger than 8 KB are refused with 431.** The Node adapter now sets
  `maxHeaderSize` to §19.2's 8 KB; Node's own default, which applied until now,
  is 16 KB. The request line counts toward it. An application whose clients
  send large cookies or tokens restores the old allowance with
  `nodeAdapter({ maxHeaderSize: 16_384 })`.
- **`app.generatedSource()` throws `ZEN_INSPECT_DISABLED`** on an app built
  without `inspect: true` or `dev: true`. Every unit's source and externals used
  to be kept for the life of the process: measured on Node 24 at 10,000 routes
  with a validator, a middleware and a hook each, 54 MB of heap after boot with
  them and 37 MB without — 31% less. It refuses rather than returning an empty
  list, because an empty list is also what "nothing was compiled for this"
  looks like, and the zero-cost gates read exactly that. `CodeGen` keeps units
  only with `retain: true`, and `CodeGen.units` refuses likewise.
- **`ctx.log` is bound to the request** (§7.2, §31.1): a child of the
  application's logger with `requestId` and `route` (the path template), made
  on its first read and made again when `ctx.id` changes — so a line written
  after `requestId()` adopts an inbound id carries that id. A request that never
  logs makes no child; one that does calls `child()` once, ~40–60 ns with the
  default logger. `ctx.id` is an accessor on both context twins; the field
  count, and so the hidden class, is unchanged.
- **A missing value's issue code is `required`**, whatever the library calls
  it: Zen decides it from the input it validated, before any mapper is asked.
  With no mapper registered, every other code is still inferred from the
  message, as before.
- **Plain functions reach the synchronous pipeline** (§8.4). A function that is
  neither `async` nor marked with `markSync()` is a speculation point: the
  call, a thenable test, and the rest of the route as a continuation that runs
  at once when no promise appeared. A route of plain functions with no `around`
  and no body to read compiles with no `async` and no `await`. A segment
  holding an `async` member compiles as before, byte for byte, and
  `pipeline: 'simple'` still opts out. More than 32 speculation points in one
  chain compile to the async form, which bounds the stack.

### Performance

Measured on one machine (Apple M5, Node 24), 5 runs of 10 s after a 3 s
warm-up — shorter than Annex C's protocol, on a laptop rather than a dedicated
host, with the load generator on the same machine. Ratios within a run are the
claim; absolute numbers are this machine's.

- **JSON intake.** A body that cannot hold a key named `__proto__`,
  `constructor` or `prototype` — no such word and no `\u` escape anywhere in it
  — is parsed with no reviver; any other body is revived exactly as before.
  The depth limit is checked by visiting containers only, with the same
  verdict, held differentially over 3,000 random nestings. On a clean ~1 KB
  body, intake is 5.8× faster than alpha.4 on Node 22 and 5.5× on Node 24 —
  gated at 5× in `benchmarks/request-path` — and 3.5× on Node 26, whose V8 at
  times optimises the reviver path itself to under 4× a bare parse, which puts
  5× out of reach there; that run publishes its figure rather than gating it.
  End to end, the Zod POST workload went from 23,394 to 37,363 req/s.
- **Speculative sync** made no difference to throughput that this benchmark can
  resolve: the dispatcher around the pipeline is still an `async` function and
  awaits what the pipeline returns, so a request still costs that promise.
- **The router** builds the `Allow` set only on a miss — a served match
  constructs no `Set`, gated structurally — and reuses one capture list,
  guarded against a parameter type that matches a path itself. No end-to-end
  difference beyond noise either.
- **What it costs in code.** A speculative pipeline is longer than the `async`
  one it replaces — each speculation point ends a function and starts the
  next: a minimal route's pipeline went from 226 to 314 bytes of generated
  source, and the context class from 4,468 to 4,706 for the `id` and `log`
  accessors. Paid once, at boot; the byte-identical gates still hold, since
  they compare two builds of the same compiler.

### Documentation

- §3.4, §4.2 stages 0 and 2, §8.4 (and the trampoline, corrected: the stack is
  bounded at compile time, not by yielding), §11.2 with the Zod, Valibot and
  ArkType mappers, §19.2's header and URL rows, §31.1, §28.8's four rows,
  Annex B, the README's status lists and "The idea" listing — now the output of
  plain functions, with no `markSync()` — and the Node adapter's options table.
- The Valibot and ArkType mappers were checked by hand against Valibot 1.5.0
  and ArkType 2.2.7, through a Zen app; the repository installs neither, so CI
  does not hold them.

### Repository

- A tenth CI job: the competitor harness's smoke pass.
- `benchmarks/request-path` section 6: the hot path's gates and costs.
- Tests: a 2,000-text JSON differential against the reviver, plus the depth
  walk's; issue codes through a vendor seam and real Zod in two languages;
  the bound logger on both twins; the router's reused state; ingress limits
  over raw sockets; what an app keeps after boot.
- The claims ledger: 48 claims, 5 admitted gaps. `ctx-log` and `issue-codes`
  closed and are claims now; `ingress-guards` and `unit-retention` are new.
- Fifteen negative controls, one per new behaviour — 144 in all.

## [0.1.0-alpha.4] — 2026-10-08

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

This version was first tagged on 2026-10-05, and its release run stopped
before anything was published: on Windows under Node 22, a test in
`examples/deadlines` lost a race between two timers due in the same
millisecond (**Repository**, below). Nothing reached npm under that tag. It was
moved to the commit that keeps those timers 30 ms apart, together with the
fixes a second look at the release found, below.

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
- **A request id costs ~75 ns, where it cost ~460.** `generateRequestId`, which
  every request calls, encoded all 26 characters every time; requests that
  share a millisecond move only the last digit of the count between them, so
  the other 25 are kept and re-encoded only when the millisecond moves or the
  count carries. Every id is byte-identical to the one the full encoding
  writes — checked differentially over 400,000 ids, and held by a test and a
  control. A minimal served request through `inject()` went from ~1.7 µs to
  ~1.3 µs, on one machine.

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
- **`cors()` compiled an `origin: RegExp` again on every request** — a
  `new RegExp` per call, to drop its `g` flag, in the hook every request with
  an `Origin` runs, where I1 says no regex is compiled at request time. It is
  copied once, at boot: the match measures ~25 ns against ~128 ns before
  (paired arms, one machine), and allocates nothing. A sticky (`y`) pattern
  keeps its anchoring: `lastIndex` is put back to 0 before each test rather
  than the flag being dropped.
- A missing service's "did you mean" (`ZEN_DI_MISSING`) looked for the name's
  first four letters anywhere in another token's, so a typo in those four got
  no suggestion and an unrelated token could be offered. It uses `closest()`,
  the one definition of "close" every other suggestion uses.

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
- A second look before the release found sentences the first pass left: §5.2
  still called the `params` check unbuilt in the block after the sentence
  saying it was built; §7.4 said `ctx.state` exists; §13.2 and §28.8 named the
  wrong code for a returned `Response` — it is `ZEN_INTERNAL`, because it has a
  `status`, `headers` and `body` and is taken for a `Reply`; §18.3's C1 and
  §22.2's `source` still described a generated matcher; §21.8 said the OpenAPI
  client generator exists; §4.2 stage 0 said the Node server reads
  `config.http` and sets `maxRequestsPerSocket`; §5.5 and the router's README
  promised both routes' origins; and the published doc comments on
  `ValidationError` and `normaliseIssues` still promised byte-identical
  envelopes across schema libraries.

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
- Forty negative controls, 129 in all; one control a refactor had made
  stale is updated, and the harness runs a script as a control's suite.
- `npm test` reports a failing test as a GitHub annotation
  (`scripts/test-annotations.ts`), so a red run names the test on the commit
  and the run's summary — the job log is readable only with repository access.
- `examples/deadlines`: the test of an inbound budget sent `x-request-timeout:
  150`, which left the 90 ms `steady` provider a slice of 90 ms less whatever
  the request had spent. Its two timers came due in the same millisecond, and
  which one ran first was decided by the loop clock ticking between them —
  what failed the first release run. It sends 120 ms, keeping them 30 ms apart,
  and the provider's granted budget is held to the same window as every other.

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

[0.1.0-alpha.5]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/erenthedeveloper0/zen/releases/tag/v0.1.0-alpha.1
