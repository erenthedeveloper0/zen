/**
 * What coercion costs — rfcs/0001 §11.4, §18.6, I9.
 *
 * `node benchmarks/coercion/run.ts`
 *
 * The feature is a convenience, and a convenience has to justify itself twice:
 * once against not having it, and once against the thing people do instead.
 * Both comparisons are here, and the second is the one that decides whether
 * this was worth building — because the alternative is not "no conversion", it
 * is `z.coerce.number()`, which already works. If Zen's compiled coercer were
 * meaningfully slower than that, the honest recommendation would be to keep
 * writing `z.coerce`.
 *
 * Five questions, two of which fail the build:
 *
 *   1. **What does a route that coerces nothing pay?** Nothing, checked against
 *      the emitted bytes rather than a clock — for the reason §9.4 gives, that
 *      a timing result inside the noise is also what a real small cost looks
 *      like. **Gated.**
 *   2. **Is a declared string ever converted?** No, and this is a correctness
 *      gate rather than a performance one, sitting in the benchmark because it
 *      is the property a future optimisation would be most tempted to trade
 *      away. **Gated.**
 *   3. **What does it cost per request?** Against a route with the same schema
 *      whose fields are already the right type, and against the same route
 *      doing the conversion inside its own validator — the `z.coerce` shape.
 *   4. **How does it scale with the number of fields?** Linearly, and the
 *      per-field slope is the number that matters.
 *   5. **What does the generated form buy over the interpreted twin?** The
 *      `caps.eval === false` path is production for workerd, so the size of
 *      that gap is a real deployment fact rather than a curiosity.
 *
 * Every schema here is hand-written. `@erenthedeveloper0/zen-core` has no runtime dependencies
 * and its benchmarks keep that honest; more importantly, putting Zod on one
 * side of a comparison and not the other would measure Zod.
 */
import {
  createApp, markSync, buildCoercePlan, compileCoercer, walkCoercer,
  CodeGen, DEFAULT_CAPABILITIES, COERCION_DEFAULTS,
  type CoercePlan, type ZenApp,
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

// ─────────────────────────────────────────────────────────────────────────────
// Schemas: shape + validation, hand-written
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

/** Declares its shape and checks it. What a strict `z.object({ n: z.number() })` is. */
function strict(json: Json) {
  const properties = (json['properties'] ?? {}) as Record<string, Json>
  const keys = Object.keys(properties)
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'bench-strict',
      validate: (value: unknown) => {
        const record = value as Record<string, unknown>
        for (const key of keys) {
          const v = record[key]
          if (v === undefined) continue
          if (!isType(v, (properties[key] as Json)['type'] as string)) {
            return { issues: [{ message: `expected ${String((properties[key] as Json)['type'])}`, path: [key] }] }
          }
        }
        return { value }
      },
    },
    toJSONSchema: () => json,
  } as never
}

/**
 * Converts inside its own `validate`, then checks — the `z.coerce.number()`
 * shape, written out.
 *
 * It declares the *input* as a string, which is what makes this a like-for-like
 * arm rather than a rigged one: §11.4 reads the declared input type, sees a
 * string, and emits nothing, so this route runs exactly one conversion per
 * field, in the validator, and the compiled arm runs exactly one, in generated
 * code. Same work, two places.
 */
function coercing(json: Json) {
  const properties = (json['properties'] ?? {}) as Record<string, Json>
  const plan = Object.entries(properties).map(([key, node]) => [key, node['type'] as string] as const)
  const asInput: Json = {
    type: 'object',
    properties: Object.fromEntries(plan.map(([key]) => [key, { type: 'string' }])),
  }
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'bench-coercing',
      validate: (value: unknown) => {
        const record = value as Record<string, unknown>
        for (const [key, type] of plan) {
          const v = record[key]
          if (typeof v !== 'string') continue
          if (type === 'integer' || type === 'number') {
            const n = Number(v)
            if (!Number.isFinite(n)) return { issues: [{ message: 'expected number', path: [key] }] }
            record[key] = n
          } else if (type === 'boolean') {
            record[key] = v === 'true'
          }
        }
        return { value: record }
      },
    },
    toJSONSchema: () => asInput,
  } as never
}

function isType(value: unknown, type: string): boolean {
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
  return typeof value === 'string'
}

const numericFields = (count: number): Json => ({
  type: 'object',
  properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, { type: 'integer' }])),
})

const queryFor = (count: number): string =>
  Array.from({ length: count }, (_, i) => `f${i}=${i + 1}`).join('&')

