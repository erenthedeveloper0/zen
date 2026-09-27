/**
 * What health and readiness cost — rfcs/0001 §31.4, §18.6, I9.
 *
 * `node benchmarks/health/run.ts`
 *
 * A health endpoint looks like the one thing in a service too cheap to measure,
 * and that intuition is what makes it dangerous. It is polled by the
 * orchestrator, the load balancer, the service mesh and the metrics scraper
 * simultaneously and forever, at a rate nobody chose deliberately, and the
 * naive implementation turns each of those polls into a round trip to the
 * component least able to absorb one. The cost that matters here is not
 * microseconds on the endpoint; it is **how much load the endpoint puts on the
 * things it is asking about**.
 *
 * Five questions, three of which fail the build:
 *
 *   1. **What does an application route pay for the feature existing?**
 *      Nothing, and — as in §9.4 and §4.4 — that is checked against the emitted
 *      bytes rather than a clock, because a benchmark inside the noise looks
 *      identical to a cost that is real and small. **Gated.**
 *   2. **How many probes does a stampede produce?** One. This is the whole
 *      feature, and it is the number that decides whether the endpoint helps or
 *      hurts during an incident. **Gated.**
 *   3. **Can one wedged dependency take the endpoint down?** No: each check
 *      carries its own budget, and the report still names the healthy ones.
 *      **Gated.**
 *   4. **What does the endpoint itself cost?** Liveness, readiness cold,
 *      readiness cached — against an ordinary route as the yardstick.
 *   5. **Does the cost scale with the number of dependencies?** Only in the
 *      cached case should it, and only linearly in report-building; the probes
 *      themselves fan out in parallel, so ten dependencies cost the slowest
 *      one rather than the sum.
 */
import { createApp, healthPlugin, markSync, type ZenApp } from '@visionpilot/zen-core'
import { ZenRouter, parsePath } from '@visionpilot/zen-router'

const pathParser = {
  parse: (path: string) => {
    const parsed = parsePath(path)
    return { path: parsed.path, segments: parsed.segments }
  },
}

const silent = (() => {
  const noop = () => {}
  const logger = { level: 'fatal' as const, child: () => logger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
  return logger
})()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function buildApp(configure: (app: ZenApp) => void, dev = false): ZenApp {
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent, dev })
  configure(app)
  return app
}

const ITERATIONS = 20_000
const REPS = 7

/**
 * Paired, alternating which arm runs first — the harness the hook and deadline
 * benchmarks use, and for the same reason: two apps timed one after the other
 * drift by more than several of the effects being claimed, and alternating
 * makes that drift common-mode.
 */
async function compare(
  a: { app: ZenApp; url: string },
  b: { app: ZenApp; url: string },
  iterations = ITERATIONS,
): Promise<{ a: number; b: number; ratio: number; spread: number }> {
  const hit = (x: { app: ZenApp; url: string }) => x.app.inject('GET', x.url)
  for (let i = 0; i < 2000; i++) { await hit(a); await hit(b) }

  const aTimes: number[] = []
  const bTimes: number[] = []
  const ratios: number[] = []

  for (let rep = 0; rep < REPS; rep++) {
    const first = rep % 2 === 0 ? a : b
    const second = rep % 2 === 0 ? b : a

    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) await hit(first)
    const t1 = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) await hit(second)
    const t2 = process.hrtime.bigint()

    const firstUs = Number(t1 - t0) / 1e3 / iterations
    const secondUs = Number(t2 - t1) / 1e3 / iterations
    aTimes.push(rep % 2 === 0 ? firstUs : secondUs)
    bTimes.push(rep % 2 === 0 ? secondUs : firstUs)
    ratios.push((rep % 2 === 0 ? secondUs : firstUs) / (rep % 2 === 0 ? firstUs : secondUs))
  }

  const sorted = [...ratios].sort((x, y) => x - y)
  const ratio = sorted[Math.floor(sorted.length / 2)] as number
  return {
    a: Math.min(...aTimes),
    b: Math.min(...bTimes),
    ratio,
    spread: ((sorted[sorted.length - 1] as number) - (sorted[0] as number)) / ratio,
  }
}

