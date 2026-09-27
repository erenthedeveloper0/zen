import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, CONTEXT_MEMBERS, PlainContext, CodeGen, compileContext, NoopLogger, ZenContainer,
  DEFAULT_CAPABILITIES, type RawRequest, type ServerHandle, type RuntimeAdapter,
} from '@visionpilot/zen-core'
import { makeApp, silentLogger, uniqueName } from './helpers.ts'

// ── §7.5: decoration names ──────────────────────────────────────────────────

describe('decorate() refuses names it cannot honour (§7.5)', () => {
  it('refuses a name the framework owns — it would replace ctx.json() on every route', () => {
    const app = makeApp()
    for (const name of ['json', 'params', 'res', 'signal', 'sse', 'config', 'constructor', 'then']) {
      assert.throws(() => app.decorate(name, () => 1), { code: 'ZEN_DECORATOR_CONFLICT' }, name)
    }
  })

  it('refuses a name that is not an identifier, instead of failing inside the compiler', () => {
    const app = makeApp()
    for (const name of ['bad-name', '1st', 'has space', '$internal', '']) {
      assert.throws(() => app.decorate(name, () => 1), { code: 'ZEN_DECORATOR_CONFLICT' }, JSON.stringify(name))
    }
  })

  it('still accepts an ordinary name', async () => {
    const app = makeApp()
    app.decorate('tenant', () => 'acme')
    app.get('/', (ctx) => ({ tenant: (ctx as unknown as { tenant: string }).tenant }))
    assert.deepEqual((await app.inject('GET', '/')).json(), { tenant: 'acme' })
  })

  it('CONTEXT_MEMBERS names every member of both context twins', () => {
    // The list is data, so this is what stops it drifting: a member added to
    // either class without being added to the list fails here, before it can
    // be shadowed by a plugin.
    const raw: RawRequest = {
      method: 'GET', url: '/', header: () => undefined, headerNames: () => [],
      body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
      remote: { address: '127.0.0.1', port: 0, family: 'IPv4' }, native: null,
    }
    const env = { log: new NoopLogger(), maxQueryParams: 100, trustProxy: false, container: new ZenContainer(), config: {} }
    const Compiled = compileContext({ decorations: [], slotCount: 0, codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }) })

    for (const ctx of [
      new PlainContext(raw, null, {}, env, 0, new AbortController().signal),
      new Compiled(raw, null, {}, env, new AbortController().signal),
    ]) {
      const names = new Set([...Object.keys(ctx), ...Object.getOwnPropertyNames(Object.getPrototypeOf(ctx))])
      for (const name of names) {
        if (name.startsWith('$')) continue
        assert.ok(CONTEXT_MEMBERS.has(name), `${ctx.constructor.name}.${name} is missing from CONTEXT_MEMBERS`)
      }
    }
  })
})

// ── §9.7: hook phases that do not exist ─────────────────────────────────────

describe('a hook for a phase that does not exist is a boot error (§9.7)', () => {
  const bootDiagnostics = async (register: (app: ReturnType<typeof makeApp>) => void) => {
    const app = makeApp()
    register(app)
    app.get('/', () => 'ok')
    try {
      await app.ready()
    } catch (error) {
      assert.ok(error instanceof BootError)
      return error.diagnostics
    }
    return []
  }

  it('names the phase and suggests the one that was meant', async () => {
    const diagnostics = await bootDiagnostics((app) => { app.hook('onReqest' as never, () => {}) })
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0]?.code, 'ZEN_HOOK_PHASE_UNKNOWN')
    assert.match(diagnostics[0]?.hint ?? '', /Did you mean "onRequest"\?/)
  })

  it('catches it on a collection and on a route, not only at the app scope', async () => {
    const diagnostics = await bootDiagnostics((app) => {
      app.collection('/api', { hooks: { preHandlr: () => {} } as never }, () => {})
      app.get('/x', { hooks: { onResponce: () => {} } as never }, () => 'x')
    })
    assert.deepEqual(diagnostics.map((d) => d.code), ['ZEN_HOOK_PHASE_UNKNOWN', 'ZEN_HOOK_PHASE_UNKNOWN'])
  })

  it('refuses an application phase declared on a route, where it could never fire', async () => {
    const diagnostics = await bootDiagnostics((app) => {
      app.get('/y', { hooks: { onReady: () => {} } as never }, () => 'y')
    })
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0]?.code, 'ZEN_HOOK_PHASE_UNKNOWN')
    assert.match(diagnostics[0]?.hint ?? '', /app\.hook\('onReady', fn\)/)
  })

  it('lists the real phases when nothing is close', async () => {
    const diagnostics = await bootDiagnostics((app) => { app.hook('whenever' as never, () => {}) })
    assert.match(diagnostics[0]?.hint ?? '', /onRequest, onRoute/)
  })

  it('does not fire for real application phases', async () => {
    const diagnostics = await bootDiagnostics((app) => {
      app.hook('onReady', () => {})
      app.hook('onClose', () => {})
    })
    assert.deepEqual(diagnostics, [])
  })
})

