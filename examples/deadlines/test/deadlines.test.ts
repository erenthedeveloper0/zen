import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { explainRoute } from '@erenthedeveloper0/zen'
import type { ZenApp } from '@erenthedeveloper0/zen'
import { makeApp } from '../src/app.ts'
import type { DeadlineReport } from '../src/plugins/deadlines.ts'
import { settled, resetUpstreams } from '../src/shared/upstream.ts'
import type { QuoteEnvelope } from '../src/features/quotes/index.ts'

/**
 * The example, tested as an application — rfcs/0001 §20.2, §23.4.
 *
 * Unit tests of a timeout tend to assert "the response arrived quickly", which
 * is also what you observe when the framework stopped waiting and left the work
 * running. So the assertions here are about the things that distinguish those
 * two worlds: whether the *upstream* was cancelled, which stage the deadline
 * blew in, what the caller's own budget did to ours, and what a partial answer
 * looks like on the wire.
 *
 * `inject()` runs the whole pipeline with no sockets, so all of it is in-process
 * and fast — the budgets below are milliseconds, not seconds.
 */

interface Fixture {
  app: ZenApp
  reports: DeadlineReport[]
}

function fixture(): Fixture {
  const reports: DeadlineReport[] = []
  const app = makeApp({ quiet: true, requestTimeout: '400ms', onTimeout: (r) => reports.push(r) })
  return { app, reports }
}

beforeEach(() => { resetUpstreams() })

describe('budgets resolve from the scope chain (§4.4)', () => {
  test('every route reports the budget it will actually use, and where it came from', async () => {
    const { app } = fixture()
    await app.ready()

    const byPath = new Map(app.graph().routes.map((r) => [r.path, r.timeout]))
    assert.deepEqual(byPath.get('/quotes'), { ms: 400, from: 'app' })
    assert.deepEqual(byPath.get('/reports/quarterly'), { ms: 10_000, from: 'root/reports' })
    assert.deepEqual(byPath.get('/reports/status'), { ms: 250, from: 'route' })
    // Streams opt out explicitly; so does the plugin's own summary endpoint.
    assert.equal(byPath.get('/feed/live'), null)
    assert.equal(byPath.get('/deadlines'), null)
  })

  test('the budget is printed with its provenance, which is the surprising half', async () => {
    const { app } = fixture()
    await app.ready()

    const quarterly = app.graph().routes.find((r) => r.path === '/reports/quarterly')
    assert.ok(quarterly !== undefined)
    assert.match(explainRoute(quarterly), /deadline\s+\[root\/reports\]\s+10000 ms budget/)
  })

  test('a route that opted out generates no deadline code', async () => {
    const { app } = fixture()
    await app.ready()

    const units = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
    const live = units.find((u) => u.name.includes('feed'))?.source ?? ''
    const quotes = units.find((u) => u.name.includes('quotes'))?.source ?? ''

    assert.ok(live.length > 0)
    assert.ok(!live.includes('$deadline'), 'timeout: false must cost nothing, not just do nothing')
    assert.ok(quotes.includes('$deadline'))
  })
})

