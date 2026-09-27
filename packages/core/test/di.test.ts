import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ZenContainer, token } from '@visionpilot/zen-core'
import { makeApp, uniqueName } from './helpers.ts'

const t = <T,>(name: string) => token<T>(uniqueName(name))

describe('lifetimes', () => {
  test('singletons are built once', () => {
    const c = new ZenContainer()
    const Db = t<{ n: number }>('db')
    let builds = 0
    c.provide(Db, { factory: () => ({ n: ++builds }), lifetime: 'singleton' })

    assert.equal(c.resolve(Db).n, 1)
    assert.equal(c.resolve(Db).n, 1)
    assert.equal(builds, 1)
  })

  test('transients are built every time', () => {
    const c = new ZenContainer()
    const Rand = t<{ n: number }>('rand')
    let builds = 0
    c.provide(Rand, { factory: () => ({ n: ++builds }), lifetime: 'transient' })

    assert.equal(c.resolve(Rand).n, 1)
    assert.equal(c.resolve(Rand).n, 2)
  })

  test('scoped services cannot be resolved outside a request', () => {
    const c = new ZenContainer()
    const Tenant = t<string>('tenant')
    c.provide(Tenant, { factory: () => 'acme', lifetime: 'scoped' })

    assert.throws(() => c.resolve(Tenant), /request-scoped/)
  })

  test('scoped services are one-per-request and cached in the slot array', async () => {
    const Tenant = t<{ id: number }>('tenant-req')
    let builds = 0

    const app = makeApp()
    app.provide(Tenant, { factory: () => ({ id: ++builds }), lifetime: 'scoped' })
    app.get('/', (ctx) => {
      const a = ctx.resolve(Tenant)
      const b = ctx.resolve(Tenant)
      return { same: a === b, id: a.id }
    })

    assert.deepEqual((await app.inject('GET', '/')).json(), { same: true, id: 1 })
    assert.deepEqual((await app.inject('GET', '/')).json(), { same: true, id: 2 })
  })

  test('dependencies are injected in declared order', () => {
    const c = new ZenContainer()
    const A = t<string>('a')
    const B = t<string>('b')
    const AB = t<string>('ab')

    c.provide(A, () => 'a')
    c.provide(B, () => 'b')
    c.provide(AB, { deps: [A, B] as never, factory: ((x: string, y: string) => x + y) as never })

    assert.equal(c.resolve(AB), 'ab')
  })

  test('async factories require resolveAsync and say so', async () => {
    const c = new ZenContainer()
    const Slow = t<string>('slow')
    c.provide(Slow, { factory: async () => 'ready' })

    assert.throws(() => c.resolve(Slow), /resolveAsync/)
    assert.equal(await c.resolveAsync(Slow), 'ready')
  })

  test('eager singletons are built at boot', async () => {
    const Warm = t<string>('warm')
    let built = false

    const app = makeApp()
    app.provide(Warm, { factory: () => { built = true; return 'x' }, eager: true })
    app.get('/', () => 'ok')

    assert.equal(built, false)
    await app.ready()
    assert.equal(built, true)
  })
})

describe('graph analysis', () => {
  test('a missing provider is reported with a suggestion', () => {
    const c = new ZenContainer()
    const Service = t<string>('service')
    const DbToken = t<string>('dbtoken')
    c.provide(DbToken, () => 'db')
    c.provide(Service, { deps: [t<string>('dbtokn')] as never, factory: (() => 'x') as never })

    const issues = c.analyze()
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.code, 'ZEN_DI_MISSING')
  })

  test('cycles are detected with the full path', () => {
    const c = new ZenContainer()
    const A = t<string>('cyc-a')
    const B = t<string>('cyc-b')
    c.provide(A, { deps: [B] as never, factory: (() => 'a') as never })
    c.provide(B, { deps: [A] as never, factory: (() => 'b') as never })

    const issues = c.analyze()
    const cycle = issues.find((i) => i.code === 'ZEN_DI_CYCLE')
    assert.ok(cycle, 'expected a cycle diagnostic')
    assert.match(cycle.message, /→/)
  })

  /**
   * The captive-dependency bug: a singleton holding a scoped service captures
   * the first request's instance forever. §15.4 makes it a boot error precisely
   * because it is invisible in testing and catastrophic in production.
   */
  test('a singleton depending on a scoped service is a boot error', async () => {
    const Tenant = t<string>('captive-tenant')
    const Reporter = t<string>('captive-reporter')

    const app = makeApp()
    app.provide(Tenant, { factory: () => 'acme', lifetime: 'scoped' })
    app.provide(Reporter, { deps: [Tenant] as never, factory: (() => 'r') as never, lifetime: 'singleton' })
    app.get('/', () => 'ok')

    await assert.rejects(() => app.ready(), (error: Error) => {
      assert.match(error.message, /ZEN_DI_LIFETIME/)
      assert.match(error.message, /capture the first request's instance/)
      return true
    })
  })

  test('a valid graph produces no diagnostics', () => {
    const c = new ZenContainer()
    const Config = t<string>('ok-config')
    const Db = t<string>('ok-db')
    c.provide(Config, () => 'cfg')
    c.provide(Db, { deps: [Config] as never, factory: ((cfg: string) => `db(${cfg})`) as never })

    assert.deepEqual(c.analyze(), [])
  })
})

