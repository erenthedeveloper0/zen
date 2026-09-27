import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, slot, markSync, NotFound, ZenApp, ALL_METHODS } from '@visionpilot/zen-core'
import { ZenRouter, parsePath } from '@visionpilot/zen-router'

const pathParser = {
  parse(path: string) {
    const parsed = parsePath(path)
    return { path: parsed.path, segments: parsed.segments }
  },
}

function makeApp(): ZenApp {
  return createApp({ router: new ZenRouter(), pathParser, logger: silent() })
}

function silent() {
  const noop = () => {}
  return {
    level: 'fatal' as const,
    child() { return this },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
}

describe('routing', () => {
  test('returns a string body as text/plain', async () => {
    const app = makeApp()
    app.get('/', () => 'hello')

    const res = await app.inject('GET', '/')
    assert.equal(res.status, 200)
    assert.equal(res.text(), 'hello')
    assert.match(res.header('content-type') ?? '', /text\/plain/)
    assert.equal(res.header('content-length'), '5')
  })

  test('serialises objects as JSON', async () => {
    const app = makeApp()
    app.get('/j', () => ({ a: 1 }))

    const res = await app.inject('GET', '/j')
    assert.deepEqual(res.json(), { a: 1 })
    assert.match(res.header('content-type') ?? '', /application\/json/)
  })

  test('typed params are parsed, not just captured', async () => {
    const app = makeApp()
    app.get('/users/:id<int>', (ctx) => ({ id: ctx.params.id, type: typeof ctx.params.id }))

    const res = await app.inject('GET', '/users/42')
    assert.deepEqual(res.json(), { id: 42, type: 'number' })
  })

  test('a typed param that does not match 404s instead of reaching the handler', async () => {
    const app = makeApp()
    let reached = false
    app.get('/users/:id<int>', () => { reached = true; return 'x' })

    const res = await app.inject('GET', '/users/abc')
    assert.equal(res.status, 404)
    assert.equal(reached, false)
  })

  test('405 carries a correct Allow header (Express returns 404 here)', async () => {
    const app = makeApp()
    app.get('/only-get', () => 'x')
    app.put('/only-get', () => 'x')

    const res = await app.inject('DELETE', '/only-get')
    assert.equal(res.status, 405)
    const allow = (res.header('allow') ?? '').split(', ').sort()
    // HEAD is served wherever GET is (§4.2), and Allow lists what the resource
    // supports (RFC 9110 §10.2.1) — so it is named even though no route declares it.
    assert.deepEqual(allow, ['GET', 'HEAD', 'PUT'])
  })

  test('backtracks: static and dynamic siblings both remain reachable', async () => {
    const app = makeApp()
    app.get('/a/b', () => 'static')
    app.get('/:x/c', () => 'dynamic')

    assert.equal((await app.inject('GET', '/a/b')).text(), 'static')
    assert.equal((await app.inject('GET', '/a/c')).text(), 'dynamic')
  })

  test('registration order never affects matching (§5.6)', async () => {
    const first = makeApp()
    first.get('/users/:id', () => 'dynamic')
    first.get('/users/new', () => 'static')

    const second = makeApp()
    second.get('/users/new', () => 'static')
    second.get('/users/:id', () => 'dynamic')

    assert.equal((await first.inject('GET', '/users/new')).text(), 'static')
    assert.equal((await second.inject('GET', '/users/new')).text(), 'static')
  })

  test('wildcards capture the remainder', async () => {
    const app = makeApp()
    app.get('/files/*path', (ctx) => ctx.params.path)

    assert.equal((await app.inject('GET', '/files/a/b/c.txt')).text(), 'a/b/c.txt')
  })

  test('collections compose prefixes without runtime cost', async () => {
    const app = makeApp()
    app.collection('/api', (api) => {
      api.get('/health', () => 'ok')
    })

    assert.equal((await app.inject('GET', '/api/health')).status, 200)
    assert.equal((await app.inject('GET', '/health')).status, 404)
  })

  test('an absolute-form request target is routed by its path (RFC 9112 §3.2.2)', async () => {
    // A client behind a forward proxy sends `GET http://host/path`, and Node
    // passes it through verbatim. It used to be matched as a path and 404.
    const app = makeApp()
    app.get('/orders/:id<int>', (ctx) => ({ id: ctx.params.id, page: (ctx.query as { page?: string }).page ?? null }))

    const res = await app.inject('GET', 'http://api.example.com/orders/7?page=2')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { id: 7, page: '2' })
    assert.equal((await app.inject('GET', 'https://api.example.com')).status, 404, 'the root, and it has no route')
  })

  test('a `+` in a path is a plus, with or without percent-escapes beside it', async () => {
    const app = makeApp()
    app.get('/files/:name', (ctx) => ctx.params.name)
    app.get('/tail/*rest', (ctx) => ctx.params.rest)

    assert.equal((await app.inject('GET', '/files/a+b')).text(), 'a+b')
    assert.equal((await app.inject('GET', '/files/a+b%20c')).text(), 'a+b c', 'only form encoding spells a space as +')
    assert.equal((await app.inject('GET', '/tail/x+y/%41+b')).text(), 'x+y/A+b')
  })

  test('HEAD is served by a wildcard GET route, and a 405 names HEAD wherever GET exists', async () => {
    const app = makeApp()
    app.get('/files/*path', (ctx) => ctx.params.path)

    const head = await app.inject('HEAD', '/files/a/b.txt')
    assert.equal(head.status, 200, 'it used to be a 405 — the wildcard branch had no HEAD fallback')
    assert.equal(head.text(), '', 'and carries no body')
    const refused = await app.inject('DELETE', '/files/a/b.txt')
    assert.equal(refused.status, 405)
    assert.equal(refused.header('allow'), 'GET, HEAD')
  })

  test('all() registers one ordinary route per method, and a name per route', async () => {
    const app = makeApp()
    app.all('/proxy', { name: 'proxy' }, (ctx) => ctx.method)
    app.all('/echo', (ctx) => ctx.method)

    for (const method of ALL_METHODS) {
      assert.equal((await app.inject(method, '/proxy')).text(), method)
      assert.equal((await app.inject(method, '/echo')).text(), method)
    }
    assert.equal((await app.inject('HEAD', '/proxy')).status, 200, 'HEAD through the GET route')
    assert.equal((await app.inject('TRACE', '/proxy')).status, 405, 'TRACE is never registered for you')
    const names = app.graph().routes.filter((r) => r.path === '/proxy').map((r) => r.name).sort()
    assert.deepEqual(names, ['proxy.delete', 'proxy.get', 'proxy.options', 'proxy.patch', 'proxy.post', 'proxy.put'])
  })
})