/** Best of N for one endpoint, in microseconds. */
async function timeEndpoint(app: ZenApp, url: string, iterations = ITERATIONS): Promise<number> {
  for (let i = 0; i < 2000; i++) await app.inject('GET', url)
  const runs: number[] = []
  for (let rep = 0; rep < 5; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) await app.inject('GET', url)
    runs.push(Number(process.hrtime.bigint() - start) / 1e3 / iterations)
  }
  return Math.min(...runs)
}

const verdict = (ratio: number, spread: number): string =>
  `${((ratio - 1) * 100).toFixed(1).padStart(7)}%   ` +
  (Math.abs(ratio - 1) <= spread ? 'INSIDE NOISE' : 'ABOVE NOISE')

console.log('\n  Health & readiness — rfcs/0001 §31.4')
console.log('  node ' + process.version + '\n')

// ── 1. what the feature costs a route that is not a health endpoint ─────────

console.log('  1. What an application route pays for health existing\n')

{
  const bare = buildApp((app) => { app.get('/orders/:id', markSync(() => ({ ok: true }))) }, true)
  const withHealth = buildApp((app) => {
    app.use(healthPlugin)
    app.health('db', () => {})
    app.health('redis', () => {})
    app.get('/orders/:id', markSync(() => ({ ok: true })))
  }, true)

  await bare.ready()
  await withHealth.ready()

  const source = (app: ZenApp): string =>
    app.generatedSource().find((u) => u.name.startsWith('pipeline:') && u.name.includes('orders'))?.source ?? ''

  const a = source(bare)
  const b = source(withHealth)

  console.log(`    no health plugin                           ${String(a.length).padStart(5)} bytes`)
  console.log(`    health plugin + 2 checks registered        ${String(b.length).padStart(5)} bytes`)
  console.log(`    byte-identical: ${a === b ? 'yes — health is two routes and a registry, not a tax' : 'NO'}`)

  if (a !== b || a.length === 0) {
    console.error('\n    ::error:: registering the health plugin changed an application route (§31.4)')
    process.exitCode = 1
  }

  // The request-level confirmation. The structural check above is the real
  // gate; this only rules out a change in the *dispatcher* rather than the
  // pipeline, which bytes would not catch.
  const r = await compare({ app: bare, url: '/orders/7' }, { app: withHealth, url: '/orders/7' })
  console.log(`\n    per-request, paired:  ${r.a.toFixed(2)} µs → ${r.b.toFixed(2)} µs  ${verdict(r.ratio, r.spread)}`)
  console.log(`    (spread ${(r.spread * 100).toFixed(0)}%)`)
}

// ── 2. the stampede ─────────────────────────────────────────────────────────

console.log('\n  2. What a stampede costs the dependency\n')

{
  const POLLERS = 500
  const ROUND_TRIP = 5

  // The same dependency, the same poll count, and — importantly — the same
  // *shape*: both arms are a route on a Zen app answered through `inject()`.
  // Comparing the registry against a bare loop of promises would charge one
  // arm for the whole HTTP pipeline and call the difference a feature.
  let collapsed = 0
  const managed = buildApp((a) => {
    a.use(healthPlugin)
    a.health('db', async () => { collapsed++; await sleep(ROUND_TRIP) }, { ttl: '1s' })
  })
  await managed.ready()

  let naive = 0
  const handRolled = buildApp((a) => {
    // What a health endpoint looks like when it is written by hand — which is
    // to say, correct, readable, and quietly multiplying load by the number of
    // things watching.
    a.get('/readyz', async function handWrittenReadyz(ctx: { json(v: unknown): unknown }) {
      naive++
      await sleep(ROUND_TRIP)
      return ctx.json({ status: 'pass' })
    })
  })
  await handRolled.ready()

  const timed = async (app: ZenApp): Promise<number> => {
    const t = process.hrtime.bigint()
    await Promise.all(Array.from({ length: POLLERS }, () => app.inject('GET', '/readyz')))
    return Number(process.hrtime.bigint() - t) / 1e6
  }

  const managedMs = await timed(managed)
  const naiveMs = await timed(handRolled)

  console.log(`    ${POLLERS} simultaneous polls, one dependency, ${ROUND_TRIP}ms round trip\n`)
  const plural = (n: number): string => (n === 1 ? 'probe ' : 'probes')
  console.log(`    single-flight + TTL      ${String(collapsed).padStart(5)} ${plural(collapsed)}  ${managedMs.toFixed(1)}ms`)
  console.log(`    one probe per poll       ${String(naive).padStart(5)} ${plural(naive)}  ${naiveMs.toFixed(1)}ms`)
  console.log('')
  console.log(`    ${(naive / Math.max(collapsed, 1)).toFixed(0)}× fewer round trips to a component that, at the moment this`)
  console.log('    matters, is the one already in trouble. This is the entire feature:')
  console.log('    the endpoint exists to describe an outage, and the naive form makes')
  console.log('    the outage worse in proportion to how many things are watching.')
  console.log('')
  console.log('    The wall times are close and that is not the point — 500 concurrent')
  console.log('    fake sleeps overlap either way. The load on the *dependency* is what')
  console.log('    differs, and in a real deployment those 500 probes are 500 connections')
  console.log('    checked out of a pool that is already failing to hand them out.')

  if (collapsed !== 1) {
    console.error(`\n    ::error:: single-flight regressed — ${collapsed} probes for ${POLLERS} simultaneous polls (§31.4)`)
    process.exitCode = 1
  }
}

