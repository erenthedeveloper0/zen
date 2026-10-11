import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { explainRequest, issue, jsonSchema, slot } from '@erenthedeveloper0/zen-core'
import { makeApp, shaped, uniqueName } from './helpers.ts'

/**
 * EXPLAIN ANALYZE for HTTP — the plan `explainRoute` prints, with what one
 * request actually did at each step (§8.5).
 */

const Order = jsonSchema({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] })
const NewOrder = shaped({ type: 'object', properties: { item: { type: 'string' } }, required: ['item'] })

function shop(options: Parameters<typeof makeApp>[0] = {}) {
  const user = slot<string>(uniqueName('explain.user'), { optional: true })
  const app = makeApp({ timeout: '2s', ...options })
  app.hook('onRequest', function rateLimit() { return undefined })
  app.hook('onRequest', function cors(ctx) { ctx.res.vary('Origin'); return undefined })
  app.collection('/api', (c) => {
    c.use(function authenticate(ctx) { ctx.set(user, 'ada'); return undefined })
    c.post('/orders', {
      name: 'orders.create',
      body: NewOrder,
      check: (ctx) => (ctx.body.item === 'banned' ? issue('item', 'banned', 'Not sold here') : undefined),
      response: { 201: Order },
    }, async function createOrder(ctx) {
      ctx.res.status(201)
      return { id: 7, costCents: 120, supplier: 'acme' } as never
    })
  })
  return { app, user }
}

describe('explainRequest (§8.5)', () => {
  test('every step that ran, in the order it ran, with what it did', async () => {
    const { app, user } = shop()
    const explained = await explainRequest(app, 'POST', '/api/orders', { body: { item: 'tea' } })
    assert.equal(explained.status, 201)
    assert.deepEqual(
      explained.events.map((e) => `${e.kind} ${e.name} ${e.outcome}`),
      [
        'onRequest rateLimit continue',
        'onRequest cors continue',
        'phase authenticate continue',
        'intake read the body ok',
        'validate body ok',
        'check check ok',
        'handler createOrder ran',
        'serialize 201 ok',
      ],
    )
    const notes = (name: string) => explained.events.find((e) => e.name === name)?.notes ?? []
    assert.ok(notes('cors').includes('staged vary: Origin'))
    assert.ok(notes('authenticate').includes(`set ${user.name}`))
    assert.ok(notes('createOrder').includes('async'))
    assert.ok(notes('201').includes('dropped undeclared: costCents, supplier'), 'the fields the schema kept off the wire')
    assert.equal(explained.deadline?.budgetMs, 2000)
    assert.match(explained.text, /^POST \/api\/orders → orders\.create/)
    assert.match(explained.text, /wire\s+201\s+\d+ headers · 8 B/)
  })

  test('a refusal shows where the request stopped', async () => {
    const { app } = shop()
    const malformed = await explainRequest(app, 'POST', '/api/orders', { body: { nope: 1 } })
    assert.equal(malformed.status, 422)
    assert.equal(malformed.events.find((e) => e.kind === 'validate')?.outcome, 'refused')
    assert.equal(malformed.events.some((e) => e.kind === 'handler'), false)

    const banned = await explainRequest(app, 'POST', '/api/orders', { body: { item: 'banned' } })
    assert.equal(banned.events.find((e) => e.kind === 'check')?.outcome, 'refused')
  })

  test('a hook that answers is a short-circuit, and nothing after it runs', async () => {
    const app = makeApp()
    app.hook('onRequest', function closed(ctx) { return ctx.json({ closed: true }, { status: 503 }) })
    app.get('/x', function never() { return 'x' })
    const explained = await explainRequest(app, 'GET', '/x')
    assert.equal(explained.status, 503)
    assert.deepEqual(explained.events.map((e) => `${e.name} ${e.outcome}`), ['closed short-circuit'])
  })

  test('a request no route matched shows the global hooks it ran', async () => {
    const { app } = shop()
    const explained = await explainRequest(app, 'GET', '/nowhere')
    assert.equal(explained.route, null)
    assert.equal(explained.status, 404)
    assert.deepEqual(explained.events.map((e) => e.name), ['rateLimit', 'cors'])
    assert.match(explained.text, /^GET \/nowhere → no route/)
  })

  test('the instrumented pipeline is never installed: concurrent and later requests run the production one', async () => {
    const { app } = shop({ inspect: true })
    await app.ready()
    const units = app.generatedSource().length
    const [explained] = await Promise.all([
      explainRequest(app, 'POST', '/api/orders', { body: { item: 'tea' } }),
      app.inject('POST', '/api/orders', { body: { item: 'coffee' } }),
      app.inject('POST', '/api/orders', { body: { item: 'cocoa' } }),
    ])
    assert.equal(explained.events.filter((e) => e.kind === 'handler').length, 1, 'only the explained request was observed')
    const again = await explainRequest(app, 'POST', '/api/orders', { body: { item: 'tea' } })
    assert.equal(again.events.filter((e) => e.kind === 'handler').length, 1, 'a second explanation starts clean')
    assert.equal(app.generatedSource().length, units, 'nothing was compiled into the application')
    assert.equal((await app.inject('POST', '/api/orders', { body: { item: 'tea' } })).status, 201)
  })
})
