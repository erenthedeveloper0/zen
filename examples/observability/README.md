# `examples/observability`

Metrics, structured request logs, and per-stage timing — built entirely from
Zen's hook system ([RFC 0001 §9](../../ARCHITECTURE.md#9-hook-system-specification)), with no globals patched and nothing monkeyed.

```bash
npm run example:observability     # serve on :3000
npm run explain                   # print the resolved chain for every route
node --test "examples/observability/test/**/*.test.ts"
```

---

## What this example is for

`examples/rest-api` shows the request path. `examples/openapi` shows reading the
AppGraph. This one shows the **twelve request phases**, and specifically the
three things a hook can do that a middleware structurally cannot.

### 1. Time the response, not the handler

`onResponse` runs *after the last byte is flushed*. A response-time middleware
stops the clock before serialization and before egress, and reports a number
smaller than the one the client experienced.

```
POST /checkout
  Server-Timing: parse;dur=0.223, validate;dur=1.790, handler;dur=0.940, epilogue;dur=0.237, total;dur=3.355
  logged:        POST /checkout 201 3.967ms parse=0.22 validate=1.79 handler=0.94
                                    ^^^^^^^
                                    strictly larger — that gap is egress, and it
                                    is invisible to anything that runs earlier
```

The test `onResponse measures more than onSend can` asserts that inequality.

### 2. Bounded cardinality, by construction

The `onRoute` hook is handed the matched route, and the metric label is
`route.path` — the **template**. So this:

```bash
curl localhost:3000/products/1
curl localhost:3000/products/2
curl localhost:3000/products/3
```

produces exactly one series:

```
http_requests_total{method="GET",route="/products/:id<int>",status="200"} 3
```

Unbounded label cardinality is the most common way a Node service takes down its
own metrics backend, and it is normally a documentation problem — "remember not
to label on the URL". Here the raw URL is simply not what the hook is given. A
request that matches nothing is labelled `route="<unmatched>"` for the same
reason.

### 3. Per-stage attribution without a profiler

The guard phases bracket each stage, so "this endpoint is slow" becomes
"validation is 60% of this endpoint":

```
http_request_stage_seconds_total{route="/checkout",stage="parse"}    0.000223
http_request_stage_seconds_total{route="/checkout",stage="validate"} 0.001790
http_request_stage_seconds_total{route="/checkout",stage="handler"}  0.000940
http_request_stage_seconds_total{route="/checkout",stage="epilogue"} 0.000237
```

Zod validation is 45% of that request, which is not a guess.

A stage that does not exist on a route is **absent, not zero**. `/products/:id`
declares no body, so intake is never emitted into its pipeline and there is no
parse stage to report — and reporting `parse;dur=0` would claim parsing was
instant rather than that it did not happen. The plugin knows which stages a
route has because it reads the frozen AppGraph once, in `onBoot`.

---

## The three scopes, in one file

`src/app.ts` shows all of §9.3 at once, and the point is that you can tell which
is which by looking at the indentation:

```ts
app.hook('onSerialize', stampGeneration)              // global — every route

app.collection('/admin', {
  hooks: { onRequest: requireAdminKey,                // collection — this subtree
           onResponse: auditLog },
}, admin => { … })

c.get('/:id<int>', {
  hooks: { onSend: cacheForAMinute },                 // route — exactly here
}, showProduct)
```

Pre-family hooks run outermost-first; post-family run in the exact mirror, so
`onRequest`/`onResponse` pairs nest like a stack rather than queueing.

`npm run explain` prints the resolved chain for every route, including
provenance:

```
GET /admin/orders                     → admin.orders

  onRequest       [global]      metrics.start
  onRequest       [root/admin]  requireAdminKey
  onRoute         [global]      metrics.route
  preValidation   [global]      metrics.preValidation
  postValidation  [global]      metrics.postValidation
  preHandler      [global]      metrics.preHandler
  handler                       listOrders
  postHandler     [global]      metrics.postHandler
  onSerialize     [global]      stampGeneration
  onSend          [global]      metrics.serverTiming
  onResponse      [root/admin]  auditLog
  onResponse      [global]      metrics.finish
  onError         [global]      metrics.error
```

That output is generated from `record.hooks` and `record.middleware` — *the same
arrays the pipeline compiler consumed*. There is no second model of the ordering,
so the explanation cannot drift from the pipeline.

---

## What it costs

`npm run explain` also prints the generated pipeline for each route, so the
§9.4 claim is inspectable rather than asserted:

```
generated pipelines: 6
  pipeline:GET_/products              2031 bytes   8 phases, 8 call sites
  pipeline:GET_/products/:id<int>     2104 bytes   8 phases, 9 call sites
```

Nine call sites on `/products/:id` because that route adds a route-scoped
`onSend`. A route that registered nothing generates nothing — see
`benchmarks/hooks/run.ts`, which asserts the hookless pipeline is *byte
identical* whether or not eight phases are registered elsewhere in the app.

Measured cost of this plugin: one small object per request, ten hook calls
(well under a nanosecond each after the first), and one `performance.now()` per
stage — which dominates. Turn off `serverTiming` and you drop one header and one
`performance.now()`.

---

## The sharp edge worth knowing

The global `onSerialize` hook in `src/app.ts` adds `generatedBy` to every JSON
body. On `/admin/orders`, which declares no response schema, it survives. On
`/products/:id`, which does, it is **dropped**:

```
GET /admin/orders   → { "orders": [...], "generatedBy": "dev" }
GET /products/1     → { "id":1, "name":"…", "priceCents":12900, "tags":[…] }
```

That is §13.3 doing its job: the compiled serializer is bound *after* the
transform hooks, so a hook cannot add a field the schema does not declare — the
same mechanism that stops a handler leaking `costCents` and `supplier` from the
row it returns. If you want an envelope on a schema'd route, the schema has to
declare the envelope. This is deliberate, and both halves are asserted in the
test suite.

---

## Layout

Feature-first, per §23.4:

```
src/
  main.ts                  entry
  app.ts                   composition root — all three hook scopes
  inspect.ts               explainRoute over the whole graph
  config/observability.config.ts
  plugins/observability.ts one plugin, ten phases
  shared/metrics.ts        dependency-free OpenMetrics registry
  features/
    catalog/               routes · schemas · service · index
    checkout/              routes · schemas · service · index
test/observability.test.ts
```
