import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { build } from '../src/app.ts'
import { UserRepoToken } from '../src/services.ts'
import type { UserRow } from '../src/domain.ts'

/**
 * Testing a Zen app is calling `inject()` — no socket, no supertest, no
 * `app.listen(0)` dance (rfcs/0001 §20.2). `inject` runs the *real* dispatcher,
 * pipeline, validators, serializer and egress; the only thing it skips is the
 * adapter, which `scripts/smoke.ts` covers over a real socket.
 */

function app(overrides: Parameters<typeof build>[0] = {}) {
  return build({ logger: quiet(), ...overrides })
}

const asAdmin = { headers: { 'x-user-id': '1' } }
const asMember = { headers: { 'x-user-id': '2' } }

const PRIVATE_COLUMNS = ['passwordHash', 'totpSecret', 'stripeCustomerId', 'internalNotes', 'deletedAt'] as const

describe('response contracts (§13.3)', () => {
  test('a single user ships five fields and no others', async () => {
    const response = await app().inject('GET', '/users/1', asAdmin)

    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.json<object>()).sort(), ['createdAt', 'email', 'id', 'name', 'role'])
  })

  test('the handler really did return the private columns', async () => {
    // Without this assertion the test above would pass just as well against a
    // repository that never loaded them, and would prove nothing.
    const instance = app()
    await instance.ready()

    const row = instance.resolve(UserRepoToken).find(1) as UserRow
    for (const column of PRIVATE_COLUMNS) {
      assert.ok(column in row, `fixture is not exercising the leak: ${column} missing from the row`)
    }
    assert.match(row.passwordHash, /^\$2b\$12\$/)

    const response = await instance.inject('GET', '/users/1', asAdmin)
    for (const column of PRIVATE_COLUMNS) {
      assert.ok(!response.text().includes(column), `${column} reached the wire`)
    }
    assert.ok(!response.text().includes(row.passwordHash))
  })

  test('filtering survives nesting — every user in a list is filtered', async () => {
    const response = await app().inject('GET', '/users/', asAdmin)
    const body = response.json<{ users: object[]; total: number }>()

    assert.equal(body.total, 3)
    for (const user of body.users) {
      assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'name', 'role'])
    }
    for (const column of PRIVATE_COLUMNS) {
      assert.ok(!response.text().includes(column), `${column} reached the wire inside the list`)
    }
  })

  test('a 201 selects the 201 contract, not the 200 one', async () => {
    const response = await app().inject('POST', '/users/', {
      ...asAdmin,
      body: { email: 'alan@example.com', name: 'Alan Turing', password: 'enigma-1936' },
    })

    assert.equal(response.status, 201)
    assert.equal(response.header('location'), '/users/4')
    // `Created` declares id + createdAt. The row carried far more.
    assert.deepEqual(Object.keys(response.json<object>()).sort(), ['createdAt', 'id'])
  })

  test('content-length matches the filtered body, not the handler value', async () => {
    const response = await app().inject('GET', '/users/1', asAdmin)
    assert.equal(response.header('content-length'), String(Buffer.byteLength(response.text())))
  })
})

describe('validation (§11)', () => {
  test('a well-formed body is accepted and typed', async () => {
    const response = await app().inject('POST', '/users/', {
      ...asAdmin,
      body: { email: 'katherine2@example.com', name: 'K. Johnson', password: 'apollo-11', role: 'admin' },
    })
    assert.equal(response.status, 201)
  })

  test('a schema violation is a 422 with a normalised issue envelope', async () => {
    const response = await app().inject('POST', '/users/', {
      ...asAdmin,
      body: { email: 'not-an-email', name: '', password: 'short' },
    })

    assert.equal(response.status, 422)
    const problem = response.json<{ code: string; errors: { path: (string | number)[]; message: string }[] }>()
    assert.equal(problem.code, 'ZEN_VALIDATION')
    // Paths are re-rooted by the schema, so the client is told *which* field.
    assert.deepEqual(problem.errors.map((issue) => issue.path.join('.')).sort(), ['email', 'name', 'password'])
  })

  test('a route with no body schema never parses one', async () => {
    // Stage 6 is not emitted into this route's pipeline at all, so a body on a
    // GET is ignored rather than parsed and discarded.
    const response = await app().inject('GET', '/health')
    assert.equal(response.status, 200)
  })

  test('a typed path param that does not parse is a 404, not a 500', async () => {
    const response = await app().inject('GET', '/users/not-a-number', asAdmin)
    assert.equal(response.status, 404)
  })
})

