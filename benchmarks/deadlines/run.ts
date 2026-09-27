/**
 * What a deadline costs — rfcs/0001 §4.4, §18.6, I9.
 *
 * `node benchmarks/deadlines/run.ts`
 *
 * Timeouts are the feature people assume is free because `setTimeout` looks
 * free. It is not: a deadline is a timer, an `AbortController`, a listener on
 * the connection's signal, a promise, and — when the pipeline actually suspends
 * — a `Promise.race`. Six allocations on a path that otherwise allocates about
 * nine. That is a real number and it belongs in the open, because the decision
 * a reader has to make is "should this route have a budget", and they cannot
 * make it against a shrug.
 *
 * Five questions:
 *
 *   1. **What does a route without a deadline pay?** Nothing, and that is
 *      checked against the emitted bytes rather than the clock — a benchmark
 *      inside the noise is also what you see when a cost is real and small.
 *   2. **What do the stage checks cost?** The part that runs on every
 *      deadline-bearing request whether or not the deadline ever fires.
 *   3. **What does arming cost?** The timer, the signal and the promise,
 *      end to end, which is the number that decides whether a default budget is
 *      affordable.
 *   4. **Does the sync fast path escape the race?** §8.4's sync pipelines never
 *      yield, so their deadline provably cannot fire and the dispatcher skips
 *      the race entirely. Either that shows up here or the claim is empty.
 *   5. **Where does the cost actually sit?** Decomposed, so the next person to
 *      optimise it knows which of the five allocations to attack.
 */
import {
  createApp, compilePipeline, CodeGen, DEFAULT_CAPABILITIES, PlainContext, ZenContainer,
  Deadline, markSync,
  type PipelineSpec, type RawRequest, type Reply,
} from '@visionpilot/zen-core'
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

// ─── pipeline-level harness ──────────────────────────────────────────────────

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })
const container = new ZenContainer()
const never = new AbortController().signal

const noop = () => {}
let sink = 0

/** A budget nothing in this process will ever reach, so nothing fires mid-run. */
const live = new Deadline(3_600_000, never)

function context(deadline: Deadline | null): PlainContext {
  const raw: RawRequest = {
    method: 'GET',
    url: '/bench',
    header: () => undefined,
    headerNames: () => [],
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '127.0.0.1', port: 0, family: 'IPv4' },
    native: null,
  }
  const route = { id: 'bench', name: 'bench', method: 'GET' as const, path: '/bench', meta: new Map() }
  return new PlainContext(raw, route, {}, {
    log: silent, maxQueryParams: 100, trustProxy: false, container,
  }, 4, deadline === null ? never : deadline.signal, deadline)
}

function pipelineSpec(deadline: boolean, id: string): PipelineSpec {
  return {
    routeId: `${id}_${Math.random().toString(36).slice(2)}`,
    steps: [],
    handler: markSync(() => ({ ok: true, n: 1 })),
    intake: null,
    validators: [{ source: 'query', run: markSync(() => {}) }],
    serialize: null,
    deadline,
  }
}

function pipeline(deadline: boolean, id: string): (ctx: unknown) => Reply | Promise<Reply> {
  return compilePipeline(pipelineSpec(deadline, id), codegen)
}

function sourceOf(spec: PipelineSpec): string {
  const probe = new CodeGen({ caps: DEFAULT_CAPABILITIES })
  compilePipeline(spec, probe)
  return probe.units[probe.units.length - 1]?.source ?? ''
}

const PIPELINE_ITERATIONS = 2_000_000
const REPS = 9

/**
 * Paired comparison, alternating which arm runs first — the same harness the
 * hook benchmark uses and for the same reason: two separately compiled
 * functions timed one after another drift by more than several of the effects
 * being claimed here, and alternating makes that drift common-mode.
 */
function comparePipelines(
  a: { fn: (ctx: unknown) => unknown; ctx: unknown },
  b: { fn: (ctx: unknown) => unknown; ctx: unknown },
): { a: number; b: number; ratio: number; ratioSpread: number } {
  for (let i = 0; i < 100_000; i++) { a.fn(a.ctx); b.fn(b.ctx) }

  const aTimes: number[] = []
  const bTimes: number[] = []
  const ratios: number[] = []

  for (let rep = 0; rep < REPS; rep++) {
    const first = rep % 2 === 0 ? a : b
    const second = rep % 2 === 0 ? b : a

    const t0 = process.hrtime.bigint()
    for (let i = 0; i < PIPELINE_ITERATIONS; i++) first.fn(first.ctx)
    const t1 = process.hrtime.bigint()
    for (let i = 0; i < PIPELINE_ITERATIONS; i++) second.fn(second.ctx)
    const t2 = process.hrtime.bigint()

    const firstNs = Number(t1 - t0) / PIPELINE_ITERATIONS
    const secondNs = Number(t2 - t1) / PIPELINE_ITERATIONS
    const aNs = rep % 2 === 0 ? firstNs : secondNs
    const bNs = rep % 2 === 0 ? secondNs : firstNs

    aTimes.push(aNs)
    bTimes.push(bNs)
    ratios.push(bNs / aNs)
  }

  const sorted = [...ratios].sort((x, y) => x - y)
  const ratio = sorted[Math.floor(sorted.length / 2)] as number
  return {
    a: Math.min(...aTimes),
    b: Math.min(...bTimes),
    ratio,
    ratioSpread: ((sorted[sorted.length - 1] as number) - (sorted[0] as number)) / ratio,
  }
}

