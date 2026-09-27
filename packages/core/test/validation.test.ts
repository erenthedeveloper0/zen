import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeApp, schema } from './helpers.ts'

/** A field that must be a number, reported at `[name]`. */
const numberField = (name: string) => schema((value: unknown) => {
  const record = (value ?? {}) as Record<string, unknown>
  return typeof record[name] === 'number'
    ? { value: record }
    : { issues: [{ message: `${name} must be a number`, path: [name] }] }
})

/** The same, but answering through a promise, as an async refinement would. */
const asyncField = (name: string) => {
  const sync = numberField(name)['~standard'].validate
  return schema((value: unknown) => Promise.resolve(sync(value)) as never)
}

type Problem = { status: number; code: string; errors: Array<{ source?: string; path: unknown[]; message: string }> }

describe('every failing source is reported at once (§4.2 stage 7)', () => {
  it('a bad query and a bad body produce one 400 listing both', async () => {
    const app = makeApp()
    app.post('/orders', { query: numberField('page') as never, body: numberField('qty') as never }, () => 'ok')
    const res = await app.inject('POST', '/orders?page=x', { body: { qty: 'many' } })
    assert.equal(res.status, 400, 'anything wrong outside the body makes the request malformed')
    const problem = res.json<Problem>()
    assert.equal(problem.code, 'ZEN_VALIDATION')
    assert.deepEqual(problem.errors.map((e) => [e.source, e.path]), [['query', ['page']], ['body', ['qty']]])
  })

  it('only the body failing is still a 422, and names its source', async () => {
    const app = makeApp()
    const anyQuery = schema((value) => ({ value }))
    app.post('/orders', { query: anyQuery as never, body: numberField('qty') as never }, () => 'ok')
    const res = await app.inject('POST', '/orders?page=1', { body: { qty: 'many' } })
    assert.equal(res.status, 422, 'well-formed, but invalid')
    assert.deepEqual(res.json<Problem>().errors.map((e) => e.source), ['body'])
  })

  it('async validators are collected too, in the fixed source order', async () => {
    const app = makeApp()
    app.post('/x', {
      headers: asyncField('x-n') as never,
      query: numberField('page') as never,
      body: asyncField('qty') as never,
    }, () => 'ok')
    const res = await app.inject('POST', '/x?page=x', { body: { qty: 'many' } })
    assert.equal(res.status, 400)
    assert.deepEqual(res.json<Problem>().errors.map((e) => e.source), ['query', 'headers', 'body'])
  })

  it('a route whose sources all pass runs its handler with every validated value', async () => {
    const app = makeApp()
    app.post('/ok', { query: schema((v) => ({ value: { page: 1, raw: v } })) as never, body: numberField('qty') as never },
      (ctx) => ({ query: ctx.query, body: ctx.body }))
    const res = await app.inject('POST', '/ok?page=1', { body: { qty: 2 } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json<{ body: unknown }>().body, { qty: 2 })
  })

  it('an error that is not a validation failure is not swallowed by the collection', async () => {
    const app = makeApp()
    const exploding = schema(() => { throw new Error('the validator itself is broken') })
    app.post('/x', { query: exploding as never, body: numberField('qty') as never }, () => 'ok')
    const res = await app.inject('POST', '/x', { body: { qty: 'many' } })
    assert.equal(res.status, 500)
  })

  it('a route with one validated source compiles exactly as it did before', async () => {
    // The combined step exists only where there is something to combine, so
    // the generated pipeline for a one-source route has one validator call.
    const app = makeApp()
    app.get('/one', { query: numberField('page') as never }, () => 'ok')
    app.post('/two', { query: numberField('page') as never, body: numberField('qty') as never }, () => 'ok')
    await app.ready()
    const one = app.generatedSource().find((u) => u.name === 'pipeline:GET_/one')?.source ?? ''
    const two = app.generatedSource().find((u) => u.name === 'pipeline:POST_/two')?.source ?? ''
    assert.equal(one.match(/d\.validators\[\d\]/g)?.length, 1)
    assert.equal(two.match(/d\.validators\[\d\]/g)?.length, 1, 'two sources, one collecting stage')
  })
})
