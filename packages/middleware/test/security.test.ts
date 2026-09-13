import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cors, rateLimit, securityHeaders } from '../src/index.ts'
import { bootFailure, makeApp } from './helpers.ts'

/**
 * Security response headers — rfcs/0001 §19.2.
 *
 * The set is §19.2's table and the table is the specification, so the first
 * suite below is a transcription check: if the table changes, this fails, and
 * that is the intended relationship between them.
 *
 * The second suite is the one that matters. §19.2's headers exist to constrain
 * how a browser treats a response, and the responses most likely to contain
 * reflected input — a 404 echoing a path, a validation error echoing a field,
 * a 500 — are exactly the ones an `after` middleware never sees (§4.6). Every
 * assertion there is against a response the handler never produced.
 */

function app(options: Parameters<typeof securityHeaders>[0] = {}) {
  const a = makeApp()
  a.use(securityHeaders(options))
  a.get('/ok', () => ({ ok: true }))
  a.get('/boom', () => { throw new Error('kaboom') })
  return a
}

const DEFAULT_SET: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
}

describe('the default set is §19.2\'s table', () => {
  test('every row is present with the documented value', async () => {
    const res = await app().inject('GET', '/ok')
    for (const [name, value] of Object.entries(DEFAULT_SET)) {
      assert.equal(res.header(name), value, name)
    }
  })

  test('HSTS is off by default — a header you cannot take back is not a default', async () => {
    const res = await app().inject('GET', '/ok')
    assert.equal(res.header('strict-transport-security'), undefined)
  })

  test('CSP is not set by default — §19.2 prompts rather than guesses', async () => {
    const res = await app().inject('GET', '/ok')
    assert.equal(res.header('content-security-policy'), undefined)
  })

  test('x-powered-by is absent, with or without this plugin', async () => {
    for (const res of [await app().inject('GET', '/ok'), await makeApp().inject('GET', '/nope')]) {
      assert.equal(res.header('x-powered-by'), undefined)
    }
  })
})

describe('the headers are on the responses that need them most (§4.6)', () => {
  test('a 404 carries the full set', async () => {
    const res = await app().inject('GET', '/no-such-path')
    assert.equal(res.status, 404)
    for (const [name, value] of Object.entries(DEFAULT_SET)) assert.equal(res.header(name), value, name)
  })

  test('a 500 carries the full set', async () => {
    const res = await app().inject('GET', '/boom')
    assert.equal(res.status, 500)
    assert.equal(res.header('x-content-type-options'), 'nosniff')
  })

  test('a 405 carries the full set', async () => {
    const res = await app().inject('POST', '/ok')
    assert.equal(res.status, 405)
    assert.equal(res.header('x-content-type-options'), 'nosniff')
  })

  test('a CORS preflight carries them, though nothing downstream of cors runs', async () => {
    // The defect the first draft had: `securityHeaders` was ordered last, `cors`
    // short-circuits the `onRequest` chain to answer a preflight, and every
    // preflight went out bare. Registered here in the order that would have
    // reproduced it.
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.use(securityHeaders())
    a.get('/ok', () => ({ ok: true }))

    const res = await a.inject('OPTIONS', '/ok', {
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.header('x-content-type-options'), 'nosniff')
  })

  test('a 429 carries them, though the limiter threw before the chain finished', async () => {
    const a = makeApp()
    a.use(rateLimit({ limit: 1, window: '1m' }))
    a.use(securityHeaders())
    a.get('/ok', () => ({ ok: true }))

    await a.inject('GET', '/ok')
    const res = await a.inject('GET', '/ok')
    assert.equal(res.status, 429)
    assert.equal(res.header('x-content-type-options'), 'nosniff')
  })

  test('an application header on the reply survives alongside them', async () => {
    const a = makeApp()
    a.use(securityHeaders())
    a.get('/ok', (ctx) => ctx.json({ ok: true }, { headers: { 'x-mine': '1' } }))

    const res = await a.inject('GET', '/ok')
    assert.equal(res.header('x-mine'), '1')
    assert.equal(res.header('x-frame-options'), 'DENY')
  })
})

describe('each option', () => {
  test('frameOptions: false omits the header', async () => {
    assert.equal((await app({ frameOptions: false }).inject('GET', '/ok')).header('x-frame-options'), undefined)
  })

  test('frameOptions: SAMEORIGIN', async () => {
    assert.equal((await app({ frameOptions: 'SAMEORIGIN' }).inject('GET', '/ok')).header('x-frame-options'), 'SAMEORIGIN')
  })

  test('referrerPolicy', async () => {
    const res = await app({ referrerPolicy: 'strict-origin-when-cross-origin' }).inject('GET', '/ok')
    assert.equal(res.header('referrer-policy'), 'strict-origin-when-cross-origin')
  })

  test('hsts renders max-age, includeSubDomains and preload in that order', async () => {
    const res = await app({ hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true } }).inject('GET', '/ok')
    assert.equal(res.header('strict-transport-security'), 'max-age=31536000; includeSubDomains; preload')
  })

  test('hsts defaults to 180 days when enabled with no max-age', async () => {
    const res = await app({ hsts: {} }).inject('GET', '/ok')
    assert.equal(res.header('strict-transport-security'), 'max-age=15552000')
  })

  test('contentSecurityPolicy is emitted verbatim', async () => {
    const policy = "default-src 'self'; frame-ancestors 'none'"
    assert.equal((await app({ contentSecurityPolicy: policy }).inject('GET', '/ok')).header('content-security-policy'), policy)
  })

  test('extra headers are staged with the rest and lowercased', async () => {
    const res = await app({ headers: { 'X-Permitted-Cross-Domain-Policies': 'none' } }).inject('GET', '/ok')
    assert.equal(res.header('x-permitted-cross-domain-policies'), 'none')
  })

  test('noSniff: false omits it — the flag exists so the test above can fail honestly', async () => {
    assert.equal((await app({ noSniff: false }).inject('GET', '/ok')).header('x-content-type-options'), undefined)
  })
})