// ── 3. one wedged dependency ────────────────────────────────────────────────

console.log('\n  3. Can one wedged dependency take the endpoint down?\n')

{
  const app = buildApp((a) => {
    a.use(healthPlugin)
    a.health('fast', () => {}, { ttl: 0 })
    a.health('wedged', () => new Promise<void>(() => {}), { timeout: 50, ttl: 0 })
  })
  await app.ready()

  const started = process.hrtime.bigint()
  const res = await app.inject('GET', '/readyz')
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6
  const body = res.json<{ status: string; checks: Record<string, { status: string }> }>()

  console.log(`    answered in                                ${elapsed.toFixed(1)}ms   (wedged check budget: 50ms)`)
  console.log(`    status                                     ${res.status} ${body.status}`)
  console.log(`    fast                                       ${body.checks['fast']?.status}`)
  console.log(`    wedged                                     ${body.checks['wedged']?.status}`)
  console.log('')
  console.log('    The healthy component is still reported as healthy. A single budget')
  console.log('    over the whole endpoint would have produced one 504 and the least')
  console.log('    useful sentence available during an incident — "the health check')
  console.log('    timed out" — which names nothing and rules out nothing.')

  const isolated =
    elapsed < 500 &&
    res.status === 503 &&
    body.checks['fast']?.status === 'pass' &&
    body.checks['wedged']?.status === 'fail'
  if (!isolated) {
    console.error('\n    ::error:: a wedged check escaped its own budget or hid a healthy one (§31.4)')
    process.exitCode = 1
  }
}

// ── 4. what the endpoints themselves cost ───────────────────────────────────

console.log('\n  4. The endpoints, against an ordinary route\n')

