import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, HealthRegistry, healthPlugin, definePlugin, token,
  type HealthReport, type Plugin,
} from '@visionpilot/zen-core'
import { makeApp } from './helpers.ts'

/**
 * Health and readiness — rfcs/0001 §31.4, §4.5.
 *
 * The endpoints are trivial. What is under test here is everything that is not
 * the endpoint, because a `/healthz` that returns `{ ok: true }` is a route,
 * not a feature:
 *
 *   1. **The two probes answer different questions.** Readiness follows the
 *      lifecycle *and* the dependencies; liveness follows neither, and a check
 *      only reaches it by saying so. Both directions of the confusion are
 *      tested, because both cause outages and the second one causes the worse
 *      kind: a liveness probe that watches a database turns a database blip
 *      into a fleet-wide restart storm.
 *   2. **A probe cannot hang the endpoint.** Each check carries its own budget,
 *      and a slow one must not hide a fast one's answer.
 *   3. **N probes cost one round trip.** The orchestrator, the load balancer
 *      and the scraper all poll at once, and the naive implementation opens a
 *      connection per poll to the component least able to absorb it.
 *   4. **Draining is visible before the socket closes.** That ordering is the
 *      entire reason the feature exists (§4.5 step 1) and it is the one thing a
 *      unit test of a `Promise.all` would never look at.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const ok = () => {}

// ─────────────────────────────────────────────────────────────────────────────

describe('registration (§31.4, §12.7)', () => {
  test('a duplicate name is a boot error naming both owners', async () => {
    const contributor: Plugin<void, {}> = definePlugin<void, {}>({
      name: 'cache-plugin',
      version: '1.0.0',
      setup(app) { app.health('cache', ok) },
    })

    const app = makeApp()
    app.use(contributor)
    app.health('cache', ok)

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.ok(error.diagnostics.some((d) => d.code === 'ZEN_HEALTH_CHECK_DUPLICATE'))
    // Both, not just the loser: the point of the error is that a reader can
    // find the two registrations, and naming one of them makes them hunt.
    assert.match(error.message, /plugin "cache-plugin"/)
    assert.match(error.message, /app/)
  })

  test('an unusable name, a non-function probe and a bad duration are all refused', async () => {
    const app = makeApp()
    app.health('', ok)
    app.health('has space', ok)
    app.health('notafn', 'select 1' as never)
    app.health('bad-ttl', ok, { timeout: '2 seconds' as never })
    app.health('zero', ok, { timeout: 0 })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const invalid = error.diagnostics.filter((d) => d.code === 'ZEN_HEALTH_CHECK_INVALID')
    // All five at once. A developer wiring up health checks typically has
    // several problems in one sitting, and a fail-fast framework turns that
    // into five restarts (§12.7).
    assert.equal(invalid.length, 5)
  })

  test('the resolved checks are on the frozen graph', async () => {
    const app = makeApp()
    app.health('db', ok, { description: 'primary postgres', timeout: '250ms' })
    app.health('loop', ok, { kind: 'liveness', critical: false })
    await app.ready()

    const byName = new Map(app.graph().checks.map((c) => [c.name, c]))
    assert.deepEqual(
      { ...byName.get('db'), probe: null },
      {
        name: 'db', probe: null, kind: 'readiness', timeoutMs: 250, ttlMs: 1000,
        critical: true, description: 'primary postgres', source: 'app',
      },
    )
    assert.equal(byName.get('loop')?.kind, 'liveness')
    assert.equal(byName.get('loop')?.critical, false)
  })

  test('registering a check after boot is refused like any other registration', async () => {
    const app = makeApp()
    await app.ready()
    assert.throws(() => app.health('late', ok), /frozen/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('liveness is not readiness (§31.4)', () => {
  /**
   * The failure this default prevents.
   *
   * A liveness probe that checks the database says "restart me" when the
   * database is down. Every pod says it at once, the orchestrator obliges, and
   * the fleet spends the outage crash-looping instead of waiting — which also
   * guarantees the connection pools never get the chance to reconnect. It is
   * the single most expensive health-check mistake, and it is one word in a
   * YAML file away at all times, so the default has to be the safe one.
   */
  test('a readiness check does not run on the liveness probe', async () => {
    let ran = 0
    const app = makeApp()
    app.health('db', () => { ran++ })
    await app.ready()

    const live = await app.probe('liveness')
    assert.equal(live.status, 'pass')
    assert.equal(live.checks.length, 0)
    assert.equal(ran, 0, 'liveness must not touch a dependency')

    const ready = await app.probe('readiness')
    assert.equal(ready.checks.length, 1)
    assert.equal(ran, 1)
  })

  test('a liveness check does not run on the readiness probe either', async () => {
    let ran = 0
    const app = makeApp()
    app.health('loop', () => { ran++ }, { kind: 'liveness' })
    await app.ready()

    await app.probe('readiness')
    assert.equal(ran, 0)
    await app.probe('liveness')
    assert.equal(ran, 1)
  })

  /**
   * The mirror-image failure, and the reason liveness passes while `starting`:
   * a service that takes 40 seconds to warm a cache must not be killed at 30
   * for failing liveness. It is simply not ready yet, which is a different
   * sentence with a different remedy.
   */
  test('before ready(): liveness passes, readiness fails', async () => {
    const app = makeApp()
    app.health('db', ok)

    assert.equal(app.state, 'starting')
    assert.equal((await app.probe('liveness')).status, 'pass')

    const ready = await app.probe('readiness')
    assert.equal(ready.status, 'fail')
    assert.equal(ready.state, 'starting')

    await app.ready()
    assert.equal((await app.probe('readiness')).status, 'pass')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('aggregation (§31.4)', () => {
  const build = async (checks: Array<[string, () => unknown, { critical?: boolean }?]>) => {
    const app = makeApp()
    for (const [name, probe, opts] of checks) app.health(name, probe as never, opts)
    await app.ready()
    return app
  }

  test('one critical failure fails the whole report', async () => {
    const app = await build([['a', ok], ['b', () => 'fail' as const]])
    const report = await app.probe('readiness')
    assert.equal(report.status, 'fail')
  })

  test('a warn is a warn, not a failure — it stays in the load balancer', async () => {
    const app = await build([['a', ok], ['b', () => 'warn' as const]])
    assert.equal((await app.probe('readiness')).status, 'warn')
  })

  /**
   * `critical: false` is what makes a health endpoint describe a service rather
   * than gate it. Without it every check is load-bearing, so people stop adding
   * checks, and the endpoint stops being worth reading.
   */
  test('a non-critical failure degrades the summary but is reported honestly', async () => {
    const app = await build([['db', ok], ['recommendations', () => false, { critical: false }]])
    const report = await app.probe('readiness')

    assert.equal(report.status, 'warn')
    const row = report.checks.find((c) => c.name === 'recommendations')
    // The component says `fail`, because that is what happened. Rewriting the
    // row to `warn` would make the report lie about what it saw in order to
    // make the summary come out green.
    assert.equal(row?.status, 'fail')
    assert.equal(row?.critical, false)
  })

  test('every probe return shape is understood', async () => {
    const app = await build([
      ['void', () => undefined],
      ['true', () => true],
      ['false', () => false],
      ['status', () => 'warn' as const],
      ['outcome', () => ({ status: 'pass' as const, message: 'lag 4ms', data: { lag: 4 } })],
    ])
    const byName = new Map((await app.probe('readiness')).checks.map((c) => [c.name, c]))

    assert.equal(byName.get('void')?.status, 'pass')
    assert.equal(byName.get('true')?.status, 'pass')
    assert.equal(byName.get('false')?.status, 'fail')
    assert.equal(byName.get('status')?.status, 'warn')
    assert.equal(byName.get('outcome')?.message, 'lag 4ms')
    assert.deepEqual(byName.get('outcome')?.data, { lag: 4 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('what a thrown error is allowed to say (§13.3, §19)', () => {
  test('by default the text is withheld and the check still fails', async () => {
    const app = makeApp()
    app.health('db', () => { throw new Error('getaddrinfo ENOTFOUND db-primary.internal') })
    await app.ready()

    const row = (await app.probe('readiness')).checks[0]
    assert.equal(row?.status, 'fail')
    assert.equal(row?.message, 'check failed')
  })

  test('details: true opts in, because sometimes the endpoint is genuinely internal', async () => {
    const app = makeApp({ health: { details: true } })
    app.health('db', () => { throw new Error('ENOTFOUND db-primary.internal') })
    await app.ready()

    assert.match((await app.probe('readiness')).checks[0]?.message ?? '', /db-primary\.internal/)
  })

  /**
   * The distinction is the same one §13.3 makes about response fields: what you
   * declared may ship, what you did not may not. A message the probe *returned*
   * was chosen by its author; a driver's exception was not.
   */
  test('a returned message is always reported, details or not', async () => {
    const app = makeApp()
    app.health('db', () => ({ status: 'fail' as const, message: 'pool exhausted (20/20)' }))
    await app.ready()

    assert.equal((await app.probe('readiness')).checks[0]?.message, 'pool exhausted (20/20)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('each probe carries its own budget (§4.4, §31.4)', () => {
  test('a hanging check fails on time and does not hide a fast sibling', async () => {
    const app = makeApp()
    app.health('fast', () => ({ status: 'pass' as const }))
    app.health('wedged', () => new Promise<void>(() => {}), { timeout: 40 })
    await app.ready()

    const started = Date.now()
    const report = await app.probe('readiness')
    const elapsed = Date.now() - started

    assert.ok(elapsed < 1000, `endpoint answered in ${elapsed}ms`)
    assert.equal(report.status, 'fail')

    const byName = new Map(report.checks.map((c) => [c.name, c]))
    // The whole argument for per-check budgets rather than one over the
    // endpoint: the report names the culprit, and the healthy component is
    // still reported as healthy instead of being lost with it.
    assert.equal(byName.get('fast')?.status, 'pass')
    assert.equal(byName.get('wedged')?.status, 'fail')
    assert.match(byName.get('wedged')?.message ?? '', /exceeded its 40ms budget/)
  })

  test('the probe receives a signal that aborts when its budget blows', async () => {
    let aborted = false
    const app = makeApp()
    app.health('slow', async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
      })
    }, { timeout: 30 })
    await app.ready()

    await app.probe('readiness')
    await sleep(10)
    // Not decorative. A probe abandoned rather than cancelled keeps a
    // connection open against a dependency that is already in trouble.
    assert.equal(aborted, true)
  })

  test('a probe that outlives its budget cannot overwrite the failure it caused', async () => {
    const app = makeApp()
    app.health('late', async () => { await sleep(60); return 'pass' as const }, { timeout: 20, ttl: 1 })
    await app.ready()

    assert.equal((await app.probe('readiness')).checks[0]?.status, 'fail')
    await sleep(80)
    // The late `pass` resolved into a race nobody is listening to any more. If
    // it had reached the cache the endpoint would report a component healthy on
    // the strength of an answer that arrived after it was declared dead.
    assert.equal((await app.probe('readiness')).checks[0]?.status, 'fail')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the cache, and the stampede it prevents (§31.4)', () => {
  test('a result is reused for its TTL and says so', async () => {
    let ran = 0
    const app = makeApp()
    app.health('db', () => { ran++ }, { ttl: '5s' })
    await app.ready()

    const first = await app.probe('readiness')
    const second = await app.probe('readiness')

    assert.equal(ran, 1)
    assert.equal(first.checks[0]?.cached, false)
    // Reported rather than hidden: a cached `pass` and a fresh `pass` are
    // different claims, and an operator reading a dashboard mid-incident is
    // entitled to know which one is on the screen.
    assert.equal(second.checks[0]?.cached, true)
  })

  test('the TTL expires', async () => {
    let ran = 0
    const app = makeApp()
    app.health('db', () => { ran++ }, { ttl: 20 })
    await app.ready()

    await app.probe('readiness')
    await sleep(40)
    await app.probe('readiness')
    assert.equal(ran, 2)
  })

  test('200 concurrent probes cost one round trip', async () => {
    let inflight = 0
    let peak = 0
    let total = 0

    const app = makeApp()
    app.health('db', async () => {
      total++
      inflight++
      peak = Math.max(peak, inflight)
      await sleep(20)
      inflight--
    }, { ttl: 1 })
    await app.ready()

    await Promise.all(Array.from({ length: 200 }, () => app.probe('readiness')))

    assert.equal(total, 1, `the dependency saw ${total} probes`)
    assert.equal(peak, 1)
  })

  /**
   * A failure is cached for the same TTL as a success, and that is a decision
   * rather than an oversight: re-probing on every request while a dependency is
   * down aims the full scrape rate at the component least able to absorb it, at
   * the exact moment it is least able to. The cost is that a recovery is
   * visible up to one TTL late, which at the default of one second is fine.
   */
  test('a failure is cached too, and recovery is visible one TTL later', async () => {
    let broken = true
    const app = makeApp()
    app.health('db', () => (broken ? 'fail' as const : 'pass' as const), { ttl: 20 })
    await app.ready()

    assert.equal((await app.probe('readiness')).status, 'fail')
    broken = false
    assert.equal((await app.probe('readiness')).status, 'fail', 'still cached')
    await sleep(40)
    assert.equal((await app.probe('readiness')).status, 'pass')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('shutdown ordering (§4.5)', () => {
  /**
   * §4.5 step 1 says: flip the health endpoint to `draining` **then** wait,
   * **then** stop accepting. The implementation used to run that sequence
   * inverted — hooks, disposal, and only then the drain window — so the
   * connection pools were already closed during the period in which the load
   * balancer is still sending traffic. Nothing failed visibly because the drain
   * delay defaults to zero; the bug only opened once somebody configured the
   * delay the documentation tells them to.
   *
   * This test is the reason it was found. "Readiness reports draining before
   * the server stops accepting" is not a checkable sentence until something can
   * be asked, which is what having a readiness endpoint at all buys.
   */
  test('readiness fails before the server stops accepting, and liveness does not', async () => {
    const order: string[] = []
    let duringClose: HealthReport | null = null

    const app = makeApp({
      adapter: {
        name: 'recording',
        caps: { eval: true } as never,
        listen: async () => ({
          address: { host: '127.0.0.1', port: 0 },
          url: 'http://127.0.0.1:0',
          close: async () => {
            order.push('server.close')
            duringClose = await app.probe('readiness')
          },
        }),
      } as never,
    })
    app.health('db', ok)
    app.hook('onClose', () => { order.push('onClose') })
    // Eager so it is built at boot: an uninstantiated singleton has nothing to
    // dispose, and the position of disposal in the sequence is the point.
    app.provide(token<string>('health.pool'), {
      eager: true,
      factory: () => 'open',
      dispose: () => { order.push('dispose') },
    })

    await app.listen({ port: 0 })
    assert.equal((await app.probe('readiness')).status, 'pass')

    await app.close()

    assert.deepEqual(order, ['server.close', 'onClose', 'dispose'])
    const seen = duringClose as HealthReport | null
    assert.equal(seen?.state, 'draining')
    assert.equal(seen?.status, 'fail')
  })

  test('liveness keeps passing while draining — a drain is not a reason to be killed', async () => {
    const app = makeApp()
    app.health('loop', ok, { kind: 'liveness' })
    await app.ready()

    await app.close()
    assert.equal(app.state, 'stopped')

    // `stopped` is past the point where anything should be routed here at all,
    // so both fail; the interesting state is the one in the test above, which
    // is why that one has to reach inside the close sequence to observe it.
    assert.equal((await app.probe('liveness')).status, 'fail')
  })

  test('the state machine is monotonic — a process never un-drains', async () => {
    const registry = new HealthRegistry()
    registry.live()
    registry.drain()
    registry.live()
    assert.equal(registry.state, 'draining')
    registry.stop()
    registry.drain()
    assert.equal(registry.state, 'stopped')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the endpoints (§31.4, §10.2)', () => {
  const serve = async (options: Parameters<typeof healthPlugin.setup>[1] = {}, build?: (app: ReturnType<typeof makeApp>) => void) => {
    const app = makeApp()
    app.use(healthPlugin, options)
    build?.(app)
    await app.ready()
    return app
  }

  test('/healthz is 200 and /readyz reflects the dependencies', async () => {
    const app = await serve({}, (a) => {
      a.health('db', () => ({ status: 'pass' as const, message: 'ok' }))
    })

    const live = await app.inject('GET', '/healthz')
    assert.equal(live.status, 200)
    // draft-inadarei-api-health-check, not application/json: an existing format
    // everything already understands beats `{ ok: true }` (§12.6's argument).
    assert.match(live.headers['content-type'] ?? '', /application\/health\+json/)
    assert.equal(live.headers['cache-control'], 'no-store')
    assert.equal(live.json<{ status: string }>().status, 'pass')

    const ready = await app.inject('GET', '/readyz')
    assert.equal(ready.status, 200)
    const body = ready.json<{ checks: Record<string, { status: string; cached: boolean }> }>()
    assert.equal(body.checks['db']?.status, 'pass')
  })

  test('a failing dependency makes readiness 503 and liveness stays 200', async () => {
    const app = await serve({}, (a) => { a.health('db', () => false) })

    assert.equal((await app.inject('GET', '/readyz')).status, 503)
    assert.equal((await app.inject('GET', '/healthz')).status, 200)
  })

  test('a warn is 200 — a warning is not a reason to stop routing traffic', async () => {
    const app = await serve({}, (a) => { a.health('cache', () => 'warn' as const) })
    const res = await app.inject('GET', '/readyz')
    assert.equal(res.status, 200)
    assert.equal(res.json<{ status: string }>().status, 'warn')
  })

  test('info fields are merged into every report', async () => {
    const app = await serve({ info: { version: '1.4.2', region: 'eu-west-1' } })
    assert.equal(app.inject !== undefined, true)
    const body = (await app.inject('GET', '/healthz')).json<{ version: string; region: string }>()
    assert.equal(body.version, '1.4.2')
    assert.equal(body.region, 'eu-west-1')
  })

  test('both endpoints are hidden from the generated document', async () => {
    const app = await serve()
    const health = app.graph().routes.filter((r) => r.path === '/healthz' || r.path === '/readyz')
    assert.equal(health.length, 2)
    assert.ok(health.every((r) => r.meta.get('hidden') === true))
  })

  /**
   * The composition that would otherwise bite: an app-wide deadline is exactly
   * what a well-configured service has, and it would make the readiness
   * endpoint 504 during the incident it exists to describe — with no body, so
   * nobody would learn which dependency was slow. The checks carry their own
   * budgets instead, which is both stricter and more informative.
   */
  test('an app-wide deadline does not bound the health endpoints', async () => {
    const app = makeApp({ timeout: '30ms' })
    app.use(healthPlugin)
    app.health('slowish', async () => { await sleep(60) }, { timeout: '2s' })
    await app.ready()

    const byPath = new Map(app.graph().routes.map((r) => [r.path, r.timeout]))
    assert.equal(byPath.get('/readyz'), null)

    const res = await app.inject('GET', '/readyz')
    assert.equal(res.status, 200)
    assert.equal(res.json<{ status: string }>().status, 'pass')
  })

  test('paths are configurable and either endpoint can be switched off', async () => {
    const app = await serve({ path: '/-/live', readiness: false })
    assert.equal((await app.inject('GET', '/-/live')).status, 200)
    assert.equal((await app.inject('GET', '/readyz')).status, 404)
  })

  /**
   * §9.7's principle applied to dependencies. Somebody deletes the plugin that
   * registered `redis`; `/readyz` keeps answering 200; the service stays in the
   * load balancer through the next Redis outage. A check that can never run
   * must not be indistinguishable from one that passed.
   */
  test('requiring a check nothing registered is a boot error naming it', async () => {
    const app = makeApp()
    app.use(healthPlugin, { checks: ['db', 'redis'] })
    app.health('db', ok)

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.ok(error.diagnostics.some((d) => d.code === 'ZEN_HEALTH_CHECK_MISSING'))
    assert.match(error.message, /"redis"/)
    assert.doesNotMatch(error.message, /"db"/)
  })

  test('a plugin that owns a connection publishes its own check', async () => {
    const redis: Plugin<void, {}> = definePlugin<void, {}>({
      name: 'redis',
      version: '2.0.0',
      setup(app) {
        app.health('redis', () => ({ status: 'pass' as const, message: 'PONG' }), { timeout: '200ms' })
      },
    })

    const app = makeApp()
    app.use(healthPlugin, { checks: ['redis'] })
    app.use(redis)
    await app.ready()

    const record = app.graph().checks.find((c) => c.name === 'redis')
    assert.equal(record?.source, 'plugin "redis"')
    assert.equal(record?.timeoutMs, 200)

    const body = (await app.inject('GET', '/readyz')).json<{ checks: Record<string, { output: string }> }>()
    assert.equal(body.checks['redis']?.output, 'PONG')
  })

  /**
   * Ordering must not matter: `checks` is verified against the frozen graph in
   * `onBoot`, not at the moment the plugin's `setup` runs. The previous test
   * registers the provider after the consumer; this one registers it before.
   */
  test('the requirement holds whichever order the plugins were registered in', async () => {
    const redis: Plugin<void, {}> = definePlugin<void, {}>({
      name: 'redis', version: '2.0.0', setup(app) { app.health('redis', ok) },
    })
    const app = makeApp()
    app.use(redis)
    app.use(healthPlugin, { checks: ['redis'] })
    await app.ready()
    assert.equal((await app.inject('GET', '/readyz')).status, 200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('cost (§31.4, §9.4)', () => {
  /**
   * The same claim §9.4 and §4.4 make, checked the same way. Health is a pair
   * of ordinary routes and a registry that nothing on the request path reads,
   * so an application route's generated pipeline must not change by one byte
   * when the plugin is registered. The benchmark gates this in CI; the test is
   * here so a compiler change that broke it fails in the suite people run.
   */
  test('registering the plugin does not change an application route by one byte', async () => {
    const bare = makeApp({ dev: true })
    bare.get('/orders/:id', () => ({ ok: true }))
    await bare.ready()

    const withHealth = makeApp({ dev: true })
    withHealth.use(healthPlugin)
    withHealth.health('db', ok)
    withHealth.get('/orders/:id', () => ({ ok: true }))
    await withHealth.ready()

    const source = (app: typeof bare) =>
      app.generatedSource().find((u) => u.name.startsWith('pipeline:') && u.name.includes('orders'))?.source

    assert.equal(source(bare), source(withHealth))
    assert.ok((source(bare) ?? '').length > 0)
  })

  test('a service with no checks answers readiness without touching anything', async () => {
    const app = makeApp()
    app.use(healthPlugin)
    await app.ready()

    const report = await app.probe('readiness')
    assert.equal(report.status, 'pass')
    assert.deepEqual(report.checks, [])
  })
})