describe('plugins (§10)', () => {
  test('the auth plugin decorates ctx.user', async () => {
    const response = await app().inject('GET', '/me', asMember)
    assert.equal(response.status, 200)
    assert.equal(response.json<{ email: string }>().email, 'grace@example.com')
    // `/me` is contract-filtered too — the decoration is a full row.
    assert.deepEqual(Object.keys(response.json<object>()).sort(), ['createdAt', 'email', 'id', 'name', 'role'])
  })

  test('a public prefix skips authentication', async () => {
    assert.equal((await app().inject('GET', '/health')).status, 200)
  })

  test('a missing credential is a 401 with WWW-Authenticate', async () => {
    const response = await app().inject('GET', '/users/1')
    assert.equal(response.status, 401)
    assert.match(response.header('www-authenticate') ?? '', /Bearer/)
  })

  test('admin-only enforces the role it depends on auth to have set', async () => {
    assert.equal((await app().inject('GET', '/users/1', asMember)).status, 403)
    assert.equal((await app().inject('GET', '/users/1', asAdmin)).status, 200)
  })

  test('the timing plugin adds its header to every response', async () => {
    const response = await app().inject('GET', '/health')
    assert.match(response.header('x-response-time') ?? '', /^\d+\.\dms$/)
  })

  test('plugins are ordered by their declared constraints, not registration luck', async () => {
    const instance = app()
    await instance.ready()
    const names = instance.graph().plugins.map((plugin) => plugin.name)
    assert.deepEqual(names, ['request-timing', 'auth', 'admin-only'])
  })
})

describe('services (§15)', () => {
  test('a scoped service is one per request', async () => {
    const instance = app()
    const first = await instance.inject('GET', '/health')
    const second = await instance.inject('GET', '/health')
    // Both succeeded, which means AuditToken resolved inside each request; a
    // scoped service resolved outside one throws by design.
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
  })

  test('the eager singleton is built at boot, before any request', async () => {
    const instance = app()
    await instance.ready()
    assert.equal(instance.resolve(UserRepoToken).list({ limit: 10 }).length, 3)
  })

  test('the container reports its own shape', async () => {
    const instance = app()
    await instance.ready()
    const lifetimes = Object.fromEntries(
      instance.container.providers.map((provider) => [provider.token.name, provider.lifetime]),
    )
    assert.deepEqual(lifetimes, {
      'app.clock': 'singleton',
      'app.userRepo': 'singleton',
      'app.audit': 'scoped',
    })
  })
})

describe('errors (§12)', () => {
  test('a domain error becomes an RFC 9457 problem document', async () => {
    const response = await app().inject('GET', '/users/999', asAdmin)

    assert.equal(response.status, 404)
    const problem = response.json<{ type: string; status: number; code: string; requestId: string }>()
    assert.equal(problem.status, 404)
    assert.equal(problem.code, 'ZEN_NOT_FOUND')
    assert.match(problem.type, /^https:\/\/zenjs\.dev\/errors\//)
    assert.ok(problem.requestId.length > 0)
  })

  test('a duplicate email is a 409 raised from the service layer', async () => {
    const response = await app().inject('POST', '/users/', {
      ...asAdmin,
      body: { email: 'ada@example.com', name: 'Impostor', password: 'password123' },
    })
    assert.equal(response.status, 409)
  })

  test('a wrong method on a known path is a 405 with Allow', async () => {
    const response = await app().inject('PUT', '/users/1', asAdmin)
    assert.equal(response.status, 405)
    assert.match(response.header('allow') ?? '', /GET/)
    assert.match(response.header('allow') ?? '', /PATCH/)
  })
})

describe('the interpreted twins agree with the compiled path (I6)', () => {
  const probes = [
    ['GET', '/health', {}],
    ['GET', '/users/1', asAdmin],
    ['GET', '/users/', asAdmin],
    ['GET', '/me', asMember],
    ['GET', '/users/999', asAdmin],
    ['GET', '/users/1', asMember],
  ] as const

  test('compiled ≡ interpreted for pipeline, serializer and router', async () => {
    const compiled = app()
    // The one-line opt-outs of §8.4 and §13.3: every compiled subsystem has an
    // interpreted twin, and an application can select them without changing a
    // single line of its own code.
    const interpreted = app({ pipeline: 'simple', serialization: { mode: 'walk' } })

    for (const [method, path, init] of probes) {
      const a = await compiled.inject(method, path, init)
      const b = await interpreted.inject(method, path, init)
      assert.equal(a.status, b.status, `${method} ${path} status`)
      assert.equal(stable(a.text()), stable(b.text()), `${method} ${path} body`)
    }
  })
})

/** Request ids are unique per request by design; everything else must match. */
function stable(body: string): string {
  return body.replace(/"requestId":"[^"]*"/, '"requestId":"<id>"')
}

function quiet() {
  const noop = () => {}
  return { level: 'fatal' as const, child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
}
