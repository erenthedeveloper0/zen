import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  compileContext, CodeGen, DEFAULT_CAPABILITIES, PlainContext, ZenContainer, SmallHeaderBag,
  parseQuery, parseCookies, serializeCookie, slot, prepareForWire, jsonReply, emptyReply,
  type RawRequest, type ContextEnv,
} from '@zenjs/core'
import { silentLogger, uniqueName } from './helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))

function rawRequest(url: string, headers: Record<string, string> = {}): RawRequest {
  return {
    method: 'GET',
    url,
    header: (name) => headers[name as string],
    headerNames: () => Object.keys(headers),
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '10.0.0.1', port: 1234, family: 'IPv4' },
    native: null,
  }
}

function makeEnv(trustProxy = false): ContextEnv {
  return { log: silentLogger(), maxQueryParams: 100, trustProxy, container: new ZenContainer() }
}

const SLOT_COUNT = 64

/**
 * Differential testing — §20.5, I6.
 *
 * `PlainContext` is the semantic definition; the generated class must match it
 * on every accessor. It is used verbatim when `caps.eval === false` (workerd,
 * CSP-locked runtimes), so a divergence here is a portability bug, not just a
 * performance one.
 */
describe('differential: compiled context ≡ PlainContext', () => {
  const Marker = slot<string>(uniqueName('ctx.marker'))

  const Compiled = compileContext({
    decorations: [{ name: 'marker', slotIndex: Marker.index, accessor: null, source: 'test' }],
    slotCount: SLOT_COUNT,
    codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }),
  })

  const Interpreted = compileContext({
    decorations: [{ name: 'marker', slotIndex: Marker.index, accessor: null, source: 'test' }],
    slotCount: SLOT_COUNT,
    codegen: new CodeGen({ caps: { ...DEFAULT_CAPABILITIES, eval: false } }),
  })

  const PROBES: Array<[string, Record<string, string>]> = [
    ['/', {}],
    ['/users/42', {}],
    ['/search?q=hello&page=2', {}],
    ['/search?a=1&a=2&empty=&novalue', {}],
    ['/caf%C3%A9?city=S%C3%A3o%20Paulo', {}],
    ['/x', { host: 'api.example.com', cookie: 'sid=abc; theme=dark' }],
    ['/x', { host: 'api.example.com', 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'x-forwarded-proto': 'https' }],
  ]

  test('every accessor agrees on every probe', () => {
    for (const [url, headers] of PROBES) {
      for (const trustProxy of [false, true]) {
        const env = makeEnv(trustProxy)
        const signal = new AbortController().signal
        const a = new Compiled(rawRequest(url, headers), null, { id: '1' }, env, signal)
        const b = new Interpreted(rawRequest(url, headers), null, { id: '1' }, env, signal)

        const observe = (ctx: PlainContext) => ({
          path: ctx.path,
          query: { ...ctx.query as object },
          headers: { ...ctx.headers as object },
          cookies: { ...ctx.cookies as object },
          host: ctx.host,
          secure: ctx.secure,
          ip: ctx.ip,
          params: ctx.params,
          url: ctx.url.href,
        })

        assert.deepEqual(observe(a), observe(b), `divergence for ${url} (trustProxy=${trustProxy})`)
      }
    }
  })

  test('slots and decorations behave identically', () => {
    for (const Klass of [Compiled, Interpreted]) {
      const ctx = new Klass(rawRequest('/'), null, {}, makeEnv(), new AbortController().signal)
      assert.equal(ctx.find(Marker), undefined)
      ctx.set(Marker, 'set')
      assert.equal(ctx.get(Marker), 'set')
      assert.equal((ctx as unknown as { marker: string }).marker, 'set')
      assert.equal(ctx.has(Marker), true)
    }
  })

  test('reading an unset slot throws the same named error in both', () => {
    const Empty = slot<string>(uniqueName('ctx.empty'))
    for (const Klass of [Compiled, Interpreted]) {
      const ctx = new Klass(rawRequest('/'), null, {}, makeEnv(), new AbortController().signal)
      assert.throws(() => ctx.get(Empty), /ZEN_SLOT_EMPTY|was read before it was set/)
    }
  })
})

