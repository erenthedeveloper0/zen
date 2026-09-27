import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'

import { openapiDocument } from '@erenthedeveloper0/zen-openapi'
import type { OpenApiDocument, OpenApiSchema } from '@erenthedeveloper0/zen-openapi'

import { build } from '../src/app.ts'
import { openapiOptions } from '../src/config/zen.config.ts'
import type { ZenApp } from '@erenthedeveloper0/zen'

let app: ZenApp
let document: OpenApiDocument

before(async () => {
  app = build({ dev: false })
  await app.ready()
  document = openapiDocument(app.graph(), openapiOptions).document
})

function deref(schema: unknown): Record<string, unknown> {
  let current = schema as Record<string, unknown>
  for (let hop = 0; hop < 16; hop++) {
    const ref = current['$ref']
    if (typeof ref !== 'string') return current
    const name = ref.slice('#/components/schemas/'.length)
    const target = (document.components?.schemas ?? {})[name]
    assert.ok(target, `dangling $ref: ${ref}`)
    current = target as Record<string, unknown>
  }
  throw new Error('$ref chain too deep')
}

function operationOf(path: string, method: string): Record<string, unknown> {
  const item = document.paths[path] as Record<string, Record<string, unknown>> | undefined
  assert.ok(item, `no path ${path}`)
  const op = item[method]
  assert.ok(op, `no ${method} on ${path}`)
  return op
}

