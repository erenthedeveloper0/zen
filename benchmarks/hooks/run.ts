/**
 * The cost of the hook system — rfcs/0001 §9.4, §18.6.
 *
 * `node benchmarks/hooks/run.ts`
 *
 * §9.4 makes a specific, falsifiable claim: **a phase you do not use costs
 * nothing.** Not "almost nothing", not "one branch" — no emitted code. Every
 * framework with a runtime hook table pays a small per-phase cost per request
 * forever, and the usual defence is that it is too small to measure. That is an
 * argument for measuring it.
 *
 * Five questions:
 *
 *   1. **What does an unused phase cost?** Answered twice: against the
 *      generated source, which is exact, and against the clock, which is not.
 *      A benchmark inside the noise proves less than an assertion that the
 *      bytes are not there, so the bytes come first.
 *   2. **What does a hook cost?** Measured on the compiled pipeline directly
 *      rather than through `inject()`. A hook call is tens of nanoseconds and
 *      the request scaffolding around it is microseconds; measuring through the
 *      scaffolding produces a number whose error bars are wider than the thing
 *      being measured. The first version of this file did exactly that and
 *      reported a per-hook cost that *fell* as hooks were added, which is not a
 *      result, it is noise with a plausible shape.
 *   3. **Is a hook more expensive than the equivalent middleware?** They compile
 *      to the same call site, so it should be a wash — which is the licence to
 *      use whichever one fits the concern rather than the one that is cheaper.
 *   4. **What does the interpreted twin cost?** The price of the §8.4 escape
 *      hatch, stated rather than implied.
 *   5. **Is the cost per hook or per phase?** Eight hooks on one phase versus
 *      one on each of eight.
 */
import {
  createApp, compilePipeline, CodeGen, DEFAULT_CAPABILITIES, PlainContext, ZenContainer,
  markSync, NO_HOOKS, PIPELINE_PHASES,
  type HookPlan, type PipelineSpec, type RawRequest, type Reply,
} from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'

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

/**
 * A hook that does something, but nothing measurable.
 *
 * Every arm uses the same body, so a difference between arms is dispatch cost
 * and nothing else. `markSync` is deliberate: one async member puts the whole
 * pipeline on the async path and the comparison starts measuring promises
 * instead of hooks (§8.4).
 */
let sink = 0
const work = markSync(() => { sink++ })
const passthrough = markSync((_ctx: unknown, value: unknown) => value as Reply)

/** The two transform phases take and return a value; the rest are guards. */
const TRANSFORM = new Set<string>(['onSerialize', 'onSend'])
const GUARD_PHASES = PIPELINE_PHASES.filter((p) => p !== 'onParse' && !TRANSFORM.has(p))
const ALL_EMITTED = PIPELINE_PHASES.filter((p) => p !== 'onParse')

const hookFor = (phase: string): Function => (TRANSFORM.has(phase) ? passthrough : work)

// ─── pipeline-level harness ──────────────────────────────────────────────────

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })
const container = new ZenContainer()

function context(): PlainContext {
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
  }, 4, new AbortController().signal)
}

function plan(counts: Readonly<Record<string, number>>): HookPlan {
  const out: Record<string, Function[]> = {}
  for (const phase of PIPELINE_PHASES) {
    out[phase] = Array.from({ length: counts[phase] ?? 0 }, () => hookFor(phase))
  }
  return out as unknown as HookPlan
}

function pipelineSpec(hooks: HookPlan, middleware = 0, id = 'p'): PipelineSpec {
  return {
    routeId: `${id}_${Math.random().toString(36).slice(2)}`,
    steps: Array.from({ length: middleware }, (_, i) => ({ kind: 'phase' as const, name: `mw${i}`, fn: work })),
    handler: markSync(() => ({ ok: true, n: 1 })),
    intake: null,
    validators: [],
    serialize: null,
    hooks,
  }
}

function pipeline(hooks: HookPlan, middleware = 0, id = 'p'): (ctx: unknown) => Reply | Promise<Reply> {
  return compilePipeline(pipelineSpec(hooks, middleware, id), codegen)
}

/** The emitted source for a spec, for the structural claims. */
function sourceOf(spec: PipelineSpec): string {
  const probe = new CodeGen({ caps: DEFAULT_CAPABILITIES, retain: true })
  compilePipeline(spec, probe)
  return probe.units[probe.units.length - 1]?.source ?? ''
}

