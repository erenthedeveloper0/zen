import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  definePlugin, token, satisfies, resolvePlugins, DEFAULT_CAPABILITIES, BootError,
  type AppGraph, type RuntimeAdapter,
} from '@erenthedeveloper0/zen-core'
import { makeApp, schema, shaped, uniqueName } from './helpers.ts'

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

/** The aggregated boot error `ready()` rejected with (§12.7). */
async function bootError(app: { ready(): Promise<unknown> }): Promise<BootError> {
  try {
    await app.ready()
  } catch (error) {
    assert.ok(error instanceof BootError, `expected a BootError, got ${String(error)}`)
    return error
  }
  throw new Error('expected ready() to fail, and it did not')
}

describe('application phases fire, whichever door registered them (§9.2, §9.7)', () => {
  test('app.hook("onBoot") is called with the frozen graph', async () => {
    let seen: AppGraph | null = null
    const app = makeApp()
    app.hook('onBoot', (graph) => { seen = graph })
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(seen, app.graph())
  })

  test('a plugin\'s hook("onBoot") and onBoot() share one table, run in registration order', async () => {
    const order: string[] = []
    const Inspector = definePlugin({
      name: 'inspector-order',
      version: '1.0.0',
      setup(app) {
        app.hook('onBoot', () => { order.push('hook 1') })
        app.onBoot(() => { order.push('onBoot 2') })
        app.hook('onBoot', () => { order.push('hook 3') })
      },
    })
    const app = makeApp().use(Inspector)
    app.get('/', () => 'ok')
    await app.ready()
    assert.deepEqual(order, ['hook 1', 'onBoot 2', 'hook 3'])
  })

  test('an onBoot hook runs once, however many times ready() is awaited', async () => {
    let calls = 0
    const app = makeApp()
    app.hook('onBoot', () => { calls++ })
    app.get('/', () => 'ok')
    await Promise.all([app.ready(), app.ready()])
    await app.ready()
    assert.equal(calls, 1)
  })
})

