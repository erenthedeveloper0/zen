import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { defineConfig } from '@visionpilot/zen-core'
import { cors, securityHeaders } from '../src/index.ts'
import { bootFailure, makeApp, varyTokens } from './helpers.ts'

/**
 * CORS — rfcs/0001 §19.2, §4.2 stage 5, §9.2.
 *
 * Four things are under test, and only the first is the obvious one:
 *
 *   1. the protocol — preflight, allowlist, `Vary`, the header set;
 *   2. **that a preflight to a path with no route is answered**, which is the
 *      claim the whole design exists for and the one every `.use()`-based CORS
 *      middleware fails. The negative control in `pack.test.ts` shows the
 *      failure directly rather than describing it;
 *   3. that the headers reach the 404, the 500 and the validation error, which
 *      is what staging through `ctx.res` buys over stamping a reply;
 *   4. that a misconfiguration is a **boot error naming the fix**, not a
 *      silent deny that reads like a bug.
 */

function app(options: Parameters<typeof cors>[0] = { origin: ['https://app.example.com'] }) {
  const a = makeApp()
  a.use(cors(options))
  a.get('/things', () => ({ ok: true }))
  a.post('/things', () => ({ created: true }))
  a.get('/boom', () => { throw new Error('kaboom') })
  return a
}

const PREFLIGHT = (origin: string, method = 'POST') => ({
  headers: { origin, 'access-control-request-method': method },
})

describe('the default is the absence of the plugin (§19.2)', () => {
  test('an app with no cors plugin emits no Access-Control-* header at all', async () => {
    const a = makeApp()
    a.get('/things', () => ({ ok: true }))
    const res = await a.inject('GET', '/things', { headers: { origin: 'https://evil.example' } })

    assert.equal(res.status, 200)
    for (const [name] of res.reply.headers.entries()) {
      assert.ok(!name.startsWith('access-control-'), `unexpected ${name}`)
    }
  })

  test('registering it without an allowlist is a boot error that names the fix and the consequence', async () => {
    const a = makeApp()
    a.use(cors())
    a.get('/x', () => ({}))

    const message = await bootFailure(a)
    assert.match(message, /needs an origin allowlist/)
    // §12.7's contract: a `fix:` that can be acted on and an `also:` that is
    // not a fix. Both come from the plugin, which was impossible before
    // `ZenErrorInit.hint` existed — a plugin could state a message and nothing
    // more, so §12.7 held for the framework and for none of the ecosystem.
    assert.match(message, /fix: Pass one/)
    assert.match(message, /also: Not registering this plugin at all is the deny-everything default/)
  })

  test("origin: '*' with credentials is refused rather than quietly repaired", async () => {
    const a = makeApp()
    a.use(cors({ origin: '*', credentials: true }))
    a.get('/x', () => ({}))

    const message = await bootFailure(a)
    assert.match(message, /cannot combine origin: '\*' with credentials: true/)
    assert.match(message, /turns an allowlist into allow-everyone/)
  })

  test('a trailing slash is a boot error, because it would match nothing', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com/'] }))
    a.get('/x', () => ({}))

    const message = await bootFailure(a)
    assert.match(message, /is not an origin/)
    assert.match(message, /fix: Use "https:\/\/app\.example\.com"/)
  })

  test('a path in the origin is refused for the same reason', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com/api'] }))
    a.get('/x', () => ({}))
    assert.match(await bootFailure(a), /is not an origin/)
  })
})

