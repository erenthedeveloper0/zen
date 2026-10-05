import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  compileContext, CodeGen, DEFAULT_CAPABILITIES, PlainContext, ZenContainer, SmallHeaderBag,
  parseQuery, parseCookies, serializeCookie, slot, prepareForWire, jsonReply, emptyReply,
  type RawRequest, type ContextEnv,
} from '@erenthedeveloper0/zen-core'
import { makeApp, silentLogger, uniqueName } from './helpers.ts'

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

function makeEnv(trustProxy: boolean | number = false): ContextEnv {
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
    // The absolute form (RFC 9112 §3.2.2) and a cookie that is base64: both
    // twins must read the path out of the one and keep the `+` in the other.
    ['http://api.example.com/orders/7?expand=lines', { host: 'api.example.com' }],
    ['/x', { host: 'api.example.com', cookie: 'session=ab+cd/ef==; plain=a+b' }],
  ]

  test('every accessor agrees on every probe', () => {
    for (const [url, headers] of PROBES) {
      for (const trustProxy of [false, true, 0, 1, 2, 5]) {
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
          protocol: ctx.protocol,
          ip: ctx.ip,
          ips: ctx.ips,
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

  test('a disposable slot queues every value it held, once each, in both (§7.4)', () => {
    // The queue used to hold the *slot*, and settle read its current value — so
    // a slot set twice disposed its second value twice and leaked its first.
    const noop = (): void => {}
    const Tx = slot<string>(uniqueName('ctx.tx'), { dispose: noop })
    for (const Klass of [Compiled, Interpreted]) {
      const ctx = new Klass(rawRequest('/'), null, {}, makeEnv(), new AbortController().signal)
      ctx.set(Tx, 'first')
      ctx.set(Tx, 'second')
      ctx.set(Tx, 'second')
      ctx.set(Tx, undefined as never)
      assert.deepEqual(
        (ctx.$disposers ?? []).map((entry) => entry.value),
        ['first', 'second'],
        `${Klass === Compiled ? 'compiled' : 'interpreted'}: each value once; undefined is nothing to release`,
      )
    }
  })

  test('an invalid Host header makes ctx.url a 400, not a TypeError (RFC 9112 §3.2)', () => {
    for (const Klass of [Compiled, Interpreted]) {
      const ctx = new Klass(rawRequest('/x', { host: 'exa mple' }), null, {}, makeEnv(), new AbortController().signal)
      assert.throws(() => ctx.url, (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400)
        // Not ZEN_BODY_INVALID: the body was never read.
        assert.equal((error as { code?: string }).code, 'ZEN_BAD_REQUEST')
        return true
      })
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
      assert.throws(() => bag.set('x-test', bad), { code: 'ZEN_HEADER_INVALID' })
      assert.throws(() => bag.append('x-test', bad), { code: 'ZEN_HEADER_INVALID' })
    }
  })

  /** RFC 9110 §5.5 — and exactly what Node refuses when the adapter writes it,
   *  so nothing the bag accepts can fail later, outside the error path. */
  test('refuses every character a header cannot carry, and a name that is not a token', () => {
    const bag = new SmallHeaderBag()
    // Short values and long ones take different paths through the check; both must refuse.
    const long = 'x'.repeat(60)
    for (const bad of ['a\x01b', 'a\x1fb', 'a\x7fb', '日本', 'a b', `${long}\x01`, `${long}日本`]) {
      assert.throws(() => bag.set('x-test', bad), /a character a header cannot carry/, JSON.stringify(bad))
    }
    bag.set('x-long', `${long} é\t`)
    for (const name of ['x test', 'x:test', '', 'x\ntest', 'café']) {
      assert.throws(() => bag.set(name, 'v'), /is not a token/, JSON.stringify(name))
    }
    // A tab, a space, visible ASCII and obs-text are all a value may hold.
    bag.set('x-ok', 'a\tb c~é')
    assert.equal(bag.get('x-ok'), 'a\tb c~é')
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

  test('a `+` is a plus — only form encoding spells a space that way', () => {
    // Base64 session ids are full of `+`. Decoding it as a space turned a valid
    // session into one no server would recognise.
    assert.deepEqual(
      { ...parseCookies('session=ab+cd/ef==; mixed=a+b%20c') },
      { session: 'ab+cd/ef==', mixed: 'a+b c' },
    )
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

describe('trustProxy as a hop count (§19.4)', () => {
  // The client sent "spoofed"; the one load balancer in front (10.0.0.1, the
  // socket peer) appended the address it actually saw.
  const headers = { 'x-forwarded-for': 'spoofed, 203.0.113.7', 'x-forwarded-proto': 'https, http' }
  const ipWith = (trustProxy: boolean | number): string =>
    new PlainContext(rawRequest('/', headers), null, {}, makeEnv(trustProxy), 0, new AbortController().signal).ip

  test('off by default: the socket address, whatever the headers say', () => {
    assert.equal(ipWith(false), '10.0.0.1')
    assert.equal(ipWith(0), '10.0.0.1')
  })

  test('one trusted hop reads the address the load balancer saw, which the client cannot choose', () => {
    assert.equal(ipWith(1), '203.0.113.7')
  })

  test('`true` reads the leftmost entry — the one the client wrote', () => {
    assert.equal(ipWith(true), 'spoofed')
  })

  test('more hops than entries falls back to the leftmost', () => {
    assert.equal(ipWith(2), 'spoofed')
    assert.equal(ipWith(9), 'spoofed')
  })

  test('X-Forwarded-Proto is read from its first entry, and only when trusted', () => {
    const secure = (trustProxy: boolean | number) =>
      new PlainContext(rawRequest('/', headers), null, {}, makeEnv(trustProxy), 0, new AbortController().signal).secure
    assert.equal(secure(false), false)
    assert.equal(secure(1), true)
    assert.equal(secure(true), true)
  })
})

describe('ctx.ips and ctx.protocol (§7.2, §19.4)', () => {
  const headers = { 'x-forwarded-for': 'spoofed, 203.0.113.7', 'x-forwarded-proto': 'https' }
  const contextWith = (trustProxy: boolean | number, h: Record<string, string> = headers) =>
    new PlainContext(rawRequest('/', h), null, {}, makeEnv(trustProxy), 0, new AbortController().signal)

  test('with no trust, nothing a client wrote is believed: the peer alone, over http', () => {
    const ctx = contextWith(false)
    assert.deepEqual(ctx.ips, ['10.0.0.1'])
    assert.equal(ctx.protocol, 'http')
  })

  test('one trusted hop: the address the load balancer saw, then the balancer itself', () => {
    assert.deepEqual(contextWith(1).ips, ['203.0.113.7', '10.0.0.1'])
  })

  test('`true` believes the whole chain, client first', () => {
    assert.deepEqual(contextWith(true).ips, ['spoofed', '203.0.113.7', '10.0.0.1'])
  })

  test('ips[0] is ctx.ip under every trust setting', () => {
    for (const trust of [false, 0, 1, 2, 9, true]) {
      const ctx = contextWith(trust)
      assert.equal(ctx.ips[0], ctx.ip, `trustProxy=${String(trust)}`)
    }
  })

  test('protocol follows secure exactly', () => {
    for (const trust of [false, 1, true]) {
      const ctx = contextWith(trust)
      assert.equal(ctx.protocol, ctx.secure ? 'https' : 'http')
    }
    assert.equal(contextWith(1).protocol, 'https')
  })

  test('getters only — neither twin gains a field (I2)', () => {
    const Ctx = compileContext({ decorations: [], slotCount: SLOT_COUNT, codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }) })
    for (const ctx of [contextWith(1), new Ctx(rawRequest('/', headers), null, {}, makeEnv(1), new AbortController().signal)]) {
      assert.equal(Object.hasOwn(ctx, 'ips'), false)
      assert.equal(Object.hasOwn(ctx, 'protocol'), false)
    }
  })
})

describe('the reply builder throws once the reply is sent (§7.3)', () => {
  test('a ctx.res kept from the handler refuses every write after egress', async () => {
    const app = makeApp()
    let kept: { res: { header(n: string, v: string): unknown; status(c: number): unknown; cookie(n: string, v: string): unknown } } | null = null
    let res: { header(n: string, v: string): unknown } | null = null
    app.get('/', (ctx) => {
      kept = ctx as never
      res = ctx.res
      ctx.res.header('x-before', '1')
      return 'ok'
    })
    const reply = await app.inject('GET', '/')
    assert.equal(reply.headers['x-before'], '1')

    // Both shapes: the builder obtained before egress, and ctx.res re-read after.
    for (const write of [
      () => res!.header('x-late', '1'),
      () => kept!.res.header('x-late', '1'),
      () => kept!.res.status(500),
      () => kept!.res.cookie('late', '1'),
    ]) {
      assert.throws(write, (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'ZEN_REPLY_SENT')
        assert.match((error as Error).message, /after the reply was sent/)
        return true
      })
    }
  })

  test('a handler that never touched ctx.res is sealed too', async () => {
    const app = makeApp()
    let kept: { res: { header(n: string, v: string): unknown } } | null = null
    app.get('/', (ctx) => { kept = ctx as never; return 'ok' })
    await app.inject('GET', '/')
    assert.throws(() => kept!.res.header('x-late', '1'), { code: 'ZEN_REPLY_SENT' })
  })

  test('onSend still stages — the seal falls after the staged metadata is applied', async () => {
    const app = makeApp()
    app.hook('onSend', (ctx) => { ctx.res.header('x-on-send', '1') })
    app.get('/', () => 'ok')
    assert.equal((await app.inject('GET', '/')).headers['x-on-send'], '1')
  })

  test('an onResponse hook that writes is told so, and the response is unaffected', async () => {
    const errors: unknown[] = []
    const app = makeApp()
    app.hook('onResponse', (ctx) => {
      try { ctx.res.header('x-too-late', '1') } catch (error) { errors.push((error as { code?: string }).code) }
    })
    app.get('/', () => 'ok')
    const res = await app.inject('GET', '/')
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-too-late'], undefined)
    assert.deepEqual(errors, ['ZEN_REPLY_SENT'])
  })
})

describe('inject() can say where the request came from (§19.4)', () => {
  test('127.0.0.1 unless told otherwise', async () => {
    const app = makeApp()
    app.get('/', (ctx) => ({ ip: ctx.ip, ips: ctx.ips }))
    assert.deepEqual((await app.inject('GET', '/')).json(), { ip: '127.0.0.1', ips: ['127.0.0.1'] })
  })

  test('the given peer is ctx.ip, and the last hop when a proxy is trusted', async () => {
    const direct = makeApp()
    direct.get('/', (ctx) => ({ ip: ctx.ip }))
    const remote = { address: '198.51.100.4', port: 5555, family: 'IPv4' } as const
    assert.deepEqual((await direct.inject('GET', '/', { remote })).json(), { ip: '198.51.100.4' })

    const proxied = makeApp({ trustProxy: 1 })
    proxied.get('/', (ctx) => ({ ip: ctx.ip, ips: ctx.ips }))
    const res = await proxied.inject('GET', '/', { remote, headers: { 'x-forwarded-for': '203.0.113.9' } })
    assert.deepEqual(res.json(), { ip: '203.0.113.9', ips: ['203.0.113.9', '198.51.100.4'] })
  })
})

describe('a slot value that releases itself is released (§15.3)', () => {
  const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose
  const dispose = (Symbol as { dispose?: symbol }).dispose

  test('Symbol.asyncDispose is preferred, as `await using` prefers it, and called once', async (t) => {
    if (asyncDispose === undefined || dispose === undefined) return t.skip('no explicit resource management in this runtime')
    const calls: string[] = []
    const Conn = slot<object>(uniqueName('ctx.conn'))
    const app = makeApp()
    app.get('/', (ctx) => {
      ctx.set(Conn, {
        [asyncDispose]: async () => { calls.push('async') },
        [dispose]: () => { calls.push('sync') },
      })
      return 'ok'
    })
    await app.inject('GET', '/')
    assert.deepEqual(calls, ['async'])
  })

  test('Symbol.dispose alone works, and every value a slot held is released, in reverse order', async (t) => {
    if (dispose === undefined) return t.skip('no Symbol.dispose in this runtime')
    const calls: string[] = []
    const Tx = slot<object>(uniqueName('ctx.tx'))
    const app = makeApp()
    const value = (name: string) => ({ [dispose]: () => { calls.push(name) } })
    app.get('/', (ctx) => {
      ctx.set(Tx, value('first'))
      ctx.set(Tx, value('second'))
      return 'ok'
    })
    await app.inject('GET', '/')
    assert.deepEqual(calls, ['second', 'first'])
  })

  test('an explicit dispose wins, and primitives and plain objects are left alone', async (t) => {
    if (dispose === undefined) return t.skip('no Symbol.dispose in this runtime')
    const calls: string[] = []
    const Explicit = slot<object>(uniqueName('ctx.explicit'), { dispose: () => { calls.push('explicit') } })
    const Plain = slot<object>(uniqueName('ctx.plain'))
    const Count = slot<number>(uniqueName('ctx.count'))
    const app = makeApp()
    app.get('/', (ctx) => {
      ctx.set(Explicit, { [dispose]: () => { calls.push('protocol') } })
      ctx.set(Plain, { just: 'data' })
      ctx.set(Count, 1)
      return 'ok'
    })
    await app.inject('GET', '/')
    assert.deepEqual(calls, ['explicit'])
  })
})
