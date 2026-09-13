import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, explainRoute, markSync, slot, steps,
  type Reply, type TimeoutInfo,
} from '@zenjs/core'
import { makeApp, uniqueName } from './helpers.ts'

/**
 * Request deadlines — rfcs/0001 §4.4, §9.2 phase 12, §9.7.
 *
 * Four claims, and only the first is the one people expect from a timeout:
 *
 *   1. a request that outlives its budget is **answered anyway**, so a hung
 *      handler cannot hold its connection until the process restarts;
 *   2. the work it was doing **stops at the next stage boundary**, because
 *      answering the client and then spending another thirty seconds querying
 *      Postgres on its behalf is the failure mode this feature exists to close;
 *   3. the remaining budget is a **value** — `ctx.timeLeft` — so a service can
 *      pass a truthful deadline downstream instead of promising each of four
 *      sequential calls the full original timeout;
 *   4. a route that declared no deadline **generates no deadline code**, which
 *      is asserted against the emitted source rather than a stopwatch, for the
 *      same reason §9.4's zero-cost claim is.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const passthrough = {
  '~standard': { version: 1 as const, vendor: 'zen-test', validate: (value: unknown) => ({ value }) },
} as never

// Budgets are deliberately tiny and the sleeps deliberately much longer than
// them: a suite that waits real seconds stops being run.
const BUDGET = 20
const FOREVER = 300

describe('resolution (§4.4, §6.3)', () => {
  test('the app default reaches every route', async () => {
    const app = makeApp({ timeout: '2s' })
    app.get('/a', () => ({ ok: true }))
    app.collection('/api', (api) => api.get('/b', () => ({ ok: true })))
    await app.ready()

    for (const route of app.graph().routes) {
      assert.deepEqual(route.timeout, { ms: 2000, from: 'app' })
    }
  })

  test('the innermost declaration wins outright', async () => {
    const app = makeApp({ timeout: '10s' })
    app.collection('/api', { timeout: '2s' }, (api) => {
      api.get('/inherits', () => ({ ok: true }))
      api.get('/overrides', { timeout: '30s' }, () => ({ ok: true }))
      api.collection('/deep', { timeout: '1s' }, (deep) => {
        deep.get('/x', () => ({ ok: true }))
      })
    })
    app.get('/plain', () => ({ ok: true }))
    await app.ready()

    const byPath = new Map(app.graph().routes.map((r) => [r.path, r.timeout]))
    assert.deepEqual(byPath.get('/plain'), { ms: 10_000, from: 'app' })
    assert.deepEqual(byPath.get('/api/inherits'), { ms: 2000, from: 'root/api' })
    assert.deepEqual(byPath.get('/api/overrides'), { ms: 30_000, from: 'route' })
    assert.deepEqual(byPath.get('/api/deep/x'), { ms: 1000, from: 'root/api/deep' })
  })

  /**
   * The reason `false` exists rather than "omit it".
   *
   * Omitting inherits. A download or long-poll route living under an otherwise
   * bounded collection has to be able to *refuse* the inherited budget, and it
   * should have to say so at the route rather than by being registered
   * somewhere the collection does not reach.
   */
  test('timeout: false refuses an inherited deadline', async () => {
    const app = makeApp({ timeout: '5s' })
    app.collection('/api', { timeout: '2s' }, (api) => {
      api.get('/normal', () => ({ ok: true }))
      api.get('/download', { timeout: false }, () => ({ ok: true }))
    })
    app.collection('/streams', { timeout: false }, (s) => s.get('/live', () => ({ ok: true })))
    await app.ready()

    const byPath = new Map(app.graph().routes.map((r) => [r.path, r.timeout]))
    assert.deepEqual(byPath.get('/api/normal'), { ms: 2000, from: 'root/api' })
    assert.equal(byPath.get('/api/download'), null)
    assert.equal(byPath.get('/streams/live'), null)
  })

  test('a collection may re-arm a deadline the app did not set', async () => {
    const app = makeApp()
    app.get('/free', () => ({ ok: true }))
    app.collection('/api', { timeout: '3s' }, (api) => api.get('/bounded', () => ({ ok: true })))
    await app.ready()

    const byPath = new Map(app.graph().routes.map((r) => [r.path, r.timeout]))
    assert.equal(byPath.get('/free'), null)
    assert.deepEqual(byPath.get('/api/bounded'), { ms: 3000, from: 'root/api' })
  })

  test('an unparseable duration is a boot error naming the scope', async () => {
    const app = makeApp()
    app.collection('/api', { timeout: '2 seconds' as never }, (api) => api.get('/x', () => ({ ok: true })))

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.ok(error.diagnostics.some((d) => d.code === 'ZEN_TIMEOUT_INVALID'))
    assert.match(error.message, /collection "root\/api"/)
    assert.match(error.message, /GET \/api\/x/)
  })

  /**
   * Zero is not `false`.
   *
   * A zero budget is a deadline that has already passed: it would answer 504
   * before the handler ran, every time. Someone writing it means `false`, and
   * guessing which is not the framework's job — §12.7's rule is that a
   * registration that cannot mean what it says is a boot error.
   */
  test('a zero timeout is refused rather than read as "no deadline"', async () => {
    const app = makeApp({ timeout: 0 })
    app.get('/x', () => ({ ok: true }))

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /expires before the handler can run/)
  })
})

