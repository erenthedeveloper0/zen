/**
 * The cost of the first-party middleware pack — rfcs/0001 §32.3, §18.6.
 *
 * `node benchmarks/middleware/run.ts`
 *
 * Every other benchmark in this directory answers "what does a feature you do
 * not use cost?" and gates on the answer being *no emitted bytes*. This one has
 * to answer a harder question, because a middleware you registered is a
 * middleware you asked to run on every request. The claim is not that it is
 * free; it is that the number is small, stated, and paid for something.
 *
 * Six sections:
 *
 *   1. **An app that does not register the pack.** The familiar gate: the
 *      generated pipeline must be byte-identical to one compiled in a process
 *      that never imported it.
 *   2. **What each plugin costs**, measured per request through `inject()` in
 *      *paired* comparisons, because two arms timed one after the other drift
 *      by more than several of the effects here.
 *   3. **What `Vary: Origin` before the early return costs**, on its own,
 *      because that is a correctness decision with a price and §32.2 says the
 *      price is published rather than asserted to be small.
 *   4. **What answering a preflight costs against not answering one.** The
 *      surprise is the direction: answering is several times *cheaper*, because
 *      the alternative is a 404 and a 404 is an `Error` with a stack. 4b takes
 *      that apart, because it is a finding about the framework that a preflight
 *      is merely the first request to make matter.
 *   5. **The rate limiter's store**, at the scale it exists to survive: a
 *      million hits across a hundred thousand attacker-chosen keys, and what
 *      the process is still holding afterwards.
 *   6. **The security gate.** A disallowed origin is never reflected, under
 *      every shape of allowlist. It lives in a benchmark for the same reason
 *      §11.4's does: it is the property a later optimisation is most tempted to
 *      trade away, and a fast CORS that reflects is not a fast CORS.
 */
import { createApp, NotFound, withoutStack, type Logger } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { cors, rateLimit, requestId, securityHeaders, MemoryStore } from '@erenthedeveloper0/zen-middleware'

const pathParser = {
  parse: (path: string) => {
    const parsed = parsePath(path)
    return { path: parsed.path, segments: parsed.segments }
  },
}

const silent: Logger = (() => {
  const noop = () => {}
  const logger = { level: 'fatal' as const, child: () => logger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
  return logger
})()

const ORIGIN = 'https://app.example.com'

type App = ReturnType<typeof createApp>
type Build = (app: App) => void

function build(configure: Build = () => {}): App {
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent, inspect: true })
  configure(app)
  app.get('/things', () => ({ ok: true, n: 1 }))
  app.post('/things', () => ({ created: true }))
  return app
}

const REPS = 9
const ITERATIONS = 20_000

interface Timing { best: number; spread: number }

type Injectable = { inject: (m: string, u: string, i?: { headers?: Record<string, string> }) => Promise<unknown> }
type Call = () => Promise<unknown>

/** Synchronous best-of-N, for the parts of a request that are not a request. */
function timeSync(fn: () => unknown): number {
  for (let i = 0; i < 20_000; i++) fn()
  let best = Infinity
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < 50_000; i++) fn()
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e3 / 50_000)
  }
  return best
}

async function time(call: Call): Promise<Timing> {
  for (let i = 0; i < 5_000; i++) await call()
  const runs: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < ITERATIONS; i++) await call()
    runs.push(Number(process.hrtime.bigint() - start) / 1e3 / ITERATIONS)
  }
  const best = Math.min(...runs)
  return { best, spread: (Math.max(...runs) - best) / best }
}

/**
 * Paired comparison — the only honest way to compare two arms at this scale.
 *
 * Each app compiles its own pipeline, so V8 tiers them independently and
 * whichever ran first is measured under different conditions. `benchmarks/hooks`
 * found 6 ns of drift *between sections of one file* that way — larger than
 * several of the effects claimed here. Alternating the arms inside every rep and
 * reporting the median of the per-rep differences makes drift common-mode.
 */
