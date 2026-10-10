# Zen against `node:http`, Fastify, Hono and Express

RFC §1.4 makes a falsifiable prediction: Zen's per-request work should be within noise of a
hand-written `http.createServer` handler doing the same job — *"if that is not true in
benchmarks, the thesis has failed and we should say so."* This page says so. Every number
below is read from the JSON files beside it, written by
[`benchmarks/competitors/run.ts`](../competitors/run.ts).

## Where Zen stands — `0.1.0-alpha.5`

**Behind.** On the five workloads that do no I/O, Zen serves
0.79–0.82× of what the hand-written `node:http` server serves;
Fastify serves 0.96–1.03× on four of them. The thesis's prediction does
not hold today, and the gap is not in one place: it is the same ~20% on static JSON, on a
response schema, on five path parameters and on ten middleware, which suggests a cost every
request pays — the dispatcher, the context, egress — rather than any one feature. On the
realistic workload, where a 5 ms query dominates, everyone is within a few percent.

Requests per second, median of 5 runs; the fraction is of `node:http` in the same run.

| Workload | node-http | zen | fastify | hono | express |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. Static JSON, no schema | 79,782 | 65,324 (0.82×) | 81,731 (1.02×) | 77,425 (0.97×) | 47,716 (0.60×) |
| 2. JSON with a response schema | 79,066 | 65,191 (0.82×) | 65,181 (0.82×) | 72,416 (0.92×) | 47,472 (0.60×) |
| 3. A route with 5 path params | 77,251 | 61,279 (0.79×) | 79,456 (1.03×) | 74,132 (0.96×) | 46,221 (0.60×) |
| 4. POST + body validation (Zod), ~1 KB | 47,242 | 37,363 (0.79×) | 45,584 (0.96×) | 43,804 (0.93×) | 31,650 (0.67×) |
| 5. 10 middleware | 80,858 | 64,609 (0.80×) | 80,314 (0.99×) | 67,430 (0.83×) | 47,091 (0.58×) |
| 6. Realistic: JWT, rate limit, Zod, 5 ms DB, ~2 KB out | 19,971 | 19,499 (0.98×) | 20,205 (1.01×) | 20,978 (1.05×) | 19,072 (0.95×) |

One cell is not like the others, and is shown as it was measured: Fastify on workload 2 came out
at 0.82× in this run, with a tight spread across its five runs, where the
`0.1.0-alpha.4` run measured it at 1.03×. Fastify's app and dependencies are identical in both
runs. Re-run alone, the same cell measured 1.02× — with Zen at
0.83× beside it, as in the full run — so the full run's figure looks like that
one process's steady state rather than Fastify's; `0.1.0-alpha.5-recheck-w2.json` is beside
this page.

## What each fix did

The first run pointed at JSON intake — a reviver on every body — and the POST workload went from
23,394 to 37,363 req/s once a body that cannot hold a forbidden key stopped
paying for one. The other two fixes this release made to the request path are real — a route of
plain functions now compiles with no `async` and no `await`, and a served match builds no
`Set` — and neither moved throughput beyond this benchmark's noise: the dispatcher around the
pipeline is still an `async` function, so a request still pays a promise and a tick whatever its
pipeline does. That is the next place to look.

Zen's rate, and its fraction of `node:http` in the same run, after each change in turn:

| Workload | `0.1.0-alpha.4` | + JSON intake | + speculative sync | + router reuse | `0.1.0-alpha.5` |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. Static JSON, no schema | 65,142 (0.81×) | 65,589 (0.82×) | 65,572 (0.82×) | 66,099 (0.82×) | 65,324 (0.82×) |
| 2. JSON with a response schema | 65,069 (0.83×) | 65,139 (0.83×) | 64,662 (0.82×) | 63,292 (0.80×) | 65,191 (0.82×) |
| 3. A route with 5 path params | 62,928 (0.82×) | 62,509 (0.81×) | 63,103 (0.82×) | 62,425 (0.82×) | 61,279 (0.79×) |
| 4. POST + body validation (Zod), ~1 KB | 23,394 (0.49×) | 37,453 (0.80×) | 37,343 (0.79×) | 37,718 (0.80×) | 37,363 (0.79×) |
| 5. 10 middleware | 64,362 (0.80×) | 65,468 (0.81×) | 65,287 (0.81×) | 65,881 (0.82×) | 64,609 (0.80×) |
| 6. Realistic: JWT, rate limit, Zod, 5 ms DB, ~2 KB out | 19,254 (0.94×) | 19,563 (0.96×) | 19,442 (0.97×) | 19,288 (0.95×) | 19,499 (0.98×) |

