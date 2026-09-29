# Deadlines

A gateway that fans out to three providers under a shared budget, drops the slow
one, and answers anyway.

```bash
npm run example:deadlines      # start it
npm run explain:deadlines      # every route's budget, and where it came from
node --test examples/deadlines/test/deadlines.test.ts
```

This is [RFC 0001 §4.4](../../ARCHITECTURE.md#44-deadlines-cancellation-backpressure) built: request deadlines, real
cancellation, and budget propagation.

---

## The distinction the whole example turns on

You configure a **timeout**, which is a duration. What a request carries is a
**deadline**, which is an instant.

That is not pedantry. A service told "you have 30 seconds" that forwards *30
seconds* to each of four sequential calls has silently promised two minutes. One
that forwards the time actually remaining has not. `ctx.timeLeft` shrinks as the
request proceeds, which is what makes it safe to hand downstream — and it is
`Infinity` rather than `null` on an unbounded route, so `Math.min(ctx.timeLeft,
2000)` is correct everywhere and no call site needs a ternary.

```ts
const slice = ctx.timeLeft - EGRESS_RESERVE
await Promise.allSettled(providers.map((p) =>
  callProvider(p, { budgetMs: slice, signal: ctx.signal })))
```

The reserve matters too. Give every provider the *entire* remaining budget and
the slowest consumes all of it, so the request times out having done every bit
of the work.

---

## What each route is for

| Route | Budget | Shows |
| --- | --- | --- |
| `GET /quotes` | 2 s, from the app | Slicing. The slow provider is cut off at its share; the answer goes out with the two that arrived. |
| `GET /quotes/best-effort` | 2 s, from the app | No slicing, so the *request* blows — and `onTimeout` answers 200 with whatever landed. |
| `GET /reports/quarterly` | 10 s, from the collection | A subtree that is legitimately slower. |
| `GET /reports/status` | 250 ms, from the route | A probe that should fail fast rather than queue behind a warehouse query. |
| `GET /feed/live` | none — `timeout: false` | A stream refusing the inherited budget. |
| `GET /deadlines` | none | Which routes are bounded, and the tightest headroom seen. |

```bash
curl -i  localhost:3000/quotes                       # 200, partial, slow dropped
curl -i  localhost:3000/quotes/best-effort           # 200 from onTimeout, x-degraded
curl -N  localhost:3000/feed/live                    # streams to the end
curl -sS localhost:3000/deadlines
```

---

## Three things worth looking at

### 1. The budget is one line, in one of three places

Most services answer "what is our request timeout" with four numbers that do not
know about each other: a proxy config, an `express-timeout` call somewhere in the
middleware stack, a per-client HTTP agent, and a `statement_timeout` in a
connection string. The effective behaviour is whichever fires first, and nobody
knows which that is.

Here every budget is a `timeout` on the app, a collection, or a route. All three
resolve at boot onto `RouteRecord.timeout`, so this is a complete answer:

```
    GET /quotes               2000 ms   from app
    GET /quotes/best-effort   2000 ms   from app
    GET /reports/quarterly   10000 ms   from root/reports
    GET /reports/status        250 ms   from route
    GET /feed/live               none   —

  5/5 application routes are bounded.
  Unbounded on purpose: /feed/live
```

The provenance column is the useful half. In a real codebase the surprising
budgets are always the inherited ones.

### 2. `onTimeout` can serve a partial answer

When `/quotes/best-effort` blows its deadline, the handler is suspended on an
`await` that is not going to return and the middleware was left behind three
stages ago. There is exactly one place left to produce an answer:

```ts
hooks: {
  onTimeout(ctx, info) {
    return ctx.json({
      quotes: ctx.get(Gathered),          // whatever landed, from a slot
      partial: true,
      missed: [`deadline blown during ${info.stage}`],
    }, { status: 200, headers: { 'x-degraded': 'deadline' } })
  },
}
```

Two quotes and `partial: true` beats a 504 with none. Note `info.stage` — the
compiled pipeline marked the stage boundary on the way past, so "the handler blew
it" is a field read rather than an inference from a latency chart.

The global reporting hook in `plugins/deadlines.ts` still runs even though the
route answered. `onTimeout` deliberately differs from `onError` there: everyone
observes, one answers. Under `catch` semantics a global timeout counter would go
silent the moment a route started degrading gracefully — reading zero on exactly
the routes that handled their deadlines best.

### 3. The upstream is actually cancelled

`shared/upstream.ts` records how every call ended, so the tests can assert the
difference between *stopped waiting* and *cancelled*:

```ts
assert.equal(settled.find((c) => c.provider === 'slow')?.outcome, 'aborted')
```

`ctx.signal` fires on client disconnect **and** on the deadline, and `fetch`,
`undici`, `pg` and `mongodb` all take one. Without that, a 504 means the client
stopped waiting while the query kept running — the connection-pool exhaustion
that timeouts are supposed to prevent, caused by the timeout.

---

## Propagation from the caller

```bash
curl -i localhost:3000/quotes -H 'x-request-timeout: 150'     # honoured
curl -i localhost:3000/quotes -H 'x-request-timeout: 60000'   # ignored
```

The clamp is one-way. A caller with 150 ms left telling us so is cooperative —
we stop work that was going to be discarded, and we pass a truthful budget
further down. A caller asking for an hour is either confused or hostile, and in
both cases the answer is the route's own number. That is why it is a `min` and
not a substitution, and why reading the header at all is opt-in
(`timeout: { header: … }`) rather than a default.

Watch `x-deadline-left-ms` on every response. That number, not a latency chart,
is what tells you a route is one bad Tuesday away from timing out.

---

## What it costs

Stated because I9 requires it, and measured in
[`benchmarks/deadlines/run.ts`](../../benchmarks/deadlines/run.ts):

- **A route with no deadline: nothing.** Not "almost nothing" — the generated
  pipeline is byte-identical to one compiled in an app that never heard of the
  feature. The benchmark fails the build if that stops being true.
- **The stage checks: about 1 ns per boundary**, two or three per request.
- **Arming: about a microsecond** — a timer, an `AbortController`, a listener
  and a promise. Against a route that does nothing that is a large fraction of a
  small number; against a route that talks to a database it is under half a
  percent. The denominator that decides is your handler.

A coarse timer wheel would remove most of that microsecond and is the obvious
next optimisation. It is not built.

---

## Layout

```
src/
  app.ts                      composition root — the entire timeout policy
  config/                     the default budget and the propagation header
  plugins/deadlines.ts        onTimeout reporting, headroom, /deadlines
  shared/upstream.ts          a provider that respects a signal and a budget
  features/quotes/            fan-out under a shared budget
  features/reports/           a slower subtree, and a faster route inside it
  features/feed/              timeout: false
  inspect.ts                  budgets + chains + emitted bytes
```

Feature-first, per §23.4: everything about quotes is in one directory, and
`app.ts` is the only file that decides how the application is assembled.
