/**
 * What boot pays for origins and for the graph document — rfcs/0001 §5.1, §2.4.
 *
 * `node --expose-gc benchmarks/boot/run.ts`
 *
 * Both features are boot-time work by construction: an origin is read from the
 * stack when something registers, and the document is built when something
 * asks for it. Neither adds a line to a request's pipeline — the generated
 * source the snapshot test holds is unchanged by them — so what there is to
 * measure is what they cost before the first request:
 *
 *   1. **One capture.** Reading the registering line off V8's structured call
 *      sites.
 *   2. **Registration and `ready()`**, per route, at 500, 2,000 and 10,000
 *      routes — the numbers to compare with a build that captures nothing.
 *      Run this file from a checkout of an earlier release for that build: the
 *      sections that need this release's API say so and skip.
 *   3. **The document**: `graphDocument()` at the same sizes — canonical JSON,
 *      every schema converted, and a SHA-256 per route.
 *   4. **Heap after boot** at 10,000 routes, with `--expose-gc`.
 *
 * Best of five runs per size, each in a fresh application.
 */
import { createApp, jsonSchema, type ZenApp } from '@erenthedeveloper0/zen-core'
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

const SIZES = [500, 2000, 10_000] as const
const RUNS = 5

const Item = jsonSchema({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
  required: ['id', 'name'],
})

/** One route per index, each with a response schema, under a collection, with app-wide middleware and a hook. */
function register(app: ZenApp, count: number): void {
  app.use(function authenticate() { return undefined })
  app.hook('onRequest', function rateLimit() { return undefined })
  app.collection('/api', (api) => {
    for (let i = 0; i < count; i++) {
      api.get(`/r${i}/:id<int>`, { name: `r${i}`, response: { 200: Item } }, () => ({ id: 1, name: 'x' }))
    }
  })
}

const ms = (from: bigint, to: bigint): number => Number(to - from) / 1e6

console.log('\n  Boot — what origins and the graph document cost (rfcs/0001 §5.1, §2.4)')
console.log('  node ' + process.version + '\n')

// ── 1. one capture ──────────────────────────────────────────────────────────

type Capture = (mode?: 'call' | 'setup') => unknown
let captureOrigin: Capture | null = null
try {
  // Not part of the public surface, so read from `dist/` directly; absent in a
  // release that captured nothing, where this section is skipped.
  const url = new URL('../../packages/core/dist/primitives/origin.js', import.meta.url).href
  captureOrigin = (await import(url) as { captureOrigin: Capture }).captureOrigin
} catch {
  captureOrigin = null
}

console.log('  1. One capture of the registering line\n')
if (captureOrigin === null) {
  console.log('      skipped — this build records no origins\n')
} else {
  const capture = captureOrigin
  for (let i = 0; i < 2000; i++) capture('call')
  let best = Infinity
  for (let run = 0; run < RUNS; run++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 20_000; i++) capture('call')
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e3 / 20_000)
  }
  // From this file the first frame read is already the application's, so this
  // is one structured read of the eight-frame stack and nothing else. A real
  // registration starts inside the framework and walks a few frames further;
  // what that costs in total is section 2, against a build that reads nothing.
  console.log(`      one capture                 ${best.toFixed(2).padStart(6)} µs`)
  console.log('')
}

// ── 2. registration and ready() ─────────────────────────────────────────────

console.log('  2. Registration and ready(), best of ' + RUNS + '\n')
console.log('      routes    register     per route    ready()      per route')

const booted = new Map<number, ZenApp>()
for (const count of SIZES) {
  let bestRegister = Infinity
  let bestReady = Infinity
  for (let run = 0; run < RUNS; run++) {
    const app = createApp({ router: new ZenRouter(), pathParser, logger: silent })
    const t0 = process.hrtime.bigint()
    register(app, count)
    const t1 = process.hrtime.bigint()
    await app.ready()
    const t2 = process.hrtime.bigint()
    bestRegister = Math.min(bestRegister, ms(t0, t1))
    bestReady = Math.min(bestReady, ms(t1, t2))
    if (run === RUNS - 1) booted.set(count, app)
  }
  console.log(
    `      ${String(count).padStart(6)}  ${bestRegister.toFixed(1).padStart(8)} ms  ${(bestRegister * 1000 / count).toFixed(2).padStart(8)} µs` +
    `  ${bestReady.toFixed(1).padStart(8)} ms  ${(bestReady * 1000 / count).toFixed(2).padStart(8)} µs`,
  )
}
console.log('')

// ── 3. the document ─────────────────────────────────────────────────────────

console.log('  3. graphDocument(), first call, best of ' + RUNS + '\n')
const sample = booted.get(SIZES[0]) as ZenApp & { graphDocument?: () => Promise<{ routes: unknown[] }> }
if (typeof sample.graphDocument !== 'function') {
  console.log('      skipped — this build has no graph document\n')
} else {
  console.log('      routes    document     per route    size')
  for (const count of SIZES) {
    let best = Infinity
    let bytes = 0
    for (let run = 0; run < RUNS; run++) {
      const app = createApp({ router: new ZenRouter(), pathParser, logger: silent })
      register(app, count)
      await app.ready()
      const t0 = process.hrtime.bigint()
      const document = await (app as unknown as { graphDocument(): Promise<unknown> }).graphDocument()
      best = Math.min(best, ms(t0, process.hrtime.bigint()))
      bytes = JSON.stringify(document).length
    }
    console.log(
      `      ${String(count).padStart(6)}  ${best.toFixed(1).padStart(8)} ms  ${(best * 1000 / count).toFixed(1).padStart(8)} µs  ${(bytes / 1024).toFixed(0).padStart(7)} kB`,
    )
  }
  console.log('')
}

// ── 4. heap after boot ──────────────────────────────────────────────────────

console.log('  4. Heap after boot, 10,000 routes\n')
const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) {
  console.log('      skipped — run with node --expose-gc\n')
} else {
  booted.clear()
  gc()
  const before = process.memoryUsage().heapUsed
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent })
  register(app, 10_000)
  await app.ready()
  gc()
  const after = process.memoryUsage().heapUsed
  console.log(`      ${((after - before) / 1024 / 1024).toFixed(1)} MB held by one booted application`)
  console.log('')
  void app
}