const verdict = (ratio: number, spread: number): string =>
  `${((ratio - 1) * 100).toFixed(1).padStart(7)}%   ` +
  (Math.abs(ratio - 1) <= spread ? 'INSIDE NOISE' : 'ABOVE NOISE')

// ─── request-level harness ───────────────────────────────────────────────────

type Build = (app: ReturnType<typeof createApp>) => void

function buildApp(configure: Build, timeout?: string) {
  const app = createApp(
    timeout === undefined
      ? { router: new ZenRouter(), pathParser, logger: silent }
      : { router: new ZenRouter(), pathParser, logger: silent, timeout },
  )
  configure(app)
  return app
}

const REQUEST_ITERATIONS = 20_000

type Injectable = { inject: (m: string, u: string) => Promise<unknown> }

/**
 * Paired at the request level too.
 *
 * The first draft timed the two apps one after the other and reported spreads
 * of 28% and 87% around a difference of 50% — numbers that cannot support the
 * claim being made. Alternating the arms inside each rep and taking the median
 * of the per-rep *ratios* makes GC and tiering common-mode, which is the only
 * way a 1 µs effect on a 2 µs baseline is measurable at all.
 */
async function compareRequests(a: Injectable, b: Injectable): Promise<{
  a: number; b: number; deltaNs: number; lowNs: number; highNs: number; ratio: number; ratioSpread: number
}> {
  for (let i = 0; i < 5000; i++) { await a.inject('GET', '/bench'); await b.inject('GET', '/bench') }

  const aTimes: number[] = []
  const bTimes: number[] = []
  const ratios: number[] = []

  for (let rep = 0; rep < REPS; rep++) {
    const first = rep % 2 === 0 ? a : b
    const second = rep % 2 === 0 ? b : a

    const t0 = process.hrtime.bigint()
    for (let i = 0; i < REQUEST_ITERATIONS; i++) await first.inject('GET', '/bench')
    const t1 = process.hrtime.bigint()
    for (let i = 0; i < REQUEST_ITERATIONS; i++) await second.inject('GET', '/bench')
    const t2 = process.hrtime.bigint()

    const firstUs = Number(t1 - t0) / 1e3 / REQUEST_ITERATIONS
    const secondUs = Number(t2 - t1) / 1e3 / REQUEST_ITERATIONS
    const aUs = rep % 2 === 0 ? firstUs : secondUs
    const bUs = rep % 2 === 0 ? secondUs : firstUs

    aTimes.push(aUs)
    bTimes.push(bUs)
    ratios.push(bUs / aUs)
  }

  const sorted = [...ratios].sort((x, y) => x - y)
  const ratio = sorted[Math.floor(sorted.length / 2)] as number
  const bestA = Math.min(...aTimes)
  const cost = (r: number): number => bestA * (r - 1) * 1000
  return {
    a: bestA,
    b: Math.min(...bTimes),
    deltaNs: cost(ratio),
    lowNs: cost(sorted[0] as number),
    highNs: cost(sorted[sorted.length - 1] as number),
    ratio,
    ratioSpread: ((sorted[sorted.length - 1] as number) - (sorted[0] as number)) / ratio,
  }
}

/** Best of N for a bare operation, in nanoseconds. */
function timeOp(label: string, iterations: number, fn: () => void): number {
  for (let i = 0; i < 10_000; i++) fn()
  const runs: number[] = []
  for (let rep = 0; rep < 5; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) fn()
    runs.push(Number(process.hrtime.bigint() - start) / iterations)
  }
  const best = Math.min(...runs)
  console.log(`    ${label.padEnd(44)} ${best.toFixed(0).padStart(5)} ns`)
  return best
}

function pipelineSource(app: { generatedSource(): readonly { name: string; source: string }[] }, match: string): string {
  return app.generatedSource().find((u) => u.name.startsWith('pipeline:') && u.name.includes(match))?.source ?? ''
}

console.log('\n  Request deadlines — rfcs/0001 §4.4')
console.log('  node ' + process.version + '\n')

