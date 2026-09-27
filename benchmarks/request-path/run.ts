/**
 * What the pre-release audit's fixes cost on the request path.
 *
 * `node benchmarks/request-path/run.ts`
 *
 * Five fixes landed on code every request runs through, and a correctness fix
 * that quietly costs every request is a trade nobody agreed to. CONTRIBUTING.md
 * convention 4: *performance claims need numbers, and a structural assertion
 * beats a timing inside the noise.* So the gates come first, and they are about
 * what is — and is not — in the generated source:
 *
 *   1. **Gates — structural.**
 *        - A route with no `around` compiles byte-identically in an app that
 *          has one elsewhere: the `next()` fix cannot leak into routes that do
 *          not wrap.
 *        - An `around` whose downstream is already async gets the plain `next`
 *          closure it always had — the extra promise exists only where the
 *          downstream compiled synchronous, which is the case that was broken.
 *        - `next()` is a Promise on that path, and a sync throw downstream is a
 *          rejection rather than a throw out of `next()`.
 *        - An absolute-form request target reaches the same route, with the
 *          same params and query, as the origin form.
 *        - A request that touches no disposable slot and no scoped service
 *          leaves nothing queued — disposal stays allocation-free for everyone
 *          who does not use it.
 *   2. **`pathnameOf`**, the function every request calls twice: the origin
 *      form before and after the absolute-form fix, paired, and what the
 *      absolute form itself costs.
 *   3. **The `next()` wrapper**: an `around` over a synchronous downstream
 *      against the same `around` over an async one.
 *   4. **Disposal**: a request that sets one disposable slot, and one that
 *      resolves a scoped service with a `dispose`, against one that does
 *      neither.
 */
import {
  createApp, markSync, pathnameOf, slot, token,
  type Logger, type ZenApp,
} from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'

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

const REPS = 9
const ITERATIONS = 20_000

type Call = () => unknown

/** Paired: both arms in every repetition, alternating which goes first. */
async function compare(a: Call, b: Call, iterations = ITERATIONS): Promise<{ a: number; b: number }> {
  for (let i = 0; i < 5_000; i++) { await a(); await b() }
  const aTimes: number[] = []
  const bTimes: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const pair = rep % 2 === 0 ? [a, b] as const : [b, a] as const
    const times: number[] = []
    for (const arm of pair) {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) await arm()
      times.push(((performance.now() - start) * 1000) / iterations)
    }
    const [first, second] = times as [number, number]
    aTimes.push(rep % 2 === 0 ? first : second)
    bTimes.push(rep % 2 === 0 ? second : first)
  }
  return { a: median(aTimes), b: median(bTimes) }
}

/** Paired and synchronous, in nanoseconds — for functions far below a microsecond. */
function compareSync(a: () => unknown, b: () => unknown, iterations = 1_000_000): { a: number; b: number } {
  let sink = 0
  for (let i = 0; i < 100_000; i++) { if (a() !== undefined) sink++; if (b() !== undefined) sink++ }
  const aTimes: number[] = []
  const bTimes: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const pair = rep % 2 === 0 ? [a, b] as const : [b, a] as const
    const times: number[] = []
    for (const arm of pair) {
      const start = performance.now()
      for (let i = 0; i < iterations; i++) if (arm() !== undefined) sink++
      times.push(((performance.now() - start) * 1e6) / iterations)
    }
    const [first, second] = times as [number, number]
    aTimes.push(rep % 2 === 0 ? first : second)
    bTimes.push(rep % 2 === 0 ? second : first)
  }
  if (sink === -1) console.log(sink)
  return { a: median(aTimes), b: median(bTimes) }
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/** The difference between two paired medians, and whether it is inside their spread. */
function verdict(a: number, b: number, unit: string, noise: number): string {
  const delta = b - a
  const sign = delta >= 0 ? '+' : '−'
  return `${sign}${Math.abs(delta).toFixed(unit === 'ns' ? 1 : 2)} ${unit}${Math.abs(delta) <= noise ? '   inside noise' : ''}`
}

let failures = 0
const fail = (message: string): void => {
  failures++
  console.log(`     ✖ ${message}`)
}
const pass = (message: string): void => {
  console.log(`     ✔ ${message}`)
}

const makeApp = (): ZenApp => createApp({ router: new ZenRouter(), pathParser, logger: silent }) as unknown as ZenApp

const source = (app: ZenApp, name: string): string => {
  const unit = app.generatedSource().find((u) => u.name === name)
  if (unit === undefined) throw new Error(`no generated unit named ${name}`)
  return unit.source
}

console.log('\n  The request path after the pre-release fixes\n')

