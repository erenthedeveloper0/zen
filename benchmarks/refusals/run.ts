/**
 * The cost of refusing a request — rfcs/0001 §28.8, TASKS #5.
 *
 * `node benchmarks/refusals/run.ts`
 *
 * Two features reached the same number from opposite ends: §32.5 measured a
 * 404 at ~10× a served request from behind a preflight, and §13.4.6 a 406 at
 * 13× from behind an `Accept` header. Both traced it to the same place — the
 * `Error` object built for a routine refusal, and the stack it captures. A 404
 * flood is the cheapest hostile traffic there is, and it arrived with a free
 * amplification factor of ten.
 *
 * Four sections, one of them a CI gate:
 *
 *   1. **The gate — structural, not timed.** A refusal the *framework* makes
 *      (404 and 405 from the dispatcher, 406 from negotiation) must carry no
 *      captured stack frames: its stack is always the dispatcher's own, it
 *      names nothing in the application, and capturing it is the cost. An
 *      error the *application* throws must still carry its stack, because that
 *      is the one a developer needs. Asserted on the error objects `onError`
 *      receives, so a later change that starts capturing again fails the build
 *      rather than showing up as a slower number nobody reads.
 *   2. **What a refusal costs**, against the served 200 it would otherwise have
 *      been, in paired comparisons through `inject()` — the same scaffolding on
 *      both arms, so the difference is the refusal.
 *   3. **The mechanism**, isolated: constructing the error with and without a
 *      captured stack, and the cost of the double capture `ZenError` used to do.
 *   4. **What an application-thrown 404 costs.** It keeps its stack, on
 *      purpose, and is printed beside the others so the two are never
 *      confused. It is cheaper than it was only because `ZenError` no longer
 *      captures every stack twice.
 */
import {
  createApp, jsonSchema, registerMediaEncoder, NotFound, withoutStack,
  type Logger, type ZenApp,
} from '@visionpilot/zen-core'
import { ZenRouter, parsePath } from '@visionpilot/zen-router'

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

registerMediaEncoder('text/csv', () => (value) => String(value))

const Payload = jsonSchema<{ ok: boolean }>({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
})

function build(): { app: ZenApp; errors: unknown[] } {
  const errors: unknown[] = []
  const app = createApp({ router: new ZenRouter(), pathParser, logger: silent }) as unknown as ZenApp
  app.hook('onError', (_ctx, error) => { errors.push(error) })
  app.get('/ok', { response: { 200: Payload } }, () => ({ ok: true }))
  app.get('/csv', { response: { 200: { 'application/json': Payload, 'text/csv': Payload } } }, () => ({ ok: true }))
  app.get('/thrown/:id', (ctx) => { throw new NotFound(`User ${String(ctx.params.id)} not found`) })
  return { app, errors }
}

const REPS = 9
const ITERATIONS = 20_000

type Call = () => Promise<unknown>