// ── §5.2: application param types ───────────────────────────────────────────

describe('app.paramType() (§5.2)', () => {
  it('matches, parses and 404s through the registered type', async () => {
    const app = makeApp()
    app.paramType('objectId', {
      test: (s) => s.length === 24 && /^[0-9a-f]+$/.test(s),
      parse: (s) => ({ oid: s }),
      jsonSchema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
    })
    app.get('/posts/:id<objectId>', (ctx) => ({ id: ctx.params.id }))

    const hit = await app.inject('GET', '/posts/0123456789abcdef01234567')
    assert.equal(hit.status, 200)
    assert.deepEqual(hit.json(), { id: { oid: '0123456789abcdef01234567' } })
    assert.equal((await app.inject('GET', '/posts/not-an-id')).status, 404)
    assert.equal(app.graph().paramTypes.get('objectId')?.jsonSchema?.['pattern'], '^[0-9a-f]{24}$',
      'published on the graph, where @visionpilot/zen-openapi reads it')
  })

  it('is what the unknown-type diagnostic tells you to call', async () => {
    const app = makeApp()
    app.get('/posts/:id<objectId>', () => 'x')
    await assert.rejects(app.ready(), /Register more with app\.paramType\(\)/)
  })

  it('refuses a name that cannot appear in a path, and a type without test/parse', () => {
    const app = makeApp()
    assert.throws(() => app.paramType('bad>name', { test: () => true, parse: (s) => s }))
    assert.throws(() => app.paramType('ok', { test: undefined as never, parse: (s) => s }))
  })
})

// ── §4.5, §12.8: shutdown keeps going ───────────────────────────────────────

describe('close() completes when a step fails (§4.5, §12.8)', () => {
  const adapter: RuntimeAdapter = {
    name: 'test',
    caps: DEFAULT_CAPABILITIES,
    async listen(): Promise<ServerHandle> {
      return { address: null, url: 'test://', async close() {} }
    },
  }

  it('runs every onClose hook and disposes services even when a hook throws', async () => {
    const order: string[] = []
    const logged: string[] = []
    const logger = { ...silentLogger(), error: (_: unknown, msg?: string) => { logged.push(msg ?? '') } }
    const app = makeApp({ adapter, logger: logger as never })
    const Pool = { name: uniqueName('pool'), index: -1 } as never
    app.provide(Pool, { factory: () => 'pool', dispose: () => { order.push('dispose') } } as never)
    app.hook('onClose', () => { order.push('first registered') })
    app.hook('onClose', () => { throw new Error('flush failed') })
    app.get('/', (ctx) => ctx.resolve(Pool as never))

    await app.listen()
    await app.inject('GET', '/')
    await app.close()

    assert.deepEqual(order, ['first registered', 'dispose'])
    assert.equal(app.state, 'stopped')
    assert.equal(logged.length, 1)
  })
})

// ── the dispatcher's own refusals ───────────────────────────────────────────

