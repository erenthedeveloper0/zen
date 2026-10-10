import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerIssueMapper, issueMapperFor, __resetIssueMappers, normaliseIssues, type IssueCode,
} from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

/**
 * `issues[].code` — §11.2, I7. The seam, not any one library: these schemas
 * stand in for a vendor whose issues carry a native `code` and a message in a
 * language the heuristic cannot read. `examples/coercion` runs the documented
 * Zod mapper against real Zod, in two locales.
 */

type Raw = { readonly message: string; readonly path?: readonly PropertyKey[]; readonly code?: string }

/** A schema from `vendor` that reports `issues(value)`, or passes when there are none. */
function vendorSchema(vendor: string, issues: (value: unknown) => readonly Raw[], async = false) {
  const validate = (value: unknown) => {
    const found = issues(value)
    const result = found.length === 0 ? { value } : { issues: found }
    return async ? Promise.resolve(result) : result
  }
  return { '~standard': { version: 1 as const, vendor, validate } } as never
}

/** Every key of `fields` whose value is not a number, reported the way a translated library would. */
const numbers = (...fields: string[]) => (value: unknown): Raw[] => {
  const record = (value ?? {}) as Record<string, unknown>
  return fields
    .filter((field) => typeof record[field] !== 'number')
    .map((field) => ({ message: `Geçersiz değer: ${field}`, path: [field], code: 'too_small' }))
}

type Problem = { status: number; errors: Array<{ source: string; path: unknown[]; code: string }> }

const ACME: Readonly<Record<string, IssueCode>> = { too_small: 'min', too_big: 'max', bad_type: 'type' }
const acme = (issue: { readonly [key: string]: unknown }): IssueCode | undefined =>
  typeof issue['code'] === 'string' ? ACME[issue['code']] : undefined

afterEach(() => __resetIssueMappers())

describe('a vendor issue mapper decides the code, not the message (§11.2)', () => {
  it('maps the issue by its own fields, whatever language the message is in', async () => {
    registerIssueMapper('acme', acme)
    const app = makeApp()
    app.get('/items', { query: vendorSchema('acme', numbers('page')) }, () => 'ok')
    const res = await app.inject('GET', '/items?page=x')
    assert.equal(res.status, 400)
    assert.deepEqual(res.json<Problem>().errors.map((e) => [e.source, e.path, e.code]), [['query', ['page'], 'min']])
  })

  it('is looked up when a request fails, so one registered after ready() still applies', async () => {
    const app = makeApp()
    app.get('/items', { query: vendorSchema('acme', numbers('page')) }, () => 'ok')
    await app.ready()
    registerIssueMapper('acme', acme)
    const res = await app.inject('GET', '/items?page=x')
    assert.equal(res.json<Problem>().errors[0]?.code, 'min')
  })

  it('applies to async validators and to every source of a combined stage', async () => {
    registerIssueMapper('acme', acme)
    const app = makeApp()
    app.post('/orders', {
      query: vendorSchema('acme', numbers('page')),
      body: vendorSchema('acme', numbers('qty'), true),
    }, () => 'ok')
    const res = await app.inject('POST', '/orders?page=x', { body: { qty: 'many' } })
    assert.deepEqual(res.json<Problem>().errors.map((e) => [e.source, e.code]), [['query', 'min'], ['body', 'min']])
  })

  it('falls back to the message where the mapper returns undefined, or the vendor has none', async () => {
    registerIssueMapper('acme', () => undefined)
    const app = makeApp()
    const english = (value: unknown): Raw[] =>
      (value as { page?: unknown }).page === '0' ? [{ message: 'Too big: 9 at most', path: ['page'] }] : []
    app.get('/mapped', { query: vendorSchema('acme', english) }, () => 'ok')
    app.get('/unmapped', { query: vendorSchema('other', english) }, () => 'ok')
    for (const path of ['/mapped?page=0', '/unmapped?page=0']) {
      assert.equal((await app.inject('GET', path)).json<Problem>().errors[0]?.code, 'max', path)
    }
  })

  it('belongs to one vendor: another vendor\'s issues never reach it', async () => {
    let asked = 0
    registerIssueMapper('acme', () => { asked++; return 'min' })
    const app = makeApp()
    app.get('/x', { query: vendorSchema('other', numbers('page')) }, () => 'ok')
    await app.inject('GET', '/x?page=x')
    assert.equal(asked, 0)
    assert.equal(issueMapperFor('other'), undefined)
    assert.equal(issueMapperFor('acme') !== undefined, true)
  })
})

describe('a missing value is `required`, whichever library reported it (§11.2)', () => {
  it('is decided from the input, before any mapper is asked', async () => {
    let asked = 0
    registerIssueMapper('acme', (issue) => { asked++; return acme(issue) })
    const app = makeApp()
    app.get('/items', { query: vendorSchema('acme', numbers('page', 'size')) }, () => 'ok')
    const res = await app.inject('GET', '/items?size=x')
    assert.deepEqual(res.json<Problem>().errors.map((e) => [e.path, e.code]), [[['page'], 'required'], [['size'], 'min']])
    assert.equal(asked, 1, 'only the issue whose value was present')
  })

  it('reads nested paths, and only the input\'s own keys', async () => {
    const nested = (value: unknown): Raw[] => {
      const body = value as { user?: { name?: unknown } }
      return typeof body.user?.name === 'string' ? [] : [{ message: 'x', path: ['user', 'name'], code: 'bad_type' }]
    }
    const inherited = (): Raw[] => [{ message: 'x', path: ['constructor'], code: 'bad_type' }]
    registerIssueMapper('acme', acme)
    const app = makeApp()
    app.post('/nested', { body: vendorSchema('acme', nested) }, () => 'ok')
    app.post('/inherited', { body: vendorSchema('acme', inherited) }, () => 'ok')

    const missing = await app.inject('POST', '/nested', { body: { user: {} } })
    const wrong = await app.inject('POST', '/nested', { body: { user: { name: 7 } } })
    const proto = await app.inject('POST', '/inherited', { body: {} })
    assert.equal(missing.json<Problem>().errors[0]?.code, 'required')
    assert.equal(wrong.json<Problem>().errors[0]?.code, 'type')
    assert.equal(proto.json<Problem>().errors[0]?.code, 'required', 'Object.prototype.constructor is not a value the request sent')
  })

  it('counts null as a value, and a body that was never sent as missing', () => {
    const issue = [{ message: 'x', path: [] as PropertyKey[], code: 'bad_type' }]
    assert.equal(normaliseIssues(issue, 'body', acme, { input: null })[0]?.code, 'type')
    assert.equal(normaliseIssues(issue, 'body', acme, { input: undefined })[0]?.code, 'required')
    assert.equal(normaliseIssues(issue, 'body', acme)[0]?.code, 'type', 'no input given: nothing to read a missing value from')
  })
})