async function compare(a: Call, b: Call): Promise<{ a: number; b: number; delta: number; noise: number }> {
  for (let i = 0; i < 5_000; i++) { await a(); await b() }

  const aTimes: number[] = []
  const bTimes: number[] = []
  const deltas: number[] = []

  for (let rep = 0; rep < REPS; rep++) {
    const first = rep % 2 === 0 ? a : b
    const second = rep % 2 === 0 ? b : a

    const t0 = process.hrtime.bigint()
    for (let i = 0; i < ITERATIONS; i++) await first()
    const t1 = process.hrtime.bigint()
    for (let i = 0; i < ITERATIONS; i++) await second()
    const t2 = process.hrtime.bigint()

    const firstUs = Number(t1 - t0) / 1e3 / ITERATIONS
    const secondUs = Number(t2 - t1) / 1e3 / ITERATIONS
    const aUs = rep % 2 === 0 ? firstUs : secondUs
    const bUs = rep % 2 === 0 ? secondUs : firstUs

    aTimes.push(aUs)
    bTimes.push(bUs)
    deltas.push(bUs - aUs)
  }

  const sorted = [...deltas].sort((x, y) => x - y)
  return {
    a: Math.min(...aTimes),
    b: Math.min(...bTimes),
    delta: sorted[Math.floor(sorted.length / 2)] as number,
    noise: ((sorted[sorted.length - 1] as number) - (sorted[0] as number)) / 2,
  }
}

const verdict = (delta: number, noise: number): string =>
  Math.abs(delta) <= noise ? 'INSIDE NOISE' : ''

function pipelineSource(app: App): string {
  return (app as unknown as { generatedSource(): readonly { name: string; source: string }[] })
    .generatedSource()
    .find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
}

const plain = (app: Injectable): Call => () => app.inject('GET', '/things')
const crossOrigin = (app: Injectable): Call => () => app.inject('GET', '/things', { headers: { origin: ORIGIN } })

console.log('\n  First-party middleware pack — rfcs/0001 §32')
console.log('  node ' + process.version + '\n')

// ── 1. an app that does not register it ─────────────────────────────────────

console.log('  1. An app that does not register the pack\n')

{
  const bare = build()
  await bare.ready()

  // Instantiated but never registered: the import, the factory call, the
  // compiled origin matcher — all of it exists in this process.
  void cors({ origin: [ORIGIN] })
  void rateLimit({ limit: 100 })
  void securityHeaders()
  void requestId()

  const alongside = build()
  await alongside.ready()

  const bareSource = pipelineSource(bare)
  const alongsideSource = pipelineSource(alongside)

  console.log(`    pipeline, pack never imported      ${String(bareSource.length).padStart(5)} bytes`)
  console.log(`    pipeline, pack imported, unused    ${String(alongsideSource.length).padStart(5)} bytes`)
  console.log(`    byte-identical: ${bareSource === alongsideSource ? 'yes' : 'NO'}`)

  if (bareSource !== alongsideSource || bareSource.length === 0) {
    console.error('\n    ::error:: importing the middleware pack changed a route that does not use it (§9.4)')
    process.exitCode = 1
  }

  const packed = build((app) => {
    app.use(securityHeaders())
    app.use(cors({ origin: [ORIGIN] }))
    app.use(requestId())
    app.use(rateLimit({ limit: 1_000_000_000, window: '1h' }))
  })
  await packed.ready()
  console.log(`    pipeline, pack registered          ${String(pipelineSource(packed).length).padStart(5)} bytes  (+4 call sites)`)
}

// ── 2. what each plugin costs ───────────────────────────────────────────────

console.log('\n  2. Marginal cost per request, paired against the same bare app\n')
console.log('     plugin                    µs/req      Δ         noise')