describe('middleware', () => {
  test('phase middleware short-circuits by returning a reply', async () => {
    const app = makeApp()
    let handlerRan = false
    app.use((ctx) => ctx.json({ blocked: true }, { status: 401 }))
    app.get('/', () => { handlerRan = true; return 'x' })

    const res = await app.inject('GET', '/')
    assert.equal(res.status, 401)
    assert.equal(handlerRan, false)
  })

  test('phase middleware returning undefined continues', async () => {
    const app = makeApp()
    const order: string[] = []
    app.use(() => { order.push('a') })
    app.use(() => { order.push('b') })
    app.get('/', () => { order.push('handler'); return 'ok' })

    await app.inject('GET', '/')
    assert.deepEqual(order, ['a', 'b', 'handler'])
  })

  test('around middleware can inspect and replace the downstream reply', async () => {
    const app = makeApp()
    app.around(async (ctx, next) => {
      const reply = await next()
      return reply.status === 200 ? ctx.json({ wrapped: true }) : reply
    })
    app.get('/', () => ({ original: true }))

    assert.deepEqual((await app.inject('GET', '/')).json(), { wrapped: true })
  })

  test('collection middleware applies only inside the collection', async () => {
    const app = makeApp()
    app.collection('/guarded', (c) => {
      c.use((ctx) => ctx.json({ denied: true }, { status: 403 }))
      c.get('/x', () => 'never')
    })
    app.get('/open', () => 'open')

    assert.equal((await app.inject('GET', '/guarded/x')).status, 403)
    assert.equal((await app.inject('GET', '/open')).status, 200)
  })

  test('next() is a Promise even when everything downstream compiled synchronous (§8.2, §8.4)', async () => {
    // `Next` is typed `() => Promise<Reply>`. On a route whose remaining steps
    // and handler are all sync, the generated segment returned a bare Reply,
    // and `next().then(…)` failed with "then is not a function" — only on the
    // routes the compiler had optimised.
    const app = makeApp()
    app.around((ctx, next) => next().then((reply) => (reply.status === 200 ? ctx.json({ wrapped: true }) : reply)))
    app.get('/sync', markSync(() => ({ original: true })))
    app.get('/throws', markSync(() => { throw new NotFound('gone') }))

    const res = await app.inject('GET', '/sync')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { wrapped: true })
    // A synchronous throw downstream arrives as a rejection, not as a throw
    // from `next()` itself — `next().catch(…)` has to be able to see it.
    assert.equal((await app.inject('GET', '/throws')).status, 404)
  })

  test('a collection has the whole registration surface — head, options, all, around, after', async () => {
    const app = makeApp()
    const order: string[] = []
    app.collection('/c', (c) => {
      c.around(async (_ctx, next) => { order.push('around'); return next() })
      c.after((_ctx, reply) => { order.push('after'); return reply })
      c.head('/probe', (ctx) => ctx.empty())
      c.options('/probe', (ctx) => ctx.empty())
      c.all('/any', (ctx) => ctx.method)
    })

    assert.equal((await app.inject('HEAD', '/c/probe')).status, 204)
    assert.equal((await app.inject('OPTIONS', '/c/probe')).status, 204)
    assert.equal((await app.inject('PATCH', '/c/any')).text(), 'PATCH')
    assert.deepEqual(order, ['around', 'after', 'around', 'after', 'around', 'after'])
  })

  test('a collection handle refuses middleware after boot instead of dropping it', async () => {
    const app = makeApp()
    let kept: { use(fn: () => void): unknown } | null = null
    app.collection('/late', (c) => { kept = c; c.get('/x', () => 'x') })
    await app.ready()
    assert.throws(() => (kept as unknown as { use(fn: () => void): unknown }).use(() => {}), { code: 'ZEN_APP_FROZEN' })
  })
})

