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
 *   5. **`0.1.0-alpha.4` — nothing silent.** Three more gates, each the
 *      byte-identical kind: a collection that `when` turns off leaves no trace
 *      on the routes beside it, a route without `use` compiles exactly as it
 *      did beside one with it, and the `writeOnly` check emits nothing — it is
 *      a boot-time walk. Then the three costs the release put on the request
 *      path, published whichever way they come out: the seal check on every
 *      `ctx.res` staging call, the protocol check `ctx.set` now makes for an
 *      object value, and the store at egress that seals the builder.
 *   6. **`0.1.0-alpha.5` — the hot path.** Gates first: a plain-arrow handler
 *      compiles with no `async` and no `await` (§8.4), a clean JSON body is
 *      parsed with no reviver (§19.5), and a served match builds no `Set`.
 *      Then JSON intake on a clean ~1 KB body against `0.1.0-alpha.4`'s
 *      parser, verbatim: gated at 1.5× a bare decode-and-parse everywhere, and
 *      at 5× faster than before wherever 5× is reachable — that needs a
 *      reviver costing at least 6× a bare parse, which Node 22 and 24 do and
 *      Node 26's V8 at times does not. Then what a request pays for `ctx.log`
 *      on its first read, and the adapter's URL-length guard.
 */
import {
  createApp, jsonSchema, markSync, pathnameOf, slot, token, trackIntrinsic, CodeGen, compileContext,
  DEFAULT_CAPABILITIES, NoopLogger, ZenContainer, ConsoleLogger, jsonParser, BODY_DEFAULTS, isForbiddenKey,
  type Logger, type RawRequest, type ZenApp,
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

const makeApp = (): ZenApp => createApp({ router: new ZenRouter(), pathParser, logger: silent, inspect: true }) as unknown as ZenApp

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
  // An `async` handler, not a plain one: since 0.1.0-alpha.5 a plain function
  // is speculated synchronous (§8.4), so it would measure the sync arm twice.
  app.get('/async', async () => 'ok')
  await app.ready()
  const bare = makeApp()
  bare.get('/sync', markSync(() => 'ok'))
  await bare.ready()

  const unwrapped = await compare(() => bare.inject('GET', '/sync'), () => app.inject('GET', '/sync'))
  console.log(`     no around                            ${unwrapped.a.toFixed(2).padStart(6)} µs`)
  console.log(`     around, synchronous downstream       ${unwrapped.b.toFixed(2).padStart(6)} µs   ${verdict(unwrapped.a, unwrapped.b, 'µs', unwrapped.a * 0.05)}  (all of around: closure, async hop, next())`)
  const shapes = await compare(() => app.inject('GET', '/async'), () => app.inject('GET', '/sync'))
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

// ── 5. 0.1.0-alpha.4 ────────────────────────────────────────────────────────
{
  console.log('  5. 0.1.0-alpha.4 — nothing silent  (gates)\n')

  // §6.2 — a subtree `when` turned off is absent, not skipped at runtime.
  const alone = makeApp()
  alone.get('/plain', markSync(() => 'plain'))
  await alone.ready()
  const beside = makeApp()
  beside.collection('/debug', { when: () => false }, (c) => {
    c.use(async function debugOnly() {})
    c.hook('onRequest', function debugHook() {})
    c.get('/state', () => 'state')
  })
  beside.get('/plain', markSync(() => 'plain'))
  await beside.ready()
  const absentHere = beside.generatedSource().some((u) => u.name.includes('/debug'))
  if (source(alone, 'pipeline:GET_/plain') === source(beside, 'pipeline:GET_/plain') && !absentHere &&
      source(alone, 'context') === source(beside, 'context')) {
    pass("a collection its when turned off leaves the app byte-identical, and compiles nothing of its own")
  } else {
    fail('a collection turned off by when left code behind')
  }

  // §8.3 — route-scoped middleware is the route's alone.
  const owned = makeApp()
  owned.get('/plain', markSync(() => 'plain'))
  owned.get('/owned/:id', { use: [markSync(function checkOwnership() {})] }, markSync(() => 'mine'))
  await owned.ready()
  if (source(alone, 'pipeline:GET_/plain') === source(owned, 'pipeline:GET_/plain')) {
    pass('a route without use is byte-identical beside one with it')
  } else {
    fail("a route's use leaked into a route that does not declare it")
  }

  // §13.3 — the writeOnly check is a walk at boot; it emits no code.
  const shape = (format?: string) => jsonSchema({
    type: 'object',
    properties: { id: { type: 'integer' }, hash: format === undefined ? { type: 'string' } : { type: 'string', format } },
    required: ['id', 'hash'],
  })
  const plainSchema = makeApp()
  plainSchema.get('/u', { response: { 200: shape() } }, () => ({ id: 1, hash: 'h' }) as never)
  await plainSchema.ready()
  const flagged = createApp({ router: new ZenRouter(), pathParser, logger: new NoopLogger(), inspect: true }) as unknown as ZenApp
  flagged.get('/u', { response: { 200: shape('password') } }, () => ({ id: 1, hash: 'h' }) as never)
  await flagged.ready()
  if (source(plainSchema, 'serializer:GET /u#200') === source(flagged, 'serializer:GET /u#200')) {
    pass('a field the check warns about compiles to the serializer it always did — the check adds no code')
  } else {
    fail('the writeOnly check changed what the serializer emits')
  }
  console.log('')

  console.log(`     costs on the request path (paired, median of ${REPS})\n`)

  // The seal check: one identity comparison per staging call. Measured on the
  // call itself, against a builder whose context has no seal to compare.
  const raw: RawRequest = {
    method: 'GET', url: '/', header: () => undefined, headerNames: () => [],
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '127.0.0.1', port: 0, family: 'IPv4' }, native: null,
  }
  const env = { log: silent, maxQueryParams: 100, trustProxy: false, container: new ZenContainer(), config: {} }
  const Ctx = compileContext({ decorations: [], slotCount: 8, codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }) })
  const fresh = () => new Ctx(raw, null, {}, env, new AbortController().signal) as unknown as {
    res: { header(name: string, value: string): unknown }
    set(slot: unknown, value: unknown): void
    $stage: unknown
    $disposers: unknown
  }
  const staged = compareSync(
    () => { const ctx = fresh(); return ctx },
    () => { const ctx = fresh(); ctx.res.header('x-request-cost', '1'); return ctx },
    200_000,
  )
  console.log(`     a context, nothing staged             ${staged.a.toFixed(1).padStart(6)} ns`)
  console.log(`     …and one ctx.res.header() call        ${staged.b.toFixed(1).padStart(6)} ns   ${verdict(staged.a, staged.b, 'ns', staged.a * 0.05)}  (builder, validation, seal check)`)

  // The seal check in isolation: the same staging work with and without the
  // comparison, so its own share is not hidden inside the call above.
  const SEALED = Object.freeze({})
  const holder = { $stage: null as unknown, staged: 0 }
  const withCheck = (): unknown => { if (holder.$stage === SEALED) throw new Error('sealed'); holder.staged++; return holder }
  const withoutCheck = (): unknown => { holder.staged++; return holder }
  const check = compareSync(withoutCheck, withCheck)
  console.log(`     staging without the seal check        ${check.a.toFixed(1).padStart(6)} ns`)
  console.log(`     staging with it                       ${check.b.toFixed(1).padStart(6)} ns   ${verdict(check.a, check.b, 'ns', Math.max(0.3, check.a * 0.1))}  (one comparison of a loaded field)`)

  // ctx.set's protocol check: an object value now costs one symbol lookup
  // (two, for a value with neither); a primitive pays one `typeof`.
  const Plain = slot<object>('bench.request-path.plain-object')
  const Count = slot<number>('bench.request-path.number')
  const value = { id: 1 }
  const setCtx = fresh()
  const sets = compareSync(() => { setCtx.set(Count, 1); return setCtx }, () => { setCtx.set(Plain, value); return setCtx })
  console.log(`     ctx.set(slot, 1)                       ${sets.a.toFixed(1).padStart(6)} ns`)
  console.log(`     ctx.set(slot, { id: 1 })               ${sets.b.toFixed(1).padStart(6)} ns   ${verdict(sets.a, sets.b, 'ns', Math.max(0.3, sets.a * 0.1))}  (the Symbol.dispose / asyncDispose probe)`)
  const carrier = { $disposers: null, log: silent }
  const probe = compareSync(() => carrier, () => { trackIntrinsic(carrier as never, 'x', value); return carrier })
  console.log(`     the probe alone, on a plain object     ${(probe.b - probe.a).toFixed(1).padStart(6)} ns   (nothing is queued: the value implements neither)`)

  // The egress store: one write of a shared frozen object into a field every
  // context already has.
  const store = compareSync(() => { const ctx = fresh(); return ctx }, () => { const ctx = fresh(); ctx.$stage = SEALED; return ctx }, 200_000)
  console.log(`     sealing at egress                      ${(store.b - store.a).toFixed(1).padStart(6)} ns   ${Math.abs(store.b - store.a) <= Math.max(0.5, store.a * 0.05) ? 'inside noise' : ''}  (one store, no allocation)`)
  console.log('')
}