describe('slicing the budget (§4.4)', () => {
  /**
   * The behaviour a timeout cannot produce.
   *
   * Every provider is given the *remaining* budget minus a reserve, so the slow
   * one is cut off at its slice and the request answers with the two that
   * arrived. Handing each provider the whole budget instead is the classic bug:
   * the slowest consumes all of it and the request times out having done every
   * bit of the work.
   */
  test('a slow provider is dropped and the request still answers 200', async () => {
    const { app, reports } = fixture()

    const res = await app.inject('GET', '/quotes')
    const body = res.json<QuoteEnvelope>()

    assert.equal(res.status, 200)
    assert.equal(body.partial, true)
    assert.deepEqual(body.quotes.map((q) => q.provider).sort(), ['fast', 'steady'])
    assert.deepEqual(body.missed, ['slow'])
    assert.deepEqual(reports, [], 'the request never blew its own deadline')
  })

  test('the slow provider was cancelled, not merely stopped waiting for', async () => {
    const { app } = fixture()
    await app.inject('GET', '/quotes')

    const slow = settled.find((c) => c.provider === 'slow')
    assert.ok(slow !== undefined)
    assert.equal(slow.outcome, 'budget')
    // The provider is told about 340ms — 400 minus the 60ms egress reserve —
    // rather than the full request budget. This is the number that makes the
    // difference between answering and timing out.
    assert.ok(slow.grantedMs >= 330 && slow.grantedMs <= 345, `granted ${slow.grantedMs}ms`)
    assert.ok(slow.elapsedMs < 500, `it ran for ${slow.elapsedMs}ms; it should have been cut off`)
  })

  test('when every provider fits, nothing is partial', async () => {
    const { app } = fixture()

    const body = (await app.inject('GET', '/quotes?providers=fast,steady')).json<QuoteEnvelope>()
    assert.equal(body.partial, false)
    assert.deepEqual(body.missed, [])
    assert.equal(body.quotes.length, 2)
  })
})

describe('onTimeout serves what arrived (§9.2 phase 12)', () => {
  /**
   * The route that does *not* slice, so the request itself blows.
   *
   * There is no other point in the lifecycle where this answer can be produced:
   * the handler is suspended on an `await` that will not return, and middleware
   * was left behind three stages ago. A 200 with the quotes that landed beats a
   * 504 with none, and the phase is what makes it reachable.
   */
  test('a blown deadline becomes a degraded 200 rather than a 504', async () => {
    const { app, reports } = fixture()

    const res = await app.inject('GET', '/quotes/best-effort')
    const body = res.json<QuoteEnvelope>()

    assert.equal(res.status, 200)
    assert.equal(res.header('x-degraded'), 'deadline')
    assert.equal(body.partial, true)
    assert.deepEqual(body.quotes.map((q) => q.provider).sort(), ['fast', 'steady'])
    assert.match(body.missed[0] ?? '', /deadline blown during handler/)

    // The route hook answered; the global one still observed. Innermost-first
    // means "first Reply wins", not "the others are skipped" — a reporting hook
    // that stopped seeing timeouts because someone handled them would be worse
    // than useless.
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.stage, 'handler')
    assert.equal(reports[0]?.route, '/quotes/best-effort')
    assert.equal(reports[0]?.budgetMs, 400)
  })

  test('the degraded reply still goes through the response contract (§13.3)', async () => {
    const { app } = fixture()
    const res = await app.inject('GET', '/quotes/best-effort')

    // `x-degraded` was set by the hook, so the reply is the hook's — and the
    // compiled serializer was still bound to it afterwards, which is why the
    // body has exactly the four declared fields and no more.
    assert.deepEqual(Object.keys(res.json<QuoteEnvelope>()).sort(), ['budgetMs', 'missed', 'partial', 'quotes'])
  })

  test('the upstreams were aborted when the request was abandoned', async () => {
    const { app } = fixture()
    await app.inject('GET', '/quotes/best-effort')

    const slow = settled.find((c) => c.provider === 'slow')
    assert.ok(slow !== undefined)
    assert.equal(slow.outcome, 'aborted', 'ctx.signal must reach the driver, or the work outlives the reply')
  })
})