// ── 1. gates ────────────────────────────────────────────────────────────────
{
  console.log('  1. What the fixes emit, and where  (gates)\n')

  // A route that does not wrap is untouched by the `next()` fix.
  const without = makeApp()
  without.get('/plain', markSync(() => 'plain'))
  await without.ready()
  const withAround = makeApp()
  withAround.collection('/wrapped', (c) => {
    c.around(async (_ctx, next) => next())
    c.get('/x', markSync(() => 'x'))
  })
  withAround.get('/plain', markSync(() => 'plain'))
  await withAround.ready()
  if (source(without, 'pipeline:GET_/plain') === source(withAround, 'pipeline:GET_/plain')) {
    pass('a route without around is byte-identical beside one with it')
  } else {
    fail('a route without around changed because another route wraps')
  }

  // The wrapper exists only where the downstream compiled synchronous.
  const shapes = makeApp()
  shapes.around(async (_ctx, next) => next())
  shapes.get('/sync', markSync(() => 'sync'))
  shapes.get('/async', async () => 'async')
  await shapes.ready()
  const syncSource = source(shapes, 'pipeline:GET_/sync')
  const asyncSource = source(shapes, 'pipeline:GET_/async')
  if (/async function \(\) \{ return seg\d+\(ctx\) \}/.test(syncSource)) {
    pass('a synchronous downstream is reached through an async next()')
  } else {
    fail('a synchronous downstream is still reached through a plain next() — next() can return a bare Reply')
  }
  if (/[^c] function \(\) \{ return seg\d+\(ctx\) \}/.test(asyncSource) && !/async function \(\)/.test(asyncSource)) {
    pass('an async downstream keeps the plain next() — no extra promise where none was needed')
  } else {
    fail('an async downstream gained a wrapper it does not need')
  }

  // Behaviour on the path that was broken.
  const behaviour = makeApp()
  let kind = ''
  behaviour.around((ctx, next) => {
    const pending = next()
    kind = typeof (pending as { then?: unknown }).then
    return pending.then((reply) => reply)
  })
  behaviour.get('/sync', markSync(() => 'ok'))
  behaviour.get('/throws', markSync(() => { throw new Error('downstream') }))
  const ok = await behaviour.inject('GET', '/sync')
  const thrown = await behaviour.inject('GET', '/throws')
  if (ok.status === 200 && kind === 'function' && thrown.status === 500) {
    pass('next() is a Promise, and a synchronous throw arrives as a rejection')
  } else {
    fail(`next() on a synchronous downstream: status ${ok.status}, then is ${kind}, throw → ${thrown.status}`)
  }

  // The absolute form is the origin form, as far as routing is concerned.
  const targets = makeApp()
  targets.get('/orders/:id<int>', (ctx) => ({ id: ctx.params.id, q: (ctx.query as { q?: string }).q ?? null }))
  const origin = (await targets.inject('GET', '/orders/7?q=x')).text()
  const absolute = (await targets.inject('GET', 'http://api.example.com/orders/7?q=x')).text()
  if (origin === absolute && origin === '{"id":7,"q":"x"}') {
    pass('an absolute-form target reaches the same route, params and query')
  } else {
    fail(`absolute form answered ${absolute}, origin form ${origin}`)
  }

  // Disposal costs nothing for a request that has nothing to dispose.
  const quiet = makeApp()
  let queued: unknown = 'unobserved'
  quiet.hook('onResponse', (ctx) => { queued = (ctx as unknown as { $disposers: unknown }).$disposers })
  quiet.get('/', () => 'nothing to release')
  await quiet.inject('GET', '/')
  if (queued === null) pass('a request with nothing to release queues nothing')
  else fail('a request with nothing to release allocated a disposal list')

  // …and something acquired after the request settled is released on arrival.
  const late = createApp({ router: new ZenRouter(), pathParser, logger: silent, timeout: '10ms' }) as unknown as ZenApp
  const released: string[] = []
  const Late = slot<string>('bench.request-path.late', { dispose: (value) => { released.push(value) } })
  late.get('/', async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    ctx.set(Late, 'acquired after the deadline answered')
    return 'too late'
  })
  const answered = await late.inject('GET', '/')
  await new Promise((resolve) => setTimeout(resolve, 60))
  if (answered.status === 504 && released.length === 1) pass('what a settled request acquires is released on arrival, not leaked')
  else fail(`a late acquisition: status ${answered.status}, released ${released.length}`)
  console.log('')
}

