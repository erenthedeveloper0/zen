<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/banner-dark.png">
  <img alt="zen.js — a compiler-first web framework" src="./.github/images/banner-dark.png" width="100%">
</picture>

<h3>A compiler-first web framework for Node.js</h3>

Express-simple. Fastify-fast. Typed end to end. No magic.

[![CI](https://github.com/erenthedeveloper0/zen/actions/workflows/ci.yml/badge.svg)](https://github.com/erenthedeveloper0/zen/actions/workflows/ci.yml)
[![npm (alpha)](https://img.shields.io/npm/v/%40erenthedeveloper0%2Fzen/alpha?label=npm%40alpha&color=7c5cff)](https://www.npmjs.com/package/@erenthedeveloper0/zen)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.6-3c873a)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-%E2%89%A5%205.0-3178c6)](https://www.typescriptlang.org)
[![Core dependencies](https://img.shields.io/badge/core%20dependencies-0-7c5cff)](./packages/core/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Architecture RFC](./ARCHITECTURE.md) · [Roadmap](./ARCHITECTURE.md#25-roadmap-mvp-to-v10) · [Trade-offs](./ARCHITECTURE.md#27-architectural-trade-offs) · [Error codes](./docs/errors.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-06.png">
  <img alt="" src="./.github/images/image-03.png" width="100%" height="4">
</picture>

> [!IMPORTANT]
> **Alpha.** Published to npm on the `alpha` tag for feedback, not for
> production: the API will change before `1.0`. See [Status](#status).

```bash
npm install @erenthedeveloper0/zen@alpha
```

```ts
import { zen } from '@erenthedeveloper0/zen'

const app = zen()

app.get('/', () => 'Hello world')

await app.listen(3000)
```

Two concepts: `app.METHOD(path, handler)`, and **the handler returns the response**.
That is one fewer than Express, because there is no response object to learn.

A schema is the whole contract — validation, the handler's types, the response
filter and the OpenAPI document all come from it:

```ts
import { zen, NotFound } from '@erenthedeveloper0/zen'
import { z } from 'zod'

const User = z.object({ id: z.number().int(), email: z.email(), name: z.string() })

const app = zen()

app.get('/users/:id<int>', { response: { 200: User } }, async (ctx) => {
  const row = await db.users.find(ctx.params.id)      // ctx.params.id is a number
  if (row === undefined) throw new NotFound(`User ${ctx.params.id} not found`)
  return row                                           // passwordHash is never sent
})

await app.listen(3000)
```

**Contents** — [The idea](#the-idea) · [What's different](#whats-different) ·
[Status](#status) · [In depth](#in-depth) · [Try it](#try-it) ·
[Layout](#layout) · [Examples](#examples) · [Contributing](#contributing)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-06.png">
  <img alt="" src="./.github/images/image-03.png" width="100%" height="4">
</picture>

## The idea

> A web framework is a compiler with an HTTP server attached.

Registration is the source language. The per-request path is the target language.
Routes, middleware chains, validators, serializers — **and the `Context` class's own
memory layout** — are compiled once at boot from a frozen application graph.

You can read what it emits:

```
$ node scripts/show-generated.ts

function seg1(ctx) {
  let r
  let out = d.handler(ctx)              // ← sync: no promise allocated
  let reply = d.finalize(out, false)
  return runAfters(ctx, reply)
}

async function seg0(ctx) {
  let r
  r = d.steps[0](ctx); if (r !== undefined) return runAfters(ctx, d.finalize(r, true))
  r = d.steps[1](ctx); if (r !== undefined) return runAfters(ctx, d.finalize(r, true))
  return d.steps[2](ctx, function () { return seg1(ctx) })   // ← the only closure
}
```

No array iteration. No dynamic dispatch. Stages the route doesn't use are not
emitted at all — not skipped by a runtime `if`, *absent from the source*.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-01.png">
  <img alt="" src="./.github/images/image-09.png" width="100%" height="4">
</picture>

## What's different

| Express problem | Zen |
| --- | --- |
| `req.user = x` | **Slots** — declared, typed, integer-indexed. `ctx.get(CurrentUser)` compiles to `this.$s[3]`. One hidden class per app, no global type augmentation |
| `next()` confusion | **Two named forms.** `app.use` (no `next`, zero closures) for the ~90% that never wrap; `app.around` for the 10% that must. The cost is legible at the call site |
| `res.send()` side effects | Handlers **return** a `Reply` value. Double-send and hung requests are structurally impossible; `around` can inspect the real reply with no monkey-patching |
| Silent route shadowing | Boot-time conflict analysis. Duplicates and genuine ambiguities are refused, with every diagnostic reported at once |
| Validation bolt-ons | **Standard Schema** — Zod, Valibot, ArkType work with zero adapters, and core depends on none of them |
| Wrong-method 404s | Free, correct 405 with an `Allow` header |
| Leaking `passwordHash` | Response schemas compile to a serializer that *cannot* emit undeclared fields — there is no `Object.keys` in the generated source to leak through |
| Docs that drift from the code | **OpenAPI is a projection of the app graph**, generated from the same schemas the serializer executes. A test asserts the documented fields equal the fields the wire actually carries |
| Timing middleware that stops the clock too early | **Twelve lifecycle phases.** `onResponse` runs after the last byte is flushed, so its number includes serialization and egress. Phases you don't use emit *no code* — asserted in CI as byte-identical output |
| `app.use(logger)` and hoping | Hooks scope to the app, a collection subtree, or one route — **lexically**. `explainRoute(record)` prints the resolved chain, generated from the same arrays the compiler consumed, so it cannot drift |
| A hung handler holding its socket forever | **Deadlines** per app, collection or route. The arm answers on time; the compiled pipeline stops the abandoned work at the next stage boundary instead of leaving it running behind an answered request |
| A timeout you cannot pass downstream | `ctx.timeLeft` is the *remaining* budget, so a fan-out gives each call a truthful slice instead of promising all four of them the original thirty seconds |
| One `/health` doing two jobs | **Liveness and readiness are separate**, and a check is readiness *unless it says otherwise* — because the other mistake, dependencies in the liveness probe, restarts the whole fleet during a database blip and then stops the pools reconnecting |
| 502s on every rolling deploy | Readiness flips to `draining` at the **top** of shutdown, before the socket stops accepting. Asserted over a real connection, mid-shutdown, because that ordering is the entire feature |
| A health check that hammers the thing it is checking | Results are cached and concurrent probes share one in-flight call: **500 simultaneous polls, one probe**. CI fails if that stops being true |
| `Number(process.env.PORT ?? 3000)` | **A validated environment**, checked before any plugin's `setup` runs, with the expected constraint read off the schema and the `.env` file and line named in the error |
| "Which config file set this?" | Resolution keeps a `{ value, layer, source }` record per value, so `explainConfig` prints the provenance. `{...a, ...b}` has no memory of `a`; a fold over records does |
| `console.log(config)` in a log aggregator | Marked secrets redact **themselves** on serialisation — `toJSON` and inspect hooks at every level — while the code that opens the connection still gets the real value by name |
| `/v2/` prefixes, and `res.format({...})` | **Representations are declared, not branched on.** One route can serve `v1+json`, `v2+json` and `text/csv`; `Accept` picks one before the handler runs, both JSON versions go through the same compiled serializer, and a route that declares one representation emits no negotiation code at all |
| `Accept: text/csv;q=0` served as CSV anyway | The **most specific** matching range decides, per RFC 9110 §12.5.1 — so `q=0` under a permissive wildcard means "anything except this". Scoring by the highest `q` is the obvious implementation and it serves the one format the client refused. CI gate, not a test |
| `res.send('<p>' + req.query.name + '</p>')` | **HTML escaped by construction.** `ctx.html()` takes `SafeHtml`, which the `html` tag builds by escaping every hole *for where it sits*: a `javascript:` URL in an `href` is replaced rather than escaped, and a template that puts a value inside `<script>` or an `onclick` — where no escaping helps — is refused on its first render |
| `res.redirect(req.query.next)` | **Redirects stay on the origin** unless one line lists where else they may go. `//evil.example`, `/\evil.example` and the other spellings that slip past a regular expression are read the way the browser reads the `Location` header, and refused |
| `` `/files/${name}` `` in a link | **Links are asked of the route.** `app.url('files.show', { name })` encodes each value as one segment, tests it with the parameter's own type, and asks the router whether the path reaches that route — so a value cannot become a different path, and `/users/:id` given `me` beside a `GET /users/me` is refused rather than linked |

Full reasoning, including the arguments that lost, is in [ARCHITECTURE.md](./ARCHITECTURE.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-10.png">
  <img alt="" src="./.github/images/image-05.png" width="100%" height="4">
</picture>

## Status

**Alpha — `0.1.0-alpha`.** The architecture RFC is complete; the implementation is a
working vertical slice, published on npm's `alpha` tag for feedback. Do not put this in
production: the API will change, and several subsystems the RFC describes are not built
(below). What *is* built has been through two pre-release audit passes that reproduced
each defect before fixing it, and [CHANGELOG.md](./CHANGELOG.md) lists every one.

| Package | |
| --- | --- |
| [`@erenthedeveloper0/zen`](./packages/zen) | install this — everything below, wired together |
| [`@erenthedeveloper0/zen-core`](./packages/core) | registries, compilers, runtime — zero dependencies |
| [`@erenthedeveloper0/zen-router`](./packages/router) | compiled radix router |
| [`@erenthedeveloper0/zen-adapter-node`](./packages/adapter-node) | Node `http` adapter |
| [`@erenthedeveloper0/zen-middleware`](./packages/middleware) | CORS, security headers, request ids, rate limiting |
| [`@erenthedeveloper0/zen-openapi`](./packages/openapi) | OpenAPI 3.1, `$ref` dedup, breaking-change detection |

Requires Node ≥ 22.6, and TypeScript ≥ 5.0 if you use TypeScript. The packages run on
Node today; the adapter boundary is designed for Bun, Deno and the edge
([§14](./ARCHITECTURE.md#14-adapter-abstraction)), and those adapters are not built yet.

### Working today

- Compiled context class, per-route compiled pipelines, generated params builders
- Backtracking radix router: static/typed/wildcard/optional params, `app.paramType()`, correct 405 with a complete `Allow`, `HEAD`→`GET`
- Boot-time conflict analysis with aggregated, rendered diagnostics — duplicate paths *and* names, ambiguous routes, and parameter types that can match the same value; registration order never decides which route answers
- `app.get/post/…/all(path, [spec,] handler)` and `app.listen(port)` — the Express spellings — alongside the spec and options forms
- Phase / around / after middleware at app, collection and route scope, collections, slots
- **The hook system**: all twelve phases, three lexical scopes, compiled into the pipeline, with mirror ordering so before/after pairs nest — and `explainRoute()` to print the resolved chain
- **Request deadlines**: per app / collection / route, `ctx.signal` wired to the timeout as well as to disconnect, `ctx.timeLeft` to propagate the remaining budget downstream, and abandoned work stopped at the stage boundary rather than left running behind an answered request
- **Health and readiness**: two endpoints answering two different questions, per-check budgets and cancellation, stampede-safe caching, and a `draining` state that goes red before the server stops accepting
- **Plugins**: manifests, semver dependency resolution, topological ordering, cycle/conflict/capability detection, context decorations with type accumulation
- **DI**: typed tokens, three lifetimes, request-scoped services stored in the slot array and disposed at the end of the request, boot-time cycle and captive-dependency analysis
- Standard Schema validation with normalised issues; RFC 9457 error envelopes
- **Coercion profiles**: `?page=2` is a `number` because the schema says `number` — schema-guided, so `?sku=00713` stays a string, and a source with nothing to convert emits no code
- **Configuration**: layered resolution that keeps the *provenance* of every value, a schema-validated environment checked before any plugin's `setup` runs, typed `app.config` / `ctx.config`, and secrets that redact themselves when serialised
- **First-party middleware**: `cors`, `securityHeaders`, `requestId`, `rateLimit` — each a global hook rather than middleware, so a preflight to a path with no route is answered and a 404 flood counts against the limit; and each *staging* its headers, so they are on the 404 and the 429 as well as the 200
- **Content negotiation**: one route, several representations, chosen from `Accept` before the handler runs — versioned JSON for free through the same compiled serializer, an encoder seam for everything else, `Vary: Accept` on every response including the 406, and *no emitted code at all* on a route that declares one representation
- **Compiled response serializers**: undeclared fields cannot be emitted, because the generated function has no key enumeration to emit them *through*
- **Injection defences**: an `html` template tag that escapes each interpolation for the position it sits in and refuses the positions where no escaping helps, a `ctx.html()` that takes only its `SafeHtml`, and a `ctx.redirect()` that will not leave the origin unless `redirect.allowExternal` says where
- **URL generation**: `app.url(name, params, query)` returns a path its route answers, with the values given — encoded, typed and checked against the router — or refuses; reachable from a collection and from a plugin, and always on the application's origin
- **OpenAPI 3.1**: `AppGraph → document` as a pure function, `$ref` deduplication, a dependency-free reference viewer, and breaking-change detection
- Body intake emitted **only** when a route declares a body; prototype-pollution stripping
- Node adapter with lazy `RawRequest` (no WHATWG `Request` construction), client disconnects wired to `ctx.signal`, and shutdown that drains and then closes keep-alive connections rather than waiting on them
- **Server-sent events** — `ctx.sse()`, with heartbeats, backpressure, a bound on what a slow client can hold, and a final `shutdown` event on drain
- **File responses** — `ctx.file(path, { root })` with root confinement, `ETag`/`Last-Modified`, 304 revalidation and single-range 206
- **Process lifecycle** — `SIGTERM`/`SIGINT` run the graceful shutdown; an uncaught exception is logged and shuts down with exit code 1; `listen({ signal })` aborts into the same sequence
- `inject()` in-process testing; streaming responses; graceful shutdown
- **Interpreted twins** for the pipeline, context, router and serializer, verified by differential suites

### Designed, not yet built

CLI (`zen dev`, `routes`, `build`, `doctor`) · typed client · non-Node adapters and the conformance suite · WebSockets · `app.isolate()` · resource and module routing · compression and static file serving (both need a platform, so they belong to an adapter-coupled package rather than to the middleware one — [§32.6](./ARCHITECTURE.md#326-what-is-not-in-the-pack)) · negotiation of language and encoding, as opposed to media type ([§28.8](./ARCHITECTURE.md#288-smaller-known-gaps)). The roadmap in [§25](./ARCHITECTURE.md#25-roadmap-mvp-to-v10) sequences them.

## In depth

Each subsystem below was built against a claim in [the RFC](./ARCHITECTURE.md), and
each claim is either measured by a benchmark or asserted by a CI gate — usually
both. Where a measurement came out worse than the claim, the claim was corrected.

### The M2 type-performance gate — passed

The biggest risk in the design ([§28.2](./ARCHITECTURE.md#282-typescript-compilation-cost--the-biggest-technical-risk)) is that plugin type accumulation makes `tsc` crawl in real codebases. Measured, not assumed — best of 3, with the run-to-run spread shown because a single cold run of a one-second workload is not evidence:

| Routes | Plugins | `tsc --noEmit` | Per route | Spread |
| --- | --- | --- | --- | --- |
| 100 | 4 | 0.73 s | 7.3 ms | 24% |
| 250 | 8 | 0.93 s | 3.7 ms | 10% |
| **500** | **12** | **1.07 s** | **2.1 ms** | **7%** |

~0.64 s of each figure is fixed `tsc` startup; the marginal cost is **≈0.9 ms per route** and does not degrade as the plugin chain deepens. `node benchmarks/typecheck/run.ts` reproduces it.

The first version of this harness ran once per cell and reported roughly double these numbers for the same code. [§28.2](./ARCHITECTURE.md#282-typescript-compilation-cost--the-biggest-technical-risk) keeps that measurement on the record and explains why it was the more interesting result.

The gate also found a real bug: five of eight HTTP verbs had untyped overloads, so `ctx` silently became `any` on them. Hand-written tests missed it because they all use `get` and `post`.

### Response contracts, measured

A route that declares `response: { 200: User }` compiles to a serializer that cannot emit `passwordHash` — not "does not", *cannot*: there is no `Object.keys` in the generated source. `node scripts/show-serializer.ts` prints it.

Speed is the secondary benefit, and the RFC's original "2–5× faster than `JSON.stringify`" was too optimistic. Measured (`node benchmarks/serializer/run.ts`):

| Response | Same fields as declared | Plus undeclared fields |
| --- | --- | --- |
| flat object, 5 fields | **2.1×** | 1.7× |
| list of 50 objects | **1.2×** | 2.6× |
| nested object + arrays | **1.3×** | 4.0× |
| string-heavy (escapes) | **1.7×** | 2.2× |

On *identical work* it is **1.2–2.1×**. The bigger numbers come from skipping fields, which is real but is partly doing less work rather than doing the same work faster. V8's `JSON.stringify` is a tuned C++ path; [§13.3.2](./ARCHITECTURE.md#1332-measured-throughput) has the full account, including the two measurements that changed the implementation.

### Documentation that cannot drift

`AppGraph → OpenAPIDocument` is a pure function ([§29](./ARCHITECTURE.md#29-openapi--code-generation)). The interesting part is not that it generates a document — every framework has a plugin for that — it is that the document is generated from **the same schemas the serializer executes**, with Zen's `additionalProperties` rule applied ([§13.3.1](./ARCHITECTURE.md#1331-the-one-deliberate-deviation-from-json-schema)), so it says exactly what the wire will carry:

```
handler returned : {"id":1,…,"passwordHash":"$2b$12$…","totpSecret":"JBSWY3DPEHPK3PXP",…}
wire             : {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin","createdAt":"…"}
document says    : properties: id, email, name, role, createdAt   additionalProperties: false
```

The test suite asserts that by running values through the real compiled serializer and comparing key sets — so a document that promises a field the serializer drops fails the build.

Measured (`node benchmarks/openapi/run.ts`, best of 5):

| Routes | Components | Generation | Per route | Document |
| --- | --- | --- | --- | --- |
| 100 | 42 | 1.6 ms | 16 µs | 74 kB |
| 250 | 102 | 3.8 ms | 15 µs | 183 kB |
| **500** | **202** | **8.0 ms** | **16 µs** | **365 kB** |

Once, at boot. The per-request difference between an app with the plugin and the same app without it is **inside the run-to-run noise** — the endpoint serves a string built during `ready()`.

`$ref` deduplication removes **77%** of the document. Naming your schemas is worth a further 8%, which is less than expected and is [published as such](./ARCHITECTURE.md#298-measured-cost); the reason to name them is stable client type names, not bytes.

Breaking-change detection ships with it: `diffDocuments(before, after)` classifies each change as breaking, compatible or documentation-only, using the rule that requests are contravariant and responses are covariant. `npm run openapi:check` is a working gate.

### Hooks that cost nothing when unused

Twelve lifecycle phases ([§9](./ARCHITECTURE.md#9-hook-system-specification)), at three lexical scopes:

```ts
app.hook('onResponse', metrics)                            // every route
app.collection('/admin', { hooks: { onRequest: audit } })   // this subtree
app.get('/x', { hooks: { onSend: cacheHeader } }, handler)  // exactly here
```

Every other framework with hooks keeps a table and walks it per request, and pays a small cost for every phase forever. Zen compiles them into the pipeline, so **a phase nobody registered emits no source text**. That is not a claim you should take on a benchmark, so CI does not: it compiles a route in an app with no hooks and the same route in an app with eight phases registered on a different collection, and fails the build unless the two generated pipelines are **byte identical**.

Measured (`node benchmarks/hooks/run.ts`, paired sampling, Node 26):

| | |
| --- | --- |
| A phase you don't use | **0 bytes**, byte-identical pipeline — asserted, not timed |
| 1 `onRequest` hook | +2 ns over none |
| 16 `onRequest` hooks | +9–13 ns over none, i.e. **≈1 ns each** |
| One hook on each of 6 phases vs 6 on one | inside noise — the cost is per hook |
| Hooks vs phase middleware | Identical generated source after renaming the array |
| Compiled pipeline vs the interpreted twin | ≈1.6× |

The hook rows are a range because that is what the harness resolves: a call site at this scale is a few nanoseconds and consecutive runs move by a few nanoseconds. Quoting one figure to two decimals would be reporting the noise. The first row is not a range, because it is not a measurement.

What the phases buy, in [`examples/observability`](./examples/observability) — a complete metrics + request-log + `Server-Timing` stack, one plugin, ten phases, nothing patched:

```
Server-Timing: parse;dur=0.223, validate;dur=1.790, handler;dur=0.940, epilogue;dur=0.237, total;dur=3.355
logged:        POST /checkout 201 3.967ms parse=0.22 validate=1.79 handler=0.94
```

The logged total is larger, and that gap is egress. A response-time middleware cannot see it, because `onResponse` is the only thing that runs after the last byte is flushed. Meanwhile four requests to `/products/1..4` produce exactly one metric series — the label comes from the route *template*, because that is what the `onRoute` hook is handed; there is no raw URL available to accidentally label on.

### Deadlines, not timeouts

You configure a **timeout**, which is a duration. A request carries a **deadline**, which is an instant. A service told "you have 30 seconds" that forwards *30 seconds* to each of four sequential calls has quietly promised two minutes; one that forwards the time remaining has not.

```ts
const app = zen({ timeout: { default: '30s', header: 'x-request-timeout' } })

app.collection('/reports', { timeout: '10s' }, …)          // a slower subtree
app.get('/status', { timeout: '250ms' }, handler)          // one fast route
app.get('/feed',   { timeout: false },    handler)         // a stream, refusing it

app.get('/quotes', async (ctx) => {
  // The budget is a value. This is the whole point.
  const slice = ctx.timeLeft - EGRESS_RESERVE
  return Promise.allSettled(providers.map((p) => p.quote({ budgetMs: slice, signal: ctx.signal })))
})
```

Two mechanisms, because one is not enough. The **arm** answers on time, so a hung handler cannot hold its connection until the process restarts. It cannot make the *work* stop — you cannot interrupt a running `await`. So the compiled pipeline also checks at each [§4.1](./ARCHITECTURE.md#41-the-eleven-stages) stage boundary, and a request that is already over stops there instead of validating a body and querying a database for an answer nobody will read.

That second half is what a compiled framework gets nearly free: the boundaries are known statically, so the checks are two or three branches on routes that asked for a deadline and **no emitted text at all** on routes that did not — the same gate as the hooks, run the same way.

| | |
| --- | --- |
| A route with no deadline | **0 bytes** — byte-identical to three other configurations, asserted in CI |
| Each stage boundary | ≈1 ns, and measurably above the noise |
| Arming one | ≈1 µs — a timer, an `AbortController`, a listener, a promise |
| A synchronous route | Cannot time out. It never yields, so its timer cannot run — and it cannot hang either |

The microsecond is the honest headline and it is why the default is **off**: against a route that does nothing it is a large fraction of a small number, against a route that talks to a database it is under half a percent, and Zen does not levy costs nobody asked for. It is also the one line every public service should write. A coarse timer wheel would remove most of it and is not built.

`onTimeout` is handed the **stage** it blew in, because the pipeline marked it on the way past — so a 504 says "the handler stage blew a 2 s budget after 2.04 s" rather than "timeout". [`examples/deadlines`](./examples/deadlines) uses that to answer 200 with a partial result instead of 504 with none:

```
GET /quotes                200  { quotes: [fast, steady], missed: ['slow'], partial: true }
GET /quotes/best-effort    200  x-degraded: deadline — served from onTimeout
GET /feed/live             200  timeout: false, streams to the end
```

### Two health endpoints, because there are two questions

`/healthz` asks *should the orchestrator restart me?* `/readyz` asks *should the load balancer send me traffic?* Conflating them is why deployments 502 — and the mistake is worse in the other direction, because a liveness probe that checks the database tells every pod to restart at once during a blip, which then guarantees the pools never reconnect.

So a check is **readiness unless it says otherwise**. Reaching liveness takes a word a reviewer can see.

```ts
app.use(healthPlugin, { path: '/healthz', readiness: '/readyz', checks: ['db', 'payments'] })

app.health('db', async (signal) => { await pool.query('select 1', { signal }) })
app.health('cache', probe, { critical: false })        // reported, not fatal
app.health('lag',   probe, { kind: 'liveness' })       // deliberate, and visible
```

`checks: [...]` is an assertion, not a filter: if nothing registered `payments`, the app **refuses to boot**. Delete the plugin that owned that probe and you would otherwise keep answering 200 for a dependency nobody is watching — the same failure [§9.7](./ARCHITECTURE.md#97-phases-this-build-cannot-fire) refuses for hooks.

| | |
| --- | --- |
| Each check | Its own budget and its own `AbortSignal`, so a wedged dependency is **cancelled**, cannot hold the endpoint, and cannot hide a healthy one's answer |
| 500 simultaneous polls | **1 probe.** Cached by TTL, concurrent probes share one call — CI fails if that regresses |
| Shutdown | `/readyz` goes 503 *first*, and the process keeps answering for the whole drain window |
| An app route | **0 bytes.** Registering the plugin leaves the generated pipeline byte-identical |

Building it found that the shutdown sequence had been running [§4.5](./ARCHITECTURE.md#45-graceful-shutdown)'s steps inverted — pools disposed *during* the window in which traffic is still arriving. Invisible for as long as it was, because the drain delay defaults to zero and nothing could ask the question. [`examples/health`](./examples/health) lets you watch the fixed version:

```
curl -sX POST localhost:3000/control/db/down
GET /readyz    503   { status: fail, checks: { db: { status: fail } } }
GET /healthz   200   ← out of the load balancer, not out of the fleet

curl -sX POST localhost:3000/control/payments/hang
GET /readyz    503   { checks: { payments: "probe exceeded its 600ms budget", db: pass } }
```

### `?page=2` is a number

A query string is text. `?page=2` has no way to say *the number two*, so every
framework deals with it somehow, and all the answers are bad: Express hands you
`'2'`, and the Zod-on-anything pattern makes you write `z.coerce.number()` on
every numeric field of every query schema forever — where forgetting it produces
**no error at all**, because `'2' > 1` is `true`.

Zen's position is that the schema already contains the answer
([§11.4](./ARCHITECTURE.md#114-coercion-profiles)):

```ts
app.get('/catalog', {
  query: z.object({
    page:    z.number().int().min(1).default(1),   // ?page=2      → 2
    inStock: z.boolean().optional(),               // ?inStock=on  → true
    tags:    z.array(z.string()).default([]),      // ?tags=sale   → ['sale']
    sku:     z.string().optional(),                // ?sku=00713   → '00713'
  }),
}, ctx => svc.search(ctx.query))                   // every field already the right type
```

Each source's schema is converted to JSON Schema once at boot — the same probe
the response serializer and the OpenAPI generator use — and a plan is compiled
into that route's validator. Three rules fall out, and each one is a promise
that could only be broken silently:

| | |
| --- | --- |
| A position that accepts a string | is **never** converted. `?sku=00713` stays `'00713'`, and so does `z.union([z.string(), z.number()])`. Ambiguity is left alone too: if a schema takes a number *or* a boolean, the wire cannot say which `'1'` meant |
| Coercion cannot fail | A value it will not convert passes through **unchanged**, and the schema rejects it with the schema's own message and path. There is one authority on what a valid request is, and it is not the coercer |
| Nothing to convert | **no code.** Not an empty function — no function. Asserted against the generated bytes in CI |

The sharpest case is precision: `?id=9007199254740993` is an ordinary Postgres
`bigint`, and `Number()` turns it into `…992`. An integer-typed value that does
not survive the round trip is left as a string so the schema reports it, because
a visible 400 beats a silent off-by-one on a primary key.

`npm run explain -w @erenthedeveloper0/zen-example-coercion` prints the derived **plan** rather
than the profile — an outcome, not a policy, because the question is never "is
numeric coercion on" but "why did `?sku=00713` survive and `?page=2` not":

```
  GET /catalog                          → catalog.search

    coerce      query: page → integer, limit → integer, inStock → boolean, tags → array of string (repeat)
    validate    query
    handler     searchCatalog
```

That plan lives on the `RouteRecord`, so it is also what the OpenAPI generator
reads: a route with `arrays: 'comma'` is documented as `style: form, explode:
false`, and a generated client sends what the server actually parses. Nobody
wrote the mapping twice.

It is not faster. Converting a string to a number costs what it costs, and the
head-to-head against a hand-written `z.coerce` is inside the benchmark's noise
(+65 ns per field converted, either way). What it buys is that the behaviour
follows from the declared type instead of from whether somebody remembered —
`examples/coercion` builds the same service both ways and asserts they answer
identically.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-08.png">
  <img alt="" src="./.github/images/image-03.png" width="100%" height="4">
</picture>

### Configuration that can answer "where did this come from?"

Almost every Node service starts with this line, and it is wrong in two ways
that only show up in production:

```ts
export const config = { port: Number(process.env.PORT ?? 3000) }
```

`PORT=abc` produces `NaN`, which `listen` accepts. And when `DATABASE_URL` is
missing, nothing fails until the first request that touches the database.

```ts
// zen.config.ts
export default defineConfig({
  env: z.object({
    NODE_ENV:     z.enum(['development', 'test', 'production']).default('development'),
    PORT:         z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1).meta({ format: 'password' }),   // ← the secret marker
    PAGE_SIZE:    z.coerce.number().int().min(1).max(100).default(25),
  }),

  server:     { port: env => env.PORT },
  database:   { url: env => env.DATABASE_URL, poolSize: 10 },
  pagination: { pageSize: env => env.PAGE_SIZE, maxPageSize: 100 },
})
```

```ts
const app = zen({ config, env: envSources() })
await app.listen()                       // the address comes from config.server
```

Validation runs **before anything else boots**, and that is literal: a bad
environment means no plugin's `setup` has run, so nothing has opened a
connection pool ([§16.2](./ARCHITECTURE.md#162-schema-validated-environment)).
Problems are aggregated, because a developer setting up a service has three of
them at once:

```
Boot failed: 2 problems

  1. ZEN_ENV_INVALID  DATABASE_URL — ******** was rejected: Too small: expected
     string to have >=1 characters (expected: string, min length 1)
     at .env.production:4
     fix: Correct DATABASE_URL where it is set (.env.production:4).
     also: Read by jwt, which will not work without it.

  2. ZEN_ENV_INVALID  PAGE_SIZE — "1000" was rejected: Too big: expected number
     to be <=100 (expected: integer, between 1 and 100)
     at process.env
```

Four things there are mechanisms rather than prose. **`expected:` is read off
the schema**, through the same JSON Schema probe the response serializer and the
OpenAPI generator use — nobody wrote "between 1 and 100", so nobody can forget
to update it. **`at .env.production:4`** is why the `.env` parser returns line
numbers. **`used by jwt`** comes from the plugin's *manifest*, which is why it is
readable before any plugin runs. And **`********`** is there because
`DATABASE_URL` is marked and `PAGE_SIZE` is not: `PORT="abc"` is only actionable
if you can see the `"abc"`, and a secret is only safe if you cannot.

Then `npm run config:explain` answers the question no other framework can, because
`{...a, ...b}` has no memory of `a`:

```
  server.port             3000                 ← zen.config
  server.host             127.0.0.1            ← default
  database.url            ********             ← zen.config  (redacted)
  mailer.from             orders@example.com   ← mailer
  mailer.timeout          3s                   ← zen.config
  pagination.pageSize     25                   ← .env:19

  default   default         0 of   2 kept
  plugin    mailer          2 of   3 kept
  config    zen.config     13 of  13 kept
  dotenv    .env            6 of   6 kept
```

Resolution does not produce values, it produces records — `{ value, layer,
source }` per leaf — and `app.config` is the projection that drops the
provenance. So `mailer.from ← mailer` next to `mailer.timeout ← zen.config` is a
fact rather than a guess: a plugin's defaults merge **field by field**, which is
the difference between a default and a template. And `default 0 of 2 kept` says
the framework's own `server.port` is a real layer that lost, not an `?? 3000`
hiding inside `listen`.

Config is deeply frozen after boot, and it **redacts itself when serialised** —
`toJSON` and `nodejs.util.inspect.custom` at every level, so `console.log(app.config)`,
`JSON.stringify(app.config.database)` and a structured logger all produce
`********`, while the code that opens the connection gets the real value by
asking for it by name. `ctx.config` costs nothing: it is a getter over the
app-wide object every context already carries, so a route that never reads
configuration compiles to a byte-identical pipeline **and a byte-identical
context class** — gated in CI, because the tempting change is to make it a field.

Against the plain module it replaces, reading `ctx.config.x.y` measures inside
the benchmark's noise. That is the correct result: what this buys is at boot and
in the diagnostics, not in the hot path.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-02.png">
  <img alt="" src="./.github/images/image-09.png" width="100%" height="4">
</picture>

### CORS that runs on the request the browser actually sends

`@erenthedeveloper0/zen-middleware` ships `cors`, `securityHeaders`, `requestId` and `rateLimit`.
The interesting thing about them is not that a framework has CORS — every
framework does — but that building them started by measuring whether the usual
shape works. It does not:

| registration | ran on a matched `GET`, an unmatched path, and a preflight |
| --- | --- |
| `app.use(fn)` — phase middleware | **1 of 3** |
| a global `onRequest` hook | **3 of 3** |

Phase middleware lives inside a route's compiled pipeline, so a request that
matched no route has no middleware. A browser sends `OPTIONS /api/notes` before
any cross-origin write, almost nobody registers an `OPTIONS` route, and a
`.use()`-registered CORS middleware therefore never runs on the one request the
whole mechanism exists for. The browser reports the failure on the *next*
request — in a file that is correct — and the usual resolution is `origin: '*'`.

So every member of the pack is a plugin that registers a global hook:

```ts
app.use(securityHeaders())
app.use(cors())                    // the allowlist comes from config.cors.origin
app.use(rateLimit())
app.use(requestId({ trustHeader: false }))
```

The second half is what those hooks *do*. They never write a reply's headers;
they stage them through `ctx.res`, which egress applies on every path — success,
error, timeout and unmatched alike. An `after` middleware cannot: [§4.6](./ARCHITECTURE.md#46-the-error-path)
keeps the error path out of user middleware entirely. The difference is a whole
column:

```
case                    status  access-control-allow-origin   x-content-type-options   ratelimit
a served request        200     https://notes.example         nosniff                  limit=120, remaining=119
a 404                   404     https://notes.example         nosniff                  limit=120, remaining=118
a 422 (bad body)        422     https://notes.example         nosniff                  limit=120, remaining=117
a 401                   401     https://notes.example         nosniff                  limit=120, remaining=116
a preflight             204     https://notes.example         nosniff                  —
a preflight, no route   204     https://notes.example         nosniff                  —
a 404, no Origin        404     —                             nosniff                  limit=120, remaining=115
```

Only the first row is one a stamping middleware would have filled in. The rest
are why "our API works in Postman but not in the browser" is usually a 500 the
browser will not let anyone see.

Three details that fell out of the framework rather than out of the middleware:

**`Access-Control-Allow-Methods` is read off the graph.** A read-only API does
not advertise `DELETE`, and `HEAD` *is* advertised even though no `RouteRecord`
declares it, because [§4.2](./ARCHITECTURE.md#42-stage-by-stage) serves it free
for every `GET`. Add a `PUT` route tomorrow and the preflight starts advertising
it, with no second file to remember.

**The pack orders itself.** Register the four backwards and they still run
request-id → security-headers → cors → rate-limit, because the ordering is
declared in the manifests. It is load-bearing twice: security headers must be
staged before anything can short-circuit, and CORS headers before the limiter
can refuse — a 429 without them arrives at a browser as a CORS error.

**A CORS/CORP contradiction is a boot error naming both settings.**
`Cross-Origin-Resource-Policy: same-origin` and an allowlist that permits
cross-origin reads say opposite things; the CORP header wins and the symptom
appears nowhere in the CORS configuration. Both are plugins on one graph, so
each can read the other's decision.

Measured: `+2.02 µs` for all four on a cross-origin request, and an app that
imports the pack without registering it compiles a byte-identical pipeline. The
CI gate that matters more is the other one — **a disallowed origin is never
reflected**, across six shapes of allowlist crossed with eight hostile origins,
because reflecting whatever arrives is the fastest possible CORS and therefore
the shortcut a later optimisation reaches for first.

One number came out backwards and is worth keeping: **answering a preflight was
6.2× cheaper than not answering one** (4.2 µs against 26.1 µs). Dropping it
meant a 404, and a 404 cost ~10× a served request — almost all of it one `Error`
object and its stack. That was a finding about the framework rather than about
the pack, and it has since been fixed: see [the refusal path](#the-refusal-path-is-cheap).

### One resource, three representations — and the routes that pay nothing for it

```ts
app.get('/sales', {
  response: {
    200: {
      'application/vnd.acme.sales.v2+json': SalesV2,
      'application/vnd.acme.sales.v1+json': SalesV1,
      'text/csv':                            SalesCsv,
    },
    404: ProblemShape,                       // plain form — *not* negotiated
  },
}, ctx => sales.list(ctx.query))
```

No `/v2/` prefix, no second route, no `if (accept.includes('csv'))`, and no
`Vary` header written by hand. The `Accept` header is matched at
[stage 5](./ARCHITECTURE.md#42-stage-by-stage) — before validation, before the
handler, before anything touches a database — and the chosen representation
decides which compiled writer runs and what `Content-Type` goes out.

Two things about that declaration are worth more than the feature.

**The form is the opt-in.** `200: SalesV2` is not negotiated and emits *no
negotiation code*: no `Accept` read, no `Vary`, no branch. `200: { 'application/json': SalesV2 }`
is, even with one media type in it. There is no `negotiate: true` option,
because an option is a second place to say something the declaration already
says — and two places can disagree. A route that declares one representation
compiles to the same bytes it compiled before this feature existed, which is a
CI gate, not an aspiration.

**Versioning by media type is free.** Two of those three are JSON, so both are
written by the *same compiled serializer* Zen already had — with the same
guarantee that an undeclared field cannot be emitted. A `+json` vendor type
needs no encoder at all, and a client pinned to v1 keeps getting v1 from that
URL forever. It is the most common real reason to negotiate and it is the
cheapest.

`text/csv` is not something a zero-dependency package can ship, so it is a seam,
shaped exactly like the schema-converter seam:

```ts
registerMediaEncoder('text/csv', (schema) => {
  const columns = Object.keys(schema?.items?.properties ?? {})   // once, at boot
  return (rows) => /* per request: appends strings */
})
```

A **factory**, not a function — it receives the response schema and returns a
writer, so everything schema-shaped happens at boot and the per-request half
appends strings. Two things fall out. The columns come from the schema, so the
CSV inherits the leak-proofing rather than re-implementing it: `examples/negotiation`
puts an `internalMargin` on every row and it reaches neither format, with
nothing in the handler removing it. And a declared media type with **no**
encoder is a boot error naming the fix, because the alternative is booting fine
and sending a JSON body under `Content-Type: text/csv`, which is discovered by
whoever opens the file rather than by whoever deployed it.

Then the part that is just HTTP done properly:

```
Accept                        status  Content-Type   why
(none)                        200     v2             the server preference — declaration order
*/*                           200     v2             ditto: the client expressed none
text/csv                      200     csv            an exact match
v1                            200     v1             a client pinned to v1, forever
text/*                        200     csv            a subtype wildcard
v1;q=0.8, v2;q=0.9            200     v2             quality decides
v2;q=0.5, v1;q=0.5            200     v2             a tie — the server decides
text/csv;q=0, */*             200     v2             anything EXCEPT csv
*/*;q=0, text/csv             200     csv            nothing, EXCEPT csv
*/*;q=0                       406     problem+json   nothing at all
application/pdf               406     problem+json   we cannot produce it
garbage                       200     v2             unreadable — treated as absent, not as a refusal
```

Rows 8 and 9 are the ones implementations get backwards. RFC 9110 §12.5.1 says
the **most specific** matching range decides an offer's quality — so
`text/csv;q=0` overrides the wildcard that would otherwise allow it. Scoring by
"the highest `q` among matching ranges" is the obvious implementation and the
faster one, and it serves the client the single format it named and refused.
Nobody writes `q=0` by accident. It is a CI gate, five shapes of offer list
crossed with eight hostile headers, for the same reason the
never-reflect-an-origin gate exists.

Three more details, each of which is somebody's afternoon somewhere:

**`Vary: Accept` is staged before the decision, not after it** — so it is on the
406, and on a request that sent no `Accept` at all. A response without it is one
a shared cache may hand to a client that asked for something else. And in an app
that also uses CORS, `Vary: Origin` and `Vary: Accept` come from two subsystems
that know nothing about each other and must *accumulate*; there is a smoke check
over a real socket for the pair, because both in-process readers had that exact
defect once.

**A status declared in the plain form keeps its own `Content-Type`.** Ask for
CSV, get a 404, and the body is `application/problem+json` — not a one-row CSV
file. A CSV parser handed a JSON object reports a parse error at line 1, so the
bug report says "the export is corrupt" rather than "the id does not exist".

**Two statuses that offer different media types is a boot error.** `Accept` is
matched once, before the handler runs, so the offer list cannot depend on a
status that does not exist yet — and the order is part of it, because
declaration order is the server's preference and it decides ties.

Measured: **~1 ns** for no `Accept` header, **~4 ns** for an exact declared
type, **~10 ns** for a cached browser header — against ~850 ns to parse one, so
roughly **50×** and **100×**. Per request, four of five `Accept` shapes are
inside the measurement noise.

And one number that came out backwards, again: **a 406 cost 13× the 200 it
would otherwise have been** (35.7 µs against 2.8 µs). Not a negotiation cost —
the matcher answered in the nanoseconds above. It was the `Error` object and its
stack: the *same* finding the middleware pack surfaced from behind a preflight,
reached from the other direction. Two features arriving at one number is what
made it a property of the framework's refusal path, and it is now fixed.

### The refusal path is cheap

A 404, a 405 and a 406 are the cheapest hostile traffic there is, and all three
used to arrive with a free amplification factor: an `Error` whose stack was
captured — twice — and which could only ever point at the dispatcher. A refusal
the framework makes is now built without a stack, and every `ZenError` captures
its stack once. An error a *handler* throws keeps its stack, because that one
points somewhere worth reading.

Measured (`node benchmarks/refusals/run.ts`, paired arms, one machine):

| | before | after |
| --- | --- | --- |
| 404, no route | 10.0 µs — 5.6× a served 200 | **4.2 µs — 2.3×** |
| 405, wrong method | 10.6 µs — 5.7× | **4.7 µs — 2.6×** |
| 406, `Accept: application/pdf` | 17.5 µs — 9.5× | **6.4 µs — 3.6×** |
| 404 thrown by a handler (keeps its stack) | 15.4 µs | **10.8 µs** |

The CI gate is structural, not timed: it fails if a framework refusal captures a
stack frame, or if an application's error stops keeping its own.

### HTML that cannot carry a script, and redirects that stay home

The two oldest bugs in server-rendered HTML are a string that reaches a page
unescaped and a redirect that goes wherever the query string says. Neither is
something an application should have to remember
([§19.5](./ARCHITECTURE.md#195-injection-and-pollution-defences)):

```ts
import { html, isLocalUrl, NotFound } from '@erenthedeveloper0/zen'
import { z } from 'zod'

app.get('/notes/:id<int>', (ctx) => {
  const note = notes.find(ctx.params.id)
  if (note === undefined) throw new NotFound()
  return html`<h1>${note.title}</h1>
              <p>${note.body}</p>
              <a href="${ctx.query['from']}">Back</a>`
})

app.get('/login', { query: z.object({ next: z.string().default('/') }) },
  (ctx) => ctx.redirect(isLocalUrl(ctx.query.next) ? ctx.query.next : '/'))
```

`html` is a tagged template, and the *template* is what gets analysed — once,
the first time it renders, the way the HTML tokenizer will read it — so every
hole is escaped for where it sits:

| a hole in | gets |
| --- | --- |
| element content | escaped; a nested `` html`…` `` is written as markup, which is how fragments compose |
| a quoted attribute | escaped, including a nested fragment — markup means nothing there |
| `href`, `src`, `action`, … | escaped, and replaced with `about:invalid#zen-unsafe-url` if its scheme could run script — `javascript:`, `JaVa\tScRiPt:`, `data:` |
| `<script src>`, `<form action>`, `<base href>`, … | the same, and the value may not choose the origin: a link elsewhere is normal, a script from elsewhere is the attack |
| `<script>`, `onclick="…"`, an unquoted value, a tag or attribute name | **refused** — `ZEN_HTML_UNSAFE` on the first render, because no escaping function makes a value safe there |
| `<title>`, `<textarea>`, `<noscript>`, `<svg>`, … | escaped; a nested fragment is refused if it could end the text element, or carry a script only HTML can read into SVG |

The refused row is the one a helper that only escapes cannot have.
`onclick="go('${x}')"` is entity-decoded *before* the script runs, so an escaped
quote is a quote again by the time it matters; `<div ${attrs}>` needs no special
character at all to become `onmouseover=alert(1)`. Those templates are bugs in
the template, so they fail in the first test that renders them.

The last row is there because HTML and SVG read some elements differently:
HTML ends a `<noscript>` at the first `</noscript` in it — even one inside what
looks like an attribute value — and inside an `<svg>` a `<style>` or `<script>`
holds markup rather than text. A fragment can be nested anywhere, so the tag
keeps both readings and refuses any template, or nested fragment, on which they
disagree about where an element ends. The test suite has a spec-conformant HTML
parser judge random pages built that way; against the tag's first version it
finds a value in an attribute name within two hundred pages.

`ctx.html()` takes the `SafeHtml` that `html` returns and nothing else — a plain
string is a compile error, and a `ZEN_HTML_UNSAFE` for a caller without types.
Markup the application already trusts, a template engine's output say, is marked
with `unsafeHtml(markup)`, which is spelled for a code review. A handler may also
just return `` html`…` ``, the way it returns a string.

`ctx.redirect()` sends a path, a query or a fragment. Anything that leaves the
origin — including `//evil.example`, `/\evil.example` and a tab between two
slashes, each of which has slipped past a regular expression somewhere — is
refused unless its origin is listed:

```ts
const app = zen({ redirect: { allowExternal: ['https://accounts.google.com'] } })
```

The reference is read the way the browser reads the `Location` header, by a
scanner that is fuzzed against the WHATWG URL parser; an absolute URL to the
application's own host is treated as external, because only the `Host` header
could say otherwise and the client writes that.

Measured (`node benchmarks/injection/run.ts`, paired arms, one machine):

| | |
| --- | --- |
| a hostile value in 7 positions × 12 payloads | **never escapes its hole** — judged by the WHATWG parser (gate) |
| a hostile redirect under 3 policies | **never reaches an origin it was not allowed** (gate) |
| `escapeHtml` against a regex `replace` | 1.5–2.7× faster |
| `` html`…` `` with six holes and an `href` | 1.6× the same card built by hand — which writes `javascript:` into the `href` |
| `ctx.redirect('/path')` | +34 ns |
| a JSON handler, for `` () => html`…` `` | **inside noise** |

Two of those rows came out of the benchmark rather than into it. The first
`escapeHtml` was a character scan alone and lost the clean-text case by 30×,
because the regex engine finds "nothing to escape" in a kilobyte in ~70 ns; it
now searches first. And checking every object a handler returns for `SafeHtml`
cost 13.5% of `finalize` on every JSON response in every application — so a
fragment is now an async iterable of its own markup, and the check moved into
the branch `finalize` already takes for streams.

### Links that cannot route elsewhere

```ts
app.get('/notes/:id<int>', { name: 'notes.show' }, showNote)

app.url('notes.show', { id: 7 })                     // '/notes/7'
app.url('notes.show', { id: 7 }, { from: 'feed' })   // '/notes/7?from=feed'

notes.post('/', { body: NewNote }, (ctx) => {
  const note = service.create(ctx.body)
  return ctx.json(note, { status: 201, headers: { location: notes.url('notes.show', { id: note.id }) } })
})
```

A route's name and segments are already on the frozen graph, so reverse routing
is a read of it ([§5.7](./ARCHITECTURE.md#57-url-generation)). What `url()`
adds over a template literal is a guarantee: **the URL it returns is one the
named route answers, with the values it was given — or it throws.**

| written by hand | what `url()` does |
| --- | --- |
| `/files/${name}` with `a/b?c#d` is another path, a query and a fragment | each value is percent-encoded as exactly one segment |
| `/files/${'..'}` is a link to `/` — a browser resolves it, `%2E%2E` too | `.`, `..` and `''` are refused: no URL can carry them to the route |
| `/notes/${'7a'}` is a 404 for whoever clicks it | the parameter's own type tests the value, in the handler that built the link |
| `/users/${'me'}` is answered by `GET /users/me` | the compiled router is asked, and the refusal names the route that would have won |
| `?tags=${tags}` | the query is written the way the route parses it — repeated, comma-joined or bracketed, from its coercion plan |

The result is always a path on this origin, so `ctx.redirect()` sends it
without consulting `redirect.allowExternal`. A feature module links through the
collection it is handed (`notes.url(…)`), a plugin through its registrar.

It is checked when it is called rather than by `tsc`. The design typed it by
route name, and a collection's callback cannot pass a type back out — so a name
nothing registered (`ZEN_ROUTE_UNKNOWN`, with the one you probably meant) or a
value that cannot build the link (`ZEN_PARAM_MISMATCH`) fails the first test
that renders it.

Measured (`node benchmarks/url/run.ts`, paired arms, one machine):

| | |
| --- | --- |
| hostile values over a table of shadowing traps | **every link reaches its route with its values**; the rest are refused (gate) |
| naming and linking routes | **byte-identical** generated code (gate) |
| a static route | ~60 ns |
| one `<int>` parameter | ~0.5 µs — about half of it the router `match` that is the guarantee |
| the table at boot, 500 named routes | 0.13 ms, once |

Building it read route names as keys for the first time, and the reader found
two things the RFC described that did not exist: a collection's `name` was
supposed to prefix its routes' names, and a `params` schema was supposed to be
checked against its path at boot. Neither was built; the first is now decided
against — every application already namespaces by hand — and the second is
recorded as a gap rather than as a feature.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-06.png">
  <img alt="" src="./.github/images/image-05.png" width="100%" height="4">
</picture>

## Try it

```bash
git clone https://github.com/erenthedeveloper0/zen.git && cd zen
npm ci
npm run typecheck                  # builds every package (tsc -b)
npm test                           # 1,115 tests
node scripts/smoke.ts              # 80 checks over a real socket
node scripts/negative-controls.ts  # break 89 things on purpose; every suite must notice
node scripts/check-pack.ts         # what each npm tarball contains — installed and run outside the repo
node benchmarks/typecheck/run.ts   # the M2 gate
node benchmarks/serializer/run.ts  # serializer throughput
node benchmarks/openapi/run.ts     # document generation + per-request cost
node benchmarks/hooks/run.ts       # hook cost, and the zero-code assertion
node benchmarks/deadlines/run.ts   # what a deadline costs, and the same assertion
node benchmarks/health/run.ts      # stampede safety, probe isolation, zero route cost
node benchmarks/coercion/run.ts    # what a conversion costs, and what a declared string does not
node benchmarks/config/run.ts      # what config costs a request (nothing), and the redaction gate
node benchmarks/middleware/run.ts  # what the pack costs, and the never-reflect gate
node benchmarks/negotiation/run.ts # what Accept costs, and the never-serve-a-refusal gate
node benchmarks/refusals/run.ts    # what a 404/405/406 costs, and the no-stack gate
node benchmarks/request-path/run.ts # what the audit's fixes cost, and where their code is not emitted
node benchmarks/injection/run.ts   # what escaping and redirect checks cost, and the never-escape gates
node benchmarks/url/run.ts         # what a link costs, and the never-reach-another-route gate
node scripts/show-generated.ts     # read what the pipeline compiler emitted
node scripts/show-serializer.ts    # read what the serializer compiler emitted
npm run explain                    # print the resolved chain for every route
npm run explain:deadlines          # every route's budget, and where it came from
npm run health:explain             # which dependencies are probed, and by whom
npm run explain -w @erenthedeveloper0/zen-example-coercion   # what each route converts, and what it leaves alone
npm run config:explain             # where every configured value came from
npm run middleware:explain         # which responses carry which headers, and why
npm run negotiation:explain        # what each Accept header gets, and what the plain route paid
node examples/hello-world/src/main.ts
```

Working on the repository needs Node ≥ 22.18: the sources run straight through Node's type
stripping, which is unflagged from 22.18, with no bundler. The published packages need Node ≥ 22.6.
[CONTRIBUTING.md](./CONTRIBUTING.md) has the rest.

### What the tests cover

| Suite | What it proves |
| --- | --- |
| `app.test.ts` | Routing (including absolute-form targets, `+` in paths, `HEAD` on wildcards and `all()`), middleware at every scope, `next()` as a Promise on the sync fast path, slots and their disposal, errors, boot diagnostics, body handling (`+json` included) |
| `plugins.test.ts` | Registration, dependency resolution, cycles, versions, capabilities, semver |
| `di.test.ts` | Lifetimes, request scoping, cycle + captive-dependency detection, disposal order — and request-scoped services released at the end of every request, the failed ones included |
| `serializer.test.ts` | Field filtering, escapes, number/date policy, unions, `$ref`, strict mode, boot diagnostics |
| `hooks.test.ts` | All nine pipeline phases in lifecycle order, three-scope resolution and the mirror, short-circuits, the error path, phase availability, and that a hookless route generates no hook code |
| `timeouts.test.ts` | Budget resolution across the scope chain, `timeout: false`, the arm answering on time, 408-vs-504, `onTimeout` and its stage, the pipeline stopping at the boundary, one-way header propagation, and that an unbounded route generates no deadline code |
| `health.test.ts` | That liveness runs no dependency probes and readiness runs no liveness ones, the `starting → live → draining → stopped` transitions, per-check budgets and cancellation, single-flight under 200 concurrent probes, `critical: false`, withheld error text, a missing required check refused at boot, and that `close()` reports `draining` **before** the server stops accepting |
| `differential.test.ts` | Compiled pipeline ≡ interpreted pipeline over every step pair + 300 random chains; compiled hooks ≡ the twin over 200 random hook plans; and deadlines ≡ the twin over 200 chains where the client leaves at a random position — agreeing on *which* boundary abandoned it, not just that one did. All three assert their own coverage, so an agreement that ran nothing cannot pass |
| `serializer-differential.test.ts` | Compiled ≡ walking serializer over 2 500 generated schema/value pairs, plus "no undeclared key reached the wire" |
| `context.test.ts` | Compiled context ≡ `PlainContext`; **monomorphism** (`%HaveSameMap`); headers, query, cookies, egress |
| `router.test.ts` | Path syntax, param types, conflict classes — every overlapping pair of builtin param types refused and every disjoint pair left alone — typed params tried in the same order whatever the registration order, compiled ≡ interpreted router |
| `types.test.ts` | Type-level inference incl. negative `@ts-expect-error` cases; the M2 budget |
| `openapi.test.ts` | Path/param/schema mapping, `$ref` dedup, **documented fields ≡ fields the compiled serializer emits**, and the diff classifier — which compares what a schema says rather than how its converter spelled it: zod 4.4's `anyOf` and 4.6's type list are one schema, a field removed inside a nullable union is breaking, and a recursive component is compared to where it repeats instead of overflowing the stack |
| `examples/openapi` | The same drift check over real requests, plus the API compatibility gate |
| `examples/observability` | Bounded metric cardinality, per-stage attribution, that `onResponse` measures more than `onSend` can, and that a transform hook cannot smuggle a field past the response contract |
| `examples/deadlines` | That a sliced budget drops a slow provider instead of the request, that the provider was **cancelled** rather than merely stopped waiting for, that `onTimeout` can serve a partial 200, and that an inbound header shortens the budget but never lengthens it |
| `examples/health` | That a dead dependency takes the pod out of the load balancer and not out of the fleet, that a non-critical one only warns, that a **hanging** one cannot hold the endpoint or hide a healthy sibling, that 100 simultaneous polls cost one round trip, and that readiness goes red while the service is still answering |
| `config.test.ts` + `config-properties.test.ts` | Layer precedence and per-value provenance, environment validation running before any plugin's `setup`, aggregated per-key diagnostics with the constraint read off the schema, secrets absent from every projection, the deep freeze, and that `ctx.config` changes no generated byte. The property suite fuzzes 2 000 random layer stacks for six invariants — it is not a differential suite, because configuration compiles nothing, and it caught a collision rule the hand-written test passed against |
| `examples/config` | The same claims against **real Zod**: `.meta({ format: 'password' })` marking a secret, `expected: integer, between 1 and 100` read back off `z.toJSONSchema`, `.env` line numbers in the error, a plugin's namespace merging field by field, and — checked by `tsc`, not by an assertion — that `ctx.config.pagination.pageSize` is a `number` |
| `examples/coercion` | That the same service written with §11.4 and written with `z.coerce` answers **identically** — so adopting it is a refactor and not a behaviour change — plus that a zero-padded SKU survives, that a single `?tags=a` is still an array, and that a bigint-shaped id is refused rather than silently rounded |
| `cors` · `security` · `request-id` · `rate-limit`.`test.ts` | That a preflight to a path with **no route** is answered, that a disallowed origin is refused without the response saying so, that `Vary: Origin` is present even on a request that had none, that the headers reach the 404 / 422 / 401 / 429 / 500, that an inbound request id is validated before it is trusted, and that a rate limiter sees the requests a router does not |
| `pack.test.ts` | The claim the design rests on, as a count rather than a description: a `.use()` middleware ran **1 of 3** requests and a global hook ran **3 of 3**. Plus that the pack reorders itself when registered backwards, that a 429 still carries CORS headers, and that an app which does not register it compiles a byte-identical pipeline |
| `rate-limit-differential.test.ts` | The evicting store ≡ a never-evicting reference over 2 000 random request streams, with coverage assertions on boundaries crossed and keys reused across one — and the single clock-step case where they legitimately differ, pinned in its own test with its direction (it can only undercount) |
| `examples/middleware` | The composition rather than the plugins: an allowlist arriving from `CORS_ORIGINS` through a Zod-validated environment, a preflight advertising only the methods the graph actually serves, a 404 flood consuming the budget, a note stored with a `<script>` in it rendered as text, a `?next=` that cannot leave the origin, and — checked by `tsc` — that `ctx.config.cors.origin` is a `string[]` and that `ctx.html('<p>')` does not compile |
| `negotiation.test.ts` | The matcher against RFC 9110 §12.5.1 — specificity beating quality, ties going to the server, `q=0` never served — plus `Vary: Accept` on the 406 and on a request that sent none, a plain-form 404 keeping `application/problem+json`, a 406 refusing *before* body intake, and that a route with one representation emits no negotiation code |
| `negotiation-properties.test.ts` | Six invariants over 2 000 random offer sets × `Accept` headers, the load-bearing one being that a refused representation is never chosen; and a real differential — the cached negotiator against the uncached matcher over 2 000 random *streams*, because the bugs a cache introduces are order-dependent |
| `examples/negotiation` | Three representations of one resource against **real Zod**: a client pinned to `v1` staying pinned, CSV columns taken from the same schema the JSON fields come from, a field the database has and neither format contains, a spreadsheet-formula cell neutralised, and — checked by `tsc` — that `ctx.negotiated` is `string \| null` |
| `adapter.test.ts` (adapter-node) | Over **real sockets**, because `inject()` could not see any of it: a request body does not abort `ctx.signal`, a POST under a deadline is answered rather than abandoned, a client leaving mid-stream neither crashes the process nor logs a failure, a missing file is a 404 rather than a dropped connection, a path cannot escape its root (symlinks included), 304/206/416 and `HEAD` for files, SSE framing, heartbeats and disconnects, and that shutdown neither waits on idle keep-alive connections nor severs event streams |
| `sse.test.ts` | The event-stream framing, including a line break in `event` or `id` refused rather than forging a field; graceful `close()`; the `maxBuffered` bound; heartbeats that start only when something reads; and `ctx.sse()` on **both** context twins |
| `validation.test.ts` | A bad query and a bad body are reported in **one** response, each issue tagged with its source; 422 only when the body alone failed; async validators collected too; and a one-source route compiles exactly as before |
| `registration.test.ts` | Registrations that could never take effect are boot errors: a typo'd hook phase (with the phase you meant), an application phase on a route, a decoration that would shadow `ctx.json`, two routes sharing a name; `app.paramType()`; one boot per application however many callers race for it, and a failed boot that stays failed; and a shutdown that completes when an `onClose` hook throws |
| `lifecycle.test.ts` (meta-package) | A real child process: `SIGTERM` drains and exits 0, an uncaught exception or unhandled rejection drains and exits 1, and nothing is installed on the process until `listen()` |
| `error-docs.test.ts` | Every error code any package can produce has its entry in [docs/errors.md](./docs/errors.md) — the page every problem document links to |
| `logger.test.ts` | The default logger never throws — a cycle or a `bigint` in an error's metadata still produces the log line *and* the error response — and metadata cannot overwrite a line's `code` or `status` |
| `html.test.ts` | Every position a hole can take — escaped in content and in both quotes, a `javascript:` URL replaced in every spelling a browser accepts, a `<script src>` held to the origin, and each position escaping cannot fix refused on the first render — plus a `SafeHtml` no JSON body or borrowed prototype can forge, and the templates HTML and SVG would read differently refused. Then property suites judged by the WHATWG URL parser, a grammar for escaped text, and **parse5** — a spec-conformant HTML parser that parses 2,000 random pages, fragments nested in fragments, and reports where every value landed. None shares code with the tag |
| `redirect.test.ts` | Paths, queries and fragments sent; every spelling that has slipped past a regex refused (`//`, `/\`, a tab, a leading space, `https:host`, userinfo); the allowlist's look-alikes refused; a malformed allowlist entry a boot error with the spelling that would match — and a real differential: the reference scanner against the WHATWG URL parser over 2,000 random targets, with its coverage asserted |
| `url.test.ts` | A value encoded as one segment whatever it holds; a number, a bigint and a `Date` written the way their routes read them back; `.`, `..`, empty values, objects and lone surrogates refused; each way one route outranks another — a static segment, a typed parameter, anything over a wildcard — refused with the winner named; the query written in the route's own list style; reachable from a collection and a plugin. Then a property suite: 2,000 links from hostile values over a table of shadowing traps, put through the WHATWG URL parser the way a browser treats an `href` and sent to the app, which must answer on the named route with the values given — coverage asserted per kind of refusal |
| `scripts/negative-controls.ts` | That the suites above are load-bearing. Eighty-nine known defects patched in one at a time; each must make its named suite **fail**. It caught a fuzzer asserting on a branch its generator never produced, a test aimed at a code path that could not reach the behaviour it claimed to cover, a guard proven unreachable — and a test that probed for a free port with the very call it was testing, so the defect and the probe agreed |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-01.png">
  <img alt="" src="./.github/images/image-03.png" width="100%" height="4">
</picture>

## Layout

```
packages/
  core/            registries · compilers · runtime · context · errors   (0 deps)
  router/          compiled + interpreted radix routers, conflict analysis
  adapter-node/    the optimised Node path
  openapi/         AppGraph → OAS 3.1, $ref dedup, diffing, viewer
  middleware/      cors · securityHeaders · requestId · rateLimit + the Store seam
  zen/             meta-package: wires core + router + adapter + middleware
examples/
  hello-world/     routing, slots, the three middleware forms, streaming
  rest-api/        response contracts, plugins, DI, validation — the full tour
  openapi/         Zod, OAS 3.1, the API diff gate — and the RFC's recommended layout
  observability/   the hook system running: metrics, request log, Server-Timing
  deadlines/       budgets, propagation, cancellation, partial results on timeout
  health/          liveness vs readiness, per-probe budgets, a watchable drain
  coercion/        ?page=2 is a number, ?sku=00713 is not — and the same app both ways
  config/          layered config, env validation, provenance, redaction
  middleware/      a browser-facing API: preflights, 429s browsers can read, pages that escape and link
  negotiation/     one resource in three representations, and the encoder seam
benchmarks/        serializer, OpenAPI, hook, deadline, health, coercion, config,
                   middleware, negotiation, refusal, request-path, injection and URL cost; the M2 gate
scripts/           smoke test, negative controls, codegen inspectors, and release
                   tooling: version.ts, check-release.ts, check-pack.ts
docs/errors.md     every error code — where each problem document's `type` points
ARCHITECTURE.md    RFC 0001 — the full design
RELEASING.md       how the packages get to npm, and why that way
CONTRIBUTING.md    conventions, setup, sign-off · SECURITY.md · CODE_OF_CONDUCT.md
```

`@erenthedeveloper0/zen-core` has **zero runtime dependencies**, and imports nothing from `node:`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-10.png">
  <img alt="" src="./.github/images/image-09.png" width="100%" height="4">
</picture>

## Examples

```bash
npm run example                # hello-world — five minutes to understand
npm run example:rest           # rest-api — plugins, DI, validation, response contracts
npm run example:inspect        # what rest-api compiled to
npm run example:openapi        # openapi — then open /docs
npm run openapi:check          # the API compatibility gate
npm run example:observability  # observability — then curl -i /products/1 and /metrics
npm run example:deadlines      # deadlines — then curl -i /quotes and /quotes/best-effort
npm run example:health         # health — then break a dependency and watch /readyz
npm run example:config         # config — then try PAGE_SIZE=1000 and DATABASE_URL=
npm run example:middleware     # middleware — then send a preflight to a path that does not exist
npm run example:negotiation    # negotiation — then ask /api/sales for text/csv, then for a PDF
npm run explain                # the resolved hook + middleware chain, per route
npm run explain:deadlines      # every route's budget, and the scope that set it
npm run health:explain         # every dependency, its budget, and who registered it
npm run config:explain         # where every configured value came from
npm run middleware:explain     # which responses carry which headers, and why
npm run negotiation:explain    # what each Accept header gets, and what a plain route paid
```

[`examples/rest-api`](./examples/rest-api) is the one to read. It is a user
directory whose `UserRow` carries `passwordHash`, `totpSecret`,
`stripeCustomerId` and `internalNotes`, and whose handlers return those rows
**unmodified**:

```ts
users.get('/:id<int>', { response: { 200: PublicUser } }, (ctx) => {
  const row = ctx.resolve(UserRepoToken).find(ctx.params.id)
  if (row === undefined) throw new NotFound(`User ${ctx.params.id} not found`)
  return row                                     // ← all ten fields
})
```

```
handler returned: {"id":1,…,"passwordHash":"$2b$12$…","totpSecret":"JBSWY3DPEHPK3PXP",…}
wire:             {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin","createdAt":"…"}
```

It also carries a **150-line schema library written inside the example**, which
the framework has never heard of — that is the cleanest demonstration that
"works with Zod, Valibot and ArkType" is a consequence of Standard Schema rather
than a list of integrations Zen maintains. One declaration drives both the
request validator and the response serializer.

[`examples/openapi`](./examples/openapi) is the same idea taken one step
further, with **real Zod** and a generated document:

```
handler returned : {"id":1,…,"passwordHash":"$2b$12$…","totpSecret":"JBSWY3DPEHPK3PXP",…}
wire             : {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin","createdAt":"…"}
document says    : properties: id, email, name, role, createdAt   additionalProperties: false
```

All three agree, and the suite proves it by making a real request for every
documented response and comparing the keys. The Zod integration is four lines in
application code; neither `@erenthedeveloper0/zen-core` nor `@erenthedeveloper0/zen-openapi` imports it.

It is also the first example laid out the way
[§23.4](./ARCHITECTURE.md#234-recommended-application-structure) recommends —
feature-first, with `src/features/{users,orders}/` owning their own routes,
schemas, service and tests. So yes: Zen has an opinion about your folder
structure, it is written down, and now it runs.

[`examples/observability`](./examples/observability) is the hook system doing
something worth doing. One plugin touches ten phases and produces a Prometheus
endpoint, a structured request log, and a `Server-Timing` header — and **no
feature file knows it exists**. There is no `withMetrics(handler)` wrapper, no
`logger.info` at the top of each handler, and no timing middleware to remember
to register, which is the actual test of whether a cross-cutting concern was
kept cross-cutting.

`npm run explain` prints what each route resolved to, with provenance:

```
GET /admin/orders                     → admin.orders

  onRequest       [global]      metrics.start
  onRequest       [root/admin]  requireAdminKey
  onRoute         [global]      metrics.route
  preHandler      [global]      metrics.preHandler
  handler                       listOrders
  onSerialize     [global]      stampGeneration
  onSend          [global]      metrics.serverTiming
  onResponse      [root/admin]  auditLog
  onResponse      [global]      metrics.finish
```

Note the mirror: the collection's `onResponse` runs *before* the global one, so
`onRequest`/`onResponse` pairs nest like a stack rather than queueing.

[`examples/deadlines`](./examples/deadlines) is a gateway that fans out to three
providers under a shared budget. No handler in it mentions a timeout — they read
`ctx.timeLeft` and pass it on, so the same code is correct whether the operator
configures two seconds or twenty, and the budgets are three lines in `app.ts`.

`npm run explain:deadlines` answers "what is our request timeout" completely,
which in most codebases takes four files and a guess:

```
    GET /quotes               2000 ms   from app
    GET /quotes/best-effort   2000 ms   from app
    GET /reports/quarterly   10000 ms   from root/reports
    GET /reports/status        250 ms   from route
    GET /feed/live               none   —

  5/5 application routes are bounded.
  Unbounded on purpose: /feed/live
```

The provenance column is the useful half: the surprising budgets are always the
inherited ones.

[`examples/coercion`](./examples/coercion) is a catalogue whose query string
carries numbers, booleans, lists and a zero-padded SKU — every case that makes
the problem interesting, in one endpoint. `src/app.ts` builds the service
**twice**: once as written above, and once with `coercion: false` plus
`z.coerce` and the hand-written `z.preprocess` you need for the
single-value-array problem, which `z.coerce` has no answer for at all. The tests
assert the two answer identically on the same requests — which is a stronger
claim than "the feature works": it says adopting it cannot change behaviour,
because the behaviour is the one people were already hand-writing.

[`examples/config`](./examples/config) is the one that makes the layering
visible. `process.env` appears **exactly once** in it — in the fifteen lines
that read `.env` files, where it is I/O rather than configuration — and every
other file reads `ctx.config`. Try `PAGE_SIZE=1000 npm run example:config` for
a bound enforced at boot rather than on the first slow report, and
`DATABASE_URL= npm run example:config` for a missing secret reported without
being printed.

It also shows the framework's own boundary honestly: core parses `.env` text and
states the precedence, and opens no files, because `fs` and `process` do not
exist on workerd. And it names the gap it does not close — secrecy propagates by
*identity*, so `url: env => env.DATABASE_URL` inherits the marking and
`` `${env.DATABASE_URL}?replica=1` `` does not. There is a test asserting the
leak, so the gap cannot move without someone deciding to move it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/images/image-08.png">
  <img alt="" src="./.github/images/image-05.png" width="100%" height="4">
</picture>

## Contributing

Contributions are welcome — [CONTRIBUTING.md](./CONTRIBUTING.md) has setup, the
checks to run and the sign-off, and [SECURITY.md](./SECURITY.md) how to report a
vulnerability privately. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first —
particularly [§1.1, the nine invariants](./ARCHITECTURE.md#11-the-nine-invariants).
They are numbered so reviewers can cite them, and a PR that violates one needs an
argument, not a workaround.

Four rules worth knowing up front:

1. **Every compiled subsystem needs an interpreted twin**, and the differential
   suite must pass. Those suites have already caught five real bugs: an
   undeclared `let r` in generated pipelines, silently dropped middleware, an
   `around` scoping divergence, a phantom plugin cycle, and a degenerate
   `anyOf: [null, null]` the serializer refused instead of collapsing. A fuzzer
   must also assert its own **coverage** — two implementations that agree
   because neither ran anything report a pass and prove nothing.
2. **Build the reader, not just the writer.** Every subsystem that *consumes*
   the application graph has found gaps that writing more routes never would.
   The OpenAPI generator turned up four in one sitting: param types unreachable
   outside the router package, no way for a plugin to register a route, no
   nested collections, and a converter seam that could not express
   input-versus-output. Building the observability example turned up two more,
   both invisible from the spec side: `preHandler` was running *before* body
   intake, and global `onRequest` hooks were skipped entirely for unmatched
   requests — which made rate limiting bypassable by requesting a path that does
   not exist. Building the deadlines example turned up a third: `onTimeout` had
   been given `onError`'s nearest-handler rule, so a route serving partial
   results silenced the plugin counting timeouts — the counter would have read
   zero on exactly the routes that handled their deadlines best. And the health
   endpoints turned up the sharpest one: graceful shutdown had been running
   [§4.5](./ARCHITECTURE.md#45-graceful-shutdown)'s steps *inverted*, disposing
   the connection pools during the window in which the load balancer is still
   sending traffic. It survived writing, implementing and reviewing because
   nothing could ask it a question — "readiness flips before the socket stops
   accepting" is not a checkable sentence until a readiness endpoint exists.
   The count is now five: the configuration example's provenance table found
   that the environment section was enumerating every variable in the *process*,
   which buried the relevant rows and put the name of every variable on the
   AppGraph — where a name is topology even when the value is withheld.
3. **A test that passes against the bug is not a test.** Before trusting a new
   assertion, break the thing it covers and watch it fail. The deadline fuzzer
   was checked that way, and so was a narrow crash the deadline arm could cause:
   the first version of that test passed with *and* without the fix, because a
   plain throwing handler compiles to an async function and the failure needed a
   genuinely synchronous one. Seven controls were run against the configuration
   fold and one of them found the same thing again: deleting half of the
   scalar-versus-branch rule left the resolved object correct and only the
   *snapshot* wrong, so the hand-written test for that exact rule passed and
   only the property fuzzer failed.
4. **Performance claims need numbers.** Losses get published with the same
   prominence as wins — see the `seal()` result in
   [§28.2](./ARCHITECTURE.md#282-typescript-compilation-cost--the-biggest-technical-risk),
   which measured at 0.6% and may cost the API its place;
   [§13.3.2](./ARCHITECTURE.md#1332-measured-throughput), where the serializer
   came in under its published claim and the claim was corrected rather than the
   benchmark; and [§29.8](./ARCHITECTURE.md#298-measured-cost), where naming your
   schemas turned out to be worth 8% rather than the large saving expected, and
   the first version of that benchmark was thrown out for measuring an artefact
   of its own fixture. The hook benchmark cost two drafts for the same reason:
   the first measured through `inject()`, putting ~2 µs of scaffolding around an
   effect of tens of nanoseconds, and reported a per-hook cost that *fell* as
   hooks were added. Where a structural assertion is available, prefer it —
   "the generated source is byte identical" beats "the difference was inside the
   noise", because the second is also true when the cost is real and small.

## Licence

[MIT](./LICENSE) © [Eren Sümer](https://github.com/erenthedeveloper0). Everyone who has contributed
is listed in [CONTRIBUTORS.md](./CONTRIBUTORS.md).

<br>

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/images/logo-with-text-white.png">
    <img alt="zen.js" src="./.github/images/logo-with-text-black.png" width="138">
  </picture>
  <br>
  <sub>Built by <a href="https://github.com/erenthedeveloper0">Eren Sümer</a> · a web framework is a compiler with an HTTP server attached</sub>
</div>
