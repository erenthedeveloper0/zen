import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { defineConfig, definePlugin, slot, token, ZenError } from '@erenthedeveloper0/zen-core'
import { assertNoLeaks, createTestApp, fixedClock, testContext } from '@erenthedeveloper0/zen-core/testing'
import { makeApp, shaped, uniqueName } from './helpers.ts'

/**
 * The testing kit — rfcs/0001 §15.5, §20.2, §20.3. Each test here is a test
 * an application would write, so each is also the documentation of how.
 */

interface Db { find(id: number): { id: number; name: string } | undefined }
const Db = token<Db>(uniqueName('testing.db'))
const realDb: Db = { find: () => { throw new Error('the real database is not reachable from a test') } }
const fakeDb: Db = { find: (id) => (id === 1 ? { id: 1, name: 'Ada' } : undefined) }

/** The application's own factory, unbooted — what `createTestApp` takes. */
function makeUsers() {
  const app = makeApp({ config: defineConfig({ greeting: { prefix: 'Hello' } }) })
  app.provide(Db, () => realDb)
  app.get('/users/:id<int>', { inject: { db: Db } }, (ctx, { db }) => {
    const user = db.find(ctx.params.id as number)
    return user === undefined ? ctx.json({ missing: true }, { status: 404 }) : user
  })
  app.get('/greeting', (ctx) => `${(ctx.config as { greeting: { prefix: string } }).greeting.prefix}, world`)
  app.post('/echo', { body: shaped({ type: 'object' }) }, (ctx) => ({ got: ctx.body }))
  return app
}

describe('createTestApp (§15.5, §20.2)', () => {
  test('a replaced service is the one the application is compiled with', async () => {
    const t = await createTestApp(makeUsers, { override: [[Db, () => fakeDb]] })
    assert.deepEqual((await t.get('/users/1')).json(), { id: 1, name: 'Ada' })
    assert.equal((await t.get('/users/2')).status, 404)
    assert.deepEqual((await t.post('/echo', { body: { a: 1 } })).json(), { got: { a: 1 } })
    await t.close()
  })

  test('it wins over a provider a plugin registers as the application boots', async () => {
    const Clock = token<{ now(): number }>(uniqueName('testing.clock'))
    const clockPlugin = definePlugin({
      name: uniqueName('clock'),
      version: '1.0.0',
      setup(app) {
        app.provide(Clock, () => ({ now: () => Date.now() }))
        return { provides: {} }
      },
    })
    const make = () => {
      const app = makeApp()
      app.use(clockPlugin)
      app.get('/now', { inject: { clock: Clock } }, (_ctx, { clock }) => ({ now: clock.now() }))
      return app
    }
    const clock = fixedClock('2026-01-01T00:00:00Z')
    const t = await createTestApp(make, { override: [[Clock, () => clock]] })
    assert.deepEqual((await t.get('/now')).json(), { now: Date.parse('2026-01-01T00:00:00Z') })
    clock.advance(1500)
    assert.deepEqual((await t.get('/now')).json(), { now: Date.parse('2026-01-01T00:00:01.500Z') })
    await t.close()
  })

  test('configuration it is given beats every other source, and says where it came from', async () => {
    const t = await createTestApp(makeUsers, { config: { greeting: { prefix: 'Hi' } } })
    assert.equal((await t.get('/greeting')).text(), 'Hi, world')
    const value = t.app.graph().config.values.find((v) => v.path === 'greeting.prefix')
    assert.equal(value?.layer, 'override')
    assert.equal(value?.source, 'test overrides')
    await t.close()
  })

  test('a factory that already booted is refused: a replacement after compilation would be a mock', async () => {
    const booted = async () => {
      const app = makeUsers()
      await app.ready()
      return app
    }
    await assert.rejects(createTestApp(booted, { override: [[Db, () => fakeDb]] }), (error: unknown) => {
      assert.ok(error instanceof ZenError)
      assert.equal(error.code, 'ZEN_APP_FROZEN')
      return true
    })
  })
})