describe('the contradiction with CORS is a boot error (§2.4)', () => {
  const contradictory = (order: 'cors first' | 'security first') => {
    const a = makeApp()
    const c = cors({ origin: ['https://app.example.com'] })
    const s = securityHeaders({ crossOriginResource: 'same-origin' })
    if (order === 'cors first') { a.use(c); a.use(s) } else { a.use(s); a.use(c) }
    a.get('/ok', () => ({ ok: true }))
    return a
  }

  for (const order of ['cors first', 'security first'] as const) {
    test(`caught with ${order} — whichever runs second sees both halves`, async () => {
      const message = await bootFailure(contradictory(order))
      assert.match(message, /Cross-Origin-Resource-Policy: same-origin while cors allows/)
    })
  }

  test('the message names both settings and the fix is actionable', async () => {
    const message = await bootFailure(contradictory('cors first'))
    assert.match(message, /https:\/\/app\.example\.com/)
    assert.match(message, /fix: Use crossOriginResource: 'same-site'/)
    assert.match(message, /also: .*fails with a message naming CORS/)
  })

  test('the default CORP does not trip it', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.use(securityHeaders())
    a.get('/ok', () => ({ ok: true }))
    await a.ready()
    assert.equal((await a.inject('GET', '/ok')).header('cross-origin-resource-policy'), 'same-site')
  })

  test('same-origin without CORS registered is fine — it is the pair that is wrong', async () => {
    const a = app({ crossOriginResource: 'same-origin' })
    await a.ready()
    assert.equal((await a.inject('GET', '/ok')).header('cross-origin-resource-policy'), 'same-origin')
  })

  test("an empty CORS allowlist allows nothing, so the pair is not a contradiction", async () => {
    const a = makeApp()
    a.use(cors({ origin: [] }))
    a.use(securityHeaders({ crossOriginResource: 'same-origin' }))
    a.get('/ok', () => ({ ok: true }))
    await a.ready()
    assert.equal((await a.inject('GET', '/ok')).status, 200)
  })
})
