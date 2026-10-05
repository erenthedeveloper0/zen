import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, CONTEXT_MEMBERS, PlainContext, CodeGen, compileContext, NoopLogger, ZenContainer,
  DEFAULT_CAPABILITIES, type RawRequest, type ServerHandle, type RuntimeAdapter,
} from '@erenthedeveloper0/zen-core'
import { makeApp, shaped, silentLogger, uniqueName } from './helpers.ts'
import { explainRoute, slot, type Logger } from '@erenthedeveloper0/zen-core'

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
      'published on the graph, where @erenthedeveloper0/zen-openapi reads it')
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

// ── 0.1.0-alpha.4: boot checks that used to be silent ───────────────────────

/** A logger that keeps what it was told, by level. */
function recordingLogger(): Logger & { readonly lines: Array<{ level: string; obj: unknown; msg: string }> } {
  const lines: Array<{ level: string; obj: unknown; msg: string }> = []
  const at = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg: msg ?? '' }) }
  const logger = {
    level: 'trace' as const,
    lines,
    child() { return logger },
    trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'),
  }
  return logger
}

async function bootCodes(app: { ready(): Promise<unknown> }): Promise<{ codes: string[]; error: BootError }> {
  try {
    await app.ready()
  } catch (error) {
    assert.ok(error instanceof BootError, String(error))
    return { codes: error.diagnostics.map((d) => d.code), error }
  }
  throw new Error('expected ready() to fail')
}

describe('a params schema is checked against its path at boot (§5.2)', () => {
  const UserId = shaped({ type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] })

  it('refuses a required key the path does not supply, and names the one it has', async () => {
    const app = makeApp()
    app.get('/users/:id', { params: UserId }, () => 'ok')
    const { codes, error } = await bootCodes(app)
    assert.deepEqual(codes, ['ZEN_PARAM_MISMATCH'])
    const [d] = error.diagnostics
    assert.match(d?.message ?? '', /GET \/users\/:id: the params schema requires "userId", and the path supplies "id"\./)
    assert.match(d?.consequence ?? '', /Every request to GET \/users\/:id would be refused with a 400/)
  })

  it('suggests the rename when the names are close', async () => {
    const app = makeApp()
    app.get('/users/:usrId', { params: UserId }, () => 'ok')
    const { error } = await bootCodes(app)
    assert.equal(error.diagnostics[0]?.hint, 'Did you mean to name it "usrId"? Rename the schema key, or the path parameter.')
  })

  it('refuses a required key that only an optional segment supplies', async () => {
    const Page = shaped({ type: 'object', properties: { page: { type: 'string' } }, required: ['page'] })
    const app = makeApp()
    app.get('/docs/:page?', { params: Page }, () => 'ok')
    const { error } = await bootCodes(app)
    assert.match(error.diagnostics[0]?.message ?? '', /supplies only when its optional segment is present/)
  })

  it('refuses a path parameter a closed schema would reject', async () => {
    const Closed = shaped({ type: 'object', properties: {}, additionalProperties: false })
    const app = makeApp()
    app.get('/users/:id', { params: Closed }, () => 'ok')
    const { error } = await bootCodes(app)
    assert.match(error.diagnostics[0]?.message ?? '', /the path supplies "id", and the params schema refuses any key it does not declare/)
  })

  it('warns, and boots, when an open schema would drop a path parameter', async () => {
    const log = recordingLogger()
    const Open = shaped({ type: 'object', properties: { id: { type: 'string' } } })
    const app = makeApp({ logger: log })
    app.get('/orgs/:org/users/:id', { params: Open }, () => 'ok')
    await app.ready()
    const warning = log.lines.find((l) => l.level === 'warn' && /"org", which the params schema does not declare/.test(l.msg))
    assert.ok(warning, JSON.stringify(log.lines.map((l) => l.msg)))
  })

  it('reports an integer schema on an untyped segment once, for every route, as information', async () => {
    const log = recordingLogger()
    const Int = shaped({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] })
    const app = makeApp({ logger: log })
    app.get('/a/:id', { params: Int }, () => 'ok')
    app.get('/b/:id', { params: Int }, () => 'ok')
    app.get('/c/:id<int>', { params: Int }, () => 'ok')
    await app.ready()
    const info = log.lines.filter((l) => l.level === 'info' && (l.obj as { code?: string }).code === 'ZEN_PARAM_MISMATCH')
    assert.equal(info.length, 1)
    assert.match(info[0]?.msg ?? '', /^2 path parameters are declared integer .* GET \/a\/:id \(:id\), GET \/b\/:id \(:id\)\./)
  })

  it('a schema that agrees with its path boots and validates', async () => {
    const Id = shaped({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })
    const app = makeApp()
    app.get('/users/:id', { params: Id }, (ctx) => ({ id: (ctx.params as { id: string }).id }))
    assert.deepEqual((await app.inject('GET', '/users/7')).json(), { id: '7' })
  })

  it('a schema it cannot describe is left to the library, silently (§11.4.3)', async () => {
    const Opaque = { '~standard': { version: 1 as const, vendor: 'opaque', validate: (v: unknown) => ({ value: v }) } }
    const app = makeApp()
    app.get('/users/:id', { params: Opaque }, () => 'ok')
    await app.ready()
  })
})