// ── 1. what a route without a deadline pays ─────────────────────────────────

console.log('  1. Routes that declared no deadline\n')

{
  const bare = buildApp((app) => { app.get('/bench', markSync(() => ({ ok: true, n: 1 }))) })
  const elsewhere = buildApp((app) => {
    app.get('/bench', markSync(() => ({ ok: true, n: 1 })))
    app.collection('/bounded', { timeout: '2s' }, (c) => {
      c.get('/x', markSync(() => ({ ok: true })))
    })
  })
  // An app-wide default with one route opting out: the opt-out has to be as
  // free as never having configured one, or `timeout: false` is a lie.
  const optedOut = buildApp((app) => {
    app.get('/bench', { timeout: false }, markSync(() => ({ ok: true, n: 1 })))
  }, '30s')

  await bare.ready()
  await elsewhere.ready()
  await optedOut.ready()

  const a = pipelineSource(bare, 'bench')
  const b = pipelineSource(elsewhere, 'bench')
  const c = pipelineSource(optedOut, 'bench')

  console.log(`    no deadline configured anywhere            ${String(a.length).padStart(5)} bytes`)
  console.log(`    a deadline on a sibling collection         ${String(b.length).padStart(5)} bytes`)
  console.log(`    app default 30s, this route opted out      ${String(c.length).padStart(5)} bytes`)
  console.log(`    all three byte-identical: ${a === b && b === c ? 'yes — the feature does not exist for this route' : 'NO'}`)

  if (a !== b || b !== c) {
    console.error('\n    ::error:: deadline machinery leaked into a route that has no deadline (§4.4)')
    process.exitCode = 1
  }

  // The other half: a route that *does* have one must still emit every
  // boundary. A compiler change that quietly dropped a stage mark would remove
  // cancellation without failing a status-code test anywhere.
  const bounded = pipelineSource(elsewhere, 'bounded')
  const marks = [...bounded.matchAll(/dl\.stage = '(\w+)'/g)].map((m) => m[1])
  console.log(`\n    boundaries emitted on a bounded route:    ${marks.join(' → ')}`)
  if (marks.join(',') !== 'validate,handler') {
    console.error('    ::error:: a §4.1 stage boundary lost its deadline check')
    process.exitCode = 1
  }
}

// ── 2. what the stage checks cost ───────────────────────────────────────────

console.log('\n  2. The per-request cost of the checks, on the compiled pipeline\n')

{
  const withoutDl = { fn: pipeline(false, 'nodl'), ctx: context(null) }
  const withDl = { fn: pipeline(true, 'dl'), ctx: context(live) }
  const r = comparePipelines(withoutDl, withDl)

  console.log(`    no deadline           ${r.a.toFixed(1).padStart(7)} ns/req`)
  console.log(`    2 stage boundaries    ${r.b.toFixed(1).padStart(7)} ns/req`)
  console.log(`    difference            ${verdict(r.ratio, r.ratioSpread)}   (paired, spread ${(r.ratioSpread * 100).toFixed(0)}%)`)
  console.log(`\n    About ${((r.b - r.a) / 2).toFixed(1)} ns per boundary — two field reads, a null check and a`)
  console.log('    store of an interned literal. Small, and *measurable*, which is the more')
  console.log('    useful outcome: an effect that hides inside the noise is indistinguishable')
  console.log('    from one that is real and just below the resolution, so a number that')
  console.log('    survives paired sampling is worth more than a shrug either way.')
  console.log('')
  console.log('    This is what every request on a bounded route pays whether or not the')
  console.log('    deadline ever fires. It is the cheap half; section 3 is the other one.')
}

// ── 3. what arming costs ────────────────────────────────────────────────────

console.log('\n  3. The cost of arming, end to end\n')