describe('cost (§4.4, §9.4)', () => {
  test('a route with no deadline emits no deadline code at all', async () => {
    const app = makeApp({ dev: true })
    app.get('/bare', () => ({ ok: true }))
    await app.ready()

    const source = app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
    assert.ok(source.length > 0, 'expected a generated pipeline')
    assert.ok(!source.includes('$deadline'), `deadline machinery leaked into a route without one:\n${source}`)
    assert.ok(!source.includes('abandoned'))
  })

  test('a sibling route does not inherit deadline code it can never run', async () => {
    const app = makeApp({ dev: true })
    app.collection('/bounded', { timeout: '1s' }, (c) => c.get('/x', () => ({ ok: true })))
    app.get('/plain', () => ({ ok: true }))
    await app.ready()

    const units = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
    const bounded = units.find((u) => u.name.includes('bounded'))?.source ?? ''
    const plain = units.find((u) => u.name.includes('plain'))?.source ?? ''

    assert.ok(bounded.includes('$deadline'))
    assert.ok(!plain.includes('$deadline'))
  })

  test('the stage marks land at the §4.1 boundaries, once each', async () => {
    const app = makeApp({ dev: true, timeout: '1s' })
    app.post('/full', { body: passthrough }, () => ({ ok: true }))
    await app.ready()

    const source = app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
    const marks = [...source.matchAll(/dl\.stage = '(\w+)'/g)].map((m) => m[1])
    assert.deepEqual(marks, ['intake', 'validate', 'handler'])
  })

  test('a route with no body has no intake boundary to check', async () => {
    const app = makeApp({ dev: true, timeout: '1s' })
    app.get('/nobody', () => ({ ok: true }))
    await app.ready()

    const source = app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
    const marks = [...source.matchAll(/dl\.stage = '(\w+)'/g)].map((m) => m[1])
    assert.deepEqual(marks, ['validate', 'handler'], 'a stage the route does not have cannot be checked')
  })

  /**
   * How long the budget is belongs to the dispatcher, not the pipeline.
   *
   * It has to: an inbound header can shorten it per request (§4.4), and the
   * pipeline is compiled once at boot. Baking the number into the generated
   * source would make propagation impossible and would produce one compiled
   * function per distinct duration for no gain.
   */
  test('two routes with different budgets compile to identical source', async () => {
    const app = makeApp({ dev: true })
    app.get('/fast', { timeout: '100ms' }, () => ({ ok: true }))
    app.get('/slow', { timeout: '60s' }, () => ({ ok: true }))
    await app.ready()

    const units = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
    const fast = units.find((u) => u.name.includes('fast'))?.source ?? ''
    const slow = units.find((u) => u.name.includes('slow'))?.source ?? ''
    assert.ok(fast.length > 0)
    assert.equal(fast, slow)
  })
})