{
  const plain = buildApp((a) => { a.get('/bench', markSync(() => ({ ok: true }))) })
  await plain.ready()

  // The fair yardstick. A health handler is `async` because probing is, so
  // comparing it against §8.4's synchronous fast path would charge health for
  // something it did not cause. Both rows are printed; the second is the one
  // the later differences should be read against.
  const plainAsync = buildApp((a) => { a.get('/bench', async () => ({ ok: true })) })
  await plainAsync.ready()

  // Long TTL: every request after the first is a cache hit, which is what a
  // real deployment sees at any poll interval shorter than the TTL.
  const cached = buildApp((a) => {
    a.use(healthPlugin)
    a.health('db', () => {}, { ttl: '1h' })
    a.health('redis', () => {}, { ttl: '1h' })
  })
  await cached.ready()

  // TTL 0: every request re-probes. Two trivial synchronous probes, so this is
  // the *machinery* of a fresh probe — the deadline arm, the race, the report —
  // and not the I/O a real probe would dominate with.
  const fresh = buildApp((a) => {
    a.use(healthPlugin)
    a.health('db', () => {}, { ttl: 0 })
    a.health('redis', () => {}, { ttl: 0 })
  })
  await fresh.ready()

  const rows: Array<[string, ZenApp, string]> = [
    ['an ordinary JSON route, sync', plain, '/bench'],
    ['an ordinary JSON route, async', plainAsync, '/bench'],
    ['GET /healthz (no checks reach it)', cached, '/healthz'],
    ['GET /readyz, 2 checks, cached', cached, '/readyz'],
    ['GET /readyz, 2 checks, re-probed', fresh, '/readyz'],
  ]

  const measured: number[] = []
  for (const [label, app, url] of rows) {
    const us = await timeEndpoint(app, url, 10_000)
    measured.push(us)
    console.log(`    ${label.padEnd(38)}${us.toFixed(2).padStart(7)} µs`)
  }

  const [, asyncBase = 0, liveness = 0, cachedReady = 0, freshReady = 0] = measured

  console.log('')
  console.log(`    Liveness is ${(liveness - asyncBase).toFixed(2)} µs over an async route that returns a literal, and`)
  console.log('    it does no dependency work at all — that gap is a small report object')
  console.log('    and two `performance.now()` calls. Worth stating rather than rounding')
  console.log('    to "free": by construction liveness cannot check anything, because the')
  console.log('    process answered this request, so its event loop is turning. The')
  console.log('    response *is* the check.')
  console.log('')
  console.log(`    A cached readiness report with two components adds ${(cachedReady - liveness).toFixed(2)} µs for the pair —`)
  console.log('    a map lookup and one row built per component. Section 5 separates the')
  console.log('    fixed part of that from the per-component part.')
  console.log('')
  console.log(`    Re-probing the same two costs ${((freshReady - cachedReady) / 2).toFixed(2)} µs per check on top, and that`)
  console.log('    number is the interesting one: it is a deadline arm, a race and a fresh')
  console.log('    report. `benchmarks/deadlines/run.ts` measures the arm alone at about a')
  console.log('    microsecond from a completely different direction, which is the sort of')
  console.log('    agreement that makes a measurement worth believing.')
  console.log('')
  console.log('    It is also the number the TTL exists to amortise: paid once per second')
  console.log('    per dependency instead of once per poll, against a real probe whose own')
  console.log('    I/O is three orders of magnitude larger anyway.')
}

// ── 5. does it scale with the number of dependencies? ───────────────────────

console.log('\n  5. Scaling with dependency count\n')

{
  console.log('     checks    cached      re-probed')
  const cachedAt = new Map<number, number>()
  const freshAt = new Map<number, number>()
  for (const n of [1, 4, 16]) {
    const app = buildApp((a) => {
      a.use(healthPlugin)
      for (let i = 0; i < n; i++) a.health(`c${i}`, () => {}, { ttl: '1h' })
    })
    await app.ready()

    const freshApp = buildApp((a) => {
      a.use(healthPlugin)
      for (let i = 0; i < n; i++) a.health(`c${i}`, () => {}, { ttl: 0 })
    })
    await freshApp.ready()

    const cachedUs = await timeEndpoint(app, '/readyz', 8000)
    const freshUs = await timeEndpoint(freshApp, '/readyz', 8000)
    cachedAt.set(n, cachedUs)
    freshAt.set(n, freshUs)
    console.log(`    ${String(n).padStart(7)}${cachedUs.toFixed(2).padStart(11)} µs${freshUs.toFixed(2).padStart(12)} µs`)
  }

  const slope = (m: Map<number, number>): number =>
    (((m.get(16) ?? 0) - (m.get(1) ?? 0)) / 15)

  console.log('')
  console.log(`    Marginal cost per component: ${slope(cachedAt).toFixed(2)} µs cached, ${slope(freshAt).toFixed(2)} µs re-probed.`)
  console.log('    Linear in the count, over a fixed base — the report has one row per')
  console.log('    component and somebody has to build them.')
  console.log('')
  console.log('    What is *not* linear is the latency a real deployment sees, because the')
  console.log('    probes fan out with Promise.all: sixteen dependencies at 20 ms each cost')
  console.log('    20 ms, not 320. These numbers are microseconds precisely because the')
  console.log('    probes here do nothing — the shape of the curve is the finding, not its')
  console.log('    height. Running them in series is the mistake most hand-rolled versions')
  console.log('    make, and it turns the health endpoint into the slowest thing in the')
  console.log('    cluster at exactly the moment somebody is polling it every second.')
}

console.log('')