describe('slots', () => {
  test('round-trips a typed value', async () => {
    const Token = slot<string>('test.token.a')
    const app = makeApp()
    app.use((ctx) => { ctx.set(Token, 'abc') })
    app.get('/', (ctx) => ctx.get(Token))

    assert.equal((await app.inject('GET', '/')).text(), 'abc')
  })

  test('reading before writing names the slot and the route', async () => {
    const Missing = slot<string>('test.token.b')
    const app = makeApp()
    app.get('/x', (ctx) => ctx.get(Missing))

    const res = await app.inject('GET', '/x')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_SLOT_EMPTY')
  })

  test('does not leak between requests', async () => {
    const Counter = slot<number>('test.token.c')
    const app = makeApp()
    app.get('/set/:n<int>', (ctx) => {
      ctx.set(Counter, ctx.params.n)
      return { n: ctx.get(Counter) }
    })
    app.get('/read', (ctx) => ({ n: ctx.find(Counter) ?? null }))

    await app.inject('GET', '/set/7')
    assert.deepEqual((await app.inject('GET', '/read')).json(), { n: null })
  })

  test('a disposable slot set by a handler still running behind its deadline is released at once', async () => {
    // The deadline answered; the abandoned handler carries on and acquires
    // something. Stage 10 has already run, so it is released on arrival rather
    // than queued on a list nothing will read again (§4.2 stage 10).
    const released: string[] = []
    const Tx = slot<string>('test.token.tx-late', { dispose: (tx) => { released.push(tx) } })
    const app = createApp({ router: new ZenRouter(), pathParser, logger: silent(), timeout: '20ms' })
    app.get('/', async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      ctx.set(Tx, 'acquired-late')
      return 'too late'
    })

    assert.equal((await app.inject('GET', '/')).status, 504)
    assert.deepEqual(released, [])
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(released, ['acquired-late'])
  })

  test('a disposable slot set twice releases both values, newest first, once each (§7.4)', async () => {
    const released: string[] = []
    const Tx = slot<string>('test.token.tx-twice', { dispose: (tx) => { released.push(tx) } })
    const app = makeApp()
    app.get('/', (ctx) => {
      ctx.set(Tx, 'outer')
      ctx.set(Tx, 'inner')
      ctx.set(Tx, 'inner')
      return 'ok'
    })

    await app.inject('GET', '/')
    assert.deepEqual(released, ['inner', 'outer'])
  })
})