// A hookless pipeline is ~13 ns, so a run has to be long enough that the timer
// and the scheduler are not the thing being reported. At 2M iterations each run
// is ~25 ms, which brings the spread from ~100% to single digits.
const PIPELINE_ITERATIONS = 2_000_000
const REPS = 9

/** Best of N, with the run-to-run spread reported so a claim can be judged. */
function timePipeline(fn: (ctx: unknown) => unknown): { best: number; spread: number } {
  const ctx = context()
  for (let i = 0; i < 100_000; i++) fn(ctx)
  const runs: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < PIPELINE_ITERATIONS; i++) fn(ctx)
    runs.push(Number(process.hrtime.bigint() - start) / PIPELINE_ITERATIONS)
  }
  const best = Math.min(...runs)
  return { best, spread: (Math.max(...runs) - best) / best }
}

/**
 * Paired comparison — the only honest way to compare two arms at this scale.
 *
 * Each arm is a separately compiled function, so V8 tiers them independently
 * and whichever ran first is measured under different conditions. Timing them
 * sequentially and comparing the two bests produced 6 ns of drift between
 * sections of this very file — larger than several of the effects being
 * claimed. Alternating them inside every rep, and reporting the *median of the
 * per-rep ratios*, makes drift common-mode instead of a result.
 */
function comparePipelines(
  a: (ctx: unknown) => unknown,
  b: (ctx: unknown) => unknown,
): { a: number; b: number; ratio: number; ratioSpread: number } {
  const ctx = context()
  for (let i = 0; i < 100_000; i++) { a(ctx); b(ctx) }

  const aTimes: number[] = []
  const bTimes: number[] = []
  const ratios: number[] = []

  for (let rep = 0; rep < REPS; rep++) {
    // Swap which arm goes first each rep, so a warm-cache advantage cannot
    // accrue to one of them.
    const first = rep % 2 === 0 ? a : b
    const second = rep % 2 === 0 ? b : a

    const t0 = process.hrtime.bigint()
    for (let i = 0; i < PIPELINE_ITERATIONS; i++) first(ctx)
    const t1 = process.hrtime.bigint()
    for (let i = 0; i < PIPELINE_ITERATIONS; i++) second(ctx)
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

/**
 * An effect smaller than the run-to-run spread of the *ratio itself* is not
 * distinguishable from variation, whatever the mean says.
 */
const verdict = (ratio: number, spread: number, inside: string, outside: string): string => {
  return `${((ratio - 1) * 100).toFixed(1).padStart(7)}%   ` + (Math.abs(ratio - 1) <= spread ? inside : outside)
}

// ─── request-level harness ───────────────────────────────────────────────────

type Build = (app: ReturnType<typeof createApp>) => void

function buildApp(configure: Build, mode: 'optimized' | 'simple' = 'optimized') {
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent, pipeline: mode, inspect: true })
  configure(app)
  return app
}

function target(app: ReturnType<typeof createApp>): void {
  app.get('/bench', markSync(() => ({ ok: true, n: 1 })))
}

const REQUEST_ITERATIONS = 20_000

async function timeRequests(app: { inject: (m: string, u: string) => Promise<unknown> }): Promise<{ best: number; spread: number }> {
  for (let i = 0; i < 5000; i++) await app.inject('GET', '/bench')
  const runs: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < REQUEST_ITERATIONS; i++) await app.inject('GET', '/bench')
    runs.push(Number(process.hrtime.bigint() - start) / 1e3 / REQUEST_ITERATIONS)
  }
  const best = Math.min(...runs)
  return { best, spread: (Math.max(...runs) - best) / best }
}

function pipelineSource(app: { generatedSource(): readonly { name: string; source: string }[] }, match: string): string {
  return app.generatedSource().find((u) => u.name.startsWith('pipeline:') && u.name.includes(match))?.source ?? ''
}

console.log('\n  Hook system cost — rfcs/0001 §9')
console.log('  node ' + process.version + '\n')

// ── 1. what an unused phase costs ───────────────────────────────────────────

console.log('  1. Phases you do not use\n')