describe('disposal', () => {
  test('singletons dispose in reverse creation order', async () => {
    const c = new ZenContainer()
    const order: string[] = []
    const A = t<string>('dis-a')
    const B = t<string>('dis-b')

    c.provide(A, { factory: () => 'a', dispose: () => { order.push('a') } })
    c.provide(B, { deps: [A] as never, factory: (() => 'b') as never, dispose: () => { order.push('b') } })

    c.resolve(B)
    await c.dispose()

    // B was created after A, so B tears down first.
    assert.deepEqual(order, ['b', 'a'])
  })

  test('app.close() disposes the container', async () => {
    let disposed = false
    const Res = t<string>('closable')

    const app = makeApp()
    app.provide(Res, { factory: () => 'open', dispose: () => { disposed = true } })
    app.get('/', (ctx) => ctx.resolve(Res))

    await app.inject('GET', '/')
    await app.close()
    assert.equal(disposed, true)
  })
})

describe('request-scoped disposal (§15.3, §4.2 stage 10)', () => {
  // `dispose` on a scoped provider was accepted and never called: a per-request
  // transaction or pooled connection was simply dropped at the end of the
  // request. §15.3 says scoped services are "disposed at stage 10, reverse
  // creation order", and these hold it to that.

  test('each request disposes the instance it created, once, after the response', async () => {
    let built = 0
    const events: string[] = []
    const Tx = t<{ id: number }>('scoped-tx')

    const app = makeApp()
    app.provide(Tx, {
      lifetime: 'scoped',
      factory: () => ({ id: ++built }),
      dispose: (tx) => { events.push(`dispose ${tx.id}`) },
    })
    app.get('/', (ctx) => ({ id: ctx.resolve(Tx).id, again: ctx.resolve(Tx).id }))
    app.hook('onResponse', () => { events.push('onResponse') })

    assert.deepEqual((await app.inject('GET', '/')).json(), { id: 1, again: 1 })
    assert.deepEqual((await app.inject('GET', '/')).json(), { id: 2, again: 2 })
    assert.deepEqual(events, ['onResponse', 'dispose 1', 'onResponse', 'dispose 2'])
  })

  test('several scoped services dispose in reverse creation order', async () => {
    const order: string[] = []
    const Conn = t<string>('scoped-conn')
    const Tx = t<string>('scoped-tx-on-conn')

    const app = makeApp()
    app.provide(Conn, { lifetime: 'scoped', factory: () => 'conn', dispose: () => { order.push('conn') } })
    app.provide(Tx, {
      lifetime: 'scoped',
      deps: [Conn] as never,
      factory: (() => 'tx') as never,
      dispose: () => { order.push('tx') },
    })
    app.get('/', (ctx) => ctx.resolve(Tx))

    await app.inject('GET', '/')
    // Tx was built after (and on top of) Conn, so it is released first.
    assert.deepEqual(order, ['tx', 'conn'])
  })

  test('a request that fails still releases what it took', async () => {
    const disposed: string[] = []
    const Tx = t<string>('scoped-on-error')

    const app = makeApp()
    app.provide(Tx, { lifetime: 'scoped', factory: () => 'tx', dispose: (tx) => { disposed.push(tx) } })
    app.get('/', (ctx) => {
      ctx.resolve(Tx)
      throw new Error('handler failed after opening a transaction')
    })

    assert.equal((await app.inject('GET', '/')).status, 500)
    assert.deepEqual(disposed, ['tx'])
  })

  test('a scoped service that finishes opening after its deadline answered is released at once', async () => {
    // The deadline answers while the handler is still suspended in
    // `resolveAsync`; the service arrives after stage 10 has run. It used to be
    // queued on a list nothing would read again — a transaction opened for a
    // request that had already given up, and never rolled back.
    const disposed: string[] = []
    let open!: (tx: string) => void
    const Tx = t<string>('scoped-late')

    const app = makeApp({ timeout: '20ms' })
    app.provide(Tx, {
      lifetime: 'scoped',
      factory: () => new Promise<string>((resolve) => { open = resolve }),
      dispose: (tx) => { disposed.push(tx) },
    })
    app.get('/', async (ctx) => { await ctx.resolveAsync(Tx); return 'too late' })

    // Deadline timers are unref'd; stand in for the socket that would hold the
    // event loop in production, or Node 22 cancels the test (HANDOFF §8).
    const socket = setTimeout(() => {}, 5_000)
    try {
      assert.equal((await app.inject('GET', '/')).status, 504)
      assert.deepEqual(disposed, [], 'still opening when the request settled')
      open('late-tx')
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(disposed, ['late-tx'], 'released the moment it arrived')
    } finally {
      clearTimeout(socket)
    }
  })

  test('an async scoped build is disposed too, and a disposer that throws does not stop the rest', async () => {
    const disposed: string[] = []
    const A = t<string>('scoped-async-a')
    const B = t<string>('scoped-async-b')

    const app = makeApp()
    app.provide(A, { lifetime: 'scoped', factory: async () => 'a', dispose: (a) => { disposed.push(a) } })
    app.provide(B, { lifetime: 'scoped', factory: () => 'b', dispose: () => { throw new Error('b will not close') } })
    app.get('/', async (ctx) => {
      await ctx.resolveAsync(A)
      ctx.resolve(B)
      return 'ok'
    })

    assert.equal((await app.inject('GET', '/')).status, 200)
    assert.deepEqual(disposed, ['a'], 'B threw first (it was newer) and A was still released')
  })
})

