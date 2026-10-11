import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, Conflict, explainRoute, issue, markSync, token, type RouteRecord,
} from '@erenthedeveloper0/zen-core'
import { here, makeApp, shaped, uniqueName } from './helpers.ts'

/**
 * Three route-spec keys `0.2.0-alpha` builds: `check` (§11.7), `inject`
 * (§15.1) and `intake` (§4.2 stage 6, §19.2).
 */

const route = (records: readonly RouteRecord[], path: string): RouteRecord => {
  const found = records.find((r) => r.path === path)
  assert.ok(found !== undefined, `${path} is registered`)
  return found
}

const NewUser = shaped({
  type: 'object',
  properties: { email: { type: 'string' }, age: { type: 'integer' } },
  required: ['email'],
})

const pipelineOf = (app: ReturnType<typeof makeApp>, id: string): string =>
  app.generatedSource().find((u) => u.name === `pipeline:${id}`)?.source ?? ''

// ─────────────────────────────────────────────────────────────────────────────

describe('check: business rules after validation (§11.7)', () => {
  test('an issue it returns is a 422 in the envelope a schema failure uses, tagged source: check', async () => {
    const app = makeApp()
    app.post('/users', {
      body: NewUser,
      check: (ctx) => {
        if (ctx.body.email === 'taken@x.io') return issue('email', 'taken', 'Email already registered')
      },
    }, (ctx) => ({ created: ctx.body.email }))
    const refused = await app.inject('POST', '/users', { body: { email: 'taken@x.io' } })
    assert.equal(refused.status, 422)
    const problem = refused.json<{ code: string; errors: Array<Record<string, unknown>> }>()
    assert.equal(problem.code, 'ZEN_VALIDATION')
    assert.deepEqual(problem.errors, [{ source: 'check', path: ['email'], code: 'taken', message: 'Email already registered' }])
    const accepted = await app.inject('POST', '/users', { body: { email: 'new@x.io' } })
    assert.equal(accepted.status, 200)
  })

  test('several issues at once, from an async check', async () => {
    const app = makeApp()
    app.post('/u', {
      body: NewUser,
      check: async (ctx) => {
        await Promise.resolve()
        return [issue('email', 'blocked', 'Blocked domain'), issue(['age'], 'too_young', 'Must be 18', { expected: '>= 18' })]
      },
    }, () => 'never')
    const res = await app.inject('POST', '/u', { body: { email: 'a@b.c', age: 3 } })
    assert.equal(res.status, 422)
    assert.equal(res.json<{ errors: unknown[] }>().errors.length, 2)
  })

  test('it runs after the schemas and before postValidation and preHandler; a schema failure never reaches it', async () => {
    const order: string[] = []
    const app = makeApp()
    app.hook('postValidation', () => { order.push('postValidation') })
    app.hook('preHandler', () => { order.push('preHandler') })
    app.post('/o', { body: NewUser, check: () => { order.push('check') } }, () => { order.push('handler'); return 'ok' })
    await app.inject('POST', '/o', { body: { email: 'x' } })
    assert.deepEqual(order, ['check', 'postValidation', 'preHandler', 'handler'])
    order.length = 0
    const malformed = await app.inject('POST', '/o', { body: { age: 'x' } })
    assert.equal(malformed.status, 422)
    assert.deepEqual(order, [], 'a request the schemas refused is never checked')
  })

  test('a rule that means something else throws it — a 409 is a 409', async () => {
    const app = makeApp()
    app.post('/c', { body: NewUser, check: () => { throw new Conflict('already exists') } }, () => 'never')
    const res = await app.inject('POST', '/c', { body: { email: 'x' } })
    assert.equal(res.status, 409)
  })

  test('a value that is not an issue is a bug in the check, not a pass', async () => {
    const app = makeApp()
    app.post('/b', { body: NewUser, check: (() => true) as never }, () => 'never')
    const res = await app.inject('POST', '/b', { body: { email: 'x' } })
    assert.equal(res.status, 500)
  })

  test('the interpreted twin agrees', async () => {
    const app = makeApp({ pipeline: 'simple' })
    app.post('/t', { body: NewUser, check: () => issue('email', 'nope', 'no') }, () => 'never')
    const res = await app.inject('POST', '/t', { body: { email: 'x' } })
    assert.equal(res.status, 422)
  })

  test('explainRoute lists it where it runs; a marked-sync check keeps the route synchronous', async () => {
    const app = makeApp()
    app.get('/s', { query: shaped({ type: 'object', properties: { q: { type: 'string' } } }), check: () => undefined }, () => 'ok')
    app.get('/sync', { check: markSync(function noRule() { return undefined }) }, markSync(() => 'ok'))
    await app.ready()
    assert.match(explainRoute(route(app.graph().routes, '/s')), /validate\s+query\n\s+check\s+check — 422 on issues/)
    assert.match(explainRoute(route(app.graph().routes, '/sync')), /check\s+noRule — 422 on issues[\s\S]*sync path\s+synchronous/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('inject: declarative injection (§15.1)', () => {
  test('singletons are resolved once, at boot, into one frozen object every request shares', async () => {
    const Clock = token<{ now(): number }>(uniqueName('inj.clock'))
    const Repo = token<{ find(id: number): string }>(uniqueName('inj.repo'))
    let built = 0
    const seen: object[] = []
    const app = makeApp()
    app.provide(Clock, () => ({ now: () => 7 }))
    app.provide(Repo, { deps: [Clock] as never, factory: (clock: { now(): number }) => { built++; return { find: (id: number) => `user ${id} @${clock.now()}` } } })
    app.get('/users/:id<int>', { inject: { repo: Repo } }, (ctx, deps) => {
      seen.push(deps)
      return deps.repo.find(ctx.params.id)
    })
    await app.ready()
    assert.equal(built, 1, 'built at boot, before any request')
    assert.equal((await app.inject('GET', '/users/3')).text(), 'user 3 @7')
    await app.inject('GET', '/users/4')
    assert.equal(seen[0], seen[1], 'the same object')
    assert.ok(Object.isFrozen(seen[0]))
    assert.match(pipelineOf(app, 'GET_/users/:id<int>'), /d\.handler\(ctx, d\.deps\)/)
    assert.deepEqual(route(app.graph().routes, '/users/:id<int>').dependencies, [Clock.name, Repo.name].sort())
  })

  test('an asynchronous singleton is awaited at boot too', async () => {
    const Pool = token<{ ok: boolean }>(uniqueName('inj.pool'))
    const app = makeApp()
    app.provide(Pool, async () => ({ ok: true }))
    app.get('/p', { inject: { pool: Pool } }, (_ctx, { pool }) => ({ ok: pool.ok }))
    assert.deepEqual((await app.inject('GET', '/p')).json(), { ok: true })
  })

  test('a scoped service is resolved per request, from the request, beside the boot-time singletons', async () => {
    const Tenant = token<{ id: number }>(uniqueName('inj.tenant'))
    const Config = token<string>(uniqueName('inj.config'))
    let tenants = 0
    const app = makeApp()
    app.provide(Tenant, { factory: () => ({ id: ++tenants }), lifetime: 'scoped' })
    app.provide(Config, () => 'cfg')
    app.get('/t', { inject: { tenant: Tenant, config: Config } }, (ctx, deps) => ({
      tenant: deps.tenant.id, same: ctx.resolve(Tenant) === deps.tenant, config: deps.config,
    }))
    assert.deepEqual((await app.inject('GET', '/t')).json(), { tenant: 1, same: true, config: 'cfg' })
    assert.deepEqual((await app.inject('GET', '/t')).json(), { tenant: 2, same: true, config: 'cfg' })
  })

  test('an asynchronous scoped service is awaited before the handler runs', async () => {
    const Tx = token<{ open: boolean }>(uniqueName('inj.tx'))
    const app = makeApp({ pipeline: 'simple' })
    app.provide(Tx, { factory: async () => ({ open: true }), lifetime: 'scoped' })
    app.get('/tx', { inject: { tx: Tx } }, (_ctx, { tx }) => ({ open: tx.open }))
    assert.deepEqual((await app.inject('GET', '/tx')).json(), { open: true })
  })

  test('a token with no provider is a boot error naming the route and its line; an optional one is undefined', async () => {
    const Missing = token<number>(uniqueName('inj.missing'))
    const Maybe = token<number>(uniqueName('inj.maybe'), { optional: true })
    const app = makeApp()
    app.get('/m', { inject: { n: Missing } }, () => 'x'); const at = here()
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const diagnostic = error.diagnostics.find((d) => d.code === 'ZEN_DI_MISSING')
    assert.match(diagnostic?.message ?? '', /GET \/m injects "n" from service ".*inj\.missing.*", which has no provider/)
    assert.equal(diagnostic?.origins?.[0]?.line, at.line)

    const optional = makeApp()
    optional.get('/o', { inject: { n: Maybe } }, (_ctx, { n }) => ({ present: n !== undefined }))
    assert.deepEqual((await optional.inject('GET', '/o')).json(), { present: false })
  })

  test('explainRoute lists what the handler is handed', async () => {
    const Db = token<number>(uniqueName('inj.db'))
    const app = makeApp()
    app.provide(Db, () => 1)
    app.get('/e', { inject: { db: Db } }, () => 'ok')
    await app.ready()
    assert.match(explainRoute(route(app.graph().routes, '/e')), new RegExp(`inject\\s+db ← ${Db.name.replace(/\./g, '\\.')}`))
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('intake: a body policy per route (§4.2 stage 6, §19.2)', () => {
  const big = { text: 'x'.repeat(200) }

  test("a route's own limit applies to it alone", async () => {
    const app = makeApp()
    app.post('/small', { body: shaped({ type: 'object' }), intake: { maxSize: 64 } }, () => 'ok')
    app.post('/default', { body: shaped({ type: 'object' }) }, () => 'ok')
    assert.equal((await app.inject('POST', '/small', { body: big })).status, 413)
    assert.equal((await app.inject('POST', '/small', { body: { a: 1 } })).status, 200)
    assert.equal((await app.inject('POST', '/default', { body: big })).status, 200)
  })

  test('depth and field limits override too', async () => {
    const app = makeApp()
    app.post('/deep', { body: shaped({ type: 'object' }), intake: { maxDepth: 1 } }, () => 'ok')
    app.post('/form', { body: shaped({ type: 'object' }), intake: { maxFields: 2 } }, () => 'ok')
    assert.equal((await app.inject('POST', '/deep', { body: { a: { b: { c: 1 } } } })).json<{ code: string }>().code, 'ZEN_BODY_INVALID')
    const form = await app.inject('POST', '/form', { body: 'a=1&b=2&c=3', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(form.status, 413)
  })

  test("mode 'raw' hands the handler the bytes", async () => {
    const app = makeApp()
    app.post('/raw', { intake: { mode: 'raw' } }, (ctx) => ({ bytes: ctx.body.length, first: ctx.body[0] }))
    const res = await app.inject('POST', '/raw', { body: new Uint8Array([7, 8, 9]), headers: { 'content-type': 'application/octet-stream' } })
    assert.deepEqual(res.json(), { bytes: 3, first: 7 })
  })

  test("mode 'stream' hands it the chunks, and enforces the limit as they arrive", async () => {
    const app = makeApp()
    app.post('/up', { intake: { mode: 'stream', maxSize: 8 } }, async (ctx) => {
      let total = 0
      for await (const chunk of ctx.body) total += chunk.length
      return { total }
    })
    const small = await app.inject('POST', '/up', { body: new Uint8Array(5), headers: { 'content-type': 'application/octet-stream' } })
    assert.deepEqual(small.json(), { total: 5 })
    // inject declares a Content-Length, which is refused before the handler runs.
    const declared = await app.inject('POST', '/up', { body: new Uint8Array(20), headers: { 'content-type': 'application/octet-stream' } })
    assert.equal(declared.status, 413)
  })

  test('a stream cannot be validated, and a limit has to be a limit — both refused at boot', async () => {
    const app = makeApp()
    app.post('/s', { body: shaped({ type: 'object' }), intake: { mode: 'stream' } }, () => 'x'); const at = here()
    app.post('/n', { intake: { maxSize: -1 } }, () => 'x')
    app.post('/m', { intake: { mode: 'chunked' as never } }, () => 'x')
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const messages = error.diagnostics.filter((d) => d.code === 'ZEN_CONFIG_INVALID').map((d) => d.message)
    assert.equal(messages.length, 3)
    assert.ok(messages.some((m) => /POST \/s streams its body and also declares a `body` schema/.test(m)))
    assert.equal(error.diagnostics.find((d) => d.message.includes('POST /s'))?.origins?.[0]?.line, at.line)
  })

  test('an intake with no schema reads the body unvalidated; explainRoute shows the route’s own limits', async () => {
    const app = makeApp()
    app.post('/any', { intake: { maxSize: 1000 } }, (ctx) => ({ got: ctx.body }))
    assert.deepEqual((await app.inject('POST', '/any', { body: { a: 1 } })).json(), { got: { a: 1 } })
    assert.match(explainRoute(route(app.graph().routes, '/any')), /intake\s+read \+ parse body — maxSize 1000 B \(this route\)/)
  })
})