describe('plugin options are validated before any setup runs (§10.5 step 2)', () => {
  const Limits = shaped({
    type: 'object',
    properties: { limit: { type: 'integer' }, window: { type: 'string' } },
  })

  test('a key the schema does not declare is named, with the one it was meant to be', async () => {
    let ran = false
    const RateLimit = definePlugin<{ limit?: number }>({
      name: 'rate-limit', version: '1.0.0', options: Limits,
      setup() { ran = true },
    })
    const app = makeApp().use(RateLimit, { limt: 100 } as never)
    app.get('/', () => 'ok')
    const error = await bootError(app)

    assert.equal(ran, false)
    assert.deepEqual(error.diagnostics.map((d) => d.code), ['ZEN_PLUGIN_OPTIONS'])
    const [diagnostic] = error.diagnostics
    assert.match(diagnostic?.message ?? '', /Plugin "rate-limit@1\.0\.0" was given options it does not accept: "limt" is not an option/)
    assert.equal(diagnostic?.hint, '"limt" is not an option of rate-limit — did you mean "limit"?')
    assert.match(diagnostic?.consequence ?? '', /leaves the default in its place/)
  })

  test("the schema's own issues are reported by path, normalised (§11.2)", async () => {
    const P = definePlugin<{ limit?: number }>({ name: 'typed', version: '1.0.0', options: Limits, setup() {} })
    const app = makeApp().use(P, { limit: 'many' } as never)
    app.get('/', () => 'ok')
    const error = await bootError(app)
    assert.match(error.diagnostics[0]?.message ?? '', /limit: expected integer, received string/)
  })

  test('an async schema is awaited — boot is async, so it can be', async () => {
    const AsyncOptions = schema<{ token: string }>((v) =>
      Promise.resolve(typeof (v as { token?: unknown }).token === 'string'
        ? { value: v as { token: string } }
        : { issues: [{ message: 'token is required', path: ['token'] }] })as never)
    let got: unknown
    const P = definePlugin<{ token: string }>({ name: 'async-opts', version: '1.0.0', options: AsyncOptions, setup(_app, o) { got = o } })

    const bad = makeApp().use(P, {} as never)
    bad.get('/', () => 'ok')
    assert.match((await bootError(bad)).diagnostics[0]?.message ?? '', /token: token is required/)

    const good = makeApp().use(P, { token: 't' })
    good.get('/', () => 'ok')
    await good.ready()
    assert.deepEqual(got, { token: 't' })
  })

  test('setup receives the validated output — defaults applied — not what was written', async () => {
    const WithDefaults = schema<{ limit: number }>((v) => ({ value: { limit: 60, ...(v as object) } }))
    let got: unknown
    const P = definePlugin<{ limit?: number }>({ name: 'defaults', version: '1.0.0', options: WithDefaults, setup(_app, o) { got = o } })
    const app = makeApp().use(P, {})
    app.get('/', () => 'ok')
    await app.ready()
    assert.deepEqual(got, { limit: 60 })
  })

  test("a factory's bound options are checked the same way", async () => {
    const factory = (options: Record<string, unknown>) => definePlugin({
      name: 'factory', version: '1.0.0', options: Limits, boundOptions: options, setup() {},
    })
    const app = makeApp().use(factory({ windw: '1m' }))
    app.get('/', () => 'ok')
    assert.equal((await bootError(app)).diagnostics[0]?.hint, '"windw" is not an option of factory — did you mean "window"?')
  })

  test("an explicit app.use() argument wins over a factory's bound options", async () => {
    let got: unknown
    const P = definePlugin<{ limit?: number }>({
      name: 'explicit', version: '1.0.0', options: Limits, boundOptions: { limt: 1 }, setup(_app, o) { got = o },
    })
    const app = makeApp().use(P, { limit: 5 })
    app.get('/', () => 'ok')
    await app.ready()
    assert.deepEqual(got, { limit: 5 })
  })

  test('an open schema — additionalProperties: true — is believed', async () => {
    const Open = shaped({ type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: true })
    const P = definePlugin<Record<string, unknown>>({ name: 'open', version: '1.0.0', options: Open, setup() {} })
    const app = makeApp().use(P, { limit: 1, extra: true })
    app.get('/', () => 'ok')
    await app.ready()
  })

  test('a schema that throws is reported as the schema\'s fault, not the options\'', async () => {
    const Throws = schema(() => { throw new Error('schema bug') })
    const P = definePlugin({ name: 'throws', version: '1.0.0', options: Throws, setup() {} })
    const app = makeApp().use(P)
    app.get('/', () => 'ok')
    const [diagnostic] = (await bootError(app)).diagnostics
    assert.equal(diagnostic?.code, 'ZEN_PLUGIN_OPTIONS')
    assert.match(diagnostic?.message ?? '', /options schema threw while checking its options: schema bug/)
  })

  test('a refusal names keys, never values — options carry API keys and DSNs', async () => {
    const P = definePlugin<{ limit?: number }>({ name: 'secretive', version: '1.0.0', options: Limits, setup() {} })
    const app = makeApp().use(P, { apiKey: 'sk_live_must_not_be_logged', limit: 'sk_live_must_not_be_logged_either' } as never)
    app.get('/', () => 'ok')
    const error = await bootError(app)
    assert.doesNotMatch(error.message, /sk_live/)
  })

  test('every plugin with bad options is reported in one boot, and none of them runs', async () => {
    const ran: string[] = []
    const make = (name: string) => definePlugin<{ limit?: number }>({
      name, version: '1.0.0', options: Limits, setup() { ran.push(name) },
    })
    const app = makeApp().use(make('a'), { limt: 1 } as never).use(make('b'), { limit: 1 }).use(make('c'), { lmit: 1 } as never)
    app.get('/', () => 'ok')
    const error = await bootError(app)
    assert.deepEqual(error.diagnostics.map((d) => d.code), ['ZEN_PLUGIN_OPTIONS', 'ZEN_PLUGIN_OPTIONS'])
    assert.deepEqual(ran, [])
  })

  test('a plugin without an options schema gets exactly what it was given', async () => {
    let got: unknown
    const given = { anything: 1 }
    const P = definePlugin<{ anything: number }>({ name: 'schemaless', version: '1.0.0', setup(_app, o) { got = o } })
    const app = makeApp().use(P, given)
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(got, given)
  })
})