The staged runs each measured `node:http` and Zen only, built from `0.1.0-alpha.4` with that
change and the ones before it applied; the last column is the full run above, which also has
the logger binding, the ingress limits, the issue-code seam and the unit retention change.

## Before — `0.1.0-alpha.4`

| Workload | node-http | zen | fastify | hono | express |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. Static JSON, no schema | 80,467 | 65,142 (0.81×) | 81,798 (1.02×) | 77,332 (0.96×) | 48,508 (0.60×) |
| 2. JSON with a response schema | 78,775 | 65,069 (0.83×) | 80,788 (1.03×) | 75,674 (0.96×) | 47,434 (0.60×) |
| 3. A route with 5 path params | 77,146 | 62,928 (0.82×) | 78,449 (1.02×) | 71,034 (0.92×) | 46,288 (0.60×) |
| 4. POST + body validation (Zod), ~1 KB | 47,516 | 23,394 (0.49×) | 45,178 (0.95×) | 43,216 (0.91×) | 31,448 (0.66×) |
| 5. 10 middleware | 80,096 | 64,362 (0.80×) | 79,287 (0.99×) | 67,696 (0.85×) | 46,425 (0.58×) |
| 6. Realistic: JWT, rate limit, Zod, 5 ms DB, ~2 KB out | 20,394 | 19,254 (0.94×) | 20,198 (0.99×) | 20,333 (1.00×) | 18,942 (0.93×) |

## Method, and what it is not

- **The workloads** are Annex C's first six. Each server is its own Node process, booted per
  workload; each answers the workload's request once, and must produce the expected status and
  body, before anything is timed. A run with any error, timeout or non-2xx response fails its
  cell rather than being averaged in.
- **The apps** are written the way each framework's documentation teaches — Zen's with plain
  functions, no `markSync()`, and Zod schemas registered through `registerSchemaConverter`;
  Fastify's with JSON-schema response serialization; Hono's through `@hono/node-server`.
  The others validate with the same Zod schemas, calling `safeParse` themselves. They do not do
  the same work in one respect worth stating: Zen's JSON intake enforces a depth limit and
  strips `__proto__`, `constructor` and `prototype` keys, Fastify's default parser refuses
  prototype keys, and the hand-written baseline, Hono and Express parse with plain
  `JSON.parse` — so part of workload 4's gap is protection the baseline does not have.
  Annex C's fairness rule — each app reviewed by someone who prefers that framework — has
  **not** been met: all five were written here.
- **The protocol is lighter than Annex C's**, and the page should be read with that in mind:
  5 runs of 10 s after a 3 s warm-up, where Annex C asks for
  60 s runs after 30 s; 128 connections, pipelining 1, and
  autocannon with 2 worker threads **on the same machine** as the server, where
  Annex C asks for a dedicated host and a load generator on another. Ratios between servers
  measured in the same run are the claim; absolute numbers are one laptop's.
- **The machine:** Apple M5 × 10, 16 GB, darwin 25.5.0 arm64, Node
  v24.21.0. Fastify 5.12.5, Hono 4.13.12 with `@hono/node-server`
  2.1.3, Express 5.2.1, Zod 4.6.5, autocannon
  8.0.0.
- **Not covered yet:** Koa, which the roadmap names alongside these four; Annex C workloads 7–12
  (streaming, many SSE connections, the 1,000-route match distribution, cold boot, the
  all-failing error path); the TypeBox and Valibot variants of workload 4; allocations per
  request and p99.9.
- **`before`** is `0.1.0-alpha.4` at `5483903`. **`after`** is the `0.1.0-alpha.5` tree,
  measured before it was committed, on top of `5483903` — which is why its JSON names that
  commit "with uncommitted changes", and the version its `package.json` still had (0.1.0-alpha.4).