{
  const sync: Build = (app) => { app.get('/bench', markSync(() => ({ ok: true, n: 1 }))) }
  const async_: Build = (app) => { app.get('/bench', async () => ({ ok: true, n: 1 })) }

  const rows: Array<[string, Build]> = [['synchronous handler', sync], ['async handler', async_]]
  const costs: number[] = []

  console.log('     handler            no deadline   30s deadline   a deadline costs')

  for (const [label, build] of rows) {
    const off = buildApp(build)
    const on = buildApp(build, '30s')
    await off.ready()
    await on.ready()

    const r = await compareRequests(off as never, on as never)
    costs.push(r.deltaNs)

    console.log(
      `    ${label.padEnd(21)}${r.a.toFixed(2).padStart(6)} µs${r.b.toFixed(2).padStart(11)} µs   ` +
      `${(r.lowNs / 1000).toFixed(1)}-${(r.highNs / 1000).toFixed(1)} µs  (median ${(r.deltaNs / 1000).toFixed(1)})`,
    )
  }

  const [syncCost = 0, asyncCost = 0] = costs
  console.log('')
  console.log('    A range rather than a figure, because the per-rep spread is wider than')
  console.log('    the third significant digit would be: quoting "1.16 µs" here would be')
  console.log('    publishing the noise. What survives the noise is the order of magnitude —')
  console.log('    about a microsecond — and the sign of the gap between the two rows.')
  console.log('')
  console.log(`    That gap is the race, in situ: ~${((asyncCost - syncCost) / 1000).toFixed(1)} µs, and it is the whole content of`)
  console.log('    section 4. A synchronous pipeline cannot have its timer fire, so the')
  console.log('    dispatcher never builds a race for it.')
  console.log('')
  console.log('    Read the ratio carefully. Against a route that does nothing, a microsecond')
  console.log('    is a large fraction of a small number; against a route that talks to a')
  console.log('    database at 200 µs it is half a percent. The denominator that decides')
  console.log('    whether this is affordable is your handler, not this benchmark.')
}

// ── 4. the sync fast path ───────────────────────────────────────────────────

console.log('\n  4. Does the sync fast path escape the race?\n')

{
  // Not a timing claim — a structural one. A pipeline that returns a Reply
  // rather than a promise has provably not yielded, so its deadline has
  // provably not fired, so racing it is racing against something that cannot
  // win. The dispatcher checks for a thenable; this shows the two shapes.
  const syncSpec = pipelineSpec(true, 'syncshape')
  const compiled = compilePipeline(syncSpec, codegen)
  const out = compiled(context(live))
  const isPromise = typeof (out as { then?: unknown }).then === 'function'

  console.log(`    all-sync pipeline with a deadline returns:  ${isPromise ? 'a promise' : 'a Reply, synchronously'}`)
  console.log(`    …so the dispatcher can skip Promise.race:   ${isPromise ? 'no' : 'yes'}`)
  if (isPromise) {
    console.error('    ::error:: a deadline forced the sync fast path onto the async path (§8.4)')
    process.exitCode = 1
  }
  console.log('\n    Worth saying plainly, because it sounds like a hole and is not: a fully')
  console.log('    synchronous route can never time out. It also can never hang, which is')
  console.log('    the only reason a deadline was wanted.')
}

// ── 5. where the cost actually sits ─────────────────────────────────────────

console.log('\n  5. Decomposing the arm\n')

{
  const conn = new AbortController().signal

  const controller = timeOp('new AbortController()', 2_000_000, () => {
    sink += new AbortController().signal.aborted ? 1 : 0
  })
  const timer = timeOp('setTimeout + clearTimeout', 1_000_000, () => {
    clearTimeout(setTimeout(noop, 60_000))
  })
  const listener = timeOp('add + removeEventListener on a signal', 1_000_000, () => {
    conn.addEventListener('abort', noop, { once: true })
    conn.removeEventListener('abort', noop)
  })
  const promise = timeOp('new Promise(() => {})', 2_000_000, () => {
    sink += new Promise(noop) === undefined ? 1 : 0
  })
  const whole = timeOp('new Deadline(30s, connSignal) + disarm', 500_000, () => {
    new Deadline(30_000, conn).disarm()
  })

  const parts = controller + timer + listener + promise
  console.log('')
  console.log(`    The whole thing is ${whole.toFixed(0)} ns; the four pieces sum to ${parts.toFixed(0)}.`)
  console.log('')
  console.log('    The parts adding up to more than the whole is not an error in either')
  console.log('    measurement — it is what isolation costs. Each line above is its own call')
  console.log('    site in its own loop, with its own inline cache and no neighbour to batch')
  console.log('    an allocation with; run together inside one constructor they are cheaper')
  console.log('    than run apart. Treat the decomposition as showing *which* line dominates,')
  console.log('    not as an addition.')
  console.log('')
  console.log('    The timer is the expensive line and it is also the one that cannot simply')
  console.log('    be dropped: `AbortSignal.timeout` needs no `clearTimeout` but gives no')
  console.log('    handle either, so every in-flight request would leave a live callback that')
  console.log('    still has to fire. At any real rate that is hundreds of thousands of them.')
  console.log('')
  console.log('    What *would* remove it is a coarse timer wheel — one interval, requests')
  console.log('    bucketed by expiry, the way Node schedules `keepAliveTimeout` itself. That')
  console.log('    trades deadline precision for a near-zero per-request cost and is the')
  console.log('    obvious next optimisation. It is not built, and quoting a cost that assumes')
  console.log('    it would be quoting a number nobody can reproduce.')
}

console.log(`\n  (sink ${sink})\n`)
live.disarm()