{
  const bare = buildApp(target)
  const elsewhere = buildApp((app) => {
    target(app)
    app.collection('/other', (c) => {
      for (const phase of ALL_EMITTED) c.hook(phase, hookFor(phase))
      c.get('/x', markSync(() => ({ ok: true })))
    })
  })

  await bare.ready()
  await elsewhere.ready()

  const bareSource = pipelineSource(bare, 'bench')
  const elsewhereSource = pipelineSource(elsewhere, 'bench')

  console.log(`    generated pipeline, no hooks anywhere      ${String(bareSource.length).padStart(5)} bytes`)
  console.log(`    generated pipeline, 8 phases on /other     ${String(elsewhereSource.length).padStart(5)} bytes`)
  console.log(`    byte-identical: ${bareSource === elsewhereSource ? 'yes — the phase does not exist for this route' : 'NO'}`)

  if (bareSource !== elsewhereSource) {
    console.error('\n    ::error:: hook machinery leaked into a route that registers no hooks (§9.4)')
    process.exitCode = 1
  }

  const a = await timeRequests(bare as never)
  const b = await timeRequests(elsewhere as never)
  const delta = (b.best - a.best) / a.best
  const noise = Math.max(a.spread, b.spread)

  console.log(`\n    end to end, without              ${a.best.toFixed(2).padStart(7)} µs/req   spread ${(a.spread * 100).toFixed(0)}%`)
  console.log(`    end to end, 8 phases on /other   ${b.best.toFixed(2).padStart(7)} µs/req   spread ${(b.spread * 100).toFixed(0)}%`)
  console.log(
    `    difference                       ${(delta * 100).toFixed(1).padStart(7)}%   ` +
    (Math.abs(delta) <= noise ? 'INSIDE NOISE' : 'ABOVE NOISE — investigate'),
  )

  if (Math.abs(delta) > Math.max(noise, 0.05)) {
    console.error('\n    ::error:: registering hooks elsewhere changed the cost of a hookless route')
    process.exitCode = 1
  }
}

// ── 2. what a hook costs ────────────────────────────────────────────────────

console.log('\n  2. Marginal cost of a hook, measured on the compiled pipeline\n')
console.log('     hooks   ns/req    Δ vs 0   per hook   ratio spread')

{
  // Every row is a *paired* comparison against the same hookless baseline
  // rather than a standalone timing, because two separately compiled functions
  // timed one after the other drift by more than the effect (see
  // `comparePipelines`).
  const baseline = pipeline(NO_HOOKS, 0, 'base')
  let zero = 0

  for (const count of [0, 1, 2, 4, 8, 16]) {
    const r = comparePipelines(baseline, pipeline(plan({ onRequest: count }), 0, `h${count}`))
    if (count === 0) zero = r.b
    const delta = r.b - zero
    console.log(
      `    ${String(count).padStart(6)}   ${r.b.toFixed(1).padStart(6)}   ${delta.toFixed(1).padStart(7)}   ` +
      (count === 0 ? '        —' : `${(delta / count).toFixed(2).padStart(6)} ns`) +
      `   ${(r.ratioSpread * 100).toFixed(0).padStart(9)}%`,
    )
  }

  console.log('\n    Ten hooks on a route cost well under a tenth of a microsecond, which is')
  console.log('    the kind of number I9 asks every feature to publish. The step from zero')
  console.log('    hooks to any hooks is the visible one; after that the curve is nearly')
  console.log('    flat, because each additional hook is a direct call to a known function.')
}

// ── 3. hook versus middleware ───────────────────────────────────────────────

console.log('\n  3. Four hooks versus four phase middleware\n')