## Every cell — `0.1.0-alpha.5`

Spread is max − min of the 5 runs as a fraction of their median; p50 and p99 are
medians across runs, in whole milliseconds as autocannon reports them; RSS is the server's after
its runs; boot is the time from spawn to accepting.

| Workload | Server | req/s | spread | p50 | p99 | RSS | boot |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | node-http | 79,782 | 1.7% | 1 ms | 3 ms | 131 MB | 109 ms |
| 1 | zen | 65,324 | 1.2% | 1 ms | 2 ms | 170 MB | 138 ms |
| 1 | fastify | 81,731 | 1.5% | 1 ms | 3 ms | 139 MB | 191 ms |
| 1 | hono | 77,425 | 0.4% | 1 ms | 3 ms | 168 MB | 126 ms |
| 1 | express | 47,716 | 0.4% | 2 ms | 3 ms | 181 MB | 148 ms |
| 2 | node-http | 79,066 | 0.8% | 1 ms | 3 ms | 131 MB | 106 ms |
| 2 | zen | 65,191 | 1.0% | 1 ms | 2 ms | 170 MB | 137 ms |
| 2 | fastify | 65,181 | 2.2% | 1 ms | 2 ms | 140 MB | 159 ms |
| 2 | hono | 72,416 | 1.6% | 1 ms | 3 ms | 166 MB | 117 ms |
| 2 | express | 47,472 | 1.4% | 2 ms | 3 ms | 172 MB | 134 ms |
| 3 | node-http | 77,251 | 2.8% | 1 ms | 3 ms | 133 MB | 109 ms |
| 3 | zen | 61,279 | 1.1% | 2 ms | 2 ms | 171 MB | 143 ms |
| 3 | fastify | 79,456 | 1.6% | 1 ms | 3 ms | 139 MB | 160 ms |
| 3 | hono | 74,132 | 0.4% | 1 ms | 2 ms | 168 MB | 116 ms |
| 3 | express | 46,221 | 1.0% | 2 ms | 3 ms | 181 MB | 135 ms |
| 4 | node-http | 47,242 | 1.5% | 2 ms | 3 ms | 168 MB | 111 ms |
| 4 | zen | 37,363 | 1.2% | 3 ms | 3 ms | 180 MB | 134 ms |
| 4 | fastify | 45,584 | 1.6% | 2 ms | 3 ms | 175 MB | 157 ms |
| 4 | hono | 43,804 | 0.7% | 2 ms | 3 ms | 176 MB | 123 ms |
| 4 | express | 31,650 | 0.5% | 3 ms | 4 ms | 196 MB | 131 ms |
| 5 | node-http | 80,858 | 2.4% | 1 ms | 3 ms | 131 MB | 113 ms |
| 5 | zen | 64,609 | 3.1% | 1 ms | 2 ms | 170 MB | 135 ms |
| 5 | fastify | 80,314 | 2.2% | 1 ms | 3 ms | 139 MB | 155 ms |
| 5 | hono | 67,430 | 3.0% | 1 ms | 2 ms | 172 MB | 118 ms |
| 5 | express | 47,091 | 1.0% | 2 ms | 3 ms | 178 MB | 136 ms |
| 6 | node-http | 19,971 | 1.5% | 6 ms | 8 ms | 217 MB | 114 ms |
| 6 | zen | 19,499 | 0.5% | 6 ms | 8 ms | 235 MB | 160 ms |
| 6 | fastify | 20,205 | 0.7% | 6 ms | 7 ms | 219 MB | 213 ms |
| 6 | hono | 20,978 | 2.0% | 5 ms | 7 ms | 225 MB | 139 ms |
| 6 | express | 19,072 | 0.7% | 6 ms | 8 ms | 232 MB | 173 ms |

## Reproducing it

```sh
npm ci && npx tsc -b                         # Zen is read from the workspace's dist/
npm ci --prefix benchmarks/competitors       # the frameworks compared against, from their own lockfile
node benchmarks/competitors/run.ts --runs 5 --duration 10 --warmup 3 --connections 128 --workers 2
```

`--smoke` is what CI runs: every server, every workload, the correctness check and a one-second
run with no errors — the harness working, not a timing.