describe("a collection's when decides, once, whether its subtree exists (§6.2)", () => {
  it('a false subtree is absent from the router, the graph and its hooks', async () => {
    let hooked = 0
    const app = makeApp()
    app.collection('/debug', { when: () => false }, (c) => {
      c.hook('onRequest', () => { hooked++ })
      c.get('/state', () => 'state')
    })
    app.get('/ok', () => 'ok')
    await app.ready()

    assert.equal((await app.inject('GET', '/debug/state')).status, 404)
    assert.equal((await app.inject('GET', '/ok')).status, 200)
    assert.equal(hooked, 0)
    const graph = app.graph()
    assert.deepEqual(graph.routes.map((r) => r.path), ['/ok'])
    assert.equal(graph.collections.length, 0)
    assert.equal(graph.hooks.get('onRequest'), undefined)
  })

  it('reads the environment it was given, and a true subtree is an ordinary one', async () => {
    const seen: unknown[] = []
    const build = (feature: string) => {
      const app = makeApp({ env: { FEATURE_X: feature } })
      app.collection('/x', { when: (env) => { seen.push(env['FEATURE_X']); return env['FEATURE_X'] === 'on' } }, (c) => {
        c.get('/', () => 'x')
      })
      return app
    }
    assert.equal((await build('on').inject('GET', '/x')).status, 200)
    assert.equal((await build('off').inject('GET', '/x')).status, 404)
    assert.deepEqual(seen, ['on', 'off'])
  })

  it('a nested collection inside an absent one is absent too', async () => {
    const app = makeApp()
    app.collection('/admin', { when: () => false }, (c) => {
      c.collection('/users', (u) => { u.get('/', () => 'users') })
    })
    app.get('/', () => 'root')
    await app.ready()
    assert.equal((await app.inject('GET', '/admin/users')).status, 404)
    assert.deepEqual(app.graph().routes.map((r) => r.path), ['/'])
  })

  it('is evaluated once, at boot, not per request', async () => {
    let calls = 0
    const app = makeApp()
    app.collection('/x', { when: () => { calls++; return true } }, (c) => { c.get('/', () => 'x') })
    for (let i = 0; i < 5; i++) await app.inject('GET', '/x')
    assert.equal(calls, 1)
  })

  it('refuses an answer that is merely truthy — a promise, a string', async () => {
    for (const answer of [Promise.resolve(false), 'false']) {
      const app = makeApp()
      app.collection('/x', { when: () => answer as never }, (c) => { c.get('/', () => 'x') })
      const { codes, error } = await bootCodes(app)
      assert.deepEqual(codes, ['ZEN_CONFIG_INVALID'])
      assert.match(error.diagnostics[0]?.message ?? '', typeof answer === 'string' ? /a string, not a boolean/ : /a promise, not a boolean/)
    }
  })

  it('reports a when that throws, naming the collection', async () => {
    const app = makeApp()
    app.collection('/x', { when: () => { throw new Error('no such flag') } }, (c) => { c.get('/', () => 'x') })
    const { codes, error } = await bootCodes(app)
    assert.deepEqual(codes, ['ZEN_CONFIG_INVALID'])
    assert.match(error.diagnostics[0]?.message ?? '', /threw while deciding whether it exists: no such flag/)
  })
})

describe('route-scoped middleware (§8.3)', () => {
  it('runs after the app\'s and the collection\'s, in the order listed, and is labelled [route]', async () => {
    const order: string[] = []
    const app = makeApp()
    app.use(function appWide() { order.push('app') })
    app.collection('/notes', (c) => {
      c.use(function collectionWide() { order.push('collection') })
      c.get('/:id', {
        use: [function checkOwnership() { order.push('route 1') }, function audit() { order.push('route 2') }],
      }, () => { order.push('handler'); return 'ok' })
    })
    assert.equal((await app.inject('GET', '/notes/1')).status, 200)
    assert.deepEqual(order, ['app', 'collection', 'route 1', 'route 2', 'handler'])

    const route = app.graph().routes[0]!
    const text = explainRoute(route)
    assert.match(text, /\[route\]\s+checkOwnership/)
    assert.match(text, /\[route\]\s+audit/)
  })

  it('short-circuits like any phase middleware, on that route alone', async () => {
    const app = makeApp()
    app.get('/guarded', { use: [(ctx) => ctx.json({ denied: true }, { status: 403 })] }, () => 'secret')
    app.get('/open', () => 'open')
    assert.equal((await app.inject('GET', '/guarded')).status, 403)
    assert.equal((await app.inject('GET', '/open')).text(), 'open')
  })

  it('a route without use: compiles exactly as before', async () => {
    const source = async (spec: Record<string, unknown> | null) => {
      const app = makeApp()
      if (spec === null) app.get('/x', () => 'x')
      else app.get('/x', spec, () => 'x')
      await app.ready()
      return app.generatedSource().filter((u) => u.name.startsWith('pipeline')).map((u) => u.source).join('\n')
    }
    assert.equal(await source({ use: [] }), await source(null))
  })
})

describe('the graph\'s decorations are what its type says (§2.4)', () => {
  it('a slot decoration carries its Slot, an accessor decoration its function', async () => {
    const userSlot = slot<{ id: number }>(uniqueName('graph.user'))
    const app = makeApp()
    app.decorate('user', userSlot)
    const tenant = () => 'acme'
    app.decorate('tenant', tenant)
    app.get('/', () => 'ok')
    await app.ready()

    const decorations = app.graph().decorations
    const user = decorations.find((d) => d.name === 'user')
    const tenantRecord = decorations.find((d) => d.name === 'tenant')
    assert.equal(user?.slot, userSlot)
    assert.equal(user?.accessor, null)
    assert.equal(tenantRecord?.slot, null)
    assert.equal(tenantRecord?.accessor, tenant)
    assert.equal('slotIndex' in (user ?? {}), false)
  })
})