describe('the arm (§4.4)', () => {
  test('a handler that outlives its budget is answered anyway', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.get('/hang', async () => { await sleep(FOREVER); return { ok: true } })

    const started = Date.now()
    const res = await app.inject('GET', '/hang')
    const elapsed = Date.now() - started

    assert.equal(res.status, 504)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_TIMEOUT')
    assert.ok(elapsed < FOREVER, `answered after ${elapsed}ms; the budget was ${BUDGET}ms`)
  })

  test('a handler inside its budget is untouched', async () => {
    const app = makeApp({ timeout: '5s' })
    app.get('/quick', async () => { await sleep(1); return { ok: true } })

    const res = await app.inject('GET', '/quick')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { ok: true })
  })

  test('the timeout reply is an ordinary RFC 9457 problem document (§12)', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.get('/hang', async () => { await sleep(FOREVER) })

    const res = await app.inject('GET', '/hang')
    const problem = res.json<Record<string, unknown>>()
    assert.equal(res.header('content-type'), 'application/problem+json; charset=utf-8')
    assert.equal(problem['status'], 504)
    assert.equal(problem['code'], 'ZEN_TIMEOUT')
    assert.equal(problem['instance'], '/hang')
    assert.match(String(problem['title']), /handler stage/)
    // The stage is operational detail. It goes to logs and metrics via `meta`,
    // never into the body — which of our stages was slow is not the caller's
    // business (§12.2).
    assert.ok(!JSON.stringify(problem).includes('elapsedMs'))
  })

  /**
   * 408 and 504 are not interchangeable.
   *
   * Time spent in intake is time spent reading from the client's socket, so a
   * request that dies there is the client being slow — 408 says exactly that,
   * and a retry may well work. Everything after intake is time we spent, and a
   * client retrying immediately will fail the same way: 504. Annex B's
   * "408/504" for `ZEN_TIMEOUT` is this split.
   */
  test('a deadline blown during intake is a 408, not a 504', async () => {
    const app = makeApp({ timeout: BUDGET })
    // A parse hook that never finishes stands in for a client that stopped
    // sending: both are time spent inside stage 6 waiting on the socket.
    app.hook('onParse', async () => { await sleep(FOREVER); return { late: true } })
    app.post('/upload', { body: passthrough }, () => ({ ok: true }))

    const res = await app.inject('POST', '/upload', {
      body: { slowClient: true },
      headers: { 'content-type': 'application/json' },
    })

    assert.equal(res.status, 408)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_TIMEOUT')
    assert.match(res.json<{ title: string }>().title, /intake stage/)
  })

  /**
   * A pipeline that throws before yielding never builds the race, so nothing is
   * listening when the timer rejects. Left unguarded that is an unhandled
   * rejection, which by default takes the process down — a crash caused by the
   * feature that exists to keep the process up.
   */
  test('a synchronous throw plus a slow error hook does not crash the process', async () => {
    const unhandled: unknown[] = []
    const capture = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', capture)

    try {
      const app = makeApp({ timeout: BUDGET })
      app.hook('onError', async () => { await sleep(FOREVER) })
      // `markSync` is load-bearing: without it the handler classifies as
      // `maybe`, the pipeline compiles to an async function, and a throw comes
      // back as a rejected promise that `Promise.race` handles. Only a genuinely
      // synchronous pipeline reaches the catch without the race ever existing.
      app.get('/throws', markSync(() => { throw new Error('immediately') }))

      const res = await app.inject('GET', '/throws')
      assert.equal(res.status, 500)
      await sleep(FOREVER)
      assert.deepEqual(unhandled, [], 'the deadline must not be able to crash the process it protects')
    } finally {
      process.off('unhandledRejection', capture)
    }
  })

  test('the deadline does not fire for a synchronous pipeline', async () => {
    // A pipeline that never yields cannot have its timer run, so §8.4's sync
    // fast path is un-timeoutable by construction — and also incapable of
    // hanging, which is why that is fine rather than a hole.
    const app = makeApp({ timeout: 1 })
    app.get('/sync', () => ({ ok: true }))

    const res = await app.inject('GET', '/sync')
    assert.equal(res.status, 200)
  })
})

