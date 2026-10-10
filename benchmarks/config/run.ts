/**
 * What configuration costs — rfcs/0001 §16, §18.6, I9.
 *
 * `node benchmarks/config/run.ts`
 *
 * Configuration is the one subsystem in Zen whose competitor is not another
 * framework. It is a **plain module**: five of this repo's own examples answer
 * "where does the port come from" with `export const config = { port:
 * Number(process.env.PORT ?? 3000) }`, and that module is free, obvious, and
 * already written. So the bar is not "is this fast", it is "does this cost
 * anything a plain module does not" — and if the answer at request time were
 * anything but zero, the honest recommendation would be to keep the module.
 *
 * Five questions, two of which fail the build:
 *
 *   1. **What does a route pay?** Nothing, checked against the emitted bytes
 *      rather than a clock, for the reason §9.4 gives: a timing result inside
 *      the noise is also what a real small cost looks like. `ctx.config` is a
 *      getter over the shared `ContextEnv`, so there is nothing for a pipeline
 *      to carry — and this gate is what stops a later change from making it a
 *      context field. **Gated.**
 *   2. **Can a secret reach a projection?** No, and this is a correctness gate
 *      living in a benchmark on purpose: it is the property a later
 *      optimisation would be most tempted to trade away, because building the
 *      snapshot twice — once with secrets, once without — is the obvious way to
 *      make `explainConfig` cheaper. **Gated.**
 *   3. **What does reading it cost per request** against the plain module it
 *      replaces? This is the comparison that decides whether the feature was
 *      worth building at all.
 *   4. **What does it cost at boot**, against env size and config size — the
 *      only place this subsystem does any work.
 *   5. **What does the freeze cost?** §16.4 makes config deeply immutable, and
 *      "deeply" is an O(leaves) walk that somebody will eventually propose
 *      removing.
 *
 * Every schema here is hand-written. `@erenthedeveloper0/zen-core` has no runtime dependencies
 * and its benchmarks keep that honest; more importantly, putting Zod on one
 * side of a comparison and not the other would measure Zod.
 */
import {
  createApp, markSync, defineConfig, resolveConfig, explainConfig, REDACTED,
  type ConfigOverlay, type EnvSource, type ZenApp,
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

const ITERATIONS = 30_000
const REPS = 7

function buildApp(configure: (app: ZenApp) => void, options: Record<string, unknown> = {}): ZenApp {
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent, inspect: true, ...options })
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

console.log('\n  Configuration — rfcs/0001 §16')
console.log('  node ' + process.version + '\n')

// ── 1. what a route pays ────────────────────────────────────────────────────

console.log('  1. What a route pays for the whole subsystem\n')

{
  const plain = buildApp((app) => {
    app.get('/items', markSync(() => ({ ok: true })))
  }, { dev: true })

  const configured = buildApp((app) => {
    app.get('/items', markSync(() => ({ ok: true })))
  }, {
    dev: true,
    config: defineConfig({
      secrets: ['db.url'],
      server: { port: 8080 },
      db: { url: (env: Record<string, string | undefined>) => env['DATABASE_URL'] ?? '', pool: 10 },
      logging: { level: 'debug', redact: ['req.headers.authorization'] },
    }),
    env: [{ layer: 'env', name: 'bench', entries: [{ key: 'DATABASE_URL', value: 'postgres://u:p@h/d' }] }],
    overrides: { logging: { level: 'info' } },
  })

  await plain.ready()
  await configured.ready()

  const pipeline = (app: ZenApp): string =>
    app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
  const context = (app: ZenApp): string =>
    app.generatedSource().find((u) => u.name === 'context')?.source ?? ''

  const a = pipeline(plain)
  const b = pipeline(configured)
  const ca = context(plain)
  const cb = context(configured)

  console.log(`    no configuration at all            ${String(a.length).padStart(5)} bytes of pipeline, ${String(ca.length).padStart(5)} of context`)
  console.log(`    a four-namespace configuration     ${String(b.length).padStart(5)} bytes of pipeline, ${String(cb.length).padStart(5)} of context`)
  console.log(`    byte-identical: ${a === b && ca === cb ? 'yes — both, and the context is the interesting one' : 'NO'}`)
  console.log('')
  console.log('    The context matters more than the pipeline here. `ctx.config` is a')
  console.log('    getter over the shared ContextEnv rather than a field on the context,')
  console.log('    so it costs one property load and *no constructor store* — which is')
  console.log('    what keeps the generated class the same shape whether or not an')
  console.log('    application configures anything (I2, §7.6).')

  if (a !== b || ca !== cb || a.length === 0) {
    console.error('\n    ::error:: configuration changed generated code for a route that never reads it (§16.3, §9.4)')
    process.exitCode = 1
  }
}

