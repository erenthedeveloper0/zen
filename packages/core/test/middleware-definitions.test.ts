import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, defineMiddleware, definePlugin, explainRoute, markSync, token, type Diagnostic, type RouteRecord,
} from '@erenthedeveloper0/zen-core'
import { here, makeApp, schema, uniqueName } from './helpers.ts'

/**
 * §8.6 middleware as configured factories, and §8.7 conditional middleware.
 */

const route = (records: readonly RouteRecord[], path: string): RouteRecord => {
  const found = records.find((r) => r.path === path)
  assert.ok(found !== undefined, `${path} is registered`)
  return found
}

/** Options for a rate limiter — `limit` required, `window` defaulted, nothing else accepted. */
const LimitOptions = Object.assign(
  schema<{ limit: number; window: number }>((value) => {
    const v = (value ?? {}) as { limit?: unknown; window?: unknown }
    if (typeof v.limit !== 'number') return { issues: [{ message: 'limit must be a number', path: ['limit'] }] }
    return { value: { limit: v.limit, window: typeof v.window === 'number' ? v.window : 60 } }
  }),
  {
    toJSONSchema: () => ({
      type: 'object',
      properties: { limit: { type: 'number' }, window: { type: 'number' } },
      required: ['limit'],
    }),
  },
)

async function bootError(app: ReturnType<typeof makeApp>): Promise<BootError> {
  const error = await app.ready().then(() => null, (e: unknown) => e)
  assert.ok(error instanceof BootError, 'the boot is refused')
  return error
}

function only(error: BootError, code: string): Diagnostic {
  const matching = error.diagnostics.filter((d) => d.code === code)
  assert.equal(matching.length, 1, `one ${code}; got ${error.diagnostics.map((d) => d.code).join(', ')}`)
  return matching[0] as Diagnostic
}

// ─────────────────────────────────────────────────────────────────────────────

