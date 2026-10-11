import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BootError, DEFAULT_CAPABILITIES, defineConfig, definePlugin, explainRoute, healthPlugin, jsonSchema, slot, token,
  type Diagnostic, type RouteRecord, type SourceOrigin,
} from '@erenthedeveloper0/zen-core'
import { assertPlaced, here, makeApp, schema, shaped, uniqueName } from './helpers.ts'

/**
 * Origins — rfcs/0001 §5.1, §12.7, and the gate `0.2.0-alpha` set itself:
 * every boot diagnostic carries `file:line`.
 *
 * Two halves. The first holds every registration surface to the line that
 * called it, one test per form; the second provokes every boot diagnostic the
 * framework produces and requires each to point at the registration it is
 * about. Every expected line comes from `here()`, which reads the stack text
 * itself — an assertion that computed its expectation with the capture under
 * test would agree with any bug in it.
 */

const FILE = fileURLToPath(import.meta.url)
const ok = (): string => 'ok'

function route(records: readonly RouteRecord[], method: string, path: string): RouteRecord {
  const found = records.find((r) => r.method === method && r.path === path)
  assert.ok(found !== undefined, `${method} ${path} is registered`)
  return found
}

function at(origin: SourceOrigin | undefined, expected: { file: string; line: number }, what: string): void {
  assert.ok(origin !== undefined, `${what} has an origin`)
  assert.equal(origin.file, expected.file, `${what}: file`)
  assert.equal(origin.line, expected.line, `${what}: line`)
  assert.ok(origin.column > 0, `${what}: column`)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('every registration records the line that wrote it (§5.1)', () => {
  test('routes, by every verb, and all()', async () => {
    const app = makeApp()
    app.get('/g', ok); const g = here()
    app.post('/p', ok); const p = here()
    app.put('/u', ok); const u = here()
    app.patch('/a', ok); const a = here()
    app.delete('/d', ok); const d = here()
    app.head('/h', ok); const h = here()
    app.options('/o', ok); const o = here()
    app.all('/any', ok); const any = here()
    await app.ready()
    const routes = app.graph().routes
    at(route(routes, 'GET', '/g').origin, g, 'get')
    at(route(routes, 'POST', '/p').origin, p, 'post')
    at(route(routes, 'PUT', '/u').origin, u, 'put')
    at(route(routes, 'PATCH', '/a').origin, a, 'patch')
    at(route(routes, 'DELETE', '/d').origin, d, 'delete')
    at(route(routes, 'HEAD', '/h').origin, h, 'head')
    at(route(routes, 'OPTIONS', '/o').origin, o, 'options')
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      at(route(routes, method, '/any').origin, any, `all() → ${method}`)
    }
  })

  test('collections, the routes inside them, and nested ones', async () => {
    const app = makeApp()
    let inner = { file: '', line: 0 }
    let nested = { file: '', line: 0 }
    let deep = { file: '', line: 0 }
    app.collection('/api', (c) => {
      c.get('/x', ok); inner = here()
      c.collection('/v1', (v) => {
        v.post('/y', ok); deep = here()
      }); nested = here()
    }); const outer = here()
    await app.ready()
    const graph = app.graph()
    at(route(graph.routes, 'GET', '/api/x').origin, inner, 'collection route')
    at(route(graph.routes, 'POST', '/api/v1/y').origin, deep, 'nested collection route')
    // A multi-line call is placed at the line it starts on — where `here()`
    // after its closing line would not be — so the collections are compared by
    // file and by being on or before the line that closes them.
    const api = graph.collections.find((c) => c.prefix === '/api')
    const v1 = graph.collections.find((c) => c.prefix === '/api/v1')
    assert.equal(api?.origin?.file, outer.file)
    assert.ok(api !== undefined && api.origin !== undefined && api.origin.line < outer.line)
    assert.equal(v1?.origin?.file, nested.file)
    assert.ok(v1 !== undefined && v1.origin !== undefined && v1.origin.line < nested.line && v1.origin.line > (api.origin?.line ?? 0))
  })

  test('middleware — app, collection, collection options, and a route’s own use', async () => {
    const app = makeApp()
    const first = (): undefined => undefined
    const second = async (_c: unknown, next: () => Promise<unknown>): Promise<never> => (await next()) as never
    const third = (_c: unknown, reply: unknown): never => reply as never
    const scoped = (): undefined => undefined
    const listed = (): undefined => undefined
    const own = (): undefined => undefined
    let scopedAt = { file: '', line: 0 }
    let ownAt = { file: '', line: 0 }
    app.use(first); const u = here()
    app.around(second as never); const r = here()
    app.after(third as never); const f = here()
    app.collection('/c', { use: [listed] }, (c) => {
      c.use(scoped); scopedAt = here()
      c.get('/x', { use: [own] }, ok); ownAt = here()
    }); const closed = here()
    await app.ready()
    const chain = route(app.graph().routes, 'GET', '/c/x').middleware
    const byName = new Map(chain.map((m) => [m.name, m]))
    at(byName.get('first')?.origin, u, 'app.use')
    at(byName.get('second')?.origin, r, 'app.around')
    at(byName.get('third')?.origin, f, 'app.after')
    at(byName.get('scoped')?.origin, scopedAt, 'collection.use')
    at(byName.get('own')?.origin, ownAt, "a route's use: [...]")
    // Listed in the collection's options: the collection's call is the line.
    assert.equal(byName.get('listed')?.origin?.file, closed.file)
    assert.equal(byName.get('listed')?.origin?.line, closed.line - 3)
  })

  test('hooks — app, collection, a collection’s hooks option, a route’s hooks', async () => {
    const app = makeApp()
    function viaApp(): void {}
    function viaCollection(): void {}
    function viaOption(): void {}
    function viaRoute(): void {}
    function boot(): void {}
    let hooked = { file: '', line: 0 }
    let routed = { file: '', line: 0 }
    app.hook('onRequest', viaApp); const h = here()
    app.hook('onBoot', boot); const b = here()
    app.collection('/c', { hooks: { onRequest: viaOption } }, (c) => {
      c.hook('preHandler', viaCollection); hooked = here()
      c.get('/x', { hooks: { onSend: viaRoute } }, ok); routed = here()
    })
    await app.ready()
    const record = route(app.graph().routes, 'GET', '/c/x')
    const all = [...record.hooks.values()].flat()
    const named = (name: string) => all.find((hook) => hook.name === name)
    at(named('viaApp')?.origin, h, 'app.hook')
    at(named('viaCollection')?.origin, hooked, 'collection.hook')
    at(named('viaRoute')?.origin, routed, "a route's hooks: { … }")
    assert.equal(named('viaOption')?.origin?.file, FILE, "a collection's hooks: { … } is placed at the collection")
    at(app.graph().hooks.get('onBoot')?.find((hook) => hook.name === 'boot')?.origin, b, 'app.hook(onBoot)')
  })

  test('services, checks, decorations and plugins', async () => {
    const app = makeApp()
    const Service = token<number>(uniqueName('origins.service'))
    const user = slot<string>(uniqueName('origins.user'), { optional: true })
    const plugin = definePlugin({ name: uniqueName('origins.plugin'), version: '1.0.0', setup() {} })
    app.provide(Service, () => 1); const s = here()
    app.health('db', () => true); const c = here()
    app.decorate('who', user); const d = here()
    app.use(plugin); const p = here()
    await app.ready()
    const graph = app.graph()
    at(app.container.providers.find((r) => r.token === Service)?.origin, s, 'provide')
    at(graph.checks.find((check) => check.name === 'db')?.origin, c, 'health')
    at(graph.decorations.find((dec) => dec.name === 'who')?.origin, d, 'decorate')
    at(graph.plugins.find((pl) => pl.name === plugin.name)?.origin, p, 'use(plugin)')
  })

  test("a plugin's registrations are placed in its setup — or, for a first-party plugin, at its use()", async () => {
    const app = makeApp()
    let inSetup = { file: '', line: 0 }
    const local = definePlugin({
      name: uniqueName('origins.local'),
      version: '1.0.0',
      setup(r) {
        r.route({ method: 'GET', path: '/from-plugin', handler: ok }); inSetup = here()
      },
    })
    app.use(local)
    // healthPlugin is framework code all the way down: the line the
    // application wrote is the only one that caused its routes.
    app.use(healthPlugin, { path: '/healthz', readiness: '/readyz' }); const used = here()
    await app.ready()
    const routes = app.graph().routes
    at(route(routes, 'GET', '/from-plugin').origin, inSetup, "a local plugin's route")
    at(route(routes, 'GET', '/healthz').origin, used, "a first-party plugin's route")
  })

  test('defineConfig records where the configuration was declared', () => {
    const config = defineConfig({ server: { port: 1 } }); const d = here()
    at(config.origin, d, 'defineConfig')
  })

  test('relative to root, with forward slashes', async () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
    const app = makeApp({ root })
    app.get('/rel', ok); const r = here()
    await app.ready()
    const origin = route(app.graph().routes, 'GET', '/rel').origin
    assert.equal(origin?.file, 'core/test/origins.test.ts')
    assert.equal(origin?.line, r.line)
  })

  test('explainRoute prints where the route and each of its steps were registered', async () => {
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
    const app = makeApp({ root })
    function authenticate(): void {}
    app.use(authenticate); const u = here()
    app.get('/explained', ok); const g = here()
    await app.ready()
    const text = explainRoute(route(app.graph().routes, 'GET', '/explained'))
    assert.match(text, new RegExp(`registered  test/origins\\.test\\.ts:${g.line}:`))
    assert.match(text, new RegExp(`authenticate\\s+test/origins\\.test\\.ts:${u.line}:`))
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * One boot diagnostic per case, and the lines it must point at. `build`
 * registers onto a fresh app and returns the expected lines in this file.
 */
interface Case {
  readonly name: string
  readonly code: string
  readonly options?: Parameters<typeof makeApp>[0]
  readonly build: (app: ReturnType<typeof makeApp>) => readonly number[]
}

const CASES: readonly Case[] = [
  {
    name: 'a duplicate route names both registrations',
    code: 'ZEN_ROUTE_DUPLICATE',
    build: (app) => {
      app.get('/dup', ok); const a = here().line
      app.get('/dup', ok); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'a duplicate route name names both routes',
    code: 'ZEN_ROUTE_DUPLICATE',
    build: (app) => {
      app.get('/one', { name: 'same' }, ok); const a = here().line
      app.get('/two', { name: 'same' }, ok); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'an ambiguous pair names both',
    code: 'ZEN_ROUTE_AMBIGUOUS',
    build: (app) => {
      app.get('/n/:a<int>', ok); const a = here().line
      app.get('/n/:b<float>', ok); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'an invalid path',
    code: 'ZEN_ROUTE_INVALID_PATH',
    build: (app) => {
      app.get('/files/*rest/more', ok); return [here().line]
    },
  },
  {
    name: 'an unknown parameter type',
    code: 'ZEN_PARAM_TYPE_UNKNOWN',
    build: (app) => {
      app.get('/t/:id<wat>', ok); return [here().line]
    },
  },
  {
    name: 'a params schema its path cannot satisfy',
    code: 'ZEN_PARAM_MISMATCH',
    build: (app) => {
      const params = shaped({ type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] })
      app.get('/users/:id', { params }, ok); return [here().line]
    },
  },
  {
    name: "a route's own bad timeout",
    code: 'ZEN_TIMEOUT_INVALID',
    build: (app) => {
      app.get('/slow', { timeout: 'banana' as never }, ok); return [here().line]
    },
  },
  {
    name: "a collection's bad timeout names the route and the collection",
    code: 'ZEN_TIMEOUT_INVALID',
    build: (app) => {
      let routeLine = 0
      app.collection('/c', { timeout: 'nope' as never }, (c) => {
        c.get('/x', ok); routeLine = here().line
      }); const closed = here().line
      return [routeLine, closed - 2]
    },
  },
  {
    name: 'an unknown hook phase',
    code: 'ZEN_HOOK_PHASE_UNKNOWN',
    build: (app) => {
      app.hook('onReqest' as never, () => undefined); return [here().line]
    },
  },
  {
    name: "a misspelled phase in a route's hooks",
    code: 'ZEN_HOOK_PHASE_UNKNOWN',
    build: (app) => {
      app.get('/h', { hooks: { preHandlr: () => undefined } as never }, ok); return [here().line]
    },
  },
  {
    name: "an application phase in a route's hooks",
    code: 'ZEN_HOOK_PHASE_UNKNOWN',
    build: (app) => {
      app.get('/r', { hooks: { onReady: () => undefined } as never }, ok); return [here().line]
    },
  },
  {
    name: 'a phase this build cannot fire',
    code: 'ZEN_HOOK_PHASE_UNAVAILABLE',
    build: (app) => {
      app.hook('onRegister', () => undefined); return [here().line]
    },
  },
  {
    name: 'an unusable health check',
    code: 'ZEN_HEALTH_CHECK_INVALID',
    build: (app) => {
      app.health('has space', () => true); return [here().line]
    },
  },
  {
    name: 'a health check registered twice names both',
    code: 'ZEN_HEALTH_CHECK_DUPLICATE',
    build: (app) => {
      app.health('db', () => true); const a = here().line
      app.health('db', () => true); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'a required check nobody registered is placed at the health plugin',
    code: 'ZEN_HEALTH_CHECK_MISSING',
    build: (app) => {
      app.use(healthPlugin, { checks: ['db'] }); return [here().line]
    },
  },
  {
    name: 'a service whose dependency has no provider',
    code: 'ZEN_DI_MISSING',
    build: (app) => {
      const A = token<number>(uniqueName('cat.a'))
      const B = token<number>(uniqueName('cat.b'))
      app.provide(A, { deps: [B] as never, factory: (b: number) => b }); return [here().line]
    },
  },
  {
    name: 'a cycle names every service in it',
    code: 'ZEN_DI_CYCLE',
    build: (app) => {
      const A = token<number>(uniqueName('cat.cycle.a'))
      const B = token<number>(uniqueName('cat.cycle.b'))
      app.provide(A, { deps: [B] as never, factory: (b: number) => b }); const a = here().line
      app.provide(B, { deps: [A] as never, factory: (x: number) => x }); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'a captive dependency names both services',
    code: 'ZEN_DI_LIFETIME',
    build: (app) => {
      const Scoped = token<number>(uniqueName('cat.scoped'))
      const Single = token<number>(uniqueName('cat.single'))
      app.provide(Scoped, { factory: () => 1, lifetime: 'scoped' }); const a = here().line
      app.provide(Single, { deps: [Scoped] as never, factory: (n: number) => n }); const b = here().line
      return [b, a]
    },
  },
  {
    name: 'a response key that is not a status',
    code: 'ZEN_SCHEMA_UNCONVERTIBLE',
    build: (app) => {
      app.get('/k', { response: { abc: jsonSchema({ type: 'string' }) } as never }, ok); return [here().line]
    },
  },
  {
    name: 'jsonSchema() asked to validate a request',
    code: 'ZEN_SCHEMA_UNCONVERTIBLE',
    build: (app) => {
      app.post('/v', { body: jsonSchema({ type: 'object' }) }, ok); return [here().line]
    },
  },
  {
    name: 'a declared media type that is not one',
    code: 'ZEN_MEDIA_TYPE_INVALID',
    build: (app) => {
      const S = jsonSchema({ type: 'string' })
      app.get('/m', { response: { 200: { 'application/json': S, 'text/*': S } } as never }, ok); return [here().line]
    },
  },
  {
    name: 'a media type with no encoder',
    code: 'ZEN_MEDIA_TYPE_UNSUPPORTED',
    build: (app) => {
      app.get('/e', { response: { 200: { 'text/x-zen-none': jsonSchema({ type: 'string' }) } } as never }, ok); return [here().line]
    },
  },
  {
    name: 'statuses that offer different media types',
    code: 'ZEN_NEGOTIATION_INCONSISTENT',
    build: (app) => {
      const S = jsonSchema({ type: 'string' })
      app.get('/i', { response: { 200: { 'application/json': S, 'text/plain': S }, 201: { 'application/json': S } } as never }, ok); return [here().line]
    },
  },
  {
    name: 'a response that would return a writeOnly field',
    code: 'ZEN_RESPONSE_WRITE_ONLY',
    build: (app) => {
      const S = jsonSchema({ type: 'object', properties: { secret: { type: 'string', writeOnly: true } } })
      app.get('/w', { response: { 200: S } }, ok); return [here().line]
    },
  },
  {
    name: "a collection's when that answers with a non-boolean",
    code: 'ZEN_CONFIG_INVALID',
    build: (app) => {
      app.collection('/maybe', { when: (() => 'yes') as never }, () => {}); return [here().line]
    },
  },
  {
    name: "a collection's when that throws",
    code: 'ZEN_CONFIG_INVALID',
    build: (app) => {
      app.collection('/boom', { when: () => { throw new Error('no') } }, () => {}); return [here().line]
    },
  },
  {
    name: 'a configuration thunk that throws is placed at defineConfig',
    code: 'ZEN_CONFIG_INVALID',
    options: { config: defineConfig({ server: { port: () => { throw new Error('no port') } } }) }, // MARK-THUNK
    build: () => [lineOf('MARK-' + 'THUNK')],
  },
  {
    name: 'an invalid environment is placed at the schema that refused it',
    code: 'ZEN_ENV_INVALID',
    options: {
      config: defineConfig({ // MARK-ENV
        env: schema(() => ({ issues: [{ message: 'required', path: ['PORT'] }] })),
        server: {},
      }),
    },
    build: () => [lineOf('MARK-' + 'ENV')],
  },
  {
    name: 'a plugin registered twice names both use() calls',
    code: 'ZEN_PLUGIN_DUPLICATE',
    build: (app) => {
      const p = definePlugin({ name: uniqueName('cat.dup'), version: '1.0.0', setup() {} })
      app.use(p); const a = here().line
      app.use(p); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'a plugin missing its dependency',
    code: 'ZEN_PLUGIN_MISSING',
    build: (app) => {
      const p = definePlugin({ name: uniqueName('cat.needs'), version: '1.0.0', dependsOn: { nothere: '*' }, setup() {} })
      app.use(p); return [here().line]
    },
  },
  {
    name: 'a dependency at the wrong version names both plugins',
    code: 'ZEN_PLUGIN_VERSION',
    build: (app) => {
      const base = definePlugin({ name: uniqueName('cat.base'), version: '1.0.0', setup() {} })
      const needs = definePlugin({ name: uniqueName('cat.v'), version: '1.0.0', dependsOn: { [base.name]: '^2.0.0' }, setup() {} })
      app.use(base); const a = here().line
      app.use(needs); const b = here().line
      return [b, a]
    },
  },
  {
    name: 'conflicting plugins name both',
    code: 'ZEN_PLUGIN_CONFLICT',
    build: (app) => {
      const one = definePlugin({ name: uniqueName('cat.one'), version: '1.0.0', setup() {} })
      const two = definePlugin({ name: uniqueName('cat.two'), version: '1.0.0', conflictsWith: [one.name], setup() {} })
      app.use(one); const a = here().line
      app.use(two); const b = here().line
      return [b, a]
    },
  },
  {
    name: 'a plugin cycle names every plugin in it',
    code: 'ZEN_PLUGIN_CYCLE',
    build: (app) => {
      const x = uniqueName('cat.x')
      const y = uniqueName('cat.y')
      app.use(definePlugin({ name: x, version: '1.0.0', dependsOn: { [y]: '*' }, setup() {} })); const a = here().line
      app.use(definePlugin({ name: y, version: '1.0.0', dependsOn: { [x]: '*' }, setup() {} })); const b = here().line
      return [a, b]
    },
  },
  {
    name: 'a plugin given options it does not accept',
    code: 'ZEN_PLUGIN_OPTIONS',
    build: (app) => {
      const p = definePlugin<{ limit: number }>({
        name: uniqueName('cat.opts'),
        version: '1.0.0',
        options: schema((value) => (typeof (value as { limit?: unknown })?.limit === 'number'
          ? { value: value as { limit: number } }
          : { issues: [{ message: 'limit must be a number', path: ['limit'] }] })) as never,
        setup() {},
      })
      app.use(p, { limit: 'x' } as never); return [here().line]
    },
  },
  {
    name: 'a plugin whose setup threw names its use() and the line that threw',
    code: 'ZEN_PLUGIN_OPTIONS',
    build: (app) => {
      let threw = 0
      const p = definePlugin({
        name: uniqueName('cat.throws'),
        version: '1.0.0',
        setup() {
          threw = here().line + 1
          throw new Error('setup failed')
        },
      })
      app.use(p); const used = here().line
      return [used, () => threw] as never
    },
  },
  {
    name: 'a plugin requiring a capability the runtime lacks',
    code: 'ZEN_CAPABILITY_UNAVAILABLE',
    options: { caps: { ...DEFAULT_CAPABILITIES, fs: false } },
    build: (app) => {
      const p = definePlugin({ name: uniqueName('cat.fs'), version: '1.0.0', requires: { fs: true }, setup() {} })
      app.use(p); return [here().line]
    },
  },
  {
    name: 'a malformed redirect allowlist is placed at the app',
    code: 'ZEN_CONFIG_INVALID',
    options: { redirect: { allowExternal: ['not a url'] } },
    build: () => [],
  },
  {
    name: 'an app-wide bad timeout is placed at the route and at the app',
    code: 'ZEN_TIMEOUT_INVALID',
    options: { timeout: 'forever' as never },
    build: (app) => {
      app.get('/t', ok); return [here().line]
    },
  },
]

/** The line of this file that contains `text` — for a registration that is not a statement of its own. */
function lineOf(text: string): number {
  const index = readFileSync(FILE, 'utf8').split('\n').findIndex((line) => line.includes(text))
  assert.ok(index >= 0, `"${text}" is in this file`)
  return index + 1
}

describe('every boot diagnostic carries file:line (§5.1, §12.7)', () => {
  for (const c of CASES) {
    test(`${c.code}: ${c.name}`, async () => {
      const app = makeApp(c.options)
      const expected = c.build(app)
      const error = await app.ready().then(() => null, (e: unknown) => e)
      assert.ok(error instanceof BootError, `${c.code} refuses the boot`)
      // Every diagnostic, not only the one the case is about.
      assertPlaced(error)
      const diagnostic = error.diagnostics.find((d: Diagnostic) => d.code === c.code)
      assert.ok(diagnostic !== undefined, `${c.code} is reported; got ${error.diagnostics.map((d) => d.code).join(', ')}`)
      const lines = (diagnostic.origins ?? []).map((o) => o.line)
      for (const line of expected) {
        const wanted = typeof line === 'function' ? (line as () => number)() : line
        assert.ok(lines.includes(wanted), `${c.code} points at line ${wanted}; it points at ${lines.join(', ')}`)
      }
      // And it says so when rendered.
      for (const origin of diagnostic.origins ?? []) {
        assert.ok(error.message.includes(`${origin.file}:${origin.line}:${origin.column}`), 'rendered')
      }
    })
  }
})