// ── 2. the correctness gate ─────────────────────────────────────────────────

console.log('\n  2. Can a secret reach a projection?\n')

{
  const SECRET = 'postgres://user:hunter2@db/app'
  const app = buildApp((a) => {
    a.get('/x', markSync(() => ({ ok: true })))
  }, {
    config: defineConfig({
      secrets: ['DATABASE_URL'],
      db: { url: (env: Record<string, string | undefined>) => env['DATABASE_URL'] ?? '', pool: 10 },
      site: { url: 'https://acme.com' },
    }),
    env: [{ layer: 'env', name: 'bench', entries: [{ key: 'DATABASE_URL', value: SECRET }] }],
  })
  await app.ready()

  const snapshot = app.graph().config
  const projections: Array<[string, string]> = [
    ['AppGraph.config', JSON.stringify(snapshot)],
    ['explainConfig()', explainConfig(snapshot)],
    ['JSON.stringify(app.config)', JSON.stringify(app.config)],
    ['JSON.stringify(app.config.db)', JSON.stringify((app.config as { db: unknown }).db)],
  ]

  let leaked = false
  for (const [name, text] of projections) {
    const safe = !text.includes('hunter2')
    console.log(`    ${safe ? '✔' : '✖'} ${name.padEnd(30)} ${safe ? 'redacted' : 'LEAKED'}`)
    if (!safe) leaked = true
  }

  const real = (app.config as { db: { url: string } }).db.url
  console.log(`\n    and the value is still there when something asks for it by name:`)
  console.log(`      app.config.db.url          ${real === SECRET ? 'the real URL' : 'BROKEN'}`)
  console.log(`      snapshot                   ${snapshot.values.find((v) => v.path === 'db.url')?.value as string}`)
  console.log('')
  console.log('    Redaction that hides everything hides nothing, because people turn it')
  console.log(`    off. \`site.url\` survives: ${snapshot.values.find((v) => v.path === 'site.url')?.value as string}`)

  if (leaked || real !== SECRET || snapshot.values.find((v) => v.path === 'db.url')?.value !== REDACTED) {
    console.error('\n    ::error:: a secret reached a projection, or redaction ate a value it should not have (§16.2)')
    process.exitCode = 1
  }
}

// ── 3. per request, against the plain module ────────────────────────────────

console.log('\n  3. Per request: ctx.config against the module it replaces\n')

/**
 * The yardstick has to be the thing people actually write.
 *
 * Not "an app with no config" — that arm does not read anything, so it would be
 * timing an absent property access and reporting the difference as a cost. The
 * honest comparison is a handler that reads a value from a module-level
 * `const`, which is what all five of this repo's examples do today, against the
 * same handler reading it from `ctx.config`.
 */
const MODULE_CONFIG = Object.freeze({ limits: Object.freeze({ body: '1mb' }) })

{
  const fromModule = buildApp((a) => {
    a.get('/x', markSync(() => ({ limit: MODULE_CONFIG.limits.body })))
  })
  const fromContext = buildApp((a) => {
    a.get('/x', markSync((ctx: never) => ({
      limit: (ctx as { config: { limits: { body: string } } }).config.limits.body,
    })))
  }, { config: defineConfig({ limits: { body: '1mb' } }) })

  await fromModule.ready()
  await fromContext.ready()

  for (const [name, app] of [['module', fromModule], ['context', fromContext]] as const) {
    const res = await app.inject('GET', '/x')
    if (res.status !== 200 || res.text() !== '{"limit":"1mb"}') {
      console.error(`    ::error:: the "${name}" arm answered ${res.status} ${res.text()}, so this section is timing the wrong thing`)
      process.exitCode = 1
    }
  }

  const r = await compare({ app: fromModule, url: '/x' }, { app: fromContext, url: '/x' })
  console.log(`    a module-level const               ${r.a.toFixed(2)} µs`)
  console.log(`    ctx.config.limits.body             ${r.b.toFixed(2)} µs   ${verdict(r.ratio, r.spread)}`)
  console.log(`    (spread ${(r.spread * 100).toFixed(0)}%)`)
  console.log('')
  console.log('    The result is that there is no result, and that is the finding. Both')
  console.log('    are two property loads off a frozen object that V8 has seen a million')
  console.log('    times; the only difference is where the first load starts. A config')
  console.log('    system that cost anything measurable *here* would not be worth having,')
  console.log('    because the thing it replaces costs nothing.')
  console.log('')
  console.log('    What it buys is at boot and in the diagnostics, not in the hot path:')
  console.log('    a missing DATABASE_URL that fails in the first five milliseconds')
  console.log('    instead of on the first request that touches the database, and an')
  console.log('    answer to "where did this value come from" that is not a grep.')
}