async function compare(a: Call, b: Call): Promise<{ a: number; b: number }> {
  for (let i = 0; i < 5_000; i++) { await a(); await b() }
  const aTimes: number[] = []
  const bTimes: number[] = []
  for (let rep = 0; rep < REPS; rep++) {
    const pair = rep % 2 === 0 ? [a, b] as const : [b, a] as const
    const times: number[] = []
    for (const arm of pair) {
      const start = performance.now()
      for (let i = 0; i < ITERATIONS; i++) await arm()
      times.push(((performance.now() - start) * 1000) / ITERATIONS)
    }
    const [first, second] = times as [number, number]
    aTimes.push(rep % 2 === 0 ? first : second)
    bTimes.push(rep % 2 === 0 ? second : first)
  }
  return { a: median(aTimes), b: median(bTimes) }
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function frames(error: unknown): number {
  const stack = (error as { stack?: unknown }).stack
  if (typeof stack !== 'string') return 0
  return stack.split('\n').filter((line) => line.trim().startsWith('at ')).length
}

let failures = 0
const fail = (message: string): void => {
  failures++
  console.log(`  ✖ ${message}`)
}

console.log('\n  Refusals — what a 404, 405 and 406 cost (§28.8)\n')

// ── 1. the gate ─────────────────────────────────────────────────────────────
{
  console.log('  1. Framework refusals carry no stack; application errors keep theirs  (gate)\n')
  const { app, errors } = build()
  const cases: Array<[string, string, string, Record<string, string>, boolean]> = [
    ['404 unmatched', 'GET', '/nope', {}, false],
    ['405 wrong method', 'POST', '/ok', {}, false],
    ['406 refused representation', 'GET', '/csv', { accept: 'application/pdf' }, false],
    ['404 thrown by a handler', 'GET', '/thrown/7', {}, true],
  ]
  for (const [label, method, url, headers, keeps] of cases) {
    errors.length = 0
    const res = await app.inject(method, url, { headers })
    const error = errors[0]
    const count = frames(error)
    const ok = keeps ? count > 0 : count === 0
    console.log(`     ${ok ? '✔' : '✖'} ${label.padEnd(30)} ${res.status}  ${count} captured frame${count === 1 ? '' : 's'}`)
    if (!ok) {
      fail(keeps
        ? `${label}: an application error lost its stack — that is the one a developer needs`
        : `${label}: a routine refusal captured ${count} frames of the dispatcher's own stack`)
    }
  }
  console.log('')
}

// ── 2. what a refusal costs ─────────────────────────────────────────────────
{
  console.log(`  2. Against a served 200, per request (paired, median of ${REPS}, ${ITERATIONS.toLocaleString()} iterations)\n`)
  const { app } = build()
  await app.ready()
  const served = () => app.inject('GET', '/ok')
  const arms: Array<[string, Call]> = [
    ['404  unmatched path', () => app.inject('GET', '/nope')],
    ['405  wrong method', () => app.inject('POST', '/ok')],
    ['406  Accept: application/pdf', () => app.inject('GET', '/csv', { headers: { accept: 'application/pdf' } })],
  ]
  for (const [label, arm] of arms) {
    const { a, b } = await compare(served, arm)
    console.log(`     ${label.padEnd(32)} ${b.toFixed(2).padStart(6)} µs   vs 200 at ${a.toFixed(2)} µs   ${(b / a).toFixed(1)}×`)
  }
  console.log('')
}

// ── 3. the mechanism ────────────────────────────────────────────────────────
{
  console.log('  3. Constructing the error, isolated\n')
  const N = 200_000
  const time = (fn: () => unknown): number => {
    for (let i = 0; i < 20_000; i++) fn()
    const samples: number[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const start = performance.now()
      for (let i = 0; i < N; i++) fn()
      samples.push(((performance.now() - start) * 1e6) / N)
    }
    return median(samples)
  }
  const withStack = time(() => new NotFound('No route matches GET /nope'))
  const quiet = time(() => withoutStack(() => new NotFound('No route matches GET /nope')))
  const bare = time(() => new Error('No route matches GET /nope'))
  console.log(`     new NotFound(…), stack captured        ${withStack.toFixed(0).padStart(6)} ns`)
  console.log(`     withoutStack(() => new NotFound(…))    ${quiet.toFixed(0).padStart(6)} ns   ${(withStack / quiet).toFixed(1)}× cheaper`)
  console.log(`     new Error(…), for reference            ${bare.toFixed(0).padStart(6)} ns`)
  console.log('')
}

// ── 4. an application's own 404 ─────────────────────────────────────────────
{
  console.log('  4. A 404 the application throws keeps its stack, and its cost\n')
  const { app } = build()
  await app.ready()
  const { a, b } = await compare(() => app.inject('GET', '/ok'), () => app.inject('GET', '/thrown/7'))
  console.log(`     handler throws NotFound            ${b.toFixed(2).padStart(6)} µs   vs 200 at ${a.toFixed(2)} µs   ${(b / a).toFixed(1)}×`)
  console.log('     its stack is kept — it points at the handler, and is the one a developer reads. It is cheaper')
  console.log('     only by the second capture every ZenError used to make and no longer does.\n')
}

if (failures > 0) {
  console.log(`  ${failures} gate${failures === 1 ? '' : 's'} failed\n`)
  process.exitCode = 1
} else {
  console.log('  all gates passed\n')
}