{
  const bare = build()
  await bare.ready()

  const arms: Array<[string, App, Call]> = []
  const add = async (name: string, configure: Build, call: (a: Injectable) => Call) => {
    const app = build(configure)
    await app.ready()
    arms.push([name, app, call(app as unknown as Injectable)])
  }

  await add('requestId()', (a) => a.use(requestId()), plain)
  await add('securityHeaders()', (a) => a.use(securityHeaders()), plain)
  await add('cors(), no Origin header', (a) => a.use(cors({ origin: [ORIGIN] })), plain)
  await add('cors(), cross-origin GET', (a) => a.use(cors({ origin: [ORIGIN] })), crossOrigin)
  await add('rateLimit()', (a) => a.use(rateLimit({ limit: 1_000_000_000, window: '1h' })), plain)
  await add('all four', (a) => {
    a.use(securityHeaders()); a.use(cors({ origin: [ORIGIN] })); a.use(requestId())
    a.use(rateLimit({ limit: 1_000_000_000, window: '1h' }))
  }, crossOrigin)

  const baseline = plain(bare as unknown as Injectable)
  for (const [name, , call] of arms) {
    const r = await compare(baseline, call)
    const delta = `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)} µs`
    console.log(
      `    ${name.padEnd(26)}${r.b.toFixed(2).padStart(6)}   ${delta.padStart(8)}   ` +
      `± ${r.noise.toFixed(2)}   ${verdict(r.delta, r.noise)}`,
    )
  }

  console.log('\n    Each of these is one hook — the same call site a phase middleware')
  console.log('    compiles to (§9.4) — plus what the hook body does. The whole pack on a')
  console.log('    cross-origin request is the row that matters, because it is the one a')
  console.log('    browser-facing service actually runs.')
}

// ── 3. the price of Vary before the early return ────────────────────────────

console.log('\n  3. `Vary: Origin` staged before the early return (§32.2)\n')

{
  // The tempting shape is to bail when there is no `Origin` and vary only when
  // there is. It is wrong for caching: the origin-less response has no
  // `Access-Control-Allow-Origin`, so a shared cache holding it without `Vary`
  // replays it to a browser request that needed the header. This measures what
  // correctness costs on the request that does not need it.
  const varying = build((a) => a.use(cors({ origin: [ORIGIN] })))
  const notVarying = build((a) => a.use(cors({ origin: '*' })))
  await varying.ready()
  await notVarying.ready()

  const r = await compare(
    plain(notVarying as unknown as Injectable),
    plain(varying as unknown as Injectable),
  )
  console.log(`    origin: '*'  (no Vary, no push)   ${r.a.toFixed(2).padStart(6)} µs/req`)
  console.log(`    an allowlist (one array push)     ${r.b.toFixed(2).padStart(6)} µs/req`)
  console.log(`    difference                        ${((r.delta >= 0 ? '+' : '') + r.delta.toFixed(2)).padStart(6)} µs   ± ${r.noise.toFixed(2)}   ${verdict(r.delta, r.noise)}`)
  console.log('\n    Published rather than asserted to be small, because it is the one place')
  console.log('    in this pack where a request that gains nothing pays something.')
}

// ── 4. what answering a preflight costs, against not answering it ──────────

console.log('\n  4. Answering a preflight is cheaper than not answering one\n')

