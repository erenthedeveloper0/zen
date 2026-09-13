import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { requestId } from '../src/index.ts'
import { makeApp } from './helpers.ts'

/**
 * Request id — rfcs/0001 §19.4, §31.1.
 *
 * Two claims, and the second is the reason this is a plugin rather than a
 * default:
 *
 *   1. the id a caller is handed is the id the logs and the problem document
 *      are filed under — a correlation key that correlates with nothing is
 *      worse than none, because it is *believed*;
 *   2. adopting an inbound id is a **trust decision**, off by default, and
 *      bounded even when taken. An `X-Request-Id` is attacker-controlled and
 *      ends up in every log line for the request.
 */

function app(options: Parameters<typeof requestId>[0] = {}) {
  const a = makeApp()
  a.use(requestId(options))
  a.get('/ok', (ctx) => ({ id: ctx.id }))
  a.get('/boom', () => { throw new Error('kaboom') })
  return a
}

describe('echoing', () => {
  test('the reply carries the id the handler saw', async () => {
    const res = await app().inject('GET', '/ok')
    const body = res.json<{ id: string }>()
    assert.equal(res.header('x-request-id'), body.id)
    assert.ok(body.id.length > 0)
  })

  test('two requests get different ids', async () => {
    const a = app()
    const first = (await a.inject('GET', '/ok')).header('x-request-id')
    const second = (await a.inject('GET', '/ok')).header('x-request-id')
    assert.notEqual(first, second)
  })

  test('the id on a 500 matches the requestId in the problem document', async () => {
    // The claim that makes the header worth having. A caller reads the header,
    // an operator greps the logs; if the two disagree the correlation key is
    // decorative.
    const res = await app().inject('GET', '/boom')
    assert.equal(res.status, 500)
    assert.equal(res.header('x-request-id'), res.json<{ requestId: string }>().requestId)
  })

  test('a 404 carries one too', async () => {
    const res = await app().inject('GET', '/nope')
    assert.equal(res.status, 404)
    assert.equal(res.header('x-request-id'), res.json<{ requestId: string }>().requestId)
  })

  test('a custom header name', async () => {
    const res = await app({ header: 'x-correlation-id' }).inject('GET', '/ok')
    assert.equal(res.header('x-correlation-id'), res.json<{ id: string }>().id)
    assert.equal(res.header('x-request-id'), undefined)
  })
})

describe('adopting an inbound id is off by default (§19.4)', () => {
  test('an inbound id is ignored unless trusted', async () => {
    const res = await app().inject('GET', '/ok', { headers: { 'x-request-id': 'caller-supplied-value' } })
    assert.notEqual(res.json<{ id: string }>().id, 'caller-supplied-value')
  })

  test('trustHeader: true adopts a well-formed id', async () => {
    const res = await app({ trustHeader: true }).inject('GET', '/ok', {
      headers: { 'x-request-id': '01HZY8QK4T7ZC9V2N5M3XW6RPB' },
    })
    assert.equal(res.json<{ id: string }>().id, '01HZY8QK4T7ZC9V2N5M3XW6RPB')
    assert.equal(res.header('x-request-id'), '01HZY8QK4T7ZC9V2N5M3XW6RPB')
  })

  test('a separate inbound header is read while a different one is echoed', async () => {
    const a = makeApp()
    a.use(requestId({ header: 'x-request-id', trustHeader: 'x-amzn-trace-id' }))
    a.get('/ok', (ctx) => ({ id: ctx.id }))

    const res = await a.inject('GET', '/ok', { headers: { 'x-amzn-trace-id': 'Root-1-63441c4a-abcdef012345' } })
    assert.equal(res.header('x-request-id'), 'Root-1-63441c4a-abcdef012345')
  })

  test('the adopted id is what the problem document reports', async () => {
    const res = await app({ trustHeader: true }).inject('GET', '/boom', {
      headers: { 'x-request-id': 'trace-abcdef-012345' },
    })
    assert.equal(res.json<{ requestId: string }>().requestId, 'trace-abcdef-012345')
  })
})

describe('a rejected id is replaced, not refused', () => {
  const bad: Readonly<Record<string, string>> = {
    'a newline (log injection)': 'abcdefgh\nFAKE LOG LINE',
    'a carriage return': 'abcdefgh\rmore',
    'a space': 'abc def ghi',
    'too short': 'abc',
    'too long': 'x'.repeat(129),
    'a semicolon': 'abcdefgh;drop',
    'a quote': 'abcdefgh"x',
    'unicode': 'abcdefgh x',
  }

  for (const [why, value] of Object.entries(bad)) {
    test(`${why} is refused and a fresh id is issued`, async () => {
      const res = await app({ trustHeader: true }).inject('GET', '/ok', { headers: { 'x-request-id': value } })
      assert.equal(res.status, 200, 'the request is served, not refused')
      assert.notEqual(res.json<{ id: string }>().id, value)
      assert.equal(res.header('x-request-id-rejected'), '1')
    })
  }

  test('a good id sets no rejection header', async () => {
    const res = await app({ trustHeader: true }).inject('GET', '/ok', { headers: { 'x-request-id': 'good-enough-id' } })
    assert.equal(res.header('x-request-id-rejected'), undefined)
  })

  test('no inbound header at all sets no rejection header', async () => {
    const res = await app({ trustHeader: true }).inject('GET', '/ok')
    assert.equal(res.header('x-request-id-rejected'), undefined)
  })

  test('rejectedHeader: false stays silent', async () => {
    const res = await app({ trustHeader: true, rejectedHeader: false }).inject('GET', '/ok', {
      headers: { 'x-request-id': 'no' },
    })
    assert.equal(res.header('x-request-id-rejected'), undefined)
    assert.notEqual(res.json<{ id: string }>().id, 'no')
  })

  test('the boundary values of the length rule', async () => {
    const a = app({ trustHeader: true })
    const eight = 'abcdefgh'
    const oneTwentyEight = 'a'.repeat(128)
    assert.equal((await a.inject('GET', '/ok', { headers: { 'x-request-id': eight } })).json<{ id: string }>().id, eight)
    assert.equal(
      (await a.inject('GET', '/ok', { headers: { 'x-request-id': oneTwentyEight } })).json<{ id: string }>().id,
      oneTwentyEight,
    )
    assert.notEqual(
      (await a.inject('GET', '/ok', { headers: { 'x-request-id': 'abcdefg' } })).json<{ id: string }>().id,
      'abcdefg',
    )
  })
})

describe('configuration that would do nothing is refused', () => {
  test('neither echoing nor adopting is a boot error naming the fix', () => {
    assert.throws(
      () => requestId({ header: false }),
      (error: Error & { hint?: string }) => {
        assert.match(error.message, /neither echo an id nor adopt one/)
        assert.match(error.hint ?? '', /Drop the registration/)
        return true
      },
    )
  })

  test('header: false with trustHeader is allowed — adopting alone is a real configuration', async () => {
    const a = makeApp()
    a.use(requestId({ header: false, trustHeader: 'x-trace' }))
    a.get('/ok', (ctx) => ({ id: ctx.id }))

    const res = await a.inject('GET', '/ok', { headers: { 'x-trace': 'inbound-trace-id' } })
    assert.equal(res.json<{ id: string }>().id, 'inbound-trace-id')
    assert.equal(res.header('x-request-id'), undefined)
  })

  test('the boot error is reported through ready(), not only at the call site', async () => {
    // `requestId()` throws eagerly, so this documents which of the two happens:
    // a factory that cannot produce a plugin fails where it is written.
    const a = makeApp()
    assert.throws(() => a.use(requestId({ header: false })))
  })
})