describe('errors', () => {
  test('unknown throwables never expose their message', async () => {
    const app = makeApp()
    app.get('/boom', () => { throw new Error('SECRET internal detail') })

    const res = await app.inject('GET', '/boom')
    assert.equal(res.status, 500)
    assert.doesNotMatch(res.text(), /SECRET/)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_INTERNAL')
  })

  test('HttpErrors expose their message and status', async () => {
    const app = makeApp()
    app.get('/missing', () => { throw new NotFound('no such widget') })

    const res = await app.inject('GET', '/missing')
    assert.equal(res.status, 404)
    assert.equal(res.json<{ title: string }>().title, 'no such widget')
  })

  test('every error response carries a requestId and problem+json', async () => {
    const app = makeApp()
    app.get('/boom', () => { throw new Error('x') })

    const res = await app.inject('GET', '/boom')
    assert.match(res.header('content-type') ?? '', /application\/problem\+json/)
    assert.equal(typeof res.json<{ requestId: string }>().requestId, 'string')
  })

  test('a handler that returns undefined fails loudly rather than hanging', async () => {
    const app = makeApp()
    app.get('/void', (() => undefined) as () => string)

    const res = await app.inject('GET', '/void')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_HANDLER_NO_RETURN')
  })
})

describe('boot', () => {
  test('duplicate routes are a boot error, not silent shadowing', async () => {
    const app = makeApp()
    app.get('/dup', () => 'a')
    app.get('/dup', () => 'b')

    await assert.rejects(() => app.ready(), /ZEN_ROUTE_DUPLICATE|Duplicate route/)
  })

  test('ambiguous routes are refused rather than guessed', async () => {
    const app = makeApp()
    app.get('/:org/settings', () => 'a')
    app.get('/admin/:page', () => 'b')

    await assert.rejects(() => app.ready(), /Boot failed/)
  })

  test('registration after boot is rejected', async () => {
    const app = makeApp()
    app.get('/', () => 'x')
    await app.ready()

    assert.throws(() => app.get('/late', () => 'y'), /frozen/i)
  })

  test('the AppGraph is populated and serialisable', async () => {
    const app = makeApp()
    app.get('/a', () => 'a')
    app.collection('/api', (c) => c.get('/b', () => 'b'))
    await app.ready()

    const graph = app.graph()
    assert.equal(graph.routes.length, 2)
    assert.deepEqual(graph.routes.map((r) => r.path).sort(), ['/a', '/api/b'])
    assert.equal(graph.collections.length, 1)
  })
})

describe('repeated headers (§13.6)', () => {
  /**
   * `SmallHeaderBag` stores a multi-value header as an array and `entries()`
   * flattens it to one entry per value. Two readers disagreed with that
   * contract for as long as nothing exercised it: `@visionpilot/zen-adapter-node` called
   * `setHeader` for every name but `set-cookie`, which discards all but the
   * last, and `InjectedResponse` used `Object.fromEntries`, which does the
   * same. Both looked complete because the only repeated header anyone had
   * produced was `Set-Cookie`, which was special-cased.
   *
   * CORS produced the second one — a preflight varies on three request headers
   * — and over a real socket only the third arrived. These tests cover the
   * in-process half; `scripts/smoke.ts` covers the wire, which is the only
   * place the adapter's half is falsifiable.
   */
  test('appendHeader accumulates, and the response reads back every value', async () => {
    const app = makeApp()
    app.get('/vary', (ctx) => {
      ctx.res.appendHeader('vary', 'origin')
      ctx.res.appendHeader('vary', 'accept-encoding')
      ctx.res.vary('accept-language')
      return { ok: true }
    })

    const res = await app.inject('GET', '/vary')
    assert.deepEqual(res.headerValues('vary'), ['origin', 'accept-encoding', 'accept-language'])
    // Joined the way WHATWG `Headers.get` joins, so an assertion written
    // against `inject()` says the same thing as one written against `fetch`.
    assert.equal(res.header('vary'), 'origin, accept-encoding, accept-language')
    assert.equal(res.headers['vary'], 'origin, accept-encoding, accept-language')
  })

  test('a single-valued header is unchanged by the joining', async () => {
    const app = makeApp()
    app.get('/one', (ctx) => ctx.json({ ok: true }, { headers: { 'x-one': 'value' } }))

    const res = await app.inject('GET', '/one')
    assert.equal(res.header('x-one'), 'value')
    assert.deepEqual(res.headerValues('x-one'), ['value'])
    assert.equal(res.header('x-absent'), undefined)
    assert.deepEqual(res.headerValues('x-absent'), [])
  })

  test('Set-Cookie is never joined — two cookies joined by a comma are one broken cookie', async () => {
    const app = makeApp()
    app.get('/cookies', (ctx) => {
      ctx.res.cookie('a', '1', { httpOnly: true })
      ctx.res.cookie('b', '2', { path: '/x' })
      return { ok: true }
    })

    const res = await app.inject('GET', '/cookies')
    const cookies = res.headerValues('set-cookie')
    assert.equal(cookies.length, 2)
    assert.ok(cookies.some((c) => c.startsWith('b=2')))
    assert.ok(cookies.some((c) => c.startsWith('a=1')))
    assert.doesNotMatch(res.header('set-cookie') ?? '', /,/)
  })
})

