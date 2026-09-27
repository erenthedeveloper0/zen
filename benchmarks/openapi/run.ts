/**
 * OpenAPI generation cost — rfcs/0001 §29.
 *
 * `node benchmarks/openapi/run.ts`
 *
 * Three questions, because "is it fast?" is the least interesting one:
 *
 *   1. **What does generation cost at boot?** It runs once, so the budget is
 *      generous — but "once" is also once per cold start on a serverless
 *      platform, and a 300 ms document generator would be a real tax there.
 *   2. **What does `$ref` deduplication buy?** Titled schemas become components
 *      referenced from every use; anonymous ones are inlined at each. The gap is
 *      the argument for titling your schemas, in bytes.
 *   3. **What does it cost per request?** This is the claim that matters, and
 *      the answer should be *nothing*: the document is a string built at boot.
 *      Measured against the same app with the plugin removed, and reported as
 *      noise when it is within the run-to-run spread — the same discipline
 *      §28.2 applies to the type-check gate.
 */
import { createApp, type JsonSchema } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { openapiDocument, openapiPlugin } from '@erenthedeveloper0/zen-openapi'

const pathParser = { parse: (path: string) => {
  const parsed = parsePath(path)
  return { path: parsed.path, segments: parsed.segments }
} }

const silent = (() => {
  const noop = () => {}
  const logger = { level: 'fatal' as const, child: () => logger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
  return logger
})()

function standard<T = unknown>(json: JsonSchema) {
  return {
    '~standard': { version: 1 as const, vendor: 'bench', validate: (value: unknown) => ({ value: value as T }) },
    toJsonSchema: () => json,
  }
}

/**
 * Each resource gets a *different* shape.
 *
 * The first version of this fixture gave every resource identical fields, which
 * made the structural-dedup pass collapse all fifty into four components and
 * produced a flattering, meaningless number. Real applications have fifty
 * different resources, so the fixture has to as well.
 */
function resource(index: number, name: string | null): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    id: { type: 'integer' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    meta: { type: 'object', properties: { region: { type: 'string' }, shard: { type: 'integer' } }, required: ['region'] },
  }
  // Distinct fields per resource, so nothing collapses by accident.
  for (let f = 0; f < 4; f++) properties[`field${index}_${f}`] = { type: f % 2 === 0 ? 'string' : 'integer' }
  return {
    ...(name === null ? {} : { title: name }),
    type: 'object',
    properties,
    required: ['id', 'name', 'createdAt'],
  }
}

function listOf(item: JsonSchema, name: string | null): JsonSchema {
  return {
    ...(name === null ? {} : { title: name }),
    type: 'object',
    properties: { items: { type: 'array', items: item }, total: { type: 'integer' } },
    required: ['items', 'total'],
  }
}

/**
 * `titled: false` reproduces the common case where schemas are anonymous object
 * literals, so every operation inlines its own copy.
 */
function buildApp(routeCount: number, titled: boolean, withPlugin: boolean) {
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent })
  if (withPlugin) app.use(openapiPlugin, { title: 'Bench API', version: '1.0.0' })

  const resources = Math.ceil(routeCount / 5)
  for (let r = 0; r < resources; r++) {
    const name = `res${r}`
    const item = standard(resource(r, titled ? `Resource${r}` : null))
    const list = standard(listOf(resource(r, titled ? `Resource${r}` : null), titled ? `Resource${r}List` : null))
    const input = standard({
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    })
    const query = standard({
      type: 'object',
      properties: { limit: { type: 'integer' }, cursor: { type: 'string' } },
    })

    app.collection(`/${name}`, { name, tags: [name] }, (c) => {
      c.get('/', { name: `${name}.list`, query, response: { 200: list } }, () => null as never)
      c.get('/:id<int>', { name: `${name}.show`, response: { 200: item } }, () => null as never)
      c.post('/', { name: `${name}.create`, body: input, response: { 201: item } }, () => null as never)
      c.patch('/:id<int>', { name: `${name}.update`, body: input, response: { 200: item } }, () => null as never)
      c.delete('/:id<int>', { name: `${name}.destroy`, response: { 204: null } }, () => null as never)
    })
  }
  return app
}

const REPS = 5

function bestOf(fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.max(1, Math.min(iterations, 3)); i++) fn()
  let best = Infinity
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) fn()
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6 / iterations)
  }
  return best
}

async function bestOfAsync(fn: () => Promise<unknown>, iterations: number): Promise<{ best: number; spread: number }> {
  for (let i = 0; i < 2000; i++) await fn()
  const runs: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) await fn()
    runs.push(Number(process.hrtime.bigint() - start) / 1e6 / iterations)
  }
  const best = Math.min(...runs)
  return { best, spread: (Math.max(...runs) - best) / best }
}

console.log('\n  OpenAPI generation — rfcs/0001 §29')
console.log('  node ' + process.version + '\n')

// ── 1. generation time ──────────────────────────────────────────────────────

console.log('  Document generation (best of 5)\n')
console.log('    routes   ops   components      time    per route      bytes')

