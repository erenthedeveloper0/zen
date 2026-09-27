import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from '../src/app.ts'
import type { Dependencies } from '../src/shared/dependencies.ts'
import type { ZenApp } from '@erenthedeveloper0/zen'

/**
 * The example, under test — rfcs/0001 §20.2, §31.4.
 *
 * `inject()` runs the whole pipeline with no sockets and no ports, so a
 * deployment behaviour that normally needs a cluster to observe — "readiness
 * goes red, liveness stays green, traffic drains" — is an ordinary assertion
 * here. That is the point of testing this at all: the health endpoint is the
 * least-tested part of most services precisely because exercising it seems to
 * require infrastructure.
 */

interface Document {
  status: 'pass' | 'warn' | 'fail'
  state: string
  probe: string
  service: string
  checks: Record<string, { status: string; output?: string; cached: boolean; critical?: boolean }>
}

describe('the health example', () => {
  let app: ZenApp
  let deps: Dependencies

  before(() => {
    // `ttl: 1ms` so each assertion sees a fresh probe. The cache is tested on
    // its own terms below; here it would only make the tests lie about which
    // state they are observing.
    const made = makeApp({ quiet: true, drainDelay: 0, ttl: '1ms' })
    app = made.app
    deps = made.deps
  })

  // Reset centrally rather than at the end of each test. Cleaning up on the
  // last line only works when the test reaches its last line, and the first
  // draft of this file had one assertion fail and take the next two tests with
  // it — a fixture leak masquerading as three bugs.
  beforeEach(() => {
    deps.set('db', 'ok')
    deps.set('cache', 'ok')
    deps.set('payments', 'ok')
  })

  after(async () => { await app.close() })

  const readyz = async (): Promise<{ status: number; body: Document }> => {
    const res = await app.inject('GET', '/readyz')
    return { status: res.status, body: res.json<Document>() }
  }
  const healthz = async (): Promise<{ status: number; body: Document }> => {
    const res = await app.inject('GET', '/healthz')
    return { status: res.status, body: res.json<Document>() }
  }

  test('everything healthy: both endpoints pass, and readiness names the components', async () => {
    const ready = await readyz()
    assert.equal(ready.status, 200)
    assert.equal(ready.body.status, 'pass')
    assert.deepEqual(Object.keys(ready.body.checks).sort(), ['cache', 'db', 'payments'])
    assert.equal(ready.body.service, 'orders')

    const live = await healthz()
    assert.equal(live.status, 200)
    // The whole point of the split: liveness has one check and it is not a
    // dependency. `db` must not appear here.
    assert.deepEqual(Object.keys(live.body.checks), ['event-loop'])
  })

  test('a dead database takes the pod out of the load balancer, not out of the fleet', async () => {
    deps.set('db', 'down')

    const ready = await readyz()
    assert.equal(ready.status, 503)
    assert.equal(ready.body.checks['db']?.status, 'fail')
    // `details: true` in this example's config, because the endpoints are
    // cluster-internal here. The default is to withhold it.
    assert.match(ready.body.checks['db']?.output ?? '', /ECONNREFUSED/)

    // And the half that stops an outage becoming a restart storm.
    assert.equal((await healthz()).status, 200)

    deps.set('db', 'ok')
    assert.equal((await readyz()).status, 200, 'and recovery is visible once the TTL lapses')
  })

  test('a dead cache is a warning: reported, still routed to', async () => {
    deps.set('cache', 'down')

    const ready = await readyz()
    assert.equal(ready.status, 200, 'a cold cache is slower, not broken')
    assert.equal(ready.body.status, 'warn')
    assert.equal(ready.body.checks['cache']?.status, 'fail')
    assert.equal(ready.body.checks['cache']?.critical, false)

  })

  /**
   * The failure that takes down hand-written health endpoints. A dependency
   * that errors is easy; one that never answers is how a probe with no budget
   * of its own becomes an outage — the endpoint stops responding, the
   * orchestrator's probe times out, and it restarts a process that was fine.
   */
  test('a hanging dependency cannot hang the endpoint', async () => {
    deps.set('payments', 'hang')

    const started = Date.now()
    const ready = await readyz()
    const elapsed = Date.now() - started

    assert.equal(ready.status, 503)
    assert.ok(elapsed < 2000, `answered in ${elapsed}ms`)
    assert.match(ready.body.checks['payments']?.output ?? '', /exceeded its 600ms budget/)
    // The other components still answered. One budget over the whole endpoint
    // would have lost these with it.
    assert.equal(ready.body.checks['db']?.status, 'pass')

  })

  test('a slow gateway warns rather than failing', async () => {
    deps.set('payments', 'slow')
    const ready = await readyz()
    assert.equal(ready.status, 200)
    assert.equal(ready.body.checks['payments']?.status, 'warn')
    assert.match(ready.body.checks['payments']?.output ?? '', /degraded/)
  })

  test('the API is ordinary, and is what readiness is gating', async () => {
    const list = await app.inject('GET', '/orders')
    assert.equal(list.status, 200)

    const paid = await app.inject('POST', '/orders/ord_1/pay')
    assert.equal(paid.status, 201)
    assert.equal(paid.json<{ paid: boolean }>().paid, true)
  })

  test('the plugin that owns the gateway also owns its check', async () => {
    const record = app.graph().checks.find((c) => c.name === 'payments')
    assert.equal(record?.source, 'plugin "payments"')
    assert.equal(record?.timeoutMs, 600)
  })

  test('an app-wide request deadline does not bound the health endpoints', async () => {
    const byPath = new Map(app.graph().routes.map((r) => [r.path, r.timeout]))
    assert.deepEqual(byPath.get('/orders'), { ms: 2000, from: 'app' })
    // Refused on purpose: a readiness probe bounded by the service's own
    // request budget fails during exactly the incident it exists to describe.
    assert.equal(byPath.get('/readyz'), null)
    assert.equal(byPath.get('/healthz'), null)
  })
})