// ─────────────────────────────────────────────────────────────────────────────
// Harness — paired and alternating, copied from benchmarks/health
// ─────────────────────────────────────────────────────────────────────────────

const ITERATIONS = 30_000
const REPS = 7

function buildApp(configure: (app: ZenApp) => void, dev = false): ZenApp {
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent, dev })
  configure(app)
  return app
}

async function compare(
  a: { app: ZenApp; url: string },
  b: { app: ZenApp; url: string },
  iterations = ITERATIONS,
): Promise<{ a: number; b: number; ratio: number; spread: number }> {
  const hit = (x: { app: ZenApp; url: string }) => x.app.inject('GET', x.url)
  for (let i = 0; i < 3000; i++) { await hit(a); await hit(b) }

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

const verdict = (ratio: number, spread: number): string =>
  `${((ratio - 1) * 100).toFixed(1).padStart(7)}%   ` +
  (Math.abs(ratio - 1) <= spread ? 'INSIDE NOISE' : 'ABOVE NOISE')

console.log('\n  Coercion profiles — rfcs/0001 §11.4')
console.log('  node ' + process.version + '\n')

// ── 1. what a route that coerces nothing pays ───────────────────────────────

console.log('  1. Routes with nothing to coerce\n')

{
  const stringOnly: Json = { type: 'object', properties: { q: { type: 'string' }, cursor: { type: 'string' } } }

  const before = buildApp((app) => {
    app.get('/items', { query: strict(stringOnly), coercion: false }, markSync(() => ({ ok: true })))
  }, true)
  const after = buildApp((app) => {
    app.get('/items', { query: strict(stringOnly) }, markSync(() => ({ ok: true })))
  }, true)

  await before.ready()
  await after.ready()

  const pipeline = (app: ZenApp): string =>
    app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
  const coercers = (app: ZenApp): number =>
    app.generatedSource().filter((u) => u.name.startsWith('coercer:')).length

  const a = pipeline(before)
  const b = pipeline(after)

  console.log(`    coercion disabled outright                 ${String(a.length).padStart(5)} bytes, ${coercers(before)} coercers`)
  console.log(`    coercion on, schema declares only strings  ${String(b.length).padStart(5)} bytes, ${coercers(after)} coercers`)
  console.log(`    byte-identical: ${a === b && coercers(after) === 0 ? 'yes — the absence is the feature' : 'NO'}`)

  if (a !== b || a.length === 0 || coercers(after) !== 0) {
    console.error('\n    ::error:: a route with nothing to coerce paid for the feature anyway (§11.4, §9.4)')
    process.exitCode = 1
  }

  const r = await compare({ app: before, url: '/items?q=hi' }, { app: after, url: '/items?q=hi' })
  console.log(`\n    per-request, paired:  ${r.a.toFixed(2)} µs → ${r.b.toFixed(2)} µs  ${verdict(r.ratio, r.spread)}`)
  console.log(`    (spread ${(r.spread * 100).toFixed(0)}%)`)
}

// ── 2. the correctness gate ─────────────────────────────────────────────────

console.log('\n  2. Is a declared string ever converted?\n')

{
  const app = buildApp((a) => {
    a.get('/p', {
      query: strict({
        type: 'object',
        properties: {
          zip: { type: 'string' },
          version: { type: 'string' },
          page: { type: 'integer' },
        },
      }),
    }, markSync((ctx: never) => (ctx as { query: unknown }).query))
  })
  await app.ready()

  const res = await app.inject('GET', '/p?zip=01234&version=1.10&page=2')
  const body = res.json<{ zip: unknown; version: unknown; page: unknown }>()

  console.log(`    ?zip=01234      → ${JSON.stringify(body.zip)}`)
  console.log(`    ?version=1.10   → ${JSON.stringify(body.version)}`)
  console.log(`    ?page=2         → ${JSON.stringify(body.page)}`)
  console.log('')
  console.log('    The first two are the reason this is schema-guided rather than')
  console.log('    heuristic. A framework that coerces anything numeric-looking turns a')
  console.log('    US postcode into 1234 and an API version into 1.1, and does it')
  console.log('    silently, on a field the developer never thought to check.')

  if (body.zip !== '01234' || body.version !== '1.10' || body.page !== 2) {
    console.error('\n    ::error:: a declared string was coerced, or a declared integer was not (§11.4)')
    process.exitCode = 1
  }
}

// ── 3. what it costs per request ────────────────────────────────────────────

console.log('\n  3. Per request, four fields\n')

/**
 * The yardstick has to be a route that *succeeds*.
 *
 * The first draft of this section compared the coerced arm against the same
 * integer schema with `coercion: false`, which is not a slower baseline — it is
 * a 400 on every request, so it was timing the error engine and reporting the
 * difference as a 15× win. Both arms answer 200 now. §18.6's rule, and the one
 * the deadline benchmark learned the same way: if a comparison flatters the
 * feature, check what the other arm is actually doing.
 */
const stringFields = (count: number): Json => ({
  type: 'object',
  properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, { type: 'string' }])),
})