describe('preflight (§4.2 stage 5)', () => {
  test('a preflight to a path with no route is answered — the claim the design exists for', async () => {
    const a = app()
    const res = await a.inject('OPTIONS', '/no/such/path', PREFLIGHT('https://app.example.com'))

    assert.equal(res.status, 204)
    assert.equal(res.header('access-control-allow-origin'), 'https://app.example.com')
    assert.equal(res.header('access-control-allow-methods'), 'GET, HEAD, POST')
  })

  test('an OPTIONS without Access-Control-Request-Method is not a preflight', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.options('/things', () => ({ options: 'mine' }))

    const res = await a.inject('OPTIONS', '/things', { headers: { origin: 'https://app.example.com' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { options: 'mine' })
  })

  test('a disallowed origin gets a well-formed 204 and no CORS headers, and learns nothing', async () => {
    const res = await app().inject('OPTIONS', '/things', PREFLIGHT('https://evil.example'))

    assert.equal(res.status, 204)
    assert.equal(res.header('access-control-allow-origin'), undefined)
    assert.equal(res.header('access-control-allow-methods'), undefined)
    assert.equal(res.text(), '')
  })

  test('the preflight never reaches the route', async () => {
    let handlerRuns = 0
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.post('/things', () => { handlerRuns++; return { created: true } })

    await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(handlerRuns, 0)
  })

  test('max-age defaults to ten minutes and is emitted in seconds', async () => {
    const res = await app().inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(res.header('access-control-max-age'), '600')
  })

  test('maxAge: 0 omits the header rather than emitting a zero', async () => {
    const a = app({ origin: ['https://app.example.com'], maxAge: 0 })
    const res = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(res.header('access-control-max-age'), undefined)
  })

  test('preflightStatus: 200 is honoured for legacy stacks', async () => {
    const a = app({ origin: ['https://app.example.com'], preflightStatus: 200 })
    const res = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(res.status, 200)
  })
})

describe('the advertised method set comes from the graph (§2.4)', () => {
  test('a read-only API does not advertise DELETE', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.get('/things', () => ({ ok: true }))

    const res = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com', 'GET'))
    assert.equal(res.header('access-control-allow-methods'), 'GET, HEAD')
  })

  test('HEAD is advertised because §4.2 serves it for free, though no record declares it', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.get('/things', () => ({ ok: true }))
    await a.ready()

    const declared = a.graph().routes.map((r) => r.method)
    assert.ok(!declared.includes('HEAD'), 'no RouteRecord declares HEAD')

    const res = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com', 'HEAD'))
    assert.match(res.header('access-control-allow-methods') ?? '', /HEAD/)
  })

  test('an explicit list wins over the graph', async () => {
    const a = app({ origin: ['https://app.example.com'], methods: ['GET', 'PATCH'] })
    const res = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(res.header('access-control-allow-methods'), 'GET, PATCH')
  })
})

describe('Vary, and why it is staged before the early return', () => {
  test('an allowed actual request varies on origin', async () => {
    const res = await app().inject('GET', '/things', { headers: { origin: 'https://app.example.com' } })
    assert.ok(varyTokens(res).includes('origin'))
  })

  test('a rejected request varies on origin too', async () => {
    const res = await app().inject('GET', '/things', { headers: { origin: 'https://evil.example' } })
    assert.equal(res.header('access-control-allow-origin'), undefined)
    assert.ok(varyTokens(res).includes('origin'), 'a cache that stored this would replay it to an allowed origin')
  })

  test('a request with NO Origin header still varies on origin', async () => {
    // The one every CORS library gets wrong. The response has no
    // `Access-Control-Allow-Origin`, so it is a *different* response, and a
    // shared cache holding it without `Vary` serves it to a browser request
    // that needed the header. Only reproducible behind a CDN, which is why it
    // has to be a test rather than a review comment.
    const res = await app().inject('GET', '/things')
    assert.equal(res.header('access-control-allow-origin'), undefined)
    assert.ok(varyTokens(res).includes('origin'))
  })

  test("origin: '*' without credentials does not vary — the answer cannot differ", async () => {
    const a = app({ origin: '*' })
    const res = await a.inject('GET', '/things', { headers: { origin: 'https://anyone.example' } })
    assert.equal(res.header('access-control-allow-origin'), '*')
    assert.ok(!varyTokens(res).includes('origin'))
  })

  test("a preflight varies on the request-method header, and on request-headers only when reflecting", async () => {
    const reflecting = await app().inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.ok(varyTokens(reflecting).includes('access-control-request-method'))
    assert.ok(varyTokens(reflecting).includes('access-control-request-headers'))

    const fixed = app({ origin: ['https://app.example.com'], allowedHeaders: ['content-type'] })
    const listed = await fixed.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.ok(varyTokens(listed).includes('access-control-request-method'))
    assert.ok(!varyTokens(listed).includes('access-control-request-headers'))
    assert.equal(listed.header('access-control-allow-headers'), 'content-type')
  })

  test('an application Vary is appended to, never replaced', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.get('/things', (ctx) => { ctx.res.appendHeader('vary', 'accept-encoding'); return { ok: true } })

    const res = await a.inject('GET', '/things', { headers: { origin: 'https://app.example.com' } })
    const tokens = varyTokens(res)
    assert.ok(tokens.includes('origin'))
    assert.ok(tokens.includes('accept-encoding'))
  })
})