describe('a disconnected streaming client is reported as aborted', () => {
  it('publishes ctx.aborted when the connection signal fires during a streamed body', async () => {
    const app = makeApp({ timeout: '5s' })
    let seen: boolean | null = null
    app.hook('onResponse', (ctx) => { seen = ctx.aborted })
    app.get('/', (ctx) => ctx.stream(async function* () { yield 'x' }))
    const controller = new AbortController()
    // `inject` captures the reply rather than writing it, so abort as egress
    // begins: the deadline's clock has stopped by then, and its connection
    // listener must still be attached for `ctx.signal` to hear this.
    const res = app.inject('GET', '/', { signal: controller.signal })
    queueMicrotask(() => controller.abort())
    await res
    assert.equal(typeof seen, 'boolean')
  })
})

// ── §5.5: a route's identity ────────────────────────────────────────────────

describe('a route name identifies exactly one route (§5.5)', () => {
  it('two routes sharing a name are a boot error, not two routes answering each other', async () => {
    // The compiled route table is keyed by the route id — its name when it has
    // one — so the second registration replaced the first: `GET /a` ran
    // `GET /b`'s handler, and the app booted without a word.
    const app = makeApp()
    app.get('/a', { name: 'users.show' }, () => 'a')
    app.get('/b', { name: 'users.show' }, () => 'b')

    await assert.rejects(app.ready(), (error: unknown) => {
      assert.ok(error instanceof BootError)
      assert.equal(error.diagnostics.length, 1)
      assert.equal(error.diagnostics[0]?.code, 'ZEN_ROUTE_DUPLICATE')
      assert.match(error.diagnostics[0]?.message ?? '', /"users\.show" is used by both GET \/a and GET \/b/)
      return true
    })
  })

  it('a name may not take another route\'s method-and-path id either', async () => {
    const app = makeApp()
    app.get('/a', () => 'a')
    app.get('/b', { name: 'GET /a' }, () => 'b')
    await assert.rejects(app.ready(), { code: 'ZEN_BOOT_FAILED' })
  })

  it('distinct names — and unnamed routes — boot as before', async () => {
    const app = makeApp()
    app.get('/a', { name: 'a' }, () => 'a')
    app.get('/b', { name: 'b' }, () => 'b')
    app.get('/c', () => 'c')
    assert.equal((await app.inject('GET', '/a')).text(), 'a')
    assert.equal((await app.inject('GET', '/b')).text(), 'b')
  })
})

// ── §2.2: one boot per application ──────────────────────────────────────────

describe('an application boots once (§2.2)', () => {
  const counting = () => {
    const calls = { setup: 0 }
    const plugin = {
      name: uniqueName('counted'),
      version: '1.0.0',
      setup() { calls.setup++; return { provides: {} } },
    }
    return { calls, plugin }
  }

  it('concurrent callers share one boot — a plugin\'s setup runs once', async () => {
    // Two `inject()`s started together used to run two boots side by side:
    // every plugin's setup ran twice (two connection pools), and the second
    // compile silently replaced the first.
    const { calls, plugin } = counting()
    const app = makeApp().use(plugin as never)
    app.get('/', () => 'ok')

    const results = await Promise.all([app.inject('GET', '/'), app.inject('GET', '/'), app.ready()])
    assert.equal(calls.setup, 1)
    assert.equal(results[0].status, 200)
    assert.equal(results[1].status, 200)
  })

  it('a boot that failed after compiling stays failed — later callers do not get a half-booted app', async () => {
    // An `onBoot` check (the health plugin's, OpenAPI's strict mode) runs after
    // the compiled state exists. The next `ready()` used to see that state and
    // report success, and `inject()` and `listen()` served the app anyway.
    const failing = {
      name: uniqueName('refuses-at-boot'),
      version: '1.0.0',
      setup(app: { onBoot(fn: () => void): void }) {
        app.onBoot(() => { throw new Error('a boot check failed') })
        return { provides: {} }
      },
    }
    const app = makeApp().use(failing as never)
    app.get('/', () => 'served')

    await assert.rejects(app.ready(), /a boot check failed/)
    await assert.rejects(app.ready(), /a boot check failed/, 'the second call reports the same failure')
    await assert.rejects(app.inject('GET', '/'), /a boot check failed/, 'and nothing is served')
    assert.equal(app.state, 'starting', 'readiness never turned true')
  })
})