// ── 2. pathnameOf ───────────────────────────────────────────────────────────
{
  console.log(`  2. pathnameOf — every request calls it (paired, median of ${REPS}, 1,000,000 calls)\n`)

  /** The implementation before the absolute-form fix, verbatim. */
  const before = (url: string): string => {
    const q = url.indexOf('?')
    const h = url.indexOf('#')
    let end = url.length
    if (q !== -1) end = q
    if (h !== -1 && h < end) end = h
    return end === url.length ? url : url.slice(0, end)
  }

  const originUrl = '/api/v2/orders/1234?expand=lines&page=2'
  const absoluteUrl = 'http://api.example.com/api/v2/orders/1234?expand=lines&page=2'
  if (before(originUrl) !== pathnameOf(originUrl)) fail('the two implementations disagree on an origin-form target')

  const origin = compareSync(() => before(originUrl), () => pathnameOf(originUrl))
  const noise = Math.max(0.5, origin.a * 0.1)
  console.log(`     origin form, before the fix         ${origin.a.toFixed(1).padStart(6)} ns`)
  console.log(`     origin form, now                    ${origin.b.toFixed(1).padStart(6)} ns   ${verdict(origin.a, origin.b, 'ns', noise)}`)
  const absolute = compareSync(() => pathnameOf(originUrl), () => pathnameOf(absoluteUrl))
  console.log(`     absolute form, now                  ${absolute.b.toFixed(1).padStart(6)} ns   ${verdict(absolute.a, absolute.b, 'ns', noise)} over the origin form`)
  console.log('     (before the fix the absolute form was not slower — it was a 404)\n')
}

// ── 3. the next() wrapper ───────────────────────────────────────────────────
{
  console.log(`  3. around + next(), per request through inject() (paired, median of ${REPS}, ${ITERATIONS.toLocaleString()} iterations)\n`)
  const app = makeApp()
  app.around(async (_ctx, next) => next())
  app.get('/sync', markSync(() => 'ok'))
  app.get('/maybe', () => 'ok')
  await app.ready()
  const bare = makeApp()
  bare.get('/sync', markSync(() => 'ok'))
  await bare.ready()

  const unwrapped = await compare(() => bare.inject('GET', '/sync'), () => app.inject('GET', '/sync'))
  console.log(`     no around                            ${unwrapped.a.toFixed(2).padStart(6)} µs`)
  console.log(`     around, synchronous downstream       ${unwrapped.b.toFixed(2).padStart(6)} µs   ${verdict(unwrapped.a, unwrapped.b, 'µs', unwrapped.a * 0.05)}  (all of around: closure, async hop, next())`)
  const shapes = await compare(() => app.inject('GET', '/maybe'), () => app.inject('GET', '/sync'))
  console.log(`     around, async downstream             ${shapes.a.toFixed(2).padStart(6)} µs`)
  console.log(`     around, synchronous downstream       ${shapes.b.toFixed(2).padStart(6)} µs   ${verdict(shapes.a, shapes.b, 'µs', shapes.a * 0.05)}  (the async next() wrapper)`)
  console.log('     the wrapper costs what an async downstream already cost — and only an around over a sync one pays it\n')
}

// ── 4. disposal ─────────────────────────────────────────────────────────────
{
  console.log(`  4. Releasing what a request took (paired, median of ${REPS}, ${ITERATIONS.toLocaleString()} iterations)\n`)
  const Tx = slot<{ open: boolean }>('bench.request-path.tx', { dispose: (tx) => { tx.open = false } })
  const Conn = token<{ open: boolean }>('bench.request-path.conn')
  const app = makeApp()
  app.provide(Conn, { lifetime: 'scoped', factory: () => ({ open: true }), dispose: (conn) => { conn.open = false } })
  app.get('/none', () => 'ok')
  app.get('/slot', (ctx) => { ctx.set(Tx, { open: true }); return 'ok' })
  app.get('/scoped', (ctx) => { ctx.resolve(Conn); return 'ok' })
  await app.ready()

  const slotted = await compare(() => app.inject('GET', '/none'), () => app.inject('GET', '/slot'))
  console.log(`     nothing to release                   ${slotted.a.toFixed(2).padStart(6)} µs`)
  console.log(`     one disposable slot                  ${slotted.b.toFixed(2).padStart(6)} µs   ${verdict(slotted.a, slotted.b, 'µs', slotted.a * 0.05)}`)
  const scoped = await compare(() => app.inject('GET', '/none'), () => app.inject('GET', '/scoped'))
  console.log(`     one scoped service with dispose      ${scoped.b.toFixed(2).padStart(6)} µs   ${verdict(scoped.a, scoped.b, 'µs', scoped.a * 0.05)}`)
  console.log('     (the scoped arm includes building the service — before the fix it was built and never released)\n')
}

if (failures > 0) {
  console.log(`  ${failures} gate${failures === 1 ? '' : 's'} failed\n`)
  process.exitCode = 1
} else {
  console.log('  all gates passed\n')
}