describe('integration', () => {
  test('handlers resolve services through the context', async () => {
    const Greeter = t<{ hello: (n: string) => string }>('greeter')

    const app = makeApp()
    app.provide(Greeter, () => ({ hello: (n: string) => `hi ${n}` }))
    app.get('/greet/:name', (ctx) => ctx.resolve(Greeter).hello(ctx.params.name))

    assert.equal((await app.inject('GET', '/greet/ada')).text(), 'hi ada')
  })

  test('resolving an unregistered token names the token', async () => {
    const Ghost = t<string>('ghost')
    const app = makeApp()
    app.get('/', (ctx) => ctx.resolve(Ghost))

    const res = await app.inject('GET', '/')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_DI_MISSING')
  })

  test('test overrides replace providers before compilation', async () => {
    const Clock = t<() => string>('clock')

    const app = makeApp()
    app.provide(Clock, () => () => new Date().toISOString())
    app.get('/now', (ctx) => ({ now: ctx.resolve(Clock)() }))

    // Re-providing before ready() wins — this is how createTestApp's `override`
    // works (§15.5): the app under test is *compiled* with the fake.
    app.provide(Clock, () => () => '2026-01-01T00:00:00.000Z')

    assert.deepEqual((await app.inject('GET', '/now')).json(), { now: '2026-01-01T00:00:00.000Z' })
  })
})

describe('async providers under concurrency', () => {
  const later = <T,>(value: T, ms = 5) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

  test('concurrent first resolves of an async singleton share one build', async () => {
    // Before: every request that arrived before the first build finished ran the
    // factory again — two pools behind one "singleton" — and the entry was
    // queued for disposal twice, so close() disposed one instance twice and
    // leaked the other.
    const c = new ZenContainer()
    const Pool = t<{ id: number }>('pool')
    let builds = 0
    const disposed: number[] = []
    c.provide(Pool, {
      factory: async () => later({ id: ++builds }),
      dispose: (pool) => { disposed.push(pool.id) },
    })

    const resolved = await Promise.all([c.resolveAsync(Pool), c.resolveAsync(Pool), c.resolveAsync(Pool)])
    assert.equal(builds, 1)
    assert.ok(resolved.every((pool) => pool === resolved[0]))

    await c.dispose()
    assert.deepEqual(disposed, [1], 'disposed exactly once')
  })

  test('a failed async build is not cached — the next caller tries again', async () => {
    const c = new ZenContainer()
    const Flaky = t<string>('flaky')
    let attempts = 0
    c.provide(Flaky, async () => {
      attempts++
      if (attempts === 1) throw new Error('database not up yet')
      return later('connected')
    })

    await assert.rejects(c.resolveAsync(Flaky), /database not up yet/)
    assert.equal(await c.resolveAsync(Flaky), 'connected')
    assert.equal(attempts, 2)
  })

  test('two async resolves of a scoped service in one request share one instance', async () => {
    const Session = t<{ n: number }>('session')
    let builds = 0
    const app = makeApp()
    app.provide(Session, { lifetime: 'scoped', factory: async () => later({ n: ++builds }) })
    app.get('/', async (ctx) => {
      const [a, b] = await Promise.all([ctx.resolveAsync(Session), ctx.resolveAsync(Session)])
      return { same: a === b }
    })

    assert.deepEqual((await app.inject('GET', '/')).json(), { same: true })
    assert.equal(builds, 1)
    assert.deepEqual((await app.inject('GET', '/')).json(), { same: true })
    assert.equal(builds, 2, 'and a new one per request')
  })

  test('dispose() runs every disposer even when one throws, then reports them together', async () => {
    const c = new ZenContainer()
    const A = t<string>('a')
    const B = t<string>('b')
    const C = t<string>('c')
    const disposed: string[] = []
    c.provide(A, { factory: () => 'a', dispose: () => { disposed.push('a') } })
    c.provide(B, { factory: () => 'b', dispose: () => { throw new Error('b failed to close') } })
    c.provide(C, { factory: () => 'c', dispose: () => { disposed.push('c') } })
    c.resolve(A)
    c.resolve(B)
    c.resolve(C)

    await assert.rejects(c.dispose(), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 1)
      return true
    })
    assert.deepEqual(disposed, ['c', 'a'], 'reverse creation order, and B did not stop A')
  })
})
