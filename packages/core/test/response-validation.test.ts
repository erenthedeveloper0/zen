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

/**
 * `shaped`, as strict as Zod's `.strict()`: wherever an object node says
 * `additionalProperties: false`, a key it does not declare is refused.
 */
function strictShaped(json: Record<string, unknown>) {
  const base = shaped(json) as unknown as { '~standard': { validate(value: unknown): unknown } }
  const extra = (value: unknown, node: Record<string, unknown> | undefined, path: PropertyKey[]): Array<{ message: string; path: PropertyKey[] }> => {
    if (node === undefined || typeof value !== 'object' || value === null) return []
    if (Array.isArray(value)) return value.flatMap((item, i) => extra(item, node['items'] as Record<string, unknown> | undefined, [...path, i]))
    const properties = (node['properties'] ?? {}) as Record<string, Record<string, unknown>>
    const issues: Array<{ message: string; path: PropertyKey[] }> = []
    if (node['additionalProperties'] === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) issues.push({ message: `Unrecognized key: "${key}"`, path })
    }
    for (const key of Object.keys(properties)) issues.push(...extra((value as Record<string, unknown>)[key], properties[key], [...path, key]))
    return issues
  }
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-test-strict',
      validate(value: unknown) {
        const issues = extra(value, json, [])
        return issues.length > 0 ? { issues } : base['~standard'].validate(value)
      },
    },
    toJSONSchema() {
      return json
    },
  } as never
}

describe('validation.response judges what the serializer will send, not what the handler returned (§11.5, §13.3)', () => {
  const ROW = {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id', 'name'],
    additionalProperties: false,
  }
  const Row = strictShaped(ROW)

  test('a whole row, returned for a strict schema, is served with only the declared fields — §13.3\'s promise holds in development', async () => {
    for (const app of [makeApp({ dev: true }), makeApp({ validation: { response: 'error' } })]) {
      app.get('/user', { response: { 200: Row } }, () => ({ id: 1, name: 'Ada', passwordHash: '$2b$12$never' }))
      const res = await app.inject('GET', '/user')
      assert.equal(res.status, 200, res.text())
      assert.equal(res.text(), '{"id":1,"name":"Ada"}')
    }
  })

  test('…at every depth: inside a nested object and inside an array', async () => {
    const List = strictShaped({
      type: 'object',
      properties: { users: { type: 'array', items: ROW }, owner: ROW },
      required: ['users', 'owner'],
      additionalProperties: false,
    })
    const app = makeApp({ validation: { response: 'error' } })
    app.get('/users', { response: { 200: List } }, () => ({
      users: [{ id: 1, name: 'Ada', passwordHash: 'x' }],
      owner: { id: 2, name: 'Alan', totpSecret: 'y' },
      cursor: 'undeclared',
    }))
    const res = await app.inject('GET', '/users')
    assert.equal(res.status, 200, res.text())
    assert.equal(res.text(), '{"users":[{"id":1,"name":"Ada"}],"owner":{"id":2,"name":"Alan"}}')
  })

  test('a Date is judged as the ISO text the serializer writes, and a bigint as the number', async () => {
    const Stamped = shaped({
      type: 'object',
      properties: { createdAt: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' }, seen: { type: 'string' }, count: { type: 'integer' } },
      required: ['createdAt', 'day', 'seen', 'count'],
    })
    const at = new Date('2026-10-15T08:30:00.000Z')
    const app = makeApp({ dev: true })
    app.get('/stamp', { response: { 200: Stamped } }, () => ({ createdAt: at, day: at, seen: at, count: 42n }))
    const res = await app.inject('GET', '/stamp')
    assert.equal(res.status, 200, res.text())
    assert.deepEqual(res.json(), { createdAt: '2026-10-15T08:30:00.000Z', day: '2026-10-15', seen: '2026-10-15T08:30:00.000Z', count: 42 })
  })

  test('a value of the wrong type is still refused: nothing is coerced before it is judged', async () => {
    const app = makeApp({ validation: { response: 'error' } })
    app.get('/user', { response: { 200: Row } }, () => ({ id: 'seven', name: 'Ada', passwordHash: 'x' }))
    const res = await app.inject('GET', '/user')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_RESPONSE_INVALID')
  })

  test('with serialization off, the undeclared field is sent — and so it is judged', async () => {
    const app = makeApp({ validation: { response: 'error' }, serialization: { mode: 'off' } })
    app.get('/user', { response: { 200: Row } }, () => ({ id: 1, name: 'Ada', passwordHash: 'x' }))
    const res = await app.inject('GET', '/user')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_RESPONSE_INVALID')
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