describe('the headers reach every response, because they are staged (§13.6)', () => {
  test('a 404 carries them', async () => {
    const res = await app().inject('GET', '/missing', { headers: { origin: 'https://app.example.com' } })
    assert.equal(res.status, 404)
    assert.equal(res.header('access-control-allow-origin'), 'https://app.example.com')
  })

  test('a 500 carries them', async () => {
    const res = await app().inject('GET', '/boom', { headers: { origin: 'https://app.example.com' } })
    assert.equal(res.status, 500)
    assert.equal(res.header('access-control-allow-origin'), 'https://app.example.com')
  })

  test('a 405 carries them', async () => {
    const res = await app().inject('DELETE', '/things', { headers: { origin: 'https://app.example.com' } })
    assert.equal(res.status, 405)
    assert.equal(res.header('access-control-allow-origin'), 'https://app.example.com')
  })

  test('a reply the handler built with its own headers keeps both', async () => {
    const a = makeApp()
    a.use(cors({ origin: ['https://app.example.com'] }))
    a.get('/thing', (ctx) => ctx.json({ ok: true }, { headers: { 'x-mine': '1' } }))

    const res = await a.inject('GET', '/thing', { headers: { origin: 'https://app.example.com' } })
    assert.equal(res.header('x-mine'), '1')
    assert.equal(res.header('access-control-allow-origin'), 'https://app.example.com')
  })
})

describe('matching', () => {
  test('a single origin is compared, a list is a set, and both are exact', async () => {
    const one = app({ origin: 'https://a.example' })
    assert.equal(
      (await one.inject('GET', '/things', { headers: { origin: 'https://a.example' } })).header('access-control-allow-origin'),
      'https://a.example',
    )
    assert.equal(
      (await one.inject('GET', '/things', { headers: { origin: 'https://a.example:443' } })).header('access-control-allow-origin'),
      undefined,
    )

    const many = app({ origin: ['https://a.example', 'https://b.example', 'https://c.example'] })
    for (const origin of ['https://a.example', 'https://b.example', 'https://c.example']) {
      assert.equal(
        (await many.inject('GET', '/things', { headers: { origin } })).header('access-control-allow-origin'),
        origin,
      )
    }
  })

  test('a global RegExp does not match every other request', async () => {
    // `lastIndex` on a `/g` regex advances between calls, so the second
    // identical request fails and the third succeeds. It is the classic
    // intermittent CORS bug and it is invisible in a single-request test.
    const a = app({ origin: /^https:\/\/[a-z]+\.example$/g })
    for (let i = 0; i < 4; i++) {
      const res = await a.inject('GET', '/things', { headers: { origin: 'https://tenant.example' } })
      assert.equal(res.header('access-control-allow-origin'), 'https://tenant.example', `request ${i + 1}`)
    }
  })

  test('a predicate decides, and is asked once per request', async () => {
    const seen: string[] = []
    const a = app({ origin: (o) => { seen.push(o); return o.endsWith('.trusted.example') } })

    const yes = await a.inject('GET', '/things', { headers: { origin: 'https://x.trusted.example' } })
    assert.equal(yes.header('access-control-allow-origin'), 'https://x.trusted.example')
    const no = await a.inject('GET', '/things', { headers: { origin: 'https://x.other.example' } })
    assert.equal(no.header('access-control-allow-origin'), undefined)

    assert.deepEqual(seen, ['https://x.trusted.example', 'https://x.other.example'])
  })
})

describe('credentials and exposed headers', () => {
  test('credentials are advertised on both the preflight and the actual response', async () => {
    const a = app({ origin: ['https://app.example.com'], credentials: true })
    for (const res of [
      await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com')),
      await a.inject('GET', '/things', { headers: { origin: 'https://app.example.com' } }),
    ]) {
      assert.equal(res.header('access-control-allow-credentials'), 'true')
    }
  })

  test('exposed headers are on the actual response and not on the preflight', async () => {
    const a = app({ origin: ['https://app.example.com'], exposedHeaders: ['x-total-count', 'ratelimit'] })

    const actual = await a.inject('GET', '/things', { headers: { origin: 'https://app.example.com' } })
    assert.equal(actual.header('access-control-expose-headers'), 'x-total-count, ratelimit')

    const preflight = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(preflight.header('access-control-expose-headers'), undefined)
  })
})

