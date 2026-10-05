/**
 * The application whose generated code is committed.
 *
 * One fixture that takes every path through the compilers: the context class
 * with a slot and an accessor decoration; hooks in every phase; phase, around
 * and after middleware, sync and async; route-scoped middleware; typed params;
 * a body with validation; query coercion; compiled serializers; a negotiated
 * route with an encoder; a deadline; and a route with nothing at all, which is
 * what every byte-identical gate compares against.
 *
 * Deterministic on purpose: fixed slot names (this fixture is loaded by one
 * test file, in its own process), registration in source order, and nothing
 * that varies between runs or machines.
 */
import { createApp, jsonSchema, markSync, registerMediaEncoder, slot, type ZenApp } from '@erenthedeveloper0/zen-core'
import { ZenRouter } from '@erenthedeveloper0/zen-router'
import { pathParser, shaped, silentLogger } from '../helpers.ts'

const User = jsonSchema<{ id: number; email: string; tags: string[] }>({
  title: 'User',
  type: 'object',
  properties: { id: { type: 'integer' }, email: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
  required: ['id', 'email', 'tags'],
})
const Rows = jsonSchema<Array<{ id: number; email: string }>>({
  type: 'array',
  items: { type: 'object', properties: { id: { type: 'integer' }, email: { type: 'string' } }, required: ['id', 'email'] },
})
const NewUser = shaped({ type: 'object', properties: { email: { type: 'string' } }, required: ['email'] })
const Search = shaped({
  type: 'object',
  properties: { page: { type: 'integer' }, active: { type: 'boolean' }, q: { type: 'string' } },
})

export async function generatedFixture(): Promise<ZenApp> {
  const Tenant = slot<string>('fixture.tenant')

  registerMediaEncoder('text/csv', (schema) => {
    const items = schema?.['items'] as { properties?: Record<string, unknown> } | undefined
    const columns = Object.keys(items?.properties ?? {})
    return (value) => [columns.join(','), ...(value as Array<Record<string, unknown>>).map((row) => columns.map((c) => String(row[c])).join(','))].join('\n')
  })

  const app = createApp({ router: new ZenRouter(), pathParser, logger: silentLogger() }) as unknown as ZenApp

  app.decorate('tenant', Tenant)
  app.decorate('requestedAt', () => 0)

  app.use(markSync(function tagRequest() {}))
  app.around(async function timing(_ctx, next) { return next() })
  app.after(markSync(function audit(_ctx, reply) { return reply }))

  // The routes with nothing of their own.
  app.get('/', () => 'root')
  app.get('/users/:id<int>', { response: { 200: User } }, markSync(() => ({ id: 1, email: 'a@x', tags: [] })) as never)
  app.post('/users', { body: NewUser, response: { 201: User } }, async () => ({ id: 2, email: 'b@x', tags: [] }) as never)
  app.get('/search', { query: Search }, (ctx) => ({ query: ctx.query }))
  app.get('/export', { response: { 200: { 'application/json': Rows, 'text/csv': Rows } } }, () => [] as never)
  app.get('/slow', { timeout: '2s' }, async () => 'slow')
  app.get('/owned/:id', { use: [markSync(function checkOwnership() {}), async function audited() {}] }, () => 'mine')

  // Every phase, on a subtree, so the routes above stay hookless.
  app.collection('/hooked', { timeout: '5s' }, (c) => {
    c.use(async function collectionGuard() {})
    c.hook('onRequest', markSync(function onRequest() {}))
    c.hook('onRoute', function onRoute() {})
    c.hook('onParse', async function onParse() { return { parsed: true } })
    c.hook('preValidation', function preValidation() {})
    c.hook('postValidation', function postValidation() {})
    c.hook('preHandler', async function preHandler() {})
    c.hook('postHandler', function postHandler() {})
    c.hook('onSerialize', function onSerialize(_ctx: unknown, payload: unknown) { return payload })
    c.hook('onSend', function onSend() {})
    c.hook('onResponse', function onResponse() {})
    c.hook('onError', function onError() {})
    c.hook('onTimeout', function onTimeout() {})
    c.post('/echo', { body: NewUser, response: { 200: User } }, (ctx) => ctx.body as never)
    c.get('/plain', () => 'plain')
  })

  await app.ready()
  return app
}

/** The generated units, as one reviewable text. */
export function renderUnits(units: readonly { readonly name: string; readonly source: string }[]): string {
  return units
    .map((unit) => `// ─── ${unit.name} ${'─'.repeat(Math.max(2, 70 - unit.name.length))}\n${unit.source.trimEnd()}\n`)
    .join('\n')
}