{
  const answered = build((a) => {
    a.use(securityHeaders())
    a.use(cors({ origin: [ORIGIN] }))
  })
  // The same app without the plugin: the preflight matches no route, so it
  // becomes a 404 — which is exactly what a browser-facing service without
  // first-party CORS does today.
  const unanswered = build((a) => a.use(securityHeaders()))
  await answered.ready()
  await unanswered.ready()

  const withCors = answered as unknown as Injectable
  const without = unanswered as unknown as Injectable
  const PRE = { headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } }

  const hit = await time(() => withCors.inject('OPTIONS', '/things', PRE))
  const miss = await time(() => withCors.inject('OPTIONS', '/no/such/path', PRE))
  const dropped = await time(() => without.inject('OPTIONS', '/things', PRE))
  const actual = await time(() => withCors.inject('GET', '/things', { headers: { origin: ORIGIN } }))

  console.log(`    the actual cross-origin GET               ${actual.best.toFixed(2).padStart(6)} µs/req   spread ${(actual.spread * 100).toFixed(0)}%`)
  console.log(`    preflight, answered, path exists          ${hit.best.toFixed(2).padStart(6)} µs/req   spread ${(hit.spread * 100).toFixed(0)}%`)
  console.log(`    preflight, answered, path does not exist  ${miss.best.toFixed(2).padStart(6)} µs/req   spread ${(miss.spread * 100).toFixed(0)}%`)
  console.log(`    preflight, no cors plugin → 404           ${dropped.best.toFixed(2).padStart(6)} µs/req   spread ${(dropped.spread * 100).toFixed(0)}%`)
  console.log(`\n    answering it is ${(dropped.best / hit.best).toFixed(1)}× cheaper than the 404 it would otherwise be`)

  console.log('\n    The third row is the one no `.use()`-registered CORS middleware can')
  console.log('    produce at all: with no OPTIONS route there is no pipeline, so the')
  console.log('    middleware never runs and the browser reports the failure on the')
  console.log('    request that follows, in a file that is correct.')
  console.log('\n    The fourth row was a finding about the framework rather than about this')
  console.log('    pack — it measured 6.2× the third when this section was written — and')
  console.log('    it is measured below because a preflight is the request that made it')
  console.log('    matter.')
}

// ── 4b. the unmatched path, which is where a preflight would otherwise land ──

console.log('\n  4b. What an unmatched request costs, and why (§4.2, §12.2)\n')

{
  const app = build()
  await app.ready()
  const injectable = app as unknown as Injectable

  const matched = await time(() => injectable.inject('GET', '/things'))
  const unmatched = await time(() => injectable.inject('GET', '/no/such/path'))

  // Where the cost went. A 404 used to cost ~10× a served request, and almost
  // none of it was routing: it was one `NotFound` and its stack — captured
  // twice, once by `Error` and again by `captureStackTrace`. The dispatcher now
  // builds routine refusals with `withoutStack` (§28.8), and `ZenError`
  // captures once; `benchmarks/refusals` gates both.
  const asApplication = timeSync(() => new NotFound('No route matches GET /no/such/path'))
  const asDispatcher = timeSync(() => withoutStack(() => new NotFound('No route matches GET /no/such/path')))

  console.log(`    a matched GET                       ${matched.best.toFixed(2).padStart(6)} µs/req`)
  console.log(`    an unmatched GET (404)              ${unmatched.best.toFixed(2).padStart(6)} µs/req   ${(unmatched.best / matched.best).toFixed(1)}× the matched one`)
  console.log(`\n    new NotFound(…), as a handler throws it   ${asApplication.toFixed(2).padStart(6)} µs   (keeps its stack)`)
  console.log(`    the same, as the dispatcher builds it    ${asDispatcher.toFixed(2).padStart(6)} µs   (no stack to capture)`)

  console.log('\n    A 404 used to cost roughly ten times a served request, and almost none')
  console.log('    of that was routing — it was one `Error` object and its stack: a free')
  console.log('    amplification factor for the cheapest hostile traffic there is, and the')
  console.log('    traffic §9.2 made the rate limiter able to see. The stack of a 404 the')
  console.log('    dispatcher answers only ever shows the dispatcher, so it is no longer')
  console.log('    captured (§28.8). A 404 a handler throws still keeps its stack.')
}

// ── 5. the store, at the scale it exists to survive ─────────────────────────

console.log('\n  5. The counter store under a key-space attack (§3.5)\n')

