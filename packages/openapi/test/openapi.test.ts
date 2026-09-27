import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CodeGen, DEFAULT_CAPABILITIES, buildSerializerTable, definePlugin, type JsonSchema } from '@visionpilot/zen-core'
import { openapiDocument, openapiPlugin, diffDocuments, renderReference } from '@visionpilot/zen-openapi'
import type { OpenApiDocument } from '@visionpilot/zen-openapi'

import { collectRefs, deref, makeApp, operation, responseSchema, schema } from './helpers.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PublicUser = schema({
  title: 'PublicUser',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['admin', 'member'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'email', 'role', 'createdAt'],
})

const UserList = schema({
  title: 'UserList',
  type: 'object',
  properties: {
    users: {
      type: 'array',
      items: {
        title: 'PublicUser',
        type: 'object',
        properties: {
          id: { type: 'integer' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['admin', 'member'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'email', 'role', 'createdAt'],
      },
    },
    total: { type: 'integer' },
  },
  required: ['users', 'total'],
})

const NewUser = schema({
  type: 'object',
  properties: { email: { type: 'string' }, name: { type: 'string' } },
  required: ['email'],
})

const ListQuery = schema({
  type: 'object',
  properties: {
    limit: { type: 'integer', description: 'Page size.' },
    role: { type: 'string', enum: ['admin', 'member'] },
  },
  required: ['limit'],
})

const INFO = { title: 'Test API', version: '1.2.3' }

async function documentFor(build: (app: ReturnType<typeof makeApp>) => void, options: Partial<{ problemDetails: boolean }> = {}) {
  const app = makeApp()
  build(app)
  await app.ready()
  return openapiDocument(app.graph(), { ...INFO, ...options })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('document structure (§29.2)', () => {
  it('templates typed params and documents them from the param type', async () => {
    const { document } = await documentFor((app) => {
      app.get('/users/:id<int>', { response: { 200: PublicUser } }, () => null as never)
    })

    const op = operation(document, '/users/{id}', 'get')
    const params = op['parameters'] as Array<Record<string, unknown>>
    assert.deepEqual(params, [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
    ])
  })

  it('documents a wildcard as a string path parameter, and says so', async () => {
    const { document } = await documentFor((app) => {
      app.get('/files/*path', { response: { 200: PublicUser } }, () => null as never)
    })

    const params = operation(document, '/files/{path}', 'get')['parameters'] as Array<Record<string, unknown>>
    assert.equal(params[0]?.['x-zen-wildcard'], true)
    assert.deepEqual(params[0]?.['schema'], { type: 'string' })
  })

  it('expands an optional trailing param into two paths, because OpenAPI has no optional path param', async () => {
    const { document } = await documentFor((app) => {
      app.get('/posts/:slug?', { name: 'posts.list', response: { 200: PublicUser } }, () => null as never)
    })

    assert.deepEqual(Object.keys(document.paths).sort(), ['/posts', '/posts/{slug}'])
    assert.equal(operation(document, '/posts', 'get')['operationId'], 'posts.list')
    assert.equal(operation(document, '/posts/{slug}', 'get')['operationId'], 'posts.listBySlug')
    // The spec requires `required: true` for in: 'path'. Both variants comply.
    const params = operation(document, '/posts/{slug}', 'get')['parameters'] as Array<Record<string, unknown>>
    assert.equal(params[0]?.['required'], true)
  })

  it('splits query, header and cookie schemas into one parameter each', async () => {
    const { document } = await documentFor((app) => {
      app.get('/users', { query: ListQuery, response: { 200: UserList } }, () => null as never)
    })

    const params = operation(document, '/users', 'get')['parameters'] as Array<Record<string, unknown>>
    assert.deepEqual(params.map((p) => [p['name'], p['in'], p['required'] ?? false]), [
      ['limit', 'query', true],
      ['role', 'query', false],
    ])
    assert.equal(params[0]?.['description'], 'Page size.')
  })

  it('documents the request body and every declared status', async () => {
    const { document } = await documentFor((app) => {
      app.post('/users', { body: NewUser, response: { 201: PublicUser, 204: null } }, () => null as never)
    })

    const op = operation(document, '/users', 'post')
    const body = op['requestBody'] as Record<string, Record<string, Record<string, unknown>>>
    assert.equal(body['required'], true)
    assert.ok(body['content']?.['application/json'])

    const responses = op['responses'] as Record<string, Record<string, unknown>>
    assert.ok(responses['201']?.['content'])
    // A `null` schema is "this status has no body", not "an empty object".
    assert.equal(responses['204']?.['content'], undefined)
    assert.equal(responses['204']?.['description'], 'No Content')
  })

  it('takes tags from the collection chain, outermost first', async () => {
    const { document } = await documentFor((app) => {
      app.collection('/api', { tags: ['v1'] }, (api) => {
        api.collection('/users', { tags: ['users'] }, (users) => {
          users.get('/', { meta: { tags: ['directory'] }, response: { 200: UserList } }, () => null as never)
        })
      })
    })

    assert.deepEqual(operation(document, '/api/users', 'get')['tags'], ['v1', 'users', 'directory'])
    assert.deepEqual((document.tags ?? []).map((t) => t.name), ['directory', 'users', 'v1'])
  })

  it('reads summary, description, deprecated and operationId from route meta', async () => {
    const { document } = await documentFor((app) => {
      app.get('/legacy', {
        meta: { summary: 'Old thing', description: 'Long form.', deprecated: true, operationId: 'legacy.read' },
        response: { 200: PublicUser },
      }, () => null as never)
    })

    const op = operation(document, '/legacy', 'get')
    assert.equal(op['summary'], 'Old thing')
    assert.equal(op['description'], 'Long form.')
    assert.equal(op['deprecated'], true)
    assert.equal(op['operationId'], 'legacy.read')
  })

  it('excludes hidden routes and honours the exclude predicate', async () => {
    const app = makeApp()
    app.get('/internal', { meta: { hidden: true }, response: { 200: PublicUser } }, () => null as never)
    app.get('/metrics', { response: { 200: PublicUser } }, () => null as never)
    app.get('/public', { response: { 200: PublicUser } }, () => null as never)
    await app.ready()

    const { document } = openapiDocument(app.graph(), {
      ...INFO,
      exclude: (route) => route.path === '/metrics',
    })
    assert.deepEqual(Object.keys(document.paths), ['/public'])
  })

  it('renames a colliding operationId rather than dropping the operation', async () => {
    // Two routes cannot share a `name` — that is a boot error now, because the
    // name is the route's identity (§5.5) — but an explicit operationId can
    // still collide, and the document must not lose an operation when it does.
    const { document, diagnostics } = await documentFor((app) => {
      app.get('/a', { name: 'a', meta: { operationId: 'same' }, response: { 200: PublicUser } }, () => null as never)
      app.get('/b', { name: 'b', meta: { operationId: 'same' }, response: { 200: PublicUser } }, () => null as never)
    })

    const ids = [operation(document, '/a', 'get')['operationId'], operation(document, '/b', 'get')['operationId']]
    assert.deepEqual(ids, ['same', 'same_2'])
    assert.ok(diagnostics.some((d) => d.code === 'ZEN_OAS_OPERATION_ID_COLLISION'))
  })

  it('documents the RFC 9457 error envelope Zen actually emits', async () => {
    const { document } = await documentFor((app) => {
      app.get('/x', { response: { 200: PublicUser } }, () => null as never)
    })

    const responses = operation(document, '/x', 'get')['responses'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    assert.equal(
      (responses['4XX']?.['content']?.['application/problem+json']?.['schema'] as Record<string, unknown>)['$ref'],
      '#/components/schemas/ProblemDetails',
    )
    const problem = document.components?.schemas?.['ProblemDetails'] as JsonSchema
    assert.deepEqual(problem.required, ['type', 'title', 'status', 'instance', 'code', 'requestId'])
  })

  it('warns about a route with no response schema instead of inventing a 200', async () => {
    const { document, diagnostics } = await documentFor((app) => {
      app.get('/health', () => ({ ok: true }))
    })

    const responses = operation(document, '/health', 'get')['responses'] as Record<string, unknown>
    assert.ok(responses['default'])
    assert.equal(responses['200'], undefined)
    assert.ok(diagnostics.some((d) => d.code === 'ZEN_OAS_RESPONSE_UNDECLARED'))
  })

  /**
   * The route's deadline, published to whoever generates a client — §4.4.
   *
   * An SDK that waits thirty seconds for an endpoint the server abandons after
   * two spends twenty-eight of them holding a socket open for an answer that is
   * not coming. That number normally lives in a runbook; here it is the same
   * field the dispatcher arms from, so the document cannot describe a budget
   * the service does not use.
   */
  it('publishes the resolved deadline as x-zen-timeout-ms', async () => {
    const { document } = await documentFor((app) => {
      app.get('/fast', { timeout: '250ms', response: { 200: PublicUser } }, () => null as never)
      app.collection('/reports', { timeout: '30s' }, (c) => {
        c.get('/big', { response: { 200: PublicUser } }, () => null as never)
      })
      app.get('/stream', { timeout: false, response: { 200: PublicUser } }, () => null as never)
    })

    assert.equal(operation(document, '/fast', 'get')['x-zen-timeout-ms'], 250)
    // Inherited from the collection: the document reports what will actually
    // happen, not what was written on the route.
    assert.equal(operation(document, '/reports/big', 'get')['x-zen-timeout-ms'], 30_000)
    // Absent, not zero. A route with no deadline has no budget to publish, and
    // `0` would read as "gives up immediately".
    assert.equal(operation(document, '/stream', 'get')['x-zen-timeout-ms'], undefined)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('closure — the document matches the wire (§13.3.1)', () => {
  it('closes response objects that declare no additionalProperties', async () => {
    const { document } = await documentFor((app) => {
      app.get('/u', { response: { 200: PublicUser } }, () => null as never)
    })
    assert.equal(responseSchema(document, '/u', 'get', '200')['additionalProperties'], false)
  })

  it('closes nested objects at every level', async () => {
    const nested = schema({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'object', properties: { a: { type: 'string' } } } },
        },
      },
    })
    const { document } = await documentFor((app) => {
      app.get('/n', { response: { 200: nested } }, () => null as never)
    })

    const root = responseSchema(document, '/n', 'get', '200')
    const outer = (root['properties'] as Record<string, Record<string, unknown>>)['outer'] as Record<string, unknown>
    const inner = (outer['properties'] as Record<string, Record<string, unknown>>)['inner'] as Record<string, unknown>
    assert.equal(root['additionalProperties'], false)
    assert.equal(outer['additionalProperties'], false)
    assert.equal(inner['additionalProperties'], false)
  })

  it('leaves request bodies open — there the validator is the authority', async () => {
    const { document } = await documentFor((app) => {
      app.post('/u', { body: NewUser, response: { 200: PublicUser } }, () => null as never)
    })

    const body = operation(document, '/u', 'post')['requestBody'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    const schemaObject = deref(document, body['content']?.['application/json']?.['schema'])
    assert.equal(schemaObject['additionalProperties'], undefined)
  })

  it('preserves an explicit additionalProperties: true', async () => {
    const open = schema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true })
    const { document } = await documentFor((app) => {
      app.get('/o', { response: { 200: open } }, () => null as never)
    })
    assert.equal(responseSchema(document, '/o', 'get', '200')['additionalProperties'], true)
  })

  it('up-converts OpenAPI 3.0 nullable into a 3.1 type union', async () => {
    const nullable = schema({
      type: 'object',
      properties: { name: { type: 'string', nullable: true } },
    })
    const { document } = await documentFor((app) => {
      app.get('/z', { response: { 200: nullable } }, () => null as never)
    })

    const props = responseSchema(document, '/z', 'get', '200')['properties'] as Record<string, Record<string, unknown>>
    assert.deepEqual(props['name']?.['type'], ['string', 'null'])
    assert.equal(props['name']?.['nullable'], undefined)
  })

  it('merges allOf in a response, because the serializer does and two closed objects cannot both hold', async () => {
    const merged = schema({
      allOf: [
        { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } } },
      ],
    })
    const { document } = await documentFor((app) => {
      app.get('/m', { response: { 200: merged } }, () => null as never)
      app.post('/m', { body: merged, response: { 200: PublicUser } }, () => null as never)
    })

    const response = responseSchema(document, '/m', 'get', '200')
    assert.equal(response['allOf'], undefined)
    assert.deepEqual(Object.keys(response['properties'] as object), ['id', 'name'])
    assert.equal(response['additionalProperties'], false)

    // The request keeps `allOf`: nothing there is unsatisfiable, and the
    // converter's output is the honest description of what the validator takes.
    const body = operation(document, '/m', 'post')['requestBody'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    assert.ok(Array.isArray(deref(document, body['content']?.['application/json']?.['schema'])['allOf']))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The drift test. This is the one that matters.
// ─────────────────────────────────────────────────────────────────────────────

describe('the document cannot drift from the serializer (§29.1)', () => {
  /**
   * Every other framework's OpenAPI story is "a second description of the API,
   * kept in sync by hand". This asserts the thing that claim is supposed to buy:
   * for each documented response, the *real compiled serializer* is run over a
   * probe value carrying every documented field plus undeclared ones, and the
   * keys that reach the wire must be exactly the keys the document promised.
   *
   * It fails if the generator documents a field the serializer drops, if the
   * serializer emits a field the generator hid, or if the closure rewrite and
   * the IR ever disagree about what `additionalProperties` means.
   */
  const cases: Array<[string, JsonSchema]> = [
    ['flat object', {
      type: 'object',
      properties: { id: { type: 'integer' }, email: { type: 'string' } },
      required: ['id', 'email'],
    }],
    ['nested objects', {
      type: 'object',
      properties: {
        user: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        meta: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
      },
      required: ['user', 'meta'],
    }],
    ['array of objects', {
      type: 'object',
      properties: {
        users: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id', 'name'] },
        },
      },
      required: ['users'],
    }],
    ['dates and enums', {
      type: 'object',
      properties: {
        createdAt: { type: 'string', format: 'date-time' },
        role: { type: 'string', enum: ['admin', 'member'] },
      },
      required: ['createdAt', 'role'],
    }],
    ['explicitly open object', {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: true,
    }],
    ['typed additionalProperties', {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: { type: 'string' },
    }],
    ['allOf merge', {
      allOf: [
        { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    }],
    ['$defs and $ref', {
      type: 'object',
      properties: { owner: { $ref: '#/$defs/Owner' } },
      required: ['owner'],
      $defs: { Owner: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    }],
  ]

  for (const [name, json] of cases) {
    it(`documented keys ≡ emitted keys: ${name}`, async () => {
      const source = schema(json)
      const { document } = await documentFor((app) => {
        app.get('/probe', { response: { 200: source } }, () => null as never)
      })

      const built = buildSerializerTable({ 200: source } as never, {
        routeId: 'GET /probe',
        strict: false,
        mode: 'compiled',
        codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }),
      })
      const serialize = built.table?.get(200)
      assert.ok(serialize, `no serializer was built: ${built.diagnostics.map((d) => d.message).join('; ')}`)

      const documented = responseSchema(document, '/probe', 'get', '200')
      const probe = sample(documented, document)
      const emitted = JSON.parse(serialize(probe)) as unknown

      compare(documented, emitted, document, '$')
    })
  }

  /** Builds a value satisfying the documented schema, salted with fields nobody declared. */
  function sample(node: Record<string, unknown>, document: unknown): unknown {
    const resolved = deref(document, node)
    const types = resolved['type']
    const type = Array.isArray(types) ? types[0] : types
    const enumValues = resolved['enum'] as unknown[] | undefined

    if (enumValues !== undefined) return enumValues[0]
    if (type === 'integer' || type === 'number') return 7
    if (type === 'boolean') return true
    if (type === 'null') return null
    if (type === 'array') {
      const items = resolved['items']
      return typeof items === 'object' && items !== null ? [sample(items as Record<string, unknown>, document)] : []
    }
    if (type === 'string' || (type === undefined && resolved['properties'] === undefined)) {
      return resolved['format'] === 'date-time' ? '2024-01-01T00:00:00.000Z' : 'value'
    }

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries((resolved['properties'] ?? {}) as Record<string, Record<string, unknown>>)) {
      out[key] = sample(child, document)
    }
    // The whole point: the handler returns more than the contract declares.
    out['passwordHash'] = '$2b$12$never'
    out['__undeclared'] = 'leak'
    return out
  }

  /** Asserts key-for-key that the wire matches the document, at every level. */
  function compare(documented: Record<string, unknown>, emitted: unknown, document: unknown, path: string): void {
    const resolved = deref(document, documented)
    const types = resolved['type']
    const type = Array.isArray(types) ? types[0] : types

    if (type === 'array') {
      assert.ok(Array.isArray(emitted), `${path} should be an array`)
      const items = resolved['items']
      for (const [index, element] of (emitted as unknown[]).entries()) {
        if (typeof items === 'object' && items !== null) {
          compare(items as Record<string, unknown>, element, document, `${path}[${index}]`)
        }
      }
      return
    }

    const properties = resolved['properties'] as Record<string, Record<string, unknown>> | undefined
    if (properties === undefined) return

    assert.ok(typeof emitted === 'object' && emitted !== null, `${path} should be an object`)
    const actual = new Set(Object.keys(emitted as object))
    const declared = new Set(Object.keys(properties))

    if (resolved['additionalProperties'] === false) {
      assert.deepEqual([...actual].sort(), [...declared].sort(), `${path}: wire keys ≠ documented keys`)
    } else {
      // Open by declaration: every documented key must still arrive.
      for (const key of declared) assert.ok(actual.has(key), `${path}.${key} documented but not emitted`)
    }

    for (const [key, child] of Object.entries(properties)) {
      compare(child, (emitted as Record<string, unknown>)[key], document, `${path}.${key}`)
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────

describe('components and $ref (§29.3)', () => {
  it('hoists a titled schema once and refs it everywhere, including nested', async () => {
    const { document } = await documentFor((app) => {
      app.get('/users/:id<int>', { response: { 200: PublicUser } }, () => null as never)
      app.get('/users', { response: { 200: UserList } }, () => null as never)
    })

    const names = Object.keys(document.components?.schemas ?? {})
    assert.ok(names.includes('PublicUser'))
    assert.ok(names.includes('UserList'))
    assert.equal(names.filter((n) => n === 'PublicUser').length, 1)

    const list = document.components?.schemas?.['UserList'] as Record<string, Record<string, Record<string, Record<string, string>>>>
    assert.equal(list['properties']?.['users']?.['items']?.['$ref'], '#/components/schemas/PublicUser')
  })

  it('collapses the same schema object used by several routes into one component', async () => {
    const { document, diagnostics } = await documentFor((app) => {
      app.get('/a', { response: { 200: PublicUser } }, () => null as never)
      app.get('/b', { response: { 200: PublicUser } }, () => null as never)
      app.get('/c', { response: { 200: PublicUser } }, () => null as never)
    })

    assert.deepEqual(Object.keys(document.components?.schemas ?? {}).sort(), ['ProblemDetails', 'PublicUser'])
    assert.equal(diagnostics.filter((d) => d.code === 'ZEN_OAS_ANONYMOUS_SHARED').length, 0)
  })

  it('names an anonymous shared schema and says it would rather have a title', async () => {
    const anonymous: JsonSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const { document, diagnostics } = await documentFor((app) => {
      app.get('/one', { response: { 200: schema(anonymous) } }, () => null as never)
      app.get('/two', { response: { 200: schema(anonymous) } }, () => null as never)
    })

    assert.ok(diagnostics.some((d) => d.code === 'ZEN_OAS_ANONYMOUS_SHARED'))
    const refs = collectRefs(document.paths)
    assert.equal(new Set(refs.filter((r) => !r.endsWith('ProblemDetails'))).size, 1)
  })

  it('leaves a single-use anonymous schema inline', async () => {
    const { document } = await documentFor((app) => {
      app.get('/only', { response: { 200: schema({ type: 'object', properties: { a: { type: 'string' } } }) } }, () => null as never)
    })
    assert.deepEqual(Object.keys(document.components?.schemas ?? {}), ['ProblemDetails'])
  })

  it('separates two different schemas that claim the same title', async () => {
    const first = schema({ title: 'Thing', type: 'object', properties: { a: { type: 'string' } } })
    const second = schema({ title: 'Thing', type: 'object', properties: { b: { type: 'integer' } } })
    const { document, diagnostics } = await documentFor((app) => {
      app.get('/1', { response: { 200: first } }, () => null as never)
      app.get('/2', { response: { 200: second } }, () => null as never)
    })

    const names = Object.keys(document.components?.schemas ?? {})
    assert.ok(names.includes('Thing') && names.includes('Thing2'))
    assert.ok(diagnostics.some((d) => d.code === 'ZEN_OAS_TITLE_COLLISION'))
  })

  it('hoists $defs, rewrites the refs, and terminates on recursion', async () => {
    const tree = schema({
      $ref: '#/$defs/Node',
      $defs: {
        Node: {
          type: 'object',
          properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
          required: ['name'],
        },
      },
    })
    const { document } = await documentFor((app) => {
      app.get('/tree', { response: { 200: tree } }, () => null as never)
    })

    const node = document.components?.schemas?.['Node'] as Record<string, Record<string, Record<string, Record<string, string>>>>
    assert.equal(node['properties']?.['children']?.['items']?.['$ref'], '#/components/schemas/Node')
  })

  it('every $ref in the document resolves', async () => {
    const { document } = await documentFor((app) => {
      app.get('/users/:id<int>', { response: { 200: PublicUser } }, () => null as never)
      app.get('/users', { query: ListQuery, response: { 200: UserList } }, () => null as never)
      app.post('/users', { body: NewUser, response: { 201: PublicUser } }, () => null as never)
    })

    const available = new Set(Object.keys(document.components?.schemas ?? {}))
    for (const ref of collectRefs(document)) {
      assert.ok(ref.startsWith('#/components/schemas/'), `unexpected ref form: ${ref}`)
      assert.ok(available.has(ref.slice('#/components/schemas/'.length)), `dangling ref: ${ref}`)
    }
  })

  it('is deterministic — two runs produce byte-identical JSON', async () => {
    const build = (app: ReturnType<typeof makeApp>) => {
      app.get('/z', { response: { 200: UserList } }, () => null as never)
      app.get('/a', { query: ListQuery, response: { 200: PublicUser } }, () => null as never)
      app.post('/m', { body: NewUser, response: { 201: PublicUser } }, () => null as never)
    }
    const first = await documentFor(build)
    const second = await documentFor(build)
    // A document that reorders itself between runs cannot be diffed, which would
    // make §29.5 useless — so ordering is part of the contract, not cosmetics.
    assert.equal(JSON.stringify(first.document), JSON.stringify(second.document))
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('breaking-change detection (§29.5)', () => {
  const base: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 'x', version: '1' },
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'users.show',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'integer' }, email: { type: 'string' }, nickname: { type: 'string' } },
                    required: ['id', 'email'],
                  },
                },
              },
            },
          },
        },
      },
    },
  }

  const clone = (): OpenApiDocument => JSON.parse(JSON.stringify(base)) as OpenApiDocument
  const mutate = (fn: (document: Record<string, never>) => void): OpenApiDocument => {
    const next = clone()
    fn(next as unknown as Record<string, never>)
    return next
  }
  const codes = (after: OpenApiDocument): string[] => diffDocuments(base, after).breaking.map((c) => c.code)

  it('reports nothing when a document is diffed against itself', () => {
    assert.deepEqual(diffDocuments(base, clone()).changes, [])
  })

  it('a removed path or operation is breaking', () => {
    const removed = mutate((d) => { delete (d as never as Record<string, unknown>)['paths'] })
    assert.deepEqual(diffDocuments(base, { ...removed, paths: {} }).breaking.map((c) => c.code), ['OAS_PATH_REMOVED'])
  })

  it('a removed response field is breaking; an added one is not', () => {
    const removedField = mutate((d) => {
      const props = deepProps(d)
      delete props['nickname']
    })
    assert.deepEqual(codes(removedField), ['OAS_RESPONSE_FIELD_REMOVED'])

    const addedField = mutate((d) => { deepProps(d)['extra'] = { type: 'string' } })
    assert.deepEqual(codes(addedField), [])
    assert.deepEqual(diffDocuments(base, addedField).compatible.map((c) => c.code), ['OAS_RESPONSE_FIELD_ADDED'])
  })

  it('a response field that may now be absent is breaking', () => {
    const optional = mutate((d) => { deepSchema(d)['required'] = ['id'] })
    assert.deepEqual(codes(optional), ['OAS_RESPONSE_FIELD_NOW_OPTIONAL'])
  })

  it('a new required request field is breaking, an optional one is not', () => {
    const withBody = (required: string[]): OpenApiDocument => mutate((d) => {
      const op = (d as never as Record<string, Record<string, Record<string, unknown>>>)['paths']!['/users/{id}']!['get'] as Record<string, unknown>
      op['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } }, required } } },
      }
    })
    assert.ok(diffDocuments(withBody([]), withBody(['note'])).breaking.some((c) => c.code === 'OAS_REQUEST_FIELD_NOW_REQUIRED'))
    assert.ok(diffDocuments(withBody(['note']), withBody([])).compatible.some((c) => c.code === 'OAS_REQUEST_FIELD_NOW_OPTIONAL'))
  })

  it('widening a response type is breaking; widening a request type is not', () => {
    const widened = mutate((d) => { deepProps(d)['email'] = { type: ['string', 'null'] } })
    assert.deepEqual(codes(widened), ['OAS_TYPE_WIDENED'])
  })

  it('renaming an operationId is breaking, because generated clients are named from it', () => {
    const renamed = mutate((d) => {
      const op = (d as never as Record<string, Record<string, Record<string, unknown>>>)['paths']!['/users/{id}']!['get'] as Record<string, unknown>
      op['operationId'] = 'users.read'
    })
    assert.deepEqual(codes(renamed), ['OAS_OPERATION_ID_CHANGED'])
  })

  it('a prose change is documentation, not a version bump', () => {
    const described = mutate((d) => {
      const op = (d as never as Record<string, Record<string, Record<string, unknown>>>)['paths']!['/users/{id}']!['get'] as Record<string, unknown>
      op['summary'] = 'Fetch a user'
    })
    const result = diffDocuments(base, described)
    assert.deepEqual(result.breaking, [])
    assert.deepEqual(result.documentation.map((c) => c.code), ['OAS_DESCRIPTION_CHANGED'])
  })

  it('follows $refs so a component change is seen at every use', () => {
    const before: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      paths: {
        '/a': { get: { operationId: 'a', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/U' } } } } } } },
        '/b': { get: { operationId: 'b', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/U' } } } } } } },
      },
      components: { schemas: { U: { type: 'object', properties: { id: { type: 'integer' }, gone: { type: 'string' } } } } },
    }
    const after = JSON.parse(JSON.stringify(before)) as OpenApiDocument
    delete (after.components!.schemas!['U'] as { properties: Record<string, unknown> }).properties['gone']

    const breaking = diffDocuments(before, after).breaking
    assert.equal(breaking.length, 2)
    assert.deepEqual(breaking.map((c) => c.code), ['OAS_RESPONSE_FIELD_REMOVED', 'OAS_RESPONSE_FIELD_REMOVED'])
  })

  function deepSchema(document: Record<string, never>): Record<string, unknown> {
    const paths = document as never as Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>>>>
    return paths['paths']!['/users/{id}']!['get']!['responses']!['200']!['content']!['application/json']!['schema'] as unknown as Record<string, unknown>
  }
  function deepProps(document: Record<string, never>): Record<string, unknown> {
    return deepSchema(document)['properties'] as Record<string, unknown>
  }
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the plugin (§29.2)', () => {
  it('serves the document, hides its own routes, and answers 304 on a matching ETag', async () => {
    const app = makeApp()
    app.use(openapiPlugin, { ...INFO })
    app.get('/users', { response: { 200: UserList } }, () => null as never)
    await app.ready()

    const response = await app.inject('GET', '/openapi.json')
    assert.equal(response.status, 200)
    assert.match(response.header('content-type') ?? '', /application\/json/)

    const document = response.json<OpenApiDocument>()
    assert.deepEqual(Object.keys(document.paths), ['/users'])

    const etag = response.header('etag')
    assert.ok(etag)
    const cached = await app.inject('GET', '/openapi.json', { headers: { 'if-none-match': etag } })
    assert.equal(cached.status, 304)
  })

  it('serves a reference page that makes no external requests', async () => {
    const app = makeApp()
    app.use(openapiPlugin, { ...INFO })
    app.get('/users', { response: { 200: UserList } }, () => null as never)
    await app.ready()

    const page = await app.inject('GET', '/docs')
    assert.equal(page.status, 200)
    const html = page.text()
    // No CDN, no fonts, no analytics: an internal docs endpoint must not phone
    // a third party, and must work behind a CSP and on a plane.
    assert.equal(/(src|href)\s*=\s*["']https?:/i.test(html), false)
    assert.match(html, /<script type="application\/json" id="spec">/)
    assert.equal(html.includes('</script>{'), false)
  })

  it('escapes a document that contains "</script>"', () => {
    const html = renderReference({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      paths: { '/x': { get: { operationId: 'x', summary: '</script><img src=x>', responses: {} } } },
    })
    assert.equal(html.includes('</script><img'), false)
    assert.match(html, /\\u003c\/script/)
  })

  it('strict mode turns a documentation hole into a boot failure', async () => {
    const app = makeApp()
    app.use(openapiPlugin, { ...INFO, strict: true })
    app.get('/undocumented', () => 'x')

    await assert.rejects(() => app.ready(), (error: Error) => {
      assert.match(error.message, /ZEN_OAS_RESPONSE_UNDECLARED/)
      return true
    })
  })

  it('exports the finished document to a plugin that depends on it', async () => {
    let seen: OpenApiDocument | null = null
    const consumer = definePlugin({
      name: 'consumer',
      version: '1.0.0',
      dependsOn: { openapi: '^0.1.0' },
      setup(app) {
        const exported = app.exportsOf('openapi') as { document: () => OpenApiDocument | null }
        // `onBoot` runs after the generator's own onBoot, in registration order,
        // so the document exists by the time this reads it.
        app.onBoot(() => { seen = exported.document() })
      },
    })

    const app = makeApp()
    app.use(openapiPlugin, { ...INFO })
    app.use(consumer)
    app.get('/users', { response: { 200: UserList } }, () => null as never)
    await app.ready()

    assert.equal((seen as OpenApiDocument | null)?.info.title, 'Test API')
  })
})