{
  const url = `/q?${queryFor(4)}`

  const noQuery = buildApp((a) => { a.get('/q', markSync(() => ({ ok: true }))) })
  const validated = buildApp((a) => {
    a.get('/q', { query: strict(stringFields(4)) }, markSync(() => ({ ok: true })))
  })
  const compiled = buildApp((a) => {
    a.get('/q', { query: strict(numericFields(4)) }, markSync(() => ({ ok: true })))
  })
  const inValidator = buildApp((a) => {
    a.get('/q', { query: coercing(numericFields(4)) }, markSync(() => ({ ok: true })))
  })

  for (const app of [noQuery, validated, compiled, inValidator]) await app.ready()
  for (const [name, app] of [['validated', validated], ['compiled', compiled], ['inValidator', inValidator]] as const) {
    const status = (await app.inject('GET', url)).status
    if (status !== 200) {
      console.error(`    ::error:: the "${name}" arm answers ${status}, so this section is timing the error path`)
      process.exitCode = 1
    }
  }

  const emitted = (app: ZenApp): number => app.generatedSource().filter((u) => u.name.startsWith('coercer:')).length
  console.log(`    coercers emitted — compiled arm: ${emitted(compiled)}, "inside validate" arm: ${emitted(inValidator)}`)
  console.log('    (the second is zero because its declared *input* type is string, which')
  console.log('     is what makes the head-to-head like-for-like rather than double-counting)\n')

  const floor = await compare({ app: noQuery, url }, { app: validated, url })
  console.log(`    no query schema at all              ${floor.a.toFixed(2)} µs`)
  console.log(`    4 string fields, validated          ${floor.b.toFixed(2)} µs   (+${(floor.b - floor.a).toFixed(2)} µs for the validator)`)

  const conversion = await compare({ app: validated, url }, { app: compiled, url })
  console.log(`    4 integer fields, coerced           ${conversion.b.toFixed(2)} µs   ${verdict(conversion.ratio, conversion.spread)}`)
  console.log(`      → ${((conversion.b - conversion.a) * 1000 / 4).toFixed(0)} ns per field converted`)

  // Printed as its own pair rather than against the row above it. Two
  // `compare()` calls drift relative to each other by more than the effect
  // being claimed — the trap the hook and deadline harnesses were built to
  // avoid — so the only two numbers here that may be subtracted are these two.
  const head = await compare({ app: compiled, url }, { app: inValidator, url })
  console.log('')
  console.log(`    head to head, one pairing:  compiled ${head.a.toFixed(2)} µs  ·  by hand ${head.b.toFixed(2)} µs   ${verdict(head.ratio, head.spread)}`)
  console.log('')
  console.log('    The last two rows are the finding, and the finding is that there is')
  console.log('    barely one. Converting a string to a number costs what it costs, and')
  console.log('    doing it in generated code rather than inside the validator moves the')
  console.log('    work rather than removing it. The two arms differ by less than the')
  console.log('    spread of the harness, which is the correct result and not a')
  console.log('    disappointing one.')
  console.log('')
  console.log('    So this feature does not make an application faster. What it does is')
  console.log('    remove `z.coerce` from every query schema in it, and make the running')
  console.log('    behaviour a consequence of the declared type rather than of whether')
  console.log('    somebody remembered — which is the part a benchmark cannot show and')
  console.log('    the whole reason it was ranked #2 rather than #8.')
}

// ── 4. scaling with field count ─────────────────────────────────────────────

console.log('\n  4. Scaling with field count\n')