{
  const windowMs = 60_000
  const store = new MemoryStore({ windowMs })
  const KEYS = 100_000
  const HITS = 1_000_000

  const start = process.hrtime.bigint()
  for (let i = 0; i < HITS; i++) store.hit(`k${i % KEYS}`, 1_000_000)
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6

  console.log(`    ${HITS.toLocaleString()} hits over ${KEYS.toLocaleString()} distinct keys   ${elapsed.toFixed(0)} ms   ${(elapsed * 1e6 / HITS).toFixed(0)} ns/hit`)
  console.log(`    keys retained inside the window            ${(store.size ?? 0).toLocaleString()}`)

  // The property the design exists for: crossing a window frees the generation
  // in one assignment, with no scan and no pause.
  const evictStart = process.hrtime.bigint()
  store.hit('anyone', 1_000_000 + windowMs)
  const evictUs = Number(process.hrtime.bigint() - evictStart) / 1e3

  console.log(`    keys retained after the window rolled      ${(store.size ?? 0).toLocaleString()}`)
  console.log(`    cost of releasing ${KEYS.toLocaleString()} keys              ${evictUs.toFixed(1)} µs`)

  if ((store.size ?? 0) > 1) {
    console.error('\n    ::error:: the store retained keys from a window that has ended (§3.5)')
    process.exitCode = 1
  }
  // A sweep over 100k keys is milliseconds and happens under the load that
  // created them. A dropped reference must stay in the microseconds.
  if (evictUs > 1_000) {
    console.error(`\n    ::error:: releasing a generation took ${evictUs.toFixed(0)}µs — that is a sweep, not a dropped reference`)
    process.exitCode = 1
  }
}

// ── 6. the security gate ────────────────────────────────────────────────────

console.log('\n  6. A disallowed origin is never reflected — gate\n')

{
  const shapes: Array<[string, Parameters<typeof cors>[0]]> = [
    ['one origin', { origin: ORIGIN }],
    ['a list', { origin: [ORIGIN, 'https://admin.example.com'] }],
    ['a long list', { origin: Array.from({ length: 64 }, (_, i) => `https://t${i}.example.com`) }],
    ['a regex', { origin: /^https:\/\/[a-z0-9-]+\.example\.com$/ }],
    ['a predicate', { origin: (o: string) => o === ORIGIN }],
    ['with credentials', { origin: [ORIGIN], credentials: true }],
  ]

  const hostile = [
    'https://evil.example',
    'https://app.example.com.evil.example',
    'https://app.example.com:8443',
    'http://app.example.com',
    'https://app.example.com/',
    'null',
    '',
    'https://APP.EXAMPLE.COM',
  ]

  let leaks = 0
  for (const [label, options] of shapes) {
    const app = build((a) => a.use(cors(options)))
    await app.ready()
    const injectable = app as unknown as { inject: (m: string, u: string, i?: { headers?: Record<string, string> }) => Promise<{ header(n: string): string | undefined }> }

    let reflected = 0
    for (const origin of hostile) {
      for (const [method, extra] of [['GET', {}], ['OPTIONS', { 'access-control-request-method': 'POST' }]] as const) {
        const res = await injectable.inject(method, '/things', { headers: { origin, ...extra } })
        const allowed = res.header('access-control-allow-origin')
        if (allowed !== undefined && allowed !== '*') {
          reflected++
          console.error(`    ::error:: ${label} reflected ${JSON.stringify(origin)} as ${JSON.stringify(allowed)}`)
        }
      }
    }
    leaks += reflected
    console.log(`    ${label.padEnd(18)} ${hostile.length * 2} hostile origins   ${reflected === 0 ? 'none reflected' : `${reflected} REFLECTED`}`)
  }

  if (leaks > 0) {
    console.error('\n    ::error:: an origin outside the allowlist was reflected (§19.2)')
    process.exitCode = 1
  } else {
    console.log('\n    In a benchmark rather than only in the test suite for the reason §11.4\'s')
    console.log("    gate is: reflecting whatever arrives is the fastest possible CORS, and")
    console.log('    it is the shortcut a later optimisation would reach for first.')
  }
}

console.log()