describe('onTimeout (§9.2 phase 12)', () => {
  test('fires with the stage, the budget and the elapsed time', async () => {
    const seen: TimeoutInfo[] = []
    const app = makeApp({ timeout: BUDGET })
    app.hook('onTimeout', (_ctx, info) => { seen.push(info) })
    app.get('/hang', async () => { await sleep(FOREVER) })

    await app.inject('GET', '/hang')

    assert.equal(seen.length, 1)
    const info = seen[0] as TimeoutInfo
    assert.equal(info.stage, 'handler')
    assert.equal(info.budgetMs, BUDGET)
    assert.equal(info.route, '/hang')
    assert.ok(info.elapsedMs >= BUDGET, `elapsed ${info.elapsedMs} should be at least the budget`)
  })

  test('a hook may answer the request itself', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.hook('onTimeout', (ctx, info) =>
      ctx.json({ servedFrom: 'cache', missedBy: info.stage }, { status: 200 }))
    app.get('/hang', async () => { await sleep(FOREVER) })

    const res = await app.inject('GET', '/hang')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { servedFrom: 'cache', missedBy: 'handler' })
  })

  /**
   * The one place `onTimeout` deliberately differs from `onError`.
   *
   * `onError` ends its chain at the first `Reply` — `catch` semantics, and the
   * intuition everybody already has. `onTimeout` does not: every hook runs and
   * only the *first* `Reply` is used. Under `catch` semantics a global timeout
   * counter would go silent the moment any route started degrading gracefully,
   * reading zero on exactly the routes that handled their deadlines best, and
   * looking correct until someone added a route hook. That is the failure §9.7
   * refuses to allow when a phase can never fire; a phase that *stops* firing
   * is the same failure with a longer fuse.
   */
  test('innermost answers first, but every hook still observes', async () => {
    const order: string[] = []
    const app = makeApp({ timeout: BUDGET })

    app.hook('onTimeout', (_ctx: unknown, info: TimeoutInfo) => { order.push(`global:${info.stage}`) })
    app.collection('/api', (api) => {
      api.hook('onTimeout', () => { order.push('collection-observer') })
      api.get('/hang', {
        hooks: {
          onTimeout: (ctx) => {
            order.push('route')
            return ctx.json({ degraded: true }, { status: 503 })
          },
        },
      }, async () => { await sleep(FOREVER) })
    })

    const res = await app.inject('GET', '/api/hang')
    assert.equal(res.status, 503, 'the innermost hook answered')
    assert.deepEqual(order, ['route', 'collection-observer', 'global:handler'])
  })

  test('a later Reply cannot override the one that already won', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.hook('onTimeout', (ctx: { json(v: unknown, i?: unknown): Reply }) =>
      ctx.json({ from: 'global' }, { status: 500 }))
    app.get('/hang', {
      hooks: {
        onTimeout: (ctx) => ctx.json({ from: 'route' }, { status: 503 }),
      },
    }, async () => { await sleep(FOREVER) })

    const res = await app.inject('GET', '/hang')
    assert.equal(res.status, 503)
    assert.deepEqual(res.json(), { from: 'route' })
  })

  test('a hook that throws is logged, and the deadline still stands', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.hook('onTimeout', () => { throw new Error('the reporter is broken too') })
    app.get('/hang', async () => { await sleep(FOREVER) })

    const res = await app.inject('GET', '/hang')
    assert.equal(res.status, 504)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_TIMEOUT')
  })

  /**
   * A timeout is not a special case that skips half the error machinery.
   *
   * That is how services end up with timeouts no dashboard counts: the timeout
   * path writes its own response and never touches the error engine, so error
   * mappers, `onError` hooks and the problem envelope all miss it.
   */
  test('an unanswered deadline takes the ordinary error path', async () => {
    const seen: string[] = []
    const app = makeApp({ timeout: BUDGET })
    app.hook('onTimeout', () => { seen.push('onTimeout') })
    app.hook('onError', (_ctx, error) => { seen.push(`onError:${(error as { code: string }).code}`) })
    app.hook('onSend', (_ctx: unknown, reply: Reply) => {
      seen.push('onSend')
      reply.headers.set('x-timed-out', '1')
    })
    app.get('/hang', async () => { await sleep(FOREVER) })

    const res = await app.inject('GET', '/hang')
    assert.equal(res.header('x-timed-out'), '1')
    assert.deepEqual(seen, ['onTimeout', 'onError:ZEN_TIMEOUT', 'onSend'])
  })

  test('onSend still stamps a reply an onTimeout hook produced', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.hook('onTimeout', (ctx: { json(v: unknown, i?: unknown): Reply }) =>
      ctx.json({ degraded: true }, { status: 503 }))
    app.hook('onSend', (_ctx: unknown, reply: Reply) => { reply.headers.set('x-stamped', 'yes') })
    app.get('/hang', async () => { await sleep(FOREVER) })

    const res = await app.inject('GET', '/hang')
    assert.equal(res.status, 503)
    assert.equal(res.header('x-stamped'), 'yes')
  })
})