describe('the cache, which is what makes the endpoint safe to poll', () => {
  test('polling hard does not multiply load on the dependency', async () => {
    const { app, deps } = makeApp({ quiet: true, drainDelay: 0, ttl: '1s' })
    let probes = 0
    const original = deps.db.query.bind(deps.db)
    deps.db.query = async (signal: AbortSignal) => { probes++; return original(signal) }

    await app.ready()
    await Promise.all(Array.from({ length: 100 }, () => app.inject('GET', '/readyz')))

    assert.equal(probes, 1, `100 simultaneous polls produced ${probes} database round trips`)
    await app.close()
  })
})

describe('shutdown, which is the reason readiness exists', () => {
  /**
   * §4.5 step 1. The service reports itself unready *first* and keeps
   * answering; only then does the socket stop accepting. Skipping that order is
   * the number-one cause of 502s during rolling deploys, and it is invisible
   * without a readiness endpoint to ask.
   */
  test('readiness goes red while the service is still answering', async () => {
    // A real listen and a real drain delay, because the window is what is under
    // test. With `drainDelay: 0` there is no window and the assertions below
    // would be racing the teardown rather than observing the design — which is
    // what the first version of this test did, and it failed for that reason
    // rather than for a reason worth fixing in the framework.
    const { app } = makeApp({ quiet: true, drainDelay: 200 })
    const handle = await app.listen({ port: 0 })
    assert.ok(handle.url.startsWith('http://'))
    assert.equal((await app.inject('GET', '/readyz')).status, 200)

    const started = Date.now()
    const closing = app.close()

    // Inside the drain window: unready, and still answering.
    const duringDrain = await app.inject('GET', '/readyz')
    const liveDuringDrain = await app.inject('GET', '/healthz')

    assert.equal(duringDrain.status, 503)
    assert.equal(duringDrain.json<Document>().state, 'draining')
    assert.equal(liveDuringDrain.status, 200, 'a drain is not a reason to be killed')

    await closing
    assert.ok(
      Date.now() - started >= 190,
      'the socket must not close until the drain delay has elapsed',
    )
  })
})
