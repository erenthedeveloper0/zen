import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { definePlugin, token, satisfies, resolvePlugins, DEFAULT_CAPABILITIES } from '@erenthedeveloper0/zen-core'
import { makeApp, uniqueName } from './helpers.ts'

describe('plugin registration', () => {
  test('a plugin can register routes, hooks and middleware', async () => {
    const order: string[] = []

    const Metrics = definePlugin({
      name: 'metrics',
      version: '1.0.0',
      setup(app) {
        app.use(() => { order.push('mw') })
        app.hook('onRequest', () => { order.push('hook') })
        return { provides: {} }
      },
    })

    const app = makeApp().use(Metrics)
    app.get('/', () => { order.push('handler'); return 'ok' })

    const res = await app.inject('GET', '/')
    assert.equal(res.status, 200)
    // Hooks registered for onRequest run before route middleware (§9.3).
    assert.deepEqual(order, ['hook', 'mw', 'handler'])
  })

  test('decorations become typed context properties', async () => {
    const name = uniqueName('auth.user')

    const Auth = definePlugin<void, { user: { id: number } }>({
      name: 'auth',
      version: '1.0.0',
      setup(app) {
        const userSlot = app.slot<{ id: number }>(name)
        app.decorate('user', userSlot)
        app.hook('onRequest', (ctx: { set: (s: typeof userSlot, v: { id: number }) => void }) => {
          ctx.set(userSlot, { id: 7 })
        })
        return { provides: {} as { user: { id: number } } }
      },
    })

    const app = makeApp().use(Auth)
    app.get('/me', (ctx) => ctx.user)

    assert.deepEqual((await app.inject('GET', '/me')).json(), { id: 7 })
  })

  test('two plugins decorating the same property is a boot error naming both', async () => {
    const make = (n: string) =>
      definePlugin({
        name: n,
        version: '1.0.0',
        setup(app) {
          app.decorate('collide', () => 1)
          return { provides: {} }
        },
      })

    const app = makeApp().use(make('first')).use(make('second'))
    app.get('/', () => 'x')

    await assert.rejects(() => app.ready(), (error: Error) => {
      assert.match(error.message, /already decorated by plugin "first"/)
      return true
    })
  })

  test('slot names are namespaced by plugin, so two plugins can both use "user"', async () => {
    const build = (n: string) =>
      definePlugin({
        name: n,
        version: '1.0.0',
        setup(app) {
          app.slot<string>('user')
          return { provides: {} }
        },
      })

    const app = makeApp().use(build(uniqueName('p1'))).use(build(uniqueName('p2')))
    app.get('/', () => 'ok')

    await app.ready()
    assert.equal((await app.inject('GET', '/')).status, 200)
  })

  test('a plugin that throws during setup names itself and its dependents', async () => {
    const Broken = definePlugin({
      name: 'broken',
      version: '2.1.0',
      setup() { throw new Error('config missing') },
    })
    const Dependent = definePlugin({
      name: 'billing',
      version: '1.0.0',
      dependsOn: { broken: '^2' },
      setup() { return { provides: {} } },
    })

    const app = makeApp().use(Broken).use(Dependent)
    app.get('/', () => 'x')

    await assert.rejects(() => app.ready(), (error: Error) => {
      assert.match(error.message, /broken@2\.1\.0.*config missing/s)
      assert.match(error.message, /billing/)
      return true
    })
  })

  test('exports are readable by dependents', async () => {
    const Secret = token<string>(uniqueName('secret'))

    const Provider = definePlugin({
      name: 'provider',
      version: '1.0.0',
      setup(app) {
        app.provide(Secret, () => 'from-provider')
        return { provides: {}, exports: { Secret } }
      },
    })

    let seen: unknown
    const Consumer = definePlugin({
      name: 'consumer',
      version: '1.0.0',
      dependsOn: { provider: '^1' },
      setup(app) {
        seen = app.exportsOf('provider')?.['Secret']
        return { provides: {} }
      },
    })

    const app = makeApp().use(Consumer).use(Provider) // registered out of order on purpose
    app.get('/', (ctx) => ctx.resolve(Secret))
    await app.ready()

    assert.equal(seen, Secret)
    assert.equal((await app.inject('GET', '/')).text(), 'from-provider')
  })
})