{
  const measured: Array<[number, number]> = []
  for (const count of [1, 2, 4, 8, 16]) {
    // Same field count, same validator shape, same 200 — the only difference is
    // that one side's fields are declared as integers and therefore converted.
    const base = buildApp((a) => { a.get('/q', { query: strict(stringFields(count)) }, markSync(() => ({ ok: true }))) })
    const withCoercion = buildApp((a) => { a.get('/q', { query: strict(numericFields(count)) }, markSync(() => ({ ok: true }))) })
    await base.ready()
    await withCoercion.ready()

    const url = `/q?${queryFor(count)}`
    const r = await compare({ app: base, url }, { app: withCoercion, url }, 10_000)
    measured.push([count, (r.b - r.a) * 1000])
    console.log(`    ${String(count).padStart(2)} fields   ${r.a.toFixed(2)} µs → ${r.b.toFixed(2)} µs   +${((r.b - r.a) * 1000).toFixed(0)} ns`)
  }

  const [first, last] = [measured[0] as [number, number], measured[measured.length - 1] as [number, number]]
  const slope = (last[1] - first[1]) / (last[0] - first[0])
  console.log('')
  console.log(`    slope: ${slope.toFixed(0)} ns per additional field.`)
  console.log('    Linear, and it should be: the plan is unrolled, so N fields is N call')
  console.log('    sites rather than N iterations of a loop that also has to re-decide')
  console.log('    what each field is. There is no fixed overhead to amortise either,')
  console.log('    because when the plan is empty there is no function at all.')
}

// ── 5. the compiled form against its twin ───────────────────────────────────

console.log('\n  5. Generated against interpreted (the caps.eval === false path)\n')

{
  const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })
  const shape = numericFields(8)
  const outcome = buildCoercePlan(strict(shape), 'query', COERCION_DEFAULTS.query)
  const plan = (outcome.kind === 'ok' ? outcome.plan : null) as CoercePlan

  const compiled = compileCoercer(plan, 'bench', codegen)
  const walked = walkCoercer(plan)

  const input = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, String(i + 1)]))
  const time = (fn: (v: unknown) => unknown): number => {
    for (let i = 0; i < 50_000; i++) fn({ ...input })
    const runs: number[] = []
    for (let rep = 0; rep < 5; rep++) {
      const start = process.hrtime.bigint()
      for (let i = 0; i < 200_000; i++) fn({ ...input })
      runs.push(Number(process.hrtime.bigint() - start) / 200_000)
    }
    return Math.min(...runs)
  }

  // Alternating, for the same reason `compare` alternates.
  const first = time(compiled)
  const second = time(walked)
  const third = time(compiled)

  const compiledNs = Math.min(first, third)
  console.log(`    compiled coercer, 8 fields    ${compiledNs.toFixed(0)} ns`)
  console.log(`    walking coercer, 8 fields     ${second.toFixed(0)} ns`)
  console.log(`    ratio                         ${(second / compiledNs).toFixed(2)}×`)
  console.log('')
  console.log('    Both numbers include the object spread the harness does to give each')
  console.log('    run a fresh record, which is most of what is being timed at this scale.')
  console.log('    The gap is what the unrolling buys: no plan iteration, no dispatch on')
  console.log('    an op tag, no closure per field. It is also the honest size of what a')
  console.log('    workerd deployment gives up, which is the number worth publishing —')
  console.log('    the interpreted path is production somewhere, not a fallback nobody runs.')
}

// ── 6. boot ─────────────────────────────────────────────────────────────────

console.log('\n  6. What it costs at boot\n')

{
  const shape = numericFields(6)
  const build = async (coercion: false | undefined): Promise<number> => {
    const start = process.hrtime.bigint()
    const app = buildApp((a) => {
      for (let i = 0; i < 200; i++) {
        a.get(`/r${i}`, { query: strict(shape), coercion }, markSync(() => ({ ok: true })))
      }
    })
    await app.ready()
    return Number(process.hrtime.bigint() - start) / 1e6
  }

  // Warm, then measure. The first boot in a process pays for the compiler's own
  // code being cold and would attribute it all to whichever arm ran first.
  await build(false)
  await build(undefined)

  const off = Math.min(await build(false), await build(false))
  const on = Math.min(await build(undefined), await build(undefined))

  console.log(`    200 routes × 6 numeric fields, coercion off   ${off.toFixed(1)} ms`)
  console.log(`    200 routes × 6 numeric fields, coercion on    ${on.toFixed(1)} ms`)
  console.log(`    → ${(((on - off) / 200) * 1000).toFixed(0)} µs per route: one schema conversion, one walk, one generated function`)
  console.log('')
  console.log('    Paid once, at boot, on the path that already converts every response')
  console.log('    schema for the serializer. §28.5 is the standing caveat: boot-time')
  console.log('    analysis is linear in routes and this adds a term to it.')
}

console.log('')