// ── 4. boot ─────────────────────────────────────────────────────────────────

console.log('\n  4. Boot cost — the only place any work happens\n')

{
  const envSources = (count: number): readonly EnvSource[] => [{
    layer: 'env',
    name: 'bench',
    entries: Array.from({ length: count }, (_, i) => ({ key: `VAR_${i}`, value: `value-${i}` })),
  }]

  const overlay = (count: number, layer: 'config' | 'override'): ConfigOverlay => {
    const values: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
      values[`ns${i % 8}`] = { ...(values[`ns${i % 8}`] as object ?? {}), [`k${i}`]: `v${i}` }
    }
    return { layer, name: `${layer}-bench`, values }
  }

  const time = (fn: () => void, runs = 2000): number => {
    for (let i = 0; i < 200; i++) fn()
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < runs; i++) fn()
    return Number(process.hrtime.bigint() - t0) / 1e3 / runs
  }

  console.log('    resolution, by environment size (no config tree)')
  for (const count of [0, 16, 64, 256]) {
    const sources = envSources(count)
    const us = time(() => { resolveConfig({ definition: undefined, envSources: sources, overlays: [] }) })
    console.log(`      ${String(count).padStart(3)} variables        ${us.toFixed(2)} µs`)
  }

  console.log('')
  console.log('    resolution, by config size (one layer, then two)')
  for (const count of [8, 32, 128]) {
    const one = [overlay(count, 'config')]
    const two = [overlay(count, 'config'), overlay(count, 'override')]
    const a = time(() => { resolveConfig({ definition: undefined, envSources: [], overlays: one }) })
    const b = time(() => { resolveConfig({ definition: undefined, envSources: [], overlays: two }) })
    console.log(`      ${String(count).padStart(3)} leaves           ${a.toFixed(2)} µs → ${b.toFixed(2)} µs with a second layer`)
  }

  console.log('')
  console.log('    Linear in leaves and in layers, which is what a fold is. The number')
  console.log('    to keep in view is the first row of the first table: an application')
  console.log('    with no configuration pays the framework-defaults fold and nothing')
  console.log('    else, and that is microseconds once, at boot, against a process')
  console.log('    that will live for weeks.')
}

// ── 5. what the freeze costs ────────────────────────────────────────────────

console.log('\n  5. What §16.4\'s deep freeze costs\n')

{
  const build = (count: number): ConfigOverlay => {
    const values: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
      values[`ns${i % 8}`] = { ...(values[`ns${i % 8}`] as object ?? {}), [`k${i}`]: `v${i}` }
    }
    return { layer: 'config', name: 'freeze-bench', values }
  }

  for (const count of [32, 256]) {
    const overlays = [build(count)]
    const t0 = process.hrtime.bigint()
    let last: Readonly<Record<string, unknown>> = {}
    for (let i = 0; i < 2000; i++) {
      last = resolveConfig({ definition: undefined, envSources: [], overlays }).config
    }
    const us = Number(process.hrtime.bigint() - t0) / 1e3 / 2000
    const frozen = Object.isFrozen(last) && Object.isFrozen((last as Record<string, unknown>)['ns0'])
    console.log(`      ${String(count).padStart(3)} leaves   ${us.toFixed(2)} µs total resolution, frozen to the leaves: ${frozen ? 'yes' : 'NO'}`)
    if (!frozen) {
      console.error('\n    ::error:: config was not deeply frozen (§16.4)')
      process.exitCode = 1
    }
  }

  console.log('')
  console.log('    The freeze is inside the resolution number above rather than measured')
  console.log('    apart from it, deliberately: two `compare()`-style numbers taken from')
  console.log('    different runs drift by more than this effect, and a "freeze costs')
  console.log('    0.4 µs" line computed by subtracting two independent measurements')
  console.log('    would be a number with no error bar. What is worth asserting is that')
  console.log('    it happened, and it is asserted rather than timed.')
}

console.log('')