describe('Registrar.meta reaches the graph (§10.2)', () => {
  test('what a plugin wrote is on graph.meta, namespaced by the plugin', async () => {
    const make = (name: string, value: number) => definePlugin({
      name, version: '1.0.0', setup(app) { app.meta('answer', value) },
    })
    const app = makeApp().use(make('m', 42)).use(make('n', 7))
    app.get('/', () => 'ok')
    await app.ready()
    const meta = app.graph().meta
    assert.equal(meta.get('m.answer'), 42)
    assert.equal(meta.get('n.answer'), 7)
    assert.equal(meta.size, 2)
  })

  test('an app with no plugin metadata has an empty map, not a missing one', async () => {
    const app = makeApp()
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(app.graph().meta.size, 0)
  })
})

describe('capabilities come from the adapter (§14.1, §14.2)', () => {
  const adapter = (caps: Partial<typeof DEFAULT_CAPABILITIES>): RuntimeAdapter => ({
    name: 'fake',
    caps: { ...DEFAULT_CAPABILITIES, ...caps },
    listen: () => Promise.reject(new Error('not in this test')),
  })
  const needsFs = definePlugin({ name: 'uploads', version: '1.0.0', requires: { fs: true }, setup() {} })

  test("a plugin requiring fs fails at boot on an adapter that declares fs: false", async () => {
    const app = makeApp({ adapter: adapter({ fs: false }) }).use(needsFs)
    app.get('/', () => 'ok')
    const error = await bootError(app)
    assert.equal(error.diagnostics[0]?.code, 'ZEN_CAPABILITY_UNAVAILABLE')
    assert.match(error.diagnostics[0]?.message ?? '', /requires capability "fs"/)
  })

  test('the same plugin boots on an adapter that has fs', async () => {
    const app = makeApp({ adapter: adapter({ fs: true }) }).use(needsFs)
    app.get('/', () => 'ok')
    await app.ready()
  })

  test('an explicit caps option still wins over the adapter, for tests', async () => {
    const app = makeApp({ adapter: adapter({ fs: false }), caps: { ...DEFAULT_CAPABILITIES, fs: true } }).use(needsFs)
    app.get('/', () => 'ok')
    await app.ready()
  })

  test('a string requirement asks for that exact capability', () => {
    const plugin = { name: 'ws', version: '1.0.0', requires: { websocket: 'native' }, setup() {} } as never
    const none = resolvePlugins([{ plugin, options: undefined, order: 0 }], { ...DEFAULT_CAPABILITIES, websocket: 'none' })
    assert.equal(none.diagnostics[0]?.code, 'ZEN_CAPABILITY_UNAVAILABLE')
    const library = resolvePlugins([{ plugin, options: undefined, order: 0 }], { ...DEFAULT_CAPABILITIES, websocket: 'library' })
    assert.equal(library.diagnostics[0]?.code, 'ZEN_CAPABILITY_UNAVAILABLE')
    const native = resolvePlugins([{ plugin, options: undefined, order: 0 }], { ...DEFAULT_CAPABILITIES, websocket: 'native' })
    assert.deepEqual(native.diagnostics, [])
  })

  test('core no longer claims what no adapter it ships can do', () => {
    assert.equal(DEFAULT_CAPABILITIES.compression, 'none')
    assert.equal(DEFAULT_CAPABILITIES.websocket, 'none')
  })
})