describe('settle (§4.4, stage 10)', () => {
  test('onResponse sees timedOut, and it decomposes with aborted', async () => {
    const seen: Array<{ status: number; aborted: boolean; timedOut: boolean }> = []
    const app = makeApp({ timeout: BUDGET })
    app.hook('onResponse', (ctx, reply) => {
      seen.push({ status: reply.status, aborted: ctx.aborted, timedOut: ctx.timedOut })
    })
    app.get('/hang', async () => { await sleep(FOREVER) })
    app.get('/fine', () => ({ ok: true }))

    await app.inject('GET', '/hang')
    await app.inject('GET', '/fine')

    assert.deepEqual(seen, [
      // A blown deadline is an abort *and* a timeout; the pair is what lets a
      // metrics hook tell "we were slow" from "the client left".
      { status: 504, aborted: true, timedOut: true },
      { status: 200, aborted: false, timedOut: false },
    ])
  })

  test('request-scoped slots are disposed on the timeout path', async () => {
    const disposed: string[] = []
    const Conn = slot<string>(uniqueName('timeout.conn'), { dispose: (v) => { disposed.push(v) } })

    const app = makeApp({ timeout: BUDGET })
    app.hook('onRequest', (ctx) => { ctx.set(Conn, 'pooled-connection') })
    app.get('/hang', async () => { await sleep(FOREVER) })

    await app.inject('GET', '/hang')
    assert.deepEqual(disposed, ['pooled-connection'], 'a timed-out request must still release what it took')
  })
})

