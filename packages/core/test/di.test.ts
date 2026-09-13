import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ZenContainer, token } from '@zenjs/core'
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