function responseSchemaOf(path: string, method: string, status: string): Record<string, unknown> {
  const responses = operationOf(path, method)['responses'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
  const media = responses[status]?.['content']?.['application/json']
  assert.ok(media, `no JSON body documented for ${status} on ${method} ${path}`)
  return deref(media['schema'])
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the document describes the whole API', () => {
  it('covers every route except the ones that document themselves', () => {
    assert.deepEqual(Object.keys(document.paths).sort(), [
      '/orders', '/orders/{id}', '/users', '/users/{id}',
    ])
    // The docs endpoints are routes like any other, and are `hidden`.
    assert.ok(app.graph().routes.some((r) => r.path === '/openapi.json'))
  })

  it('names one component per concept, whichever way the schema arrived', () => {
    const names = Object.keys(document.components?.schemas ?? {})
    // `PublicUser` reaches the generator twice: inline as a response schema, and
    // hoisted into `$defs` by Zod when it is nested inside `UserList`. One
    // component, not `PublicUser` and `PublicUser2`.
    assert.equal(names.filter((n) => n.startsWith('PublicUser')).length, 1)
    assert.equal(names.filter((n) => n.startsWith('Order') && !n.startsWith('OrderLine')).length, 1)
  })

  it('separates the request and response forms of one type by name, not by number', () => {
    const names = Object.keys(document.components?.schemas ?? {})
    // `OrderLine` is genuinely two schemas — the request form tolerates extra
    // keys, the response form cannot emit them — so it is two components. The
    // names say which is which.
    assert.ok(names.includes('OrderLine'))
    assert.ok(names.includes('OrderLineInput'))
    assert.equal(document.components?.schemas?.['OrderLine']?.additionalProperties, false)
    assert.equal(document.components?.schemas?.['OrderLineInput']?.additionalProperties, undefined)
  })

  it('reuses PublicUser inside Order rather than inlining a copy', () => {
    const order = document.components?.schemas?.['Order'] as Record<string, Record<string, Record<string, string>>>
    assert.equal(order['properties']?.['customer']?.['$ref'], '#/components/schemas/PublicUser')
  })

  it('documents typed path params from the param type, not as strings', () => {
    const params = operationOf('/users/{id}', 'get')['parameters'] as Array<Record<string, unknown>>
    assert.deepEqual(params, [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }])
  })

  it('takes the direction of a schema seriously', () => {
    // `role` defaults to 'member'. On the way in it is optional; on the way out
    // it is guaranteed. A document generated in one direction would be wrong
    // about one of them.
    const body = operationOf('/users', 'post')['requestBody'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    const input = deref(body['content']?.['application/json']?.['schema'])
    const output = responseSchemaOf('/users/{id}', 'get', '200')

    assert.deepEqual(input['required'], ['email', 'name'])
    assert.ok((output['required'] as string[]).includes('role'))
  })

  it('carries the tags and summaries the collections and routes declared', () => {
    assert.deepEqual(operationOf('/users', 'get')['tags'], ['users'])
    assert.equal(operationOf('/users', 'get')['summary'], 'List users')
    assert.deepEqual(
      (document.tags ?? []).map((t) => [t.name, t.description]),
      [['orders', 'Placed orders and their line items.'], ['users', 'The user directory.']],
    )
  })

  it('says a 204 has no body instead of inventing one', () => {
    const responses = operationOf('/users/{id}', 'delete')['responses'] as Record<string, Record<string, unknown>>
    assert.equal(responses['204']?.['content'], undefined)
    assert.equal(responses['204']?.['description'], 'No Content')
  })

  it('documents the error envelope', () => {
    const responses = operationOf('/users/{id}', 'get')['responses'] as Record<string, Record<string, Record<string, Record<string, Record<string, string>>>>>
    assert.equal(
      responses['4XX']?.['content']?.['application/problem+json']?.['schema']?.['$ref'],
      '#/components/schemas/ProblemDetails',
    )
  })

  it('has no dangling $ref anywhere', () => {
    const available = new Set(Object.keys(document.components?.schemas ?? {}))
    const seen: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (typeof node !== 'object' || node === null) return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') seen.push(value)
        else walk(value)
      }
    }
    walk(document)
    assert.ok(seen.length > 0)
    for (const ref of seen) {
      assert.ok(available.has(ref.slice('#/components/schemas/'.length)), `dangling ${ref}`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the document cannot drift from the wire (§29.1)', () => {
  /**
   * The claim this example exists to demonstrate.
   *
   * For every documented response, a real request is made through `inject()` —
   * the whole pipeline, the real compiled serializer — and the keys that come
   * back must be exactly the keys the document promised. The handlers return
   * full database rows, so any gap between the document and the serializer shows
   * up here as either a missing field or a leaked one.
   */
  const probes: Array<[string, string, string, string]> = [
    ['GET', '/users/1', '/users/{id}', '200'],
    ['GET', '/users', '/users', '200'],
    ['GET', '/orders/1', '/orders/{id}', '200'],
    ['GET', '/orders', '/orders', '200'],
  ]

  for (const [method, url, path, status] of probes) {
    it(`${method} ${url} matches its documented ${status}`, async () => {
      const response = await app.inject(method, url)
      assert.equal(response.status, Number(status))
      compare(responseSchemaOf(path, method.toLowerCase(), status), response.json(), `${method} ${url}`)
    })
  }

  it('none of the five private columns is documented, and none reaches the wire', async () => {
    const secret = ['passwordHash', 'totpSecret', 'stripeCustomerId', 'internalNotes', 'deletedAt']
    const documentJson = JSON.stringify(document)
    for (const field of secret) {
      assert.equal(documentJson.includes(field), false, `${field} is named in the document`)
    }

    for (const url of ['/users/1', '/users', '/orders/1', '/orders']) {
      const body = (await app.inject('GET', url)).text()
      for (const field of [...secret, 'marginCents', 'fraudScore']) {
        assert.equal(body.includes(field), false, `${field} reached the wire on ${url}`)
      }
    }
  })

  function compare(documented: Record<string, unknown>, actual: unknown, where: string): void {
    const resolved = deref(documented)
    const types = resolved['type']
    const type = Array.isArray(types) ? types[0] : types

    if (type === 'array') {
      assert.ok(Array.isArray(actual), `${where} should be an array`)
      const items = resolved['items']
      if (typeof items === 'object' && items !== null) {
        for (const [index, element] of (actual as unknown[]).entries()) {
          compare(items as Record<string, unknown>, element, `${where}[${index}]`)
        }
      }
      return
    }

    const properties = resolved['properties'] as Record<string, Record<string, unknown>> | undefined
    if (properties === undefined || actual === null || typeof actual !== 'object') return

    if (resolved['additionalProperties'] === false) {
      assert.deepEqual(
        Object.keys(actual as object).sort(),
        Object.keys(properties).sort(),
        `${where}: wire keys ≠ documented keys`,
      )
    }
    for (const [key, child] of Object.entries(properties)) {
      const value = (actual as Record<string, unknown>)[key]
      if (value !== undefined) compare(child, value, `${where}.${key}`)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the endpoints', () => {
  it('serves the document as JSON with an ETag', async () => {
    const response = await app.inject('GET', '/openapi.json')
    assert.equal(response.status, 200)
    assert.match(response.header('content-type') ?? '', /application\/json/)
    assert.ok(response.header('etag'))
    // The app-local plugin's after-middleware runs on plugin routes too.
    assert.ok(response.header('x-request-id'))
    assert.equal((response.json<OpenApiDocument>()).info.title, 'Zen Commerce API')
  })

  it('serves a reference page with no external requests', async () => {
    const page = await app.inject('GET', '/docs')
    assert.equal(page.status, 200)
    assert.equal(/(src|href)\s*=\s*["']https?:/i.test(page.text()), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the API still behaves like an API', () => {
  it('validates a request body and reports one issue per field', async () => {
    const response = await app.inject('POST', '/users', { body: { email: 'not-an-email', name: '' } })
    assert.equal(response.status, 422)
    const problem = response.json<{ code: string; errors: Array<{ path: string[] }> }>()
    assert.equal(problem.code, 'ZEN_VALIDATION')
    assert.deepEqual(problem.errors.map((e) => e.path.join('.')).sort(), ['email', 'name'])
  })

  it('applies the schema default the document advertises', async () => {
    const created = await app.inject('POST', '/users', { body: { email: 'new@example.com', name: 'New Person' } })
    assert.equal(created.status, 201)
    assert.equal(created.json<{ role: string }>().role, 'member')
    assert.match(created.header('location') ?? '', /^\/users\/\d+$/)
  })

  it('404s an unknown id and 405s a wrong method', async () => {
    assert.equal((await app.inject('GET', '/users/999')).status, 404)
    const wrongMethod = await app.inject('PUT', '/users/1')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.header('allow'), 'GET, PATCH, DELETE, HEAD')
  })

  it('rejects a path param that is not an integer before the handler', async () => {
    assert.equal((await app.inject('GET', '/users/abc')).status, 404)
  })
})