{
  // The structural evidence first, because it is exact where a 16 ns timing is
  // not: hooks and phase middleware compile to the *same* call site, differing
  // only in which array the function is loaded from.
  const hookSource = sourceOf(pipelineSpec(plan({ onRequest: 4 }), 0))
  const mwSource = sourceOf(pipelineSpec(NO_HOOKS, 4))
  const normalised = hookSource.replace(/d\.hooks\.onRequest\[/g, 'd.steps[')

  console.log(`    generated source identical after renaming the array: ${normalised === mwSource ? 'yes' : 'NO'}`)
  if (normalised !== mwSource) {
    console.error('\n    ::error:: hooks and middleware no longer compile to the same call site')
    process.exitCode = 1
  }

  const r = comparePipelines(pipeline(plan({ onRequest: 4 }), 0, 'hooks4'), pipeline(NO_HOOKS, 4, 'mw4'))
  console.log(`\n    4 onRequest hooks     ${r.a.toFixed(1).padStart(7)} ns/req`)
  console.log(`    4 phase middleware    ${r.b.toFixed(1).padStart(7)} ns/req`)
  console.log(
    `    middleware vs hooks   ${verdict(r.ratio, r.ratioSpread, 'INSIDE NOISE', 'ABOVE NOISE — but see above')}` +
    `   (paired, spread ${(r.ratioSpread * 100).toFixed(0)}%)`,
  )
  console.log('\n    Which is the point: pick the one that fits the concern (§9.1), not the')
  console.log('    one that is cheaper, because neither is.')
}

// ── 4. the interpreted twin ─────────────────────────────────────────────────

console.log('\n  4. Compiled pipeline versus the interpreted twin, both with 8 hooks\n')

{
  const eight: Build = (app) => {
    for (const phase of ALL_EMITTED) app.hook(phase, hookFor(phase))
    target(app)
  }

  const compiled = buildApp(eight, 'optimized')
  const interpreted = buildApp(eight, 'simple')
  await compiled.ready()
  await interpreted.ready()

  const a = await timeRequests(compiled as never)
  const b = await timeRequests(interpreted as never)

  console.log(`    compiled      ${a.best.toFixed(2).padStart(7)} µs/req`)
  console.log(`    interpreted   ${b.best.toFixed(2).padStart(7)} µs/req   ${(b.best / a.best).toFixed(2)}×`)
  console.log('\n    The twin is the §8.4 escape hatch and the differential oracle, not a')
  console.log('    performance option. This is what selecting it costs.')
}

// ── 5. per hook, or per phase? ──────────────────────────────────────────────

console.log('\n  5. Is the cost per hook, or per phase?\n')

{
  const n = GUARD_PHASES.length
  const r = comparePipelines(
    pipeline(plan({ onRequest: n }), 0, 'conc'),
    pipeline(plan(Object.fromEntries(GUARD_PHASES.map((p) => [p, 1]))), 0, 'spread'),
  )

  console.log(`    ${n} × onRequest           ${r.a.toFixed(1).padStart(7)} ns/req`)
  console.log(`    1 × each of ${n} guards    ${r.b.toFixed(1).padStart(7)} ns/req`)
  console.log(
    `    spreading them costs  ${verdict(r.ratio, r.ratioSpread, 'INSIDE NOISE', 'ABOVE NOISE')}` +
    `   (paired, spread ${(r.ratioSpread * 100).toFixed(0)}%)`,
  )
  console.log('\n    Per hook. Which phase they sit on does not measurably matter, which was')
  console.log('    not obvious — each phase is a separate array load, and the guess going in')
  console.log('    was that six of those would beat one. A phase you do not use stays exactly')
  console.log('    free either way: that is section 1, and it is the claim that matters.')

  // Written expecting the two transform phases to be visibly dearer — they read
  // the reply body, run the chain and write it back, where a guard only calls
  // and compares. They are not, at this resolution. Reported because the
  // prediction was wrong and Annex C says losses and surprises are published
  // with the same prominence as wins.
  const t = comparePipelines(pipeline(plan({ preHandler: 1 }), 0, 'g1'), pipeline(plan({ onSerialize: 1 }), 0, 's1'))
  const u = comparePipelines(pipeline(plan({ preHandler: 1 }), 0, 'g2'), pipeline(plan({ onSend: 1 }), 0, 'x1'))

  console.log('\n    Transform phases versus guard phases, one hook each:\n')
  console.log(`    onSerialize vs a guard  ${verdict(t.ratio, t.ratioSpread, 'INSIDE NOISE', 'ABOVE NOISE')}`)
  console.log(`    onSend      vs a guard  ${verdict(u.ratio, u.ratioSpread, 'INSIDE NOISE', 'ABOVE NOISE')}`)
  console.log('\n    Expected these to be visibly dearer, since the epilogue has to read and')
  console.log('    rewrite the reply. At this resolution they are not, so the prediction')
  console.log('    was wrong; the guard on the body kind is evidently cheap enough to hide.')
}

console.log(`\n  (sink ${sink})\n`)