describe('assertNoLeaks (§20.7)', () => {
  const Ticker = token<ReturnType<typeof setInterval>>(uniqueName('testing.ticker'))

  test('an application that releases what it opened passes', async () => {
    const make = () => {
      const app = makeApp()
      app.provide(Ticker, { factory: () => setInterval(() => {}, 60_000), eager: true, dispose: (t) => clearInterval(t) })
      app.get('/', () => 'ok')
      return app
    }
    const t = await createTestApp(make)
    await t.get('/')
    await assertNoLeaks(t)
  })

  test('one that leaves a timer running fails, and names it', async () => {
    // Wrapped: a bare Node timer has `Symbol.dispose`, which the container
    // calls at shutdown on its own (§15.3) — the leak has to be one it cannot see.
    const Poller = token<{ readonly handle: ReturnType<typeof setInterval> }>(uniqueName('testing.poller'))
    let leaked: ReturnType<typeof setInterval> | undefined
    const make = () => {
      const app = makeApp()
      app.provide(Poller, { factory: () => ({ handle: (leaked = setInterval(() => {}, 60_000)) }), eager: true })
      return app
    }
    const t = await createTestApp(make)
    try {
      await assert.rejects(assertNoLeaks(t, { within: 50 }), /left 1 × Timeout running after close\(\)/)
    } finally {
      clearInterval(leaked)
    }
  })

  test('it checks only what createTestApp built, and a probe can be supplied', async () => {
    const t = await createTestApp(makeUsers)
    const probed = await createTestApp(makeUsers, { resources: () => [] })
    await assertNoLeaks(probed)
    await t.close()
    const imitation = { app: t.app, close: () => Promise.resolve() } as unknown as typeof t
    await assert.rejects(assertNoLeaks(imitation), /pass the TestApp that createTestApp\(\) returned/)
  })
})

describe('testContext (§20.3)', () => {
  const CurrentUser = slot<{ id: number }>(uniqueName('testing.user'))
  const Unset = slot<string>(uniqueName('testing.unset'))

  test('a handler called as the function it is', async () => {
    const showUser = (ctx: any) => {
      const me = ctx.get(CurrentUser)
      if (ctx.params.id !== me.id) return ctx.json({ forbidden: true }, { status: 403 })
      ctx.res.header('x-viewer', String(me.id))
      return { id: ctx.params.id, q: ctx.query.q, agent: ctx.headers['user-agent'], db: ctx.resolve(Db).find(1)?.name }
    }
    const ctx = testContext({
      url: '/users/1?q=tea',
      params: { id: 1 },
      headers: { 'User-Agent': 'node:test' },
      slots: [[CurrentUser, { id: 1 }]],
      services: [[Db, () => fakeDb]],
    })
    assert.deepEqual(await showUser(ctx), { id: 1, q: 'tea', agent: 'node:test', db: 'Ada' })

    const other = testContext({ params: { id: 2 }, slots: [[CurrentUser, { id: 1 }]] })
    const reply = await showUser(other)
    assert.equal(reply.status, 403)
  })

  test('it is a real context: an unset slot throws, configuration and decorations read through', () => {
    const ctx = testContext<any>({ config: { feature: true }, decorations: { user: { id: 9 } }, body: { a: 1 } })
    assert.throws(() => ctx.get(Unset), (error: unknown) => error instanceof ZenError && error.code === 'ZEN_SLOT_EMPTY')
    assert.deepEqual(ctx.config, { feature: true })
    assert.deepEqual(ctx.user, { id: 9 })
    assert.deepEqual(ctx.body, { a: 1 })
    assert.match(ctx.id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})

describe('fixedClock', () => {
  test('moves only when told', () => {
    const clock = fixedClock('2026-10-10T00:00:00Z')
    const start = clock.now()
    assert.equal(clock.now(), start)
    clock.advance(1000)
    assert.equal(clock.now() - start, 1000)
    clock.set(0)
    assert.equal(clock.date().toISOString(), '1970-01-01T00:00:00.000Z')
    assert.throws(() => fixedClock('not a date'), RangeError)
  })
})
