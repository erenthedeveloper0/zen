import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serializeCookie, parseCookies, formParser, BODY_DEFAULTS } from '@visionpilot/zen-core'
import { makeApp } from './helpers.ts'

describe('Set-Cookie serialization (§19.2, §19.5)', () => {
  it('writes the defaults §19.2 names: HttpOnly, SameSite=Lax, Path=/', () => {
    assert.equal(serializeCookie({ name: 'sid', value: 'a b' }), 'sid=a%20b; Path=/; HttpOnly; SameSite=Lax')
  })

  it('refuses a `;` in the name, the domain or the path — it would start a new attribute', () => {
    assert.throws(() => serializeCookie({ name: 'sid', value: 'x', path: '/; Domain=evil.example' }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => serializeCookie({ name: 'sid', value: 'x', domain: 'good.example; Secure=false' }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => serializeCookie({ name: 'a=b', value: 'x' }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => serializeCookie({ name: 'has space', value: 'x' }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => serializeCookie({ name: '', value: 'x' }), { code: 'ZEN_HEADER_INVALID' })
  })

  it('percent-encodes the value, so the value cannot break out either', () => {
    assert.equal(serializeCookie({ name: 'n', value: 'x; Domain=evil' }).split(';')[0], 'n=x%3B%20Domain%3Devil')
  })

  it('adds Secure where a browser would otherwise drop the cookie', () => {
    assert.match(serializeCookie({ name: '__Host-sid', value: 'x' }), /; Secure/)
    assert.match(serializeCookie({ name: '__Secure-sid', value: 'x' }), /; Secure/)
    assert.match(serializeCookie({ name: 'sid', value: 'x', sameSite: 'none' }), /; Secure; SameSite=None$/)
    assert.doesNotMatch(serializeCookie({ name: 'sid', value: 'x' }), /Secure/)
    assert.doesNotMatch(serializeCookie({ name: '__Host-sid', value: 'x', secure: false }), /Secure/, 'an explicit false wins')
  })

  it('ignores a Max-Age that is not a number rather than writing "Max-Age=NaN"', () => {
    assert.doesNotMatch(serializeCookie({ name: 'n', value: 'x', maxAge: Number.NaN }), /Max-Age/)
  })

  it('marks a cookie Secure when the request arrived over HTTPS through a trusted proxy', async () => {
    const app = makeApp({ trustProxy: true })
    app.get('/', (ctx) => {
      ctx.res.cookie('sid', 'abc')
      return 'ok'
    })
    const https = await app.inject('GET', '/', { headers: { 'x-forwarded-proto': 'https' } })
    assert.match(https.headerValues('set-cookie')[0] ?? '', /; Secure/)
    const http = await app.inject('GET', '/', { headers: { 'x-forwarded-proto': 'http' } })
    assert.doesNotMatch(http.headerValues('set-cookie')[0] ?? '', /Secure/)
  })

  it('does not trust X-Forwarded-Proto without trustProxy', async () => {
    const app = makeApp()
    app.get('/', (ctx) => {
      ctx.res.cookie('sid', 'abc')
      return 'ok'
    })
    const res = await app.inject('GET', '/', { headers: { 'x-forwarded-proto': 'https' } })
    assert.doesNotMatch(res.headerValues('set-cookie')[0] ?? '', /Secure/)
  })

  it('parses the first of two cookies with one name, and strips prototype keys', () => {
    const parsed = parseCookies('a=1; a=2; __proto__=x; b="quoted"')
    assert.equal(parsed['a'], '1')
    assert.equal(parsed['b'], 'quoted')
    assert.equal(Object.getPrototypeOf(parsed), null)
    assert.equal(Object.hasOwn(parsed, '__proto__'), false)
  })
})

describe('form bodies are bounded (§19.2)', () => {
  const encode = (text: string) => new TextEncoder().encode(text)

  it('parses up to maxFields and refuses the body past it with a 413', () => {
    const opts = { ...BODY_DEFAULTS, maxFields: 3 }
    assert.deepEqual({ ...formParser(encode('a=1&b=2&a=3'), null as never, opts) as object }, { a: ['1', '3'], b: '2' })
    assert.throws(() => formParser(encode('a=1&b=2&c=3&d=4'), null as never, opts), { status: 413 })
  })

  it('does not count empty segments', () => {
    const opts = { ...BODY_DEFAULTS, maxFields: 2 }
    assert.deepEqual({ ...formParser(encode('&&a=1&&b=2&&'), null as never, opts) as object }, { a: '1', b: '2' })
  })

  it('answers 413 through the pipeline', async () => {
    const app = makeApp({ body: { maxFields: 10 } })
    const any = { '~standard': { version: 1 as const, vendor: 't', validate: (value: unknown) => ({ value }) } }
    app.post('/form', { body: any }, (ctx) => ({ keys: Object.keys(ctx.body as object).length }))
    const pairs = Array.from({ length: 11 }, (_, i) => `k${i}=v`).join('&')
    const res = await app.inject('POST', '/form', {
      body: pairs,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.equal(res.status, 413)
    const ok = await app.inject('POST', '/form', {
      body: pairs.split('&').slice(0, 10).join('&'),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.deepEqual(ok.json(), { keys: 10 })
  })
})