// ── 6. 0.1.0-alpha.5 ────────────────────────────────────────────────────────
{
  console.log('  6. 0.1.0-alpha.5 — the hot path  (gates)\n')

  // §8.4 — a plain function reaches the synchronous pipeline unmarked.
  const plain = makeApp()
  plain.get('/plain', () => ({ hello: 'world' }))
  plain.get('/async', async () => ({ hello: 'world' }))
  plain.get('/later', () => Promise.resolve('later'))
  await plain.ready()
  const plainSource = source(plain, 'pipeline:GET_/plain')
  if (!/\basync\b/.test(plainSource) && !/\bawait\b/.test(plainSource)) {
    pass('a plain-arrow handler compiles with no async and no await')
  } else {
    fail('a plain-arrow handler still compiles to async code')
  }
  if (/async function/.test(source(plain, 'pipeline:GET_/async'))) pass('an async handler keeps the async path it always had')
  else fail('an async handler lost its async path')
  const later = await plain.inject('GET', '/later')
  if (later.status === 200 && later.text() === 'later') pass('a plain function that returns a promise is awaited where it returns one')
  else fail(`a plain function returning a promise answered ${later.status} ${later.text()}`)

  // §19.5 — a body that cannot carry a forbidden key is parsed without a reviver.
  const order = JSON.stringify({
    customer: { id: 'c_8f14e45fceea167a5a36dedd4bea2543', email: 'ada@example.com', name: 'Ada Lovelace' },
    lines: Array.from({ length: 12 }, (_, i) => ({ sku: `SKU-${1000 + i}`, qty: i + 1, unitPrice: 12.5 + i, note: 'gift wrap' })),
    shipping: { street: '12 Analytical Row', city: 'London', postcode: 'EC1A 1BB', country: 'GB' },
    coupon: 'AUTUMN-2026',
  })
  const clean = new TextEncoder().encode(order)
  const escaped = new TextEncoder().encode(order.replace('"Ada Lovelace"', '"\\u0041da Lovelace"'))
  const options = { ...BODY_DEFAULTS }
  const parse = JSON.parse
  let revived = 0
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (reviver !== undefined) revived++
    return parse(text, reviver)
  }) as typeof JSON.parse
  try {
    jsonParser(clean, null as never, options)
    const cleanRevived = revived
    jsonParser(escaped, null as never, options)
    if (cleanRevived === 0 && revived === 1) pass('a clean body is parsed with no reviver, and an escaped one still with it')
    else fail(`revivers: clean body ${cleanRevived}, escaped body ${revived - cleanRevived}`)
  } finally {
    JSON.parse = parse
  }

  // §5.6 — a served match builds no Set; only a refusal gathers `Allow`.
  const record = (method: 'GET' | 'DELETE', path: string) => {
    const parsed = parsePath(path)
    return {
      id: `${method} ${parsed.path}`, name: undefined, method, path: parsed.path, segments: parsed.segments,
      schema: {}, handler: () => undefined, middleware: [], meta: new Map(), collection: null, origin: undefined,
    }
  }
  const matcher = new ZenRouter().build([record('GET', '/users/:a/:b/:c/:d/:e'), record('DELETE', '/users/:a/:b/:c/:d/:e')] as never)
  const RealSet = globalThis.Set
  let sets = 0
  globalThis.Set = class CountedSet<T> extends RealSet<T> {
    constructor(values?: Iterable<T> | null) { super(values); sets++ }
  } as SetConstructor
  let served = 0
  let refused = 0
  try {
    for (let i = 0; i < 1000; i++) matcher.match('GET', '/users/1/2/3/4/5')
    served = sets
    matcher.match('PUT', '/users/1/2/3/4/5')
    refused = sets - served
  } finally {
    globalThis.Set = RealSet
  }
  if (served === 0 && refused === 1) pass('a thousand served matches build no Set; the one refusal builds its Allow set')
  else fail(`Sets built: ${served} across served matches, ${refused} for the refusal`)
  console.log('')

  console.log(`     costs on the request path (paired, median of ${REPS})\n`)

  // §19.5 — the release's gate: JSON intake on a clean ~1 KB body, now and as
  // it was. `before` is 0.1.0-alpha.4's `jsonParser`, verbatim but for the
  // error class: every body revived, then walked value by value.
  const decoder = new TextDecoder('utf-8', { fatal: false })
  function protoStripper(this: unknown, key: string, value: unknown): unknown {
    return isForbiddenKey(key) ? undefined : value
  }
  function assertDepth(value: unknown, max: number, depth = 0): void {
    if (depth > max) throw new Error(`Body nesting exceeds the maximum depth of ${max}`)
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) {
      for (const item of value) assertDepth(item, max, depth + 1)
      return
    }
    for (const key in value) assertDepth((value as Record<string, unknown>)[key], max, depth + 1)
  }
  const before = (bytes: Uint8Array, opts: { readonly maxDepth: number }): unknown => {
    const text = decoder.decode(bytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(text, protoStripper)
    } catch (cause) {
      throw new Error('Body is not valid JSON', { cause })
    }
    assertDepth(parsed, opts.maxDepth)
    return parsed
  }
  if (JSON.stringify(before(clean, options)) !== JSON.stringify(jsonParser(clean, null as never, options))) {
    fail('the two parsers disagree on the gate body')
  }

  const intake = compareSync(() => before(clean, options), () => jsonParser(clean, null as never, options), 50_000)
  const bare = compareSync(() => JSON.parse(decoder.decode(clean)), () => jsonParser(clean, null as never, options), 50_000)
  const speedup = intake.a / intake.b
  const overhead = bare.b / bare.a
  // The most removing the reviver can buy: what 0.1.0-alpha.4 paid against
  // decoding and parsing with nothing else. Node 22 and 24 revive at six to
  // seven times a bare parse; Node 26's V8 at times optimises the reviver
  // path to under four, and then no intake could be 5× faster than it.
  const ceiling = intake.a / bare.a
  console.log(`     JSON intake, ${clean.length} B, 0.1.0-alpha.4      ${(intake.a / 1000).toFixed(2).padStart(6)} µs   (a reviver on every body)`)
  console.log(`     JSON intake, ${clean.length} B, now                ${(intake.b / 1000).toFixed(2).padStart(6)} µs   ${speedup.toFixed(1)}× faster`)
  console.log(`     decode + JSON.parse alone           ${(bare.a / 1000).toFixed(2).padStart(6)} µs   (intake now costs ${overhead.toFixed(2)}× that; the most it could gain was ${ceiling.toFixed(1)}×)`)
  if (overhead <= 1.5) pass(`clean JSON intake costs at most 1.5× a bare decode and parse (${overhead.toFixed(2)}×)`)
  else fail(`clean JSON intake costs ${overhead.toFixed(2)}× a bare decode and parse; the gate is 1.5×`)
  if (ceiling < 6) {
    console.log(`     – the 5× gate needs a reviver that costs 6× a bare parse; this runtime's costs ${ceiling.toFixed(1)}×, so 5× is out of reach and the ${speedup.toFixed(1)}× above is published, not gated`)
  } else if (speedup >= 5) {
    pass(`clean JSON intake is at least 5× faster than in 0.1.0-alpha.4 (${speedup.toFixed(1)}×)`)
  } else {
    fail(`clean JSON intake is only ${speedup.toFixed(1)}× faster than in 0.1.0-alpha.4; the gate is 5×`)
  }
  const careful = compareSync(() => before(escaped, options), () => jsonParser(escaped, null as never, options), 50_000)
  console.log(`     …a body with one \\u escape, now      ${(careful.b / 1000).toFixed(2).padStart(6)} µs   ${verdict(careful.a, careful.b, 'ns', careful.a * 0.05).replace(/ ns/, ' ns over 0.1.0-alpha.4')}  (still revived: the careful path)`)

  // §31.1 — ctx.log is a child made on the first read: the default logger's
  // child() is what a request that logs now pays, once; one that never logs
  // pays nothing.
  const env = { log: new ConsoleLogger('fatal'), maxQueryParams: 100, trustProxy: false, container: new ZenContainer(), config: {} }
  const raw: RawRequest = {
    method: 'GET', url: '/', header: () => undefined, headerNames: () => [],
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '127.0.0.1', port: 0, family: 'IPv4' }, native: null,
  }
  const Ctx = compileContext({ decorations: [], slotCount: 8, codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }) })
  const logs = compareSync(
    () => new Ctx(raw, null, {}, env, new AbortController().signal),
    () => { const ctx = new Ctx(raw, null, {}, env, new AbortController().signal); return ctx.log },
    200_000,
  )
  console.log(`     a context that never logs              ${logs.a.toFixed(1).padStart(6)} ns`)
  console.log(`     …and its first ctx.log read            ${logs.b.toFixed(1).padStart(6)} ns   ${verdict(logs.a, logs.b, 'ns', logs.a * 0.05)}  (ConsoleLogger.child, once per request)`)

  // §4.2 stage 2 — the Node adapter's URL-length guard, alone: one property
  // read and one comparison per request, on a target of ordinary length.
  const message = { url: '/api/v2/orders/1234?expand=lines&page=2' }
  const limit = 8192
  let refusedTargets = 0
  const guard = compareSync(
    () => message,
    () => { if ((message.url ?? '/').length > limit) refusedTargets++; return message },
  )
  console.log(`     the URL-length guard                   ${(guard.b - guard.a).toFixed(1).padStart(6)} ns   (one length compare; ${refusedTargets} refused)`)
  console.log('')
}

if (failures > 0) {
  console.log(`  ${failures} gate${failures === 1 ? '' : 's'} failed\n`)
  process.exitCode = 1
} else {
  console.log('  all gates passed\n')
}