describe('laziness (§4.2 stage 4)', () => {
  test('query is not parsed until it is read', () => {
    let headerReads = 0
    const raw: RawRequest = {
      ...rawRequest('/x?a=1'),
      header: (n) => { headerReads++; return n === 'cookie' ? 'k=v' : undefined },
    }

    const Ctx = compileContext({
      decorations: [],
      slotCount: SLOT_COUNT,
      codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }),
    })
    const ctx = new Ctx(raw, null, {}, makeEnv(), new AbortController().signal)

    // A route that touches nothing pays for nothing.
    assert.equal(headerReads, 0)
    void ctx.cookies
    assert.equal(headerReads, 1)
    void ctx.cookies
    assert.equal(headerReads, 1, 'second read must hit the memoised value')
  })
})

describe('monomorphism (I2, §20.7)', () => {
  /**
   * The mechanical defence of "no framework object is mutated by user code".
   * Requires --allow-natives-syntax, so it runs in a child process.
   */
  test('all contexts of an app share one hidden class', () => {
    const output = execFileSync(
      process.execPath,
      ['--allow-natives-syntax', join(here, 'fixtures', 'monomorphism.ts')],
      { encoding: 'utf8', stdio: 'pipe' },
    )
    assert.doesNotMatch(output, /FAIL/, output)
    assert.match(output, /ok fresh contexts share a map/)
    assert.match(output, /ok an exercised context still shares the map/)
  })
})

describe('header bag', () => {
  test('is case-insensitive and insertion-ordered', () => {
    const bag = new SmallHeaderBag()
    bag.set('Content-Type', 'text/plain')
    bag.set('X-Custom', 'a')
    assert.equal(bag.get('content-type'), 'text/plain')
    assert.deepEqual(bag.entries(), [['content-type', 'text/plain'], ['x-custom', 'a']])
  })

  test('append produces multiple entries, set replaces', () => {
    const bag = new SmallHeaderBag()
    bag.append('set-cookie', 'a=1')
    bag.append('set-cookie', 'b=2')
    assert.deepEqual(bag.getAll('set-cookie'), ['a=1', 'b=2'])
    assert.equal(bag.entries().length, 2)

    bag.set('set-cookie', 'c=3')
    assert.deepEqual(bag.getAll('set-cookie'), ['c=3'])
  })

  /** §19.5 — never silently sanitised; quietly dropping an injected newline
   *  hides the bug that produced it. */
  test('rejects CR/LF/NUL in values rather than stripping them', () => {
    const bag = new SmallHeaderBag()
    for (const bad of ['a\r\nX-Evil: 1', 'a\nb', 'a\0b']) {
      assert.throws(() => bag.set('x-test', bad), /illegal character/)
    }
  })

  test('delete removes the header', () => {
    const bag = new SmallHeaderBag()
    bag.set('a', '1')
    bag.delete('a')
    assert.equal(bag.has('a'), false)
    assert.equal(bag.size, 0)
  })
})

describe('query parsing (§11.4, §19.5)', () => {
  test('handles repeats, empties, and missing values', () => {
    assert.deepEqual({ ...parseQuery('/x?a=1&a=2') }, { a: ['1', '2'] })
    assert.deepEqual({ ...parseQuery('/x?empty=') }, { empty: '' })
    assert.deepEqual({ ...parseQuery('/x?flag') }, { flag: '' })
    assert.deepEqual({ ...parseQuery('/x') }, {})
    assert.deepEqual({ ...parseQuery('/x?') }, {})
  })

  test('decodes percent-encoding and plus signs', () => {
    assert.deepEqual({ ...parseQuery('/x?city=S%C3%A3o+Paulo') }, { city: 'São Paulo' })
  })

  test('drops malformed encodings instead of throwing', () => {
    assert.deepEqual({ ...parseQuery('/x?bad=%E0%A4%A&ok=1') }, { ok: '1' })
  })

  test('strips dangerous keys and leaves bracket forms inert', () => {
    const parsed = parseQuery('/x?__proto__=a&constructor=2&prototype=3&__proto__[x]=1&safe=4')

    // Exact dangerous keys are dropped outright.
    assert.equal(Object.hasOwn(parsed, '__proto__'), false)
    assert.equal(Object.hasOwn(parsed, 'constructor'), false)
    assert.equal(Object.hasOwn(parsed, 'prototype'), false)

    // `__proto__[x]` survives as a *literal key* and that is correct: with
    // `nested: false` (§11.4) brackets are never interpreted, so it can only
    // ever be an ordinary string key. Stripping every key that merely contains
    // "__proto__" would break legitimate ones for no security gain.
    assert.equal(parsed['__proto__[x]'], '1')
    assert.equal(parsed['safe'], '4')

    // The real defence: the result has a null prototype, so nothing on it can
    // reach Object.prototype at all.
    assert.equal(Object.getPrototypeOf(parsed), null)
    assert.equal(({} as Record<string, unknown>)['x'], undefined)
    assert.equal(({} as Record<string, unknown>)['a'], undefined)
  })

  test('caps parameter count (hash-flood defence)', () => {
    const many = '/x?' + Array.from({ length: 500 }, (_, i) => `k${i}=1`).join('&')
    assert.equal(Object.keys(parseQuery(many, 100)).length, 100)
  })
})