describe('plugin resolution', () => {
  const plugin = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, version: '1.0.0', setup: () => ({ provides: {} }), ...extra }) as never

  const resolve = (plugins: unknown[]) =>
    resolvePlugins(
      plugins.map((p, order) => ({ plugin: p as never, options: undefined, order })),
      DEFAULT_CAPABILITIES,
    )

  test('dependencies are ordered before dependents regardless of registration order', () => {
    const { order, diagnostics } = resolve([
      plugin('c', { dependsOn: { b: '^1' } }),
      plugin('a'),
      plugin('b', { dependsOn: { a: '^1' } }),
    ])

    assert.deepEqual(diagnostics, [])
    assert.deepEqual(order.map((o) => o.plugin.name), ['a', 'b', 'c'])
  })

  test('boot order is deterministic across runs', () => {
    const names = () => resolve([plugin('x'), plugin('y'), plugin('z')]).order.map((o) => o.plugin.name)
    assert.deepEqual(names(), names())
    assert.deepEqual(names(), ['x', 'y', 'z'])
  })

  test('a missing dependency is reported with a fix', () => {
    const { diagnostics } = resolve([plugin('billing', { dependsOn: { redis: '^1.0.0' } })])
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0]?.code, 'ZEN_PLUGIN_MISSING')
    assert.match(diagnostics[0]?.hint ?? '', /app\.use\(redisPlugin\)/)
  })

  test('a version mismatch is reported', () => {
    const { diagnostics } = resolve([
      plugin('redis', { version: '1.5.0' }),
      plugin('billing', { dependsOn: { redis: '^2' } }),
    ])
    assert.equal(diagnostics[0]?.code, 'ZEN_PLUGIN_VERSION')
  })

  test('cycles are detected and the path is printed', () => {
    const { diagnostics } = resolve([
      plugin('a', { dependsOn: { b: '*' } }),
      plugin('b', { dependsOn: { a: '*' } }),
    ])
    assert.equal(diagnostics[0]?.code, 'ZEN_PLUGIN_CYCLE')
    assert.match(diagnostics[0]?.message ?? '', /a|b/)
  })

  test('duplicates are refused unless multiple:true', () => {
    assert.equal(resolve([plugin('dup'), plugin('dup')]).diagnostics[0]?.code, 'ZEN_PLUGIN_DUPLICATE')
    assert.deepEqual(resolve([plugin('ok', { multiple: true }), plugin('ok', { multiple: true })]).diagnostics, [])
  })

  test('conflictsWith is honoured', () => {
    const { diagnostics } = resolve([plugin('new-thing', { conflictsWith: ['old-thing'] }), plugin('old-thing')])
    assert.equal(diagnostics[0]?.code, 'ZEN_PLUGIN_CONFLICT')
  })

  test('a plugin requiring an unavailable capability fails at boot, not at runtime', () => {
    const { diagnostics } = resolvePlugins(
      [{ plugin: plugin('uploads', { requires: { fs: true } }), options: undefined, order: 0 }],
      { ...DEFAULT_CAPABILITIES, fs: false },
    )
    assert.equal(diagnostics[0]?.code, 'ZEN_CAPABILITY_UNAVAILABLE')
    assert.match(diagnostics[0]?.message ?? '', /requires capability "fs"/)
  })

  test('before/after hints order plugins without a hard dependency', () => {
    const { order } = resolve([plugin('late', { after: ['early'] }), plugin('early')])
    assert.deepEqual(order.map((o) => o.plugin.name), ['early', 'late'])
  })

  test('onBoot sees the frozen graph', async () => {
    let routeCount = -1
    const Inspector = definePlugin({
      name: 'inspector',
      version: '1.0.0',
      setup(app) {
        app.onBoot((graph) => { routeCount = (graph as { routes: unknown[] }).routes.length })
        return { provides: {} }
      },
    })

    const app = makeApp().use(Inspector)
    app.get('/a', () => 'a')
    app.get('/b', () => 'b')
    await app.ready()

    assert.equal(routeCount, 2)
    assert.equal(app.graph().plugins[0]?.name, 'inspector')
  })
})

describe('semver ranges', () => {
  const cases: Array<[string, string, boolean]> = [
    ['1.2.3', '*', true],
    ['1.2.3', '', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '^1', true],
    ['1.9.9', '^1.2.3', true],
    ['1.2.2', '^1.2.3', false],
    ['2.0.0', '^1.2.3', false],
    ['0.3.5', '^0.3.0', true],
    ['0.4.0', '^0.3.0', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['2.0.0', '>=1.0.0', true],
    ['0.9.0', '>=1.0.0', false],
    ['1.0.0', '<2.0.0', true],
  ]

  for (const [version, range, expected] of cases) {
    test(`${version} ${expected ? 'satisfies' : 'does not satisfy'} ${range || '(empty)'}`, () => {
      assert.equal(satisfies(version, range), expected)
    })
  }
})