describe('propagation from the caller (§4.4)', () => {
  test('a shorter inbound budget wins', async () => {
    const { app } = fixture()

    // 150ms is under `steady`'s 90ms plus the 60ms reserve, so it drops too.
    const body = (await app.inject('GET', '/quotes', {
      headers: { 'x-request-timeout': '150' },
    })).json<QuoteEnvelope>()

    assert.deepEqual([...body.missed].sort(), ['slow', 'steady'])
    // 150 inbound − 60 reserve = 90, *minus whatever the request has already
    // spent* — `budgetMs` is derived from `ctx.timeLeft`, which is a live clock
    // reading and not a constant. Asserting 90 exactly passed on a warm machine
    // and failed at 89 under load; a fixture meant to land in a window should
    // say so and pin the arithmetic rather than pretend the clock stopped.
    assertBudget(body.budgetMs, 150 - 60)
  })

  test('a longer inbound budget is ignored', async () => {
    const { app } = fixture()

    const body = (await app.inject('GET', '/quotes', {
      headers: { 'x-request-timeout': '600000' },
    })).json<QuoteEnvelope>()

    // Still the route's 400ms minus the reserve. A caller may hurry us; it may
    // not pin a connection open for ten minutes by asking politely.
    assertBudget(body.budgetMs, 400 - 60)
    assert.deepEqual(body.missed, ['slow'])
  })
})

describe('the summary (§10.2)', () => {
  test('reports which routes are bounded and the tightest headroom seen', async () => {
    const { app } = fixture()
    await app.inject('GET', '/quotes?providers=fast')
    await app.inject('GET', '/reports/status')

    const summary = (await app.inject('GET', '/deadlines')).json<{
      bounded: number
      unbounded: number
      routes: Record<string, { budgetMs: number | null; from: string | null; served: number; tightestLeftMs: number | null }>
    }>()

    assert.equal(summary.unbounded, 1, 'only /feed/live is unbounded')
    assert.equal(summary.bounded, 4)
    assert.equal(summary.routes['/reports/status']?.budgetMs, 250)
    assert.equal(summary.routes['/reports/status']?.from, 'route')

    // Headroom is recorded on successful requests, not only on failures. A
    // budget you never come near is untested; one you graze is an incident
    // waiting for a slow Tuesday.
    const left = summary.routes['/quotes']?.tightestLeftMs
    assert.ok(typeof left === 'number' && left > 0 && left < 400, `headroom was ${String(left)}`)
  })

  test('the summary endpoint is not itself bounded', async () => {
    const { app } = fixture()
    await app.ready()
    const route = app.graph().routes.find((r) => r.path === '/deadlines')
    assert.equal(route?.timeout, null, 'the endpoint that reports on budgets must not trip over one')
  })
})

describe('opting out (§4.4)', () => {
  test('a stream declared timeout: false runs to completion', async () => {
    const { app, reports } = fixture()

    const res = await app.inject('GET', '/feed/live')
    assert.equal(res.status, 200)
    assert.deepEqual(reports, [])
    // 5 ticks × 20ms is well past the 400ms budget it would have inherited.
    assert.equal(res.header('x-deadline'), 'none')
  })
})

describe('every route still answers (§4.4)', () => {
  test('no request outlives its budget by more than the epilogue', async () => {
    const { app } = fixture()
    const paths = ['/quotes', '/quotes/best-effort', '/reports/status', '/reports/quarterly', '/deadlines']

    for (const path of paths) {
      const started = Date.now()
      const res = await app.inject('GET', path)
      const elapsed = Date.now() - started
      assert.ok(res.status < 500, `${path} answered ${res.status}`)
      assert.ok(elapsed < 1500, `${path} took ${elapsed}ms`)
    }
  })
})

/**
 * A budget derived from `ctx.timeLeft`: at most the ideal, and close to it.
 *
 * The upper bound is the real assertion — a budget *larger* than the arithmetic
 * allows would mean the deadline was not applied. The tolerance below it is the
 * time the request itself has taken, which is a few hundred microseconds on an
 * idle machine and several milliseconds on a loaded CI runner.
 */
function assertBudget(actual: number, ideal: number, toleranceMs = 15): void {
  assert.ok(
    actual <= ideal && actual >= ideal - toleranceMs,
    `budget ${actual}ms is not within ${toleranceMs}ms below the ideal ${ideal}ms`,
  )
}