describe('body handling', () => {
  test('a route without a body schema never parses one', async () => {
    const app = makeApp()
    app.post('/no-schema', (ctx) => ({ body: ctx.raw.body.kind }))

    const res = await app.inject('POST', '/no-schema', { body: { a: 1 } })
    // The intake stage is not emitted into this route's pipeline at all.
    assert.deepEqual(res.json(), { body: 'buffer' })
  })

  test('declared bodies are parsed and validated', async () => {
    const app = makeApp()
    app.post('/echo', { body: numberSchema() }, (ctx) => ({ got: ctx.body }))

    const res = await app.inject('POST', '/echo', { body: { n: 5 } })
    assert.deepEqual(res.json(), { got: { n: 5 } })
  })

  test('validation failures return a normalised 422 envelope', async () => {
    const app = makeApp()
    app.post('/echo', { body: numberSchema() }, (ctx) => ctx.body)

    const res = await app.inject('POST', '/echo', { body: { n: 'nope' } })
    assert.equal(res.status, 422)
    const problem = res.json<{ code: string; errors: Array<{ path: string[]; code: string }> }>()
    assert.equal(problem.code, 'ZEN_VALIDATION')
    assert.deepEqual(problem.errors[0]?.path, ['n'])
  })

  test('a +json media type is JSON (RFC 6839)', async () => {
    // `application/merge-patch+json` and vendor types used to be refused with a
    // 415, so a client that labelled its body precisely looked broken.
    const app = makeApp()
    app.patch('/doc', { body: passthroughSchema() }, (ctx) => ({ got: ctx.body }))

    for (const type of ['application/merge-patch+json', 'application/vnd.api+json; charset=utf-8']) {
      const res = await app.inject('PATCH', '/doc', { headers: { 'content-type': type }, body: '{"a":1}' })
      assert.equal(res.status, 200, type)
      assert.deepEqual(res.json(), { got: { a: 1 } })
    }
    const xml = await app.inject('PATCH', '/doc', { headers: { 'content-type': 'application/xml' }, body: '<a/>' })
    assert.equal(xml.status, 415, 'and a genuinely unknown type is still refused')
  })

  test('prototype pollution keys are stripped from JSON bodies', async () => {
    const app = makeApp()
    app.post('/p', { body: passthroughSchema() }, (ctx) => ({
      polluted: ({} as Record<string, unknown>)['polluted'] ?? null,
      keys: Object.keys(ctx.body as object),
    }))

    const res = await app.inject('POST', '/p', {
      body: '{"a":1,"__proto__":{"polluted":"yes"}}',
      headers: { 'content-type': 'application/json' },
    })
    assert.deepEqual(res.json(), { polluted: null, keys: ['a'] })
  })
})

/** A minimal hand-written Standard Schema — proves core needs no schema library. */
function numberSchema() {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate(value: unknown) {
        const v = value as { n?: unknown }
        if (typeof v?.n !== 'number') {
          return { issues: [{ message: 'Expected a number', path: ['n'] }] }
        }
        return { value: { n: v.n } }
      },
    },
  }
}

function passthroughSchema() {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => ({ value }),
    },
  }
}