for (const routeCount of [100, 250, 500]) {
  const app = buildApp(routeCount, true, false)
  await app.ready()
  const graph = app.graph()
  const options = { title: 'Bench API', version: '1.0.0' } as const

  const ms = bestOf(() => { openapiDocument(graph, options) }, 20)
  const { document, diagnostics } = openapiDocument(graph, options)
  const operations = Object.values(document.paths).reduce((n, item) => n + Object.keys(item).length, 0)
  const components = Object.keys(document.components?.schemas ?? {}).length
  const bytes = JSON.stringify(document).length

  if (diagnostics.some((d) => d.severity === 'error')) {
    console.error('    generation reported errors: ' + JSON.stringify(diagnostics))
    process.exitCode = 1
  }

  console.log(
    `    ${String(graph.routes.length).padStart(6)}  ${String(operations).padStart(4)}   ` +
    `${String(components).padStart(10)}  ${ms.toFixed(1).padStart(7)} ms  ` +
    `${(ms * 1000 / graph.routes.length).toFixed(0).padStart(7)} µs  ` +
    `${(bytes / 1024).toFixed(0).padStart(8)} kB`,
  )
}

// ── 2. what $ref dedup buys ─────────────────────────────────────────────────

console.log('\n  Effect of $ref deduplication — 250 routes\n')

{
  const options = { title: 'Bench API', version: '1.0.0' } as const
  const titledApp = buildApp(250, true, false)
  const anonymousApp = buildApp(250, false, false)
  await titledApp.ready()
  await anonymousApp.ready()

  const titled = openapiDocument(titledApp.graph(), options)
  const anonymous = openapiDocument(anonymousApp.graph(), options)

  const row = (label: string, bytes: number, components: number | null) =>
    console.log(
      `    ${label.padEnd(34)} ${(bytes / 1024).toFixed(0).padStart(6)} kB   ` +
      (components === null ? '' : `${String(components).padStart(3)} components`),
    )

  // The honest baseline is the same document with every `$ref` expanded in
  // place, which is what a generator with no identity pass would have emitted.
  const flatTitled = JSON.stringify(expandRefs(titled.document)).length
  const withTitles = JSON.stringify(titled.document).length
  const withoutTitles = JSON.stringify(anonymous.document).length

  row('no deduplication (refs expanded)', flatTitled, null)
  row('deduplicated, schemas titled', withTitles, Object.keys(titled.document.components?.schemas ?? {}).length)
  row('deduplicated, schemas anonymous', withoutTitles, Object.keys(anonymous.document.components?.schemas ?? {}).length)

  console.log(
    `\n    Deduplication removes ${(100 - (withTitles / flatTitled) * 100).toFixed(0)}% of the document.` +
    `\n    Titles are worth a further ${(100 - (withTitles / withoutTitles) * 100).toFixed(0)}% here — the identity and structural` +
    '\n    passes already collapse repeated top-level schemas, so what a title adds is' +
    '\n    hoisting *nested* uses and, mainly, a stable type name for generated clients.',
  )
}

/** Inline every `$ref`, so the "no deduplication" baseline is measurable. */
function expandRefs(document: unknown): unknown {
  const schemas = (document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {}
  const walk = (node: unknown, depth: number): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, depth))
    if (typeof node !== 'object' || node === null) return node
    const record = node as Record<string, unknown>
    const ref = record['$ref']
    if (typeof ref === 'string' && depth < 12) {
      const target = schemas[ref.slice('#/components/schemas/'.length)]
      return target === undefined ? {} : walk(target, depth + 1)
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) out[key] = walk(value, depth)
    return out
  }
  const copy = walk(document, 0) as Record<string, unknown>
  delete copy['components']
  return copy
}

// ── 3. per-request cost ─────────────────────────────────────────────────────

console.log('\n  Per-request cost of having the plugin registered — 100 routes\n')

{
  const ITERATIONS = 20_000
  const withPlugin = buildApp(100, true, true)
  const without = buildApp(100, true, false)
  await withPlugin.ready()
  await without.ready()

  const hit = (app: { inject: (m: string, u: string) => Promise<unknown> }) => () => app.inject('GET', '/res0/1')
  const a = await bestOfAsync(hit(without as never), ITERATIONS)
  const b = await bestOfAsync(hit(withPlugin as never), ITERATIONS)

  const delta = (b.best - a.best) / a.best
  const noise = Math.max(a.spread, b.spread)
  console.log(`    without plugin   ${(a.best * 1000).toFixed(2).padStart(7)} µs/req   spread ${(a.spread * 100).toFixed(0)}%`)
  console.log(`    with plugin      ${(b.best * 1000).toFixed(2).padStart(7)} µs/req   spread ${(b.spread * 100).toFixed(0)}%`)
  console.log(
    `    difference       ${(delta * 100).toFixed(1).padStart(7)}%   ` +
    (Math.abs(delta) <= noise ? 'INSIDE NOISE — no measurable per-request cost' : 'ABOVE NOISE — investigate'),
  )

  // The document is built once and served as a pre-encoded string, so a
  // regression here would mean something started running per request.
  if (Math.abs(delta) > Math.max(noise, 0.05)) {
    console.error('\n    ::error:: registering @erenthedeveloper0/zen-openapi changed request cost beyond the measurement noise')
    process.exitCode = 1
  }
}

console.log('')
