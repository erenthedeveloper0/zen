import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { diffDocuments, type OpenApiDocument } from '@erenthedeveloper0/zen-openapi'
import { build } from '../../app.ts'

/**
 * A feature's own tests live beside it — rfcs/0001 §23.4.
 *
 * The end-to-end document assertions are in `test/document.test.ts`; this file
 * covers what the users feature itself promises, plus the compatibility gate
 * that guards it.
 */

const baselinePath = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'api', 'openapi.json',
)
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as OpenApiDocument

/** Deep clone, then let a test mutate the copy freely. */
const fork = (): OpenApiDocument => JSON.parse(JSON.stringify(baseline)) as OpenApiDocument

function publicUser(document: OpenApiDocument): Record<string, unknown> {
  const schema = document.components?.schemas?.['PublicUser']
  assert.ok(schema, 'the baseline should publish a PublicUser component')
  return schema as Record<string, unknown>
}

describe('users: behaviour', () => {
  it('lists seeded users and filters by role', async () => {
    const app = build({ dev: false })
    const all = await app.inject('GET', '/users')
    assert.equal(all.json<{ page: { total: number } }>().page.total, 3)

    const admins = await app.inject('GET', '/users?role=admin')
    const body = admins.json<{ users: Array<{ role: string }> }>()
    assert.deepEqual(body.users.map((u) => u.role), ['admin'])
  })

  it('refuses a duplicate email with a 409', async () => {
    const app = build({ dev: false })
    const conflict = await app.inject('POST', '/users', {
      body: { email: 'ada@example.com', name: 'Impostor' },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json<{ code: string }>().code, 'ZEN_CONFLICT')
  })

  it('patches without disturbing the response contract', async () => {
    const app = build({ dev: false })
    const patched = await app.inject('PATCH', '/users/2', { body: { name: 'Grace B. Hopper' } })
    assert.equal(patched.status, 200)
    assert.deepEqual(
      Object.keys(patched.json<object>()).sort(),
      ['createdAt', 'email', 'id', 'name', 'role'],
    )
  })
})

describe('users: the compatibility gate (§29.5)', () => {
  it('a committed baseline exists and matches the current document', () => {
    // `scripts/check-api.ts` is the runnable form; this keeps the baseline from
    // silently rotting when someone edits a schema and forgets to re-emit.
    assert.ok(Object.keys(baseline.paths).length > 0)
  })

  it('removing a response field is breaking', () => {
    const after = fork()
    const properties = publicUser(after)['properties'] as Record<string, unknown>
    delete properties['email']

    const result = diffDocuments(baseline, after)
    assert.deepEqual([...new Set(result.breaking.map((c) => c.code))], ['OAS_RESPONSE_FIELD_REMOVED'])
    // Reported once per *operation* that returns a PublicUser, not once for the
    // component. That is the useful form: the reviewer sees which endpoints
    // change, and `$ref` reuse does not hide the blast radius.
    assert.ok(result.breaking.length >= 4)
    assert.equal(new Set(result.breaking.map((c) => c.location)).size, result.breaking.length)
  })

  it('adding an optional response field is not', () => {
    const after = fork()
    const properties = publicUser(after)['properties'] as Record<string, unknown>
    properties['nickname'] = { type: 'string' }

    const result = diffDocuments(baseline, after)
    assert.deepEqual(result.breaking, [])
    assert.ok(result.compatible.some((c) => c.code === 'OAS_RESPONSE_FIELD_ADDED'))
  })

  it('a response field that may now be absent is breaking', () => {
    const after = fork()
    const user = publicUser(after)
    user['required'] = (user['required'] as string[]).filter((name) => name !== 'role')

    const result = diffDocuments(baseline, after)
    assert.deepEqual([...new Set(result.breaking.map((c) => c.code))], ['OAS_RESPONSE_FIELD_NOW_OPTIONAL'])
  })

  it('renaming an operation is breaking, because generated clients are named from it', () => {
    const after = fork()
    const operation = (after.paths['/users'] as Record<string, Record<string, unknown>>)['get']
    assert.ok(operation)
    operation['operationId'] = 'users.index'

    assert.deepEqual(diffDocuments(baseline, after).breaking.map((c) => c.code), ['OAS_OPERATION_ID_CHANGED'])
  })
})