describe('cancellation (§4.4)', () => {
  test('ctx.signal aborts when the deadline blows, before the client is answered', async () => {
    let reason: unknown
    const app = makeApp({ timeout: BUDGET })
    app.get('/hang', async (ctx) => {
      // This is the listener a driver or `fetch` registers. It has to fire
      // *before* the 504 goes out, or the request we just gave up on keeps
      // paying for work — which is the hole §4.4 exists to close.
      ctx.signal.addEventListener('abort', () => { reason = ctx.signal.reason })
      await sleep(FOREVER)
      return { ok: true }
    })

    const res = await app.inject('GET', '/hang')
    assert.equal(res.status, 504)
    assert.equal((reason as { code?: string } | undefined)?.code, 'ZEN_TIMEOUT')
  })

  /**
   * The half of the feature a `Promise.race` alone does not buy.
   *
   * The arm answers the client. It cannot stop the work — you cannot interrupt
   * a running `await`. So the compiled pipeline checks at each stage boundary
   * and stops there, which is why "we replied 504 and then queried Postgres for
   * another thirty seconds on that request's behalf" does not happen here.
   */
  test('the pipeline stops at the next stage boundary once the deadline is blown', async () => {
    const ran: string[] = []
    const app = makeApp({ timeout: BUDGET })
    app.use(async () => { ran.push('middleware'); await sleep(FOREVER) })
    app.get('/late', { hooks: { preHandler: () => { ran.push('preHandler') } } }, () => {
      ran.push('handler')
      return { ok: true }
    })

    const res = await app.inject('GET', '/late')
    assert.equal(res.status, 504)

    await sleep(FOREVER)
    assert.deepEqual(ran, ['middleware'], 'work continued past the boundary after the request was answered')
  })

  test('a client that disconnects is answered 499 and never reaches the handler', async () => {
    const ran: string[] = []
    const client = new AbortController()

    const app = makeApp({ timeout: '5s' })
    app.use(async (ctx) => {
      ran.push('middleware')
      client.abort()                 // the browser hit stop
      await sleep(1)
      assert.equal(ctx.signal.aborted, true, 'a disconnect must reach the composed signal too')
    })
    app.get('/gone', () => { ran.push('handler'); return { ok: true } })

    const res = await app.inject('GET', '/gone', { signal: client.signal })
    assert.equal(res.status, 499, 'nginx 499 — there is no client left to receive a status, only to count')
    assert.deepEqual(ran, ['middleware'])
  })

  /**
   * Stopping early on a disconnect is something a deadline buys you.
   *
   * The stage checks are emitted for routes that declared a timeout and for no
   * others, so a route with no deadline runs to completion for a client that
   * has already gone. That is the zero-cost rule applied consistently rather
   * than an oversight — but it is worth knowing, and it is one more reason to
   * set a default budget.
   */
  test('a route with no deadline runs to completion for a client that left', async () => {
    const ran: string[] = []
    const client = new AbortController()

    const app = makeApp()
    app.use(async () => { ran.push('middleware'); client.abort(); await sleep(1) })
    app.get('/gone', () => { ran.push('handler'); return { ok: true } })

    const res = await app.inject('GET', '/gone', { signal: client.signal })
    assert.equal(res.status, 200)
    assert.deepEqual(ran, ['middleware', 'handler'])
  })
})

describe('deadline propagation (§4.4)', () => {
  test('timeLeft is Infinity without a deadline and counts down with one', async () => {
    const observed: Array<{ left: number; at: number | null }> = []
    const app = makeApp()
    const record = (ctx: { timeLeft: number; deadline: number | null }) => {
      observed.push({ left: ctx.timeLeft, at: ctx.deadline })
      return { ok: true }
    }
    app.get('/free', record)
    app.get('/bounded', { timeout: '5s' }, record)
    await app.ready()

    await app.inject('GET', '/free')
    await app.inject('GET', '/bounded')

    assert.equal(observed[0]?.left, Infinity)
    assert.equal(observed[0]?.at, null)
    assert.ok((observed[1]?.left ?? 0) > 4000 && (observed[1]?.left ?? 0) <= 5000)
    assert.equal(typeof observed[1]?.at, 'number')
  })

  test('an inbound header shortens the budget', async () => {
    let budget = 0
    const app = makeApp({ timeout: { default: '30s', header: 'x-request-timeout' } })
    app.get('/x', (ctx) => { budget = Math.round(ctx.timeLeft / 100) * 100; return { ok: true } })

    await app.inject('GET', '/x', { headers: { 'x-request-timeout': '2000' } })
    assert.equal(budget, 2000)
  })

  /**
   * The clamp is one-way, and it is the security half of the feature.
   *
   * Honouring a shorter inbound budget is cooperative: the caller has already
   * given up, and finishing the work would be waste. Honouring a *longer* one
   * hands any client the ability to pin a connection for as long as it likes,
   * which is the same primitive as slowloris with a friendlier header name.
   */
  test('an inbound header can never lengthen it', async () => {
    let budget = 0
    const app = makeApp({ timeout: { default: '2s', header: 'x-request-timeout' } })
    app.get('/x', (ctx) => { budget = Math.round(ctx.timeLeft / 100) * 100; return { ok: true } })

    await app.inject('GET', '/x', { headers: { 'x-request-timeout': '3600000' } })
    assert.equal(budget, 2000)
  })

  test('a nonsense header is ignored rather than failing the request', async () => {
    let budget = 0
    const app = makeApp({ timeout: { default: '2s', header: 'x-request-timeout' } })
    app.get('/x', (ctx) => { budget = Math.round(ctx.timeLeft / 100) * 100; return { ok: true } })

    for (const value of ['soon', '-5', '0', '']) {
      await app.inject('GET', '/x', { headers: { 'x-request-timeout': value } })
      assert.equal(budget, 2000, `header ${JSON.stringify(value)} should have been ignored`)
    }
  })

  test('the header is not read unless it was configured', async () => {
    let budget = 0
    const app = makeApp({ timeout: '2s' })
    app.get('/x', (ctx) => { budget = Math.round(ctx.timeLeft / 100) * 100; return { ok: true } })

    await app.inject('GET', '/x', { headers: { 'x-request-timeout': '50' } })
    assert.equal(budget, 2000, 'trusting a request header must be a decision, not a default')
  })
})