describe('cookies', () => {
  test('parses and ignores malformed pairs', () => {
    assert.deepEqual({ ...parseCookies('sid=abc; theme=dark; broken') }, { sid: 'abc', theme: 'dark' })
    assert.deepEqual({ ...parseCookies(undefined) }, {})
  })

  test('unquotes and decodes values', () => {
    assert.deepEqual({ ...parseCookies('a="quoted"; b=S%C3%A3o') }, { a: 'quoted', b: 'São' })
  })

  test('first value wins for duplicates', () => {
    assert.deepEqual({ ...parseCookies('a=1; a=2') }, { a: '1' })
  })

  test('serialises with secure defaults (§19.2)', () => {
    const serialised = serializeCookie({ name: 'sid', value: 'abc' })
    assert.match(serialised, /^sid=abc/)
    assert.match(serialised, /Path=\//)
    assert.match(serialised, /HttpOnly/)
    assert.match(serialised, /SameSite=Lax/)
    assert.doesNotMatch(serialised, /Secure/)

    const strict = serializeCookie({ name: 'sid', value: 'abc', secure: true, sameSite: 'strict', maxAge: 60 })
    assert.match(strict, /Secure/)
    assert.match(strict, /SameSite=Strict/)
    assert.match(strict, /Max-Age=60/)
  })
})

describe('egress (§13.6)', () => {
  const contextFor = (method: string) => {
    const Ctx = compileContext({ decorations: [], slotCount: SLOT_COUNT, codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }) })
    const raw = { ...rawRequest('/x'), method }
    return new Ctx(raw, null, {}, makeEnv(), new AbortController().signal)
  }

  const JSON_BODY = { a: 1 }
  const JSON_BYTES = String(Buffer.byteLength(JSON.stringify(JSON_BODY)))

  test('sets content-type and content-length for JSON', () => {
    const reply = prepareForWire(contextFor('GET'), jsonReply(JSON_BODY))
    assert.match(reply.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(reply.headers.get('content-length'), JSON_BYTES)
    assert.equal(reply.body.kind, 'bytes')
  })

  test('applies staged status, headers and cookies', () => {
    const ctx = contextFor('GET')
    ctx.res.status(201).header('x-a', '1').appendHeader('vary', 'accept').cookie('sid', 'v')
    const reply = prepareForWire(ctx, jsonReply({ ok: true }))

    assert.equal(reply.status, 201)
    assert.equal(reply.headers.get('x-a'), '1')
    assert.equal(reply.headers.get('vary'), 'accept')
    assert.match(reply.headers.get('set-cookie') ?? '', /^sid=v/)
  })

  test('a later cookie write overrides an earlier one by name', () => {
    const ctx = contextFor('GET')
    ctx.res.cookie('sid', 'first').cookie('sid', 'second')
    const reply = prepareForWire(ctx, jsonReply({}))
    assert.deepEqual(reply.headers.getAll('set-cookie').length, 1)
    assert.match(reply.headers.get('set-cookie') ?? '', /^sid=second/)
  })

  test('HEAD keeps headers but drops the body (RFC 9110 §9.3.2)', () => {
    const reply = prepareForWire(contextFor('HEAD'), jsonReply(JSON_BODY))
    assert.equal(reply.body.kind, 'empty')
    assert.equal(
      reply.headers.get('content-length'),
      JSON_BYTES,
      'content-length must still describe the body a GET would have returned',
    )
  })

  test('204 carries no body or content headers', () => {
    const reply = prepareForWire(contextFor('GET'), emptyReply(204))
    assert.equal(reply.body.kind, 'empty')
    assert.equal(reply.headers.has('content-type'), false)
  })
})