describe('defineMiddleware: options checked at boot, setup run once (§8.6)', () => {
  test('setup receives the validated output and runs once; what it returns runs per request', async () => {
    const seen: unknown[] = []
    let setups = 0
    const limiter = defineMiddleware({
      name: 'limiter',
      options: LimitOptions,
      setup(options) {
        setups++
        seen.push(options)
        let hits = 0
        return (ctx) => {
          hits++
          if (hits > options.limit) return (ctx as unknown as { json(b: unknown, i: unknown): unknown }).json({ limited: true }, { status: 429 }) as never
        }
      },
    })
    const app = makeApp()
    app.use(limiter({ limit: 2 }))
    app.get('/', () => 'ok')
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await app.inject('GET', '/')).status)
    assert.deepEqual(statuses, [200, 200, 429])
    assert.equal(setups, 1)
    assert.deepEqual(seen, [{ limit: 2, window: 60 }], 'the schema output, defaults applied')
  })

  test('a misspelled option is refused at boot with the key it was meant to be, at the line that used it', async () => {
    const limiter = defineMiddleware({ name: 'limiter', options: LimitOptions, setup: () => () => undefined })
    const app = makeApp()
    app.use(limiter({ limt: 100 } as never)); const at = here()
    app.get('/', () => 'ok')
    const diagnostic = only(await bootError(app), 'ZEN_MIDDLEWARE_OPTIONS')
    assert.match(diagnostic.message, /Middleware "limiter" was given options it does not accept/)
    assert.match(diagnostic.hint ?? '', /"limt" is not an option of limiter — did you mean "limit"\?/)
    assert.equal(diagnostic.origins?.[0]?.line, at.line)
  })

  test('an asynchronous options schema is awaited', async () => {
    const Async = Object.assign(
      schema<{ n: number }>(() => ({ value: { n: 1 } })),
      { '~standard': { version: 1 as const, vendor: 'async', validate: async () => ({ issues: [{ message: 'nope', path: ['n'] }] }) } },
    )
    const mw = defineMiddleware({ name: 'async', options: Async as never, setup: () => () => undefined })
    const app = makeApp()
    app.use(mw({}))
    app.get('/', () => 'ok')
    assert.match(only(await bootError(app), 'ZEN_MIDDLEWARE_OPTIONS').message, /n: nope/)
  })

  test('one configured instance on many routes is set up once; two instances, twice', async () => {
    let setups = 0
    const tag = defineMiddleware({
      name: 'tag',
      setup() { setups++; return (ctx) => { (ctx as unknown as { res: { header(n: string, v: string): void } }).res.header('x-tag', 'y') } },
    })
    const shared = tag()
    const app = makeApp()
    app.get('/a', { use: [shared] }, () => 'a')
    app.get('/b', { use: [shared] }, () => 'b')
    app.collection('/c', { use: [tag()] }, (c) => { c.get('/d', () => 'd') })
    await app.ready()
    assert.equal(setups, 2)
    assert.equal((await app.inject('GET', '/a')).header('x-tag'), 'y')
    assert.equal((await app.inject('GET', '/c/d')).header('x-tag'), 'y')
  })

  test("setup resolves the application's services — after every plugin has registered its own", async () => {
    const Greeting = token<string>(uniqueName('greeting'))
    const greet = defineMiddleware({
      name: 'greet',
      setup(_options, app) {
        const text = app.resolve(Greeting)
        return (ctx) => { (ctx as unknown as { res: { header(n: string, v: string): void } }).res.header('x-greeting', text) }
      },
    })
    const app = makeApp()
    app.use(greet())
    app.use(definePlugin({ name: uniqueName('greeting-plugin'), version: '1.0.0', setup(r) { r.provide(Greeting, () => 'hello') } }))
    app.get('/', () => 'ok')
    assert.equal((await app.inject('GET', '/')).header('x-greeting'), 'hello')
  })

  test('a setup that throws names the registration and the line that threw', async () => {
    let threw = 0
    const broken = defineMiddleware({
      name: 'broken',
      setup() {
        threw = here().line + 1
        throw new Error('cannot set up')
      },
    })
    const app = makeApp()
    app.use(broken()); const used = here()
    app.get('/', () => 'ok')
    const diagnostic = only(await bootError(app), 'ZEN_MIDDLEWARE_OPTIONS')
    assert.match(diagnostic.message, /Middleware "broken" threw during setup: cannot set up/)
    assert.deepEqual(diagnostic.origins?.map((o) => o.line), [used.line, threw])
  })

  test('a setup that returns something other than a function is refused', async () => {
    const odd = defineMiddleware({ name: 'odd', setup: () => 'not a function' as never })
    const app = makeApp()
    app.use(odd())
    app.get('/', () => 'ok')
    assert.match(only(await bootError(app), 'ZEN_MIDDLEWARE_OPTIONS').message, /setup returned a string, not a middleware function/)
  })

  test('a configured middleware is phase middleware: around() and after() refuse it', () => {
    const mw = defineMiddleware({ name: 'phase-only', setup: () => () => undefined })
    const app = makeApp()
    assert.throws(() => app.around(mw() as never), { code: 'ZEN_MIDDLEWARE_OPTIONS' })
    assert.throws(() => app.after(mw() as never), { code: 'ZEN_MIDDLEWARE_OPTIONS' })
    assert.throws(() => app.use(42 as never), { code: 'ZEN_MIDDLEWARE_OPTIONS' })
  })

  test('explainRoute names it by its definition, and the pipeline is the one the plain function compiles to', async () => {
    const stamp = markSync(function stamp(): undefined { return undefined })
    const mw = defineMiddleware({ name: 'stamp', setup: () => stamp })
    const configured = makeApp()
    configured.use(mw())
    configured.get('/x', () => 'ok')
    const plain = makeApp()
    plain.use(stamp, { name: 'stamp' })
    plain.get('/x', () => 'ok')
    await configured.ready()
    await plain.ready()
    assert.match(explainRoute(route(configured.graph().routes, '/x')), /phase\s+\[global\]\s+stamp/)
    const pipeline = (app: typeof plain) => app.generatedSource().find((u) => u.name === 'pipeline:GET_/x')?.source
    assert.equal(pipeline(configured), pipeline(plain))
  })

  test("a plugin's registrar takes one too", async () => {
    let ran = 0
    const counted = defineMiddleware({ name: 'counted', setup: () => () => { ran++ } })
    const app = makeApp()
    app.use(definePlugin({ name: uniqueName('mw-plugin'), version: '1.0.0', setup(r) { r.use(counted()) } }))
    app.get('/', () => 'ok')
    await app.inject('GET', '/')
    assert.equal(ran, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('conditional middleware: when (§8.7)', () => {
  test('when.env false omits the step: it never runs, the pipeline holds no line for it, explainRoute says so', async () => {
    let ran = 0
    const audit = function audit(): undefined { ran++; return undefined }
    const app = makeApp({ env: { MODE: 'prod' } })
    app.use(audit, { when: { env: (env) => env['MODE'] === 'dev' } })
    app.get('/x', () => 'ok')
    const without = makeApp()
    without.get('/x', () => 'ok')
    await app.inject('GET', '/x')
    await without.ready()
    assert.equal(ran, 0)
    const pipeline = (a: typeof app) => a.generatedSource().find((u) => u.name === 'pipeline:GET_/x')?.source
    assert.equal(pipeline(app), pipeline(without), 'byte-identical to never registering it')
    assert.match(explainRoute(route(app.graph().routes, '/x')), /audit \[omitted at boot\]/)
    assert.equal(route(app.graph().routes, '/x').middleware[0]?.omitted, true)
  })

  test('when.env true keeps it, compiled exactly as an unconditional registration', async () => {
    let ran = 0
    const audit = function audit(): undefined { ran++; return undefined }
    const conditional = makeApp({ env: { MODE: 'dev' } })
    conditional.use(audit, { when: { env: (env) => env['MODE'] === 'dev' } })
    conditional.get('/x', () => 'ok')
    const plain = makeApp()
    plain.use(audit)
    plain.get('/x', () => 'ok')
    await conditional.inject('GET', '/x')
    await plain.ready()
    assert.equal(ran, 1)
    const pipeline = (a: typeof plain) => a.generatedSource().find((u) => u.name === 'pipeline:GET_/x')?.source
    assert.equal(pipeline(conditional), pipeline(plain))
  })

  test('when.env is decided once per registration, however many routes it covers', async () => {
    let decided = 0
    const app = makeApp()
    app.use(() => undefined, { when: { env: () => { decided++; return true } } })
    for (let i = 0; i < 5; i++) app.get(`/r${i}`, () => 'ok')
    await app.ready()
    assert.equal(decided, 1)
  })

  test('when.env must answer a boolean, synchronously, and a throw is a boot diagnostic', async () => {
    const app = makeApp()
    app.use(() => undefined, { name: 'truthy', when: { env: () => 'yes' as never } }); const a = here()
    app.use(() => undefined, { name: 'later', when: { env: (async () => true) as never } })
    app.use(() => undefined, { name: 'boom', when: { env: () => { throw new Error('no env') } } })
    app.get('/', () => 'ok')
    const error = await bootError(app)
    const messages = error.diagnostics.filter((d) => d.code === 'ZEN_CONFIG_INVALID').map((d) => d.message)
    assert.equal(messages.length, 3)
    assert.ok(messages.some((m) => /"truthy" answered with a string, not a boolean/.test(m)))
    assert.ok(messages.some((m) => /"later" answered with a promise/.test(m)))
    assert.ok(messages.some((m) => /"boom" threw .*no env/.test(m)))
    assert.equal(error.diagnostics.find((d) => d.message.includes('"truthy"'))?.origins?.[0]?.line, a.line)
  })

  test('when.request guards the step: only true runs it, and explainRoute marks it guarded', async () => {
    const seen: string[] = []
    const app = makeApp()
    app.use(function trace(ctx: unknown) { seen.push((ctx as { path: string }).path); return undefined }, {
      when: { request: (ctx) => ((ctx as unknown as { headers: Record<string, string | undefined> }).headers['x-trace'] === 'on') as boolean },
    })
    app.use(function truthy() { seen.push('truthy'); return undefined }, {
      when: { request: () => 'yes' as never },
    })
    app.get('/x', () => 'ok')
    await app.inject('GET', '/x', { headers: { 'x-trace': 'on' } })
    await app.inject('GET', '/x', { headers: { 'x-trace': 'off' } })
    assert.deepEqual(seen, ['/x'], 'traced once; a truthy non-boolean never runs a step')
    assert.match(explainRoute(route(app.graph().routes, '/x')), /trace \[guarded\]/)
  })

  test('guarded phase, around and after steps behave the same in the compiled pipeline and its twin', async () => {
    const orders: string[][] = []
    for (const pipeline of ['optimized', 'simple'] as const) {
      const order: string[] = []
      orders.push(order)
      const on = (ctx: unknown) => (ctx as { headers: Record<string, string | undefined> }).headers['x-on'] === '1'
      const app = makeApp({ pipeline })
      app.use(function phase() { order.push('phase'); return undefined }, { when: { request: on as never } })
      app.around(async function wrap(_ctx, next) { order.push('around:in'); const r = await next(); order.push('around:out'); return r }, { when: { request: on as never } })
      app.after(function stamp(_ctx, reply) { order.push('after'); return reply }, { when: { request: on as never } })
      app.get('/', () => { order.push('handler'); return 'ok' })
      await app.inject('GET', '/', { headers: { 'x-on': '1' } })
      order.push('—')
      await app.inject('GET', '/', { headers: { 'x-on': '0' } })
    }
    // On: every step, in the order unconditional ones run (`after` is in the
    // epilogue the wrapped segment finishes with). Off: the handler alone.
    assert.deepEqual(orders[0], ['phase', 'around:in', 'handler', 'after', 'around:out', '—', 'handler'])
    assert.deepEqual(orders[1], orders[0], 'the interpreted twin agrees')
  })

  test('a function is refused: which kind of condition it is has to be said', () => {
    const app = makeApp()
    assert.throws(
      () => app.use(() => undefined, { when: (() => true) as never }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'ZEN_CONFIG_INVALID')
        assert.match((error as Error).message, /when: \{ env: \(env\) => … \}.*when: \{ request: \(ctx\) => … \}/)
        return true
      },
    )
  })

  test('a guarded step marked synchronous keeps the route synchronous (§8.4)', async () => {
    const stamp = markSync(function stamp(): undefined { return undefined })
    const app = makeApp()
    app.use(stamp, { when: { request: () => true } })
    app.get('/x', markSync(() => 'ok'))
    await app.ready()
    assert.match(explainRoute(route(app.graph().routes, '/x')), /sync path\s+synchronous/)
  })
})
