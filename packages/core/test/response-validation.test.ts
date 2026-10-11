import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonSchema, type Logger } from '@erenthedeveloper0/zen-core'
import { makeApp, schema, shaped } from './helpers.ts'

/**
 * Response validation — rfcs/0001 §11.5. The serializer keeps undeclared
 * fields off the wire whatever the mode; this is the other half — a declared
 * field holding the wrong value.
 */

/** A response schema that validates and describes: `id` an integer, `name` a string. */
const User = shaped({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
})

function recorder(): { logger: Logger; lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> } {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = []
  const at = (level: string) => (a: unknown, b?: string): void => {
    lines.push({ level, obj: typeof a === 'object' && a !== null ? a as Record<string, unknown> : {}, msg: typeof a === 'string' ? a : (b ?? '') })
  }
  const logger: Logger = {
    level: 'trace',
    child: () => logger,
    trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'),
  }
  return { logger, lines }
}

const pipelineOf = (app: ReturnType<typeof makeApp>, id: string): string =>
  app.generatedSource().find((u) => u.name === `pipeline:${id}`)?.source ?? ''

describe("validation.response: 'error' (§11.5)", () => {
  test('a wrong value is a 500 ZEN_RESPONSE_INVALID, never exposed; a right one is served', async () => {
    const app = makeApp({ validation: { response: 'error' } })
    let seeded = false
    app.get('/user', { response: { 200: User } }, () => (seeded ? { id: 'seven', name: 'Ada' } : { id: 7, name: 'Ada' }))
    assert.equal((await app.inject('GET', '/user')).status, 200)
    seeded = true
    const res = await app.inject('GET', '/user')
    assert.equal(res.status, 500)
    const problem = res.json<{ code: string; title: string }>()
    assert.equal(problem.code, 'ZEN_RESPONSE_INVALID')
    assert.equal(problem.title, 'Internal Server Error', 'what was wrong stays in the log')
  })

  test("in development it is the default, and the problem document's debug carries the issues", async () => {
    const app = makeApp({ dev: true })
    app.get('/user', { response: { 200: User } }, () => ({ id: 1, name: 42 }))
    const res = await app.inject('GET', '/user')
    assert.equal(res.status, 500)
    const debug = res.json<{ debug: { meta: { issues: Array<{ path: string[] }> } } }>().debug
    assert.deepEqual(debug.meta.issues.map((i) => i.path), [['name']])
  })

  test('it judges what is sent: a value an onSerialize hook corrupts is caught', async () => {
    const app = makeApp({ validation: { response: 'error' } })
    app.hook('onSerialize', (_ctx, payload) => ({ ...(payload as object), id: 'not a number' }))
    app.get('/user', { response: { 200: User } }, () => ({ id: 1, name: 'Ada' }))
    assert.equal((await app.inject('GET', '/user')).json<{ code: string }>().code, 'ZEN_RESPONSE_INVALID')
  })

  test('the status decides the schema, staged or returned', async () => {
    const Created = shaped({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] })
    const app = makeApp({ validation: { response: 'error' } })
    app.post('/users', { response: { 201: Created, 200: User } }, (ctx) => {
      ctx.res.status(201)
      return { id: 9 }
    })
    assert.equal((await app.inject('POST', '/users')).status, 201)
  })

  test('a negotiated response is held to the schema of the representation chosen', async () => {
    // Version 2 of the resource spells the id as a string.
    const UserV2 = shaped({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })
    const app = makeApp({ validation: { response: 'error' } })
    app.get('/user', { response: { 200: { 'application/json': User, 'application/vnd.zen.v2+json': UserV2 } } }, () => ({ id: 1, name: 'Ada' }))
    assert.equal((await app.inject('GET', '/user', { headers: { accept: 'application/json' } })).status, 200)
    const v2 = await app.inject('GET', '/user', { headers: { accept: 'application/vnd.zen.v2+json' } })
    assert.equal(v2.status, 500)
    assert.equal(v2.json<{ code: string }>().code, 'ZEN_RESPONSE_INVALID')
  })

  test('an asynchronous schema is awaited, and the interpreted twin agrees', async () => {
    const Async = schema<{ ok: boolean }>((value) => ({ value: value as { ok: boolean } }))
    ;(Async['~standard'] as unknown as { validate: unknown }).validate = async (value: unknown) =>
      (value as { ok?: unknown }).ok === true ? { value } : { issues: [{ message: 'not ok', path: ['ok'] }] }
    for (const pipeline of ['optimized', 'simple'] as const) {
      const app = makeApp({ validation: { response: 'error' }, pipeline })
      app.get('/a', { response: { 200: Async as never } }, () => ({ ok: false }))
      assert.equal((await app.inject('GET', '/a')).status, 500, pipeline)
    }
  })

  test('a jsonSchema() shape describes and cannot validate, so it is not validated', async () => {
    const app = makeApp({ validation: { response: 'error' } })
    app.get('/x', { response: { 200: jsonSchema({ type: 'object', properties: { id: { type: 'integer' } } }) } }, () => ({ id: 1 }))
    assert.equal((await app.inject('GET', '/x')).status, 200)
    assert.doesNotMatch(pipelineOf(app, 'GET_/x'), /validateResponse/, 'nothing to emit')
  })
})

describe("validation.response: 'log', { sample }, 'off' (§11.5, T8)", () => {
  test("'log' reports the mismatch and serves the response", async () => {
    const { logger, lines } = recorder()
    const app = makeApp({ logger, validation: { response: 'log' } })
    app.get('/user', { response: { 200: User } }, () => ({ id: 'x', name: 'Ada' }))
    const res = await app.inject('GET', '/user')
    assert.equal(res.status, 200)
    const logged = lines.find((l) => l.obj['code'] === 'ZEN_RESPONSE_INVALID')
    assert.equal(logged?.level, 'error')
    assert.match(logged?.msg ?? '', /The 200 response of GET \/user does not match its declared schema — id:/)
  })

  test('{ sample: n } checks one response in n', async () => {
    const { logger, lines } = recorder()
    const app = makeApp({ logger, validation: { response: { sample: 3 } } })
    app.get('/user', { response: { 200: User } }, () => ({ id: 'x', name: 'Ada' }))
    for (let i = 0; i < 9; i++) assert.equal((await app.inject('GET', '/user')).status, 200)
    assert.equal(lines.filter((l) => l.obj['code'] === 'ZEN_RESPONSE_INVALID').length, 3)
  })

  test("'off' — the production default — compiles the pipeline it compiled before the feature existed", async () => {
    const off = makeApp()
    const on = makeApp({ validation: { response: 'error' } })
    for (const app of [off, on]) app.get('/user', { response: { 200: User } }, () => ({ id: 'x', name: 'Ada' }))
    assert.equal((await off.inject('GET', '/user')).status, 200, 'nothing checks the value')
    await on.ready()
    assert.doesNotMatch(pipelineOf(off, 'GET_/user'), /validateResponse/)
    assert.match(pipelineOf(on, 'GET_/user'), /d\.validateResponse\(ctx, reply\)/)
  })

  test('an unknown mode is refused at boot, naming where it was set', async () => {
    const app = makeApp({ validation: { response: 'loud' as never } })
    app.get('/', () => 'ok')
    const error = await app.ready().then(() => null, (e: unknown) => e as { diagnostics: Array<{ code: string; locations?: string[] }> })
    const diagnostic = error?.diagnostics.find((d) => d.code === 'ZEN_CONFIG_INVALID')
    assert.deepEqual(diagnostic?.locations, ['validation.response ← zen()'])
  })
})