describe('configuration supplies the allowlist (§16)', () => {
  test('config.cors.origin is used when no option is passed, with provenance', async () => {
    const a = makeApp({
      config: defineConfig({
        cors: { origin: (env) => (env['CORS_ORIGINS'] ?? '').split(',') },
      }),
      env: [{ layer: 'env', name: 'test', entries: [{ key: 'CORS_ORIGINS', value: 'https://from-env.example' }] }],
    } as never)
    a.use(cors())
    a.get('/things', () => ({ ok: true }))

    const res = await a.inject('GET', '/things', { headers: { origin: 'https://from-env.example' } })
    assert.equal(res.header('access-control-allow-origin'), 'https://from-env.example')

    // The point of reading it from configuration rather than from the
    // environment directly: the snapshot on the graph says where it came from.
    const path = a.graph().config.values.find((v) => v.path === 'cors.origin')
    assert.equal(path?.layer, 'config')
  })

  test('an explicit option beats configuration', async () => {
    const a = makeApp({
      config: defineConfig({ cors: { origin: ['https://from-config.example'] } }),
    } as never)
    a.use(cors({ origin: ['https://from-code.example'] }))
    a.get('/things', () => ({ ok: true }))

    assert.equal(
      (await a.inject('GET', '/things', { headers: { origin: 'https://from-code.example' } })).header('access-control-allow-origin'),
      'https://from-code.example',
    )
    assert.equal(
      (await a.inject('GET', '/things', { headers: { origin: 'https://from-config.example' } })).header('access-control-allow-origin'),
      undefined,
    )
  })

  test('every option comes from configuration, not just the allowlist', async () => {
    // The gap `examples/middleware` found on its first run: only `origin` was
    // read from config, so a `zen.config.ts` declaring `cors.credentials: true`
    // was silently ignored. Half a feature is worse than none here, because
    // "configuration is ignored" is indistinguishable from "the browser is
    // wrong" from outside the process.
    const a = makeApp({
      config: defineConfig({
        cors: {
          origin: ['https://app.example.com'],
          credentials: true,
          maxAge: '30m',
          exposedHeaders: ['x-total-count'],
          allowedHeaders: ['content-type', 'authorization'],
          methods: ['GET', 'POST'],
          preflightStatus: 200,
        },
      }),
    } as never)
    a.use(cors())
    a.get('/things', () => ({ ok: true }))

    const actual = await a.inject('GET', '/things', { headers: { origin: 'https://app.example.com' } })
    assert.equal(actual.header('access-control-allow-credentials'), 'true')
    assert.equal(actual.header('access-control-expose-headers'), 'x-total-count')

    const pre = await a.inject('OPTIONS', '/things', PREFLIGHT('https://app.example.com'))
    assert.equal(pre.status, 200)
    assert.equal(pre.header('access-control-max-age'), '1800')
    assert.equal(pre.header('access-control-allow-headers'), 'content-type, authorization')
    assert.equal(pre.header('access-control-allow-methods'), 'GET, POST')
  })

  test('the merge is field by field, so the two can each supply half', async () => {
    const a = makeApp({
      config: defineConfig({ cors: { origin: ['https://app.example.com'] } }),
    } as never)
    a.use(cors({ credentials: true }))
    a.get('/things', () => ({ ok: true }))

    const res = await a.inject('GET', '/things', { headers: { origin: 'https://app.example.com' } })
    assert.equal(res.header('access-control-allow-origin'), 'https://app.example.com')
    assert.equal(res.header('access-control-allow-credentials'), 'true')
  })

  test('a config value of the wrong shape is a boot error, not something dropped', async () => {
    const a = makeApp({
      config: defineConfig({ cors: { origin: ['https://app.example.com'], credentials: 'yes' } }),
    } as never)
    a.use(cors())
    a.get('/things', () => ({ ok: true }))

    const message = await bootFailure(a)
    assert.match(message, /config\.cors\.credentials is string "yes", which is not a valid credentials/)
    assert.match(message, /also: Ignoring it would make the running configuration differ/)
  })

  test('a config namespace that is not an object is a boot error naming the shape', async () => {
    const a = makeApp({ config: defineConfig({ cors: 'https://app.example.com' }) } as never)
    a.use(cors())
    a.get('/things', () => ({ ok: true }))

    assert.match(await bootFailure(a), /config\.cors must be an object of options, and is string/)
  })

  test('the exports the consistency check reads follow configuration too', async () => {
    // `securityHeaders` decides whether to refuse based on what `cors` says it
    // is allowing. Before the merge existed, an allowlist supplied by config
    // reported itself as `dynamic`, which happens to still trip the check —
    // for the wrong reason, and it would have reported "origins chosen by a
    // predicate" for a plain list.
    const a = makeApp({
      config: defineConfig({ cors: { origin: ['https://app.example.com'] } }),
    } as never)
    a.use(cors())
    a.use(securityHeaders({ crossOriginResource: 'same-origin' }))
    a.get('/things', () => ({ ok: true }))

    const message = await bootFailure(a)
    assert.match(message, /cors allows https:\/\/app\.example\.com/)
    assert.doesNotMatch(message, /predicate/)
  })
})