describe('unmatched requests (§9.2)', () => {
  /**
   * A 404 has no route and therefore no route deadline — but it does run the
   * global `onRequest` hooks, which is where rate limiting lives. A rate
   * limiter blocking on a store it cannot reach would otherwise hold the
   * connection of a request for a path that does not even exist.
   */
  test('the app default bounds requests that matched nothing', async () => {
    const app = makeApp({ timeout: BUDGET })
    app.hook('onRequest', async (ctx) => {
      if (ctx.path === '/nope') await sleep(FOREVER)
    })
    app.get('/exists', () => ({ ok: true }))

    const res = await app.inject('GET', '/nope')
    assert.equal(res.status, 504)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_TIMEOUT')
  })
})

describe('the interpreted twin (§8.4, I6)', () => {
  test('simple pipeline: same status, same stage, same hooks', async () => {
    for (const mode of ['optimized', 'simple'] as const) {
      const seen: TimeoutInfo[] = []
      const app = makeApp({ timeout: BUDGET, pipeline: mode })
      app.hook('onTimeout', (_ctx, info) => { seen.push(info) })
      app.get('/hang', async () => { await sleep(FOREVER) })

      const res = await app.inject('GET', '/hang')
      assert.equal(res.status, 504, `${mode}: wrong status`)
      assert.equal(seen[0]?.stage, 'handler', `${mode}: wrong stage`)
    }
  })

  test('simple pipeline: the stage checks stop the work too', async () => {
    const ran: string[] = []
    const app = makeApp({ timeout: BUDGET, pipeline: 'simple' })
    app.use(async () => { ran.push('middleware'); await sleep(FOREVER) })
    app.get('/late', () => { ran.push('handler'); return { ok: true } })

    await app.inject('GET', '/late')
    await sleep(FOREVER)
    assert.deepEqual(ran, ['middleware'])
  })
})

describe('explainRoute (§8.5)', () => {
  test('the deadline is printed with the scope that declared it', async () => {
    const app = makeApp({ timeout: '30s' })
    app.collection('/api', { timeout: '2s' }, (api) => {
      api.hook('onTimeout', function reportSlow() {})
      api.get('/report', { name: 'reports.get' }, function buildReport() { return { ok: true } })
    })
    await app.ready()

    const record = app.graph().routes[0]
    assert.ok(record !== undefined)
    const rows = steps(record)

    assert.deepEqual(rows[0], {
      kind: 'deadline',
      scope: '[root/api]',
      name: '2000 ms budget, checked at each stage boundary',
    })
    assert.ok(rows.some((s) => s.kind === 'onTimeout' && s.name === 'reportSlow'))
    assert.match(explainRoute(record), /deadline\s+\[root\/api\]\s+2000 ms budget/)
  })

  test('a route with no deadline says nothing about one', async () => {
    const app = makeApp()
    app.get('/plain', () => ({ ok: true }))
    await app.ready()

    const record = app.graph().routes[0]
    assert.ok(record !== undefined)
    assert.ok(!steps(record).some((s) => s.kind === 'deadline'))
  })
})
