import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalJson, contractFingerprint, defineConfig, graphFingerprint, jsonSchema, serializeGraph, slot, token,
  type AppGraph, type GraphDocument,
} from '@erenthedeveloper0/zen-core'
import { makeApp, schema, shaped, uniqueName } from './helpers.ts'

/**
 * The graph as data — rfcs/0001 §2.4, and a gate `0.2.0-alpha` set itself: it
 * round-trips to canonical JSON, with a fingerprint that does not move when
 * nothing about the application did.
 */

const User = jsonSchema({ title: 'User', type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id'] })
const NewUser = shaped({ type: 'object', properties: { name: { type: 'string', description: 'Display name' } }, required: ['name'] })

interface Def { readonly method: 'get' | 'post' | 'delete'; readonly path: string; readonly name: string }
const DEFS: readonly Def[] = [
  { method: 'get', path: '/users', name: 'users.list' },
  { method: 'post', path: '/users', name: 'users.create' },
  { method: 'get', path: '/users/:id<int>', name: 'users.show' },
  { method: 'delete', path: '/users/:id<int>', name: 'users.remove' },
  { method: 'get', path: '/health', name: 'health' },
  { method: 'get', path: '/orders/:id', name: 'orders.show' },
]

function shuffle<T>(list: readonly T[], seed: number): T[] {
  const out = [...list]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** One service, declared once: a token is a name, and the graph lists services by it. */
const Db = token<{ ok: true }>(uniqueName('graph.db'))

/** One application, its routes registered in the order `defs` gives. */
function build(defs: readonly Def[]) {
  const app = makeApp()
  app.provide(Db, () => ({ ok: true }))
  app.use(function authenticate() { return undefined })
  app.hook('onRequest', function rateLimit() { return undefined })
  app.schema('User', User)
  for (const def of defs) {
    if (def.method === 'post') app.post(def.path, { name: def.name, body: NewUser, response: { 201: User } }, () => ({ id: 1 }))
    else if (def.method === 'delete') app.delete(def.path, { name: def.name, inject: { db: Db } }, () => null)
    else app.get(def.path, { name: def.name, response: { 200: User }, meta: { tags: ['users'] } }, () => ({ id: 1 }))
  }
  return app
}

describe('serializeGraph: the graph as canonical JSON (§2.4)', () => {
  test('a document survives JSON and still checks out against its own fingerprints', async () => {
    const app = build(DEFS)
    await app.ready()
    const document = await app.graphDocument()
    const text = JSON.stringify(document)
    const parsed = JSON.parse(text) as GraphDocument
    assert.deepEqual(parsed, document, 'nothing in it is not JSON')
    assert.equal(canonicalJson(parsed), canonicalJson(document))
    assert.equal(await graphFingerprint(parsed), document.fingerprint)
    for (const route of parsed.routes) assert.equal(await contractFingerprint(route), route.contract, route.id)
    assert.match(document.fingerprint, /^sha256-[0-9a-f]{64}$/)
  })

  test('the fingerprint is stable across ten boots that register the routes in shuffled orders', async () => {
    const seen = new Set<string>()
    const contracts = new Set<string>()
    for (let boot = 0; boot < 10; boot++) {
      const app = build(shuffle(DEFS, boot + 1))
      await app.ready()
      const document = await app.graphDocument()
      seen.add(document.fingerprint)
      contracts.add(JSON.stringify(document.routes.map((r) => [r.id, r.contract])))
    }
    assert.equal(seen.size, 1, 'one application, one fingerprint')
    assert.equal(contracts.size, 1)
  })

  test('slots are the process\'s, not the application\'s: one declared elsewhere moves nothing', async () => {
    const before = build(DEFS)
    await before.ready()
    const first = await before.graphDocument()
    // Another module of the same process declares a slot (§7.4).
    const elsewhere = slot<number>(uniqueName('graph.elsewhere'), { optional: true })
    const after = build(DEFS)
    await after.ready()
    const second = await after.graphDocument()
    assert.ok(second.slots.some((s) => s.name === elsewhere.name), 'the document still lists it')
    assert.equal(second.fingerprint, first.fingerprint)
  })

  test('the fingerprint is over the canonical order: a document whose lists were re-ordered keeps it, unless an order was a fact', async () => {
    const app = build(DEFS)
    app.hook('onRequest', function first() { return undefined })
    app.hook('onRequest', function second() { return undefined })
    await app.ready()
    const document = await app.graphDocument()
    for (let seed = 1; seed <= 10; seed++) {
      const reordered: GraphDocument = {
        ...document,
        routes: shuffle(document.routes, seed),
        services: shuffle(document.services, seed + 100),
        schemas: shuffle(document.schemas, seed + 200),
      }
      assert.equal(await graphFingerprint(reordered), document.fingerprint, `seed ${seed}`)
    }
    // Hooks within a phase run in order, so reversing them is a different application.
    const swapped = { ...document, hooks: [...document.hooks].reverse() }
    assert.notEqual(await graphFingerprint(swapped), document.fingerprint, 'two onRequest hooks swapped run in the other order')
  })

  test('order that is a fact about the application is kept: a chain of middleware is not sorted', async () => {
    const app = makeApp()
    app.use(function second() { return undefined })
    app.use(function first() { return undefined })
    app.get('/x', () => 'ok')
    await app.ready()
    const document = await app.graphDocument()
    assert.deepEqual(document.routes[0]?.middleware.map((m) => m.name), ['second', 'first'])
  })

  test('where code sits is provenance, not identity: moving a registration does not move the fingerprint', async () => {
    const here = makeApp()
    here.get('/a', { response: { 200: User } }, () => ({ id: 1 }))
    const there = makeApp()

    there.get('/a', { response: { 200: User } }, () => ({ id: 1 }))
    await here.ready()
    await there.ready()
    const [a, b] = [await here.graphDocument(), await there.graphDocument()]
    assert.notDeepEqual(a.routes[0]?.origin, b.routes[0]?.origin)
    assert.equal(a.fingerprint, b.fingerprint)
  })

  test('a contract moves with a schema and not with its description', async () => {
    const contract = async (body: unknown) => {
      const app = makeApp()
      app.post('/x', { body: body as never }, () => 'ok')
      await app.ready()
      return (await app.graphDocument()).routes[0]?.contract
    }
    const base = await contract(shaped({ type: 'object', properties: { n: { type: 'string' } } }))
    const described = await contract(shaped({ type: 'object', description: 'A thing', properties: { n: { type: 'string', title: 'N' } } }))
    const bounded = await contract(shaped({ type: 'object', properties: { n: { type: 'string', maxLength: 3 } } }))
    assert.equal(described, base)
    assert.notEqual(bounded, base)
  })

  test('no secret reaches it: configuration is the redacted snapshot', async () => {
    const config = defineConfig({
      env: shaped({ type: 'object', properties: { API_KEY: { type: 'string', format: 'password' } }, required: ['API_KEY'] }),
      api: { key: (env: { API_KEY: string }) => env.API_KEY },
    })
    const app = makeApp({ config, env: { API_KEY: 'sk_live_do_not_leak' } })
    app.get('/', () => 'ok')
    await app.ready()
    assert.doesNotMatch(JSON.stringify(await app.graphDocument()), /sk_live_do_not_leak/)
  })

  test('functions appear by identity, and anything else as JSON', async () => {
    class Pool { size = 3 }
    const app = makeApp()
    const user = slot<string>(uniqueName('graph.user'), { optional: true })
    app.decorate('who', user)
    app.get('/m', { meta: { fn: function hello() {}, map: new Map([['a', 1]]), pool: new Pool(), big: 10n } }, function show() { return 'ok' })
    await app.ready()
    const document = await app.graphDocument()
    const route = document.routes[0]
    assert.equal(route?.handler.name, 'show')
    assert.deepEqual(route?.meta, { fn: { function: 'hello' }, map: { a: 1 }, pool: { object: 'Pool' }, big: '10' })
    assert.equal(document.decorations.find((d) => d.name === 'who')?.slot, user.name)
  })

  test('it is computed once, and only for an application that has booted', async () => {
    const app = makeApp()
    app.get('/', () => 'ok')
    assert.throws(() => app.graphDocument(), { code: 'ZEN_APP_NOT_READY' })
    await app.ready()
    assert.equal(app.graphDocument(), app.graphDocument(), 'the same promise')
    const direct = await serializeGraph(app.graph() as AppGraph)
    assert.equal(direct.fingerprint, (await app.graphDocument()).fingerprint)
  })
})

describe('fingerprintHeaders (§2.4)', () => {
  test('on, every response carries Zen-Graph, and a route’s its Zen-Contract', async () => {
    const app = makeApp({ fingerprintHeaders: true })
    app.get('/a', { response: { 200: User } }, () => ({ id: 1 }))
    const res = await app.inject('GET', '/a')
    const document = await app.graphDocument()
    assert.equal(res.header('zen-graph'), document.fingerprint)
    assert.equal(res.header('zen-contract'), document.routes[0]?.contract)
    const missing = await app.inject('GET', '/nope')
    assert.equal(missing.header('zen-graph'), document.fingerprint)
    assert.equal(missing.header('zen-contract'), undefined)
  })

  test('off — the default — no header, and no line in any pipeline', async () => {
    const off = makeApp()
    const on = makeApp({ fingerprintHeaders: true })
    for (const app of [off, on]) app.get('/a', () => 'ok')
    const res = await off.inject('GET', '/a')
    await on.ready()
    assert.equal(res.header('zen-graph'), undefined)
    const pipeline = (app: typeof off) => app.generatedSource().find((u) => u.name === 'pipeline:GET_/a')?.source ?? ''
    assert.doesNotMatch(pipeline(off), /onSend/)
    assert.match(pipeline(on), /onSend/)
  })
})

void schema
