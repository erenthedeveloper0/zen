import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { explainRoute, steps } from '@erenthedeveloper0/zen-core'
import { cors, rateLimit, requestId, securityHeaders } from '../src/index.ts'
import { makeApp } from './helpers.ts'

/**
 * The pack as a whole — rfcs/0001 §9.4, §10.5, §32.
 *
 * Three claims that belong to none of the four plugins individually:
 *
 *   1. **A `.use()`-registered middleware would not work**, which is why every
 *      member is a hook. Asserted as a negative control rather than described,
 *      because "phase middleware only runs on matched routes" is the kind of
 *      sentence everybody nods at and nobody believes until they see the count.
 *   2. **The pack orders itself**, so a user cannot register it wrongly. The
 *      order matters twice: security headers must be staged before anything can
 *      short-circuit, and CORS headers must be staged before the rate limiter
 *      can refuse — or a 429 arrives at a browser as a CORS failure and is
 *      debugged in the wrong file.
 *   3. **An app that does not register it pays nothing**, asserted against the
 *      generated pipeline source rather than against a clock (§9.4). The
 *      benchmark makes the same assertion a CI gate.
 */

const ORIGIN = 'https://app.example.com'

/** Registered in the worst order a user could pick. */
function packed() {
  const a = makeApp()
  a.use(rateLimit({ limit: 2, window: '1m' }))
  a.use(securityHeaders())
  a.use(cors({ origin: [ORIGIN] }))
  a.use(requestId())
  a.get('/things', () => ({ ok: true }))
  a.post('/things', () => ({ created: true }))
  return a
}

describe('the negative control: why none of these is middleware', () => {
  test('phase middleware misses the preflight and the unmatched request; a hook sees both', async () => {
    const a = makeApp()
    let middlewareRuns = 0
    let hookRuns = 0
    a.use(() => { middlewareRuns++ })
    a.hook('onRequest', () => { hookRuns++ })
    a.get('/things', () => ({ ok: true }))

    await a.inject('GET', '/things')
    await a.inject('GET', '/no/such/path')
    await a.inject('OPTIONS', '/things', {
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    })

    assert.equal(middlewareRuns, 1, 'a .use() CORS middleware would answer one request in three')
    assert.equal(hookRuns, 3)
  })

  test('so a preflight to a path with no route is answered, and a 404 flood is counted', async () => {
    const a = packed()

    const preflight = await a.inject('OPTIONS', '/no/such/path', {
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.header('access-control-allow-origin'), ORIGIN)

    const b = packed()
    await b.inject('GET', '/garbage-1')
    await b.inject('GET', '/garbage-2')
    assert.equal((await b.inject('GET', '/things')).status, 429)
  })
})

describe('the pack orders itself (§10.5 step 4)', () => {
  test('registration order does not decide execution order', async () => {
    const a = packed()
    await a.ready()

    const record = a.graph().routes.find((r) => r.method === 'GET')
    assert.ok(record !== undefined)
    const onRequest = steps(record).filter((s) => s.kind === 'onRequest').map((s) => s.name)

    assert.deepEqual(onRequest, ['request-id', 'security-headers', 'cors', 'rate-limit'])
  })

  test('a 429 carries CORS headers, whichever order the two were registered in', async () => {
    for (const order of ['cors first', 'limiter first'] as const) {
      const a = makeApp()
      const c = cors({ origin: [ORIGIN] })
      const r = rateLimit({ limit: 1, window: '1m' })
      if (order === 'cors first') { a.use(c); a.use(r) } else { a.use(r); a.use(c) }
      a.get('/things', () => ({ ok: true }))

      await a.inject('GET', '/things', { headers: { origin: ORIGIN } })
      const res = await a.inject('GET', '/things', { headers: { origin: ORIGIN } })

      assert.equal(res.status, 429, order)
      assert.equal(
        res.header('access-control-allow-origin'), ORIGIN,
        `${order}: without this the browser reports a rate limit as a CORS failure`,
      )
    }
  })

  test('a preflight is not counted against the limit', async () => {
    // A browser sends one preflight per actual request until the cache warms.
    // Counting them would halve every user's real budget, and the budget is the
    // number in the documentation.
    const a = makeApp()
    a.use(cors({ origin: [ORIGIN] }))
    a.use(rateLimit({ limit: 2, window: '1m' }))
    a.post('/things', () => ({ created: true }))

    for (let i = 0; i < 5; i++) {
      await a.inject('OPTIONS', '/things', {
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      })
    }
    assert.equal((await a.inject('POST', '/things', { body: {} })).status, 200)
    assert.equal((await a.inject('POST', '/things', { body: {} })).status, 200)
    assert.equal((await a.inject('POST', '/things', { body: {} })).status, 429)
  })

  test('every short-circuited response still carries the request id', async () => {
    const a = packed()
    const preflight = await a.inject('OPTIONS', '/things', {
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    })
    assert.ok((preflight.header('x-request-id') ?? '').length > 0)

    await a.inject('GET', '/things')
    await a.inject('GET', '/things')
    const limited = await a.inject('GET', '/things')
    assert.equal(limited.status, 429)
    assert.equal(limited.header('x-request-id'), limited.json<{ requestId: string }>().requestId)
  })
})

describe('the whole pack on one response', () => {
  test('an allowed cross-origin GET carries every header the four contribute', async () => {
    const res = await packed().inject('GET', '/things', { headers: { origin: ORIGIN } })

    assert.equal(res.status, 200)
    assert.equal(res.header('access-control-allow-origin'), ORIGIN)
    assert.equal(res.header('x-content-type-options'), 'nosniff')
    assert.equal(res.header('ratelimit-policy'), '2;w=60')
    assert.ok((res.header('x-request-id') ?? '').length > 0)
  })

  test('explainRoute names all four and where they came from (§8.5)', async () => {
    const a = packed()
    await a.ready()
    const record = a.graph().routes.find((r) => r.method === 'GET')
    const rendered = explainRoute(record as never)

    for (const name of ['request-id', 'security-headers', 'cors', 'rate-limit']) {
      assert.match(rendered, new RegExp(`onRequest\\s+\\[global\\]\\s+${name}`), name)
    }
  })

  test('the four appear on the graph as plugins, with versions', async () => {
    const a = packed()
    await a.ready()
    const names = a.graph().plugins.map((p) => p.name).sort()
    assert.deepEqual(names, ['cors', 'rate-limit', 'request-id', 'security-headers'])
    for (const plugin of a.graph().plugins) assert.match(plugin.version, /^\d+\.\d+\.\d+$/)
  })
})

describe('an app that does not register the pack pays nothing (§9.4)', () => {
  const pipelineSource = (app: { generatedSource(): readonly { name: string; source: string }[] }): string =>
    app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''

  test('the generated pipeline is byte-identical to one from an app that never heard of it', async () => {
    const bare = makeApp()
    bare.get('/things', () => ({ ok: true }))
    await bare.ready()

    const withPack = packed()
    await withPack.ready()

    const bareSource = pipelineSource(bare as never)
    assert.ok(bareSource.length > 0, 'the bare app must actually have compiled a pipeline')
    assert.ok(
      !pipelineSource(withPack as never).includes('cors'),
      'sanity: the packed app compiles something different',
    )

    // The claim: the *bare* app is unchanged by the pack existing at all. Since
    // these are separate apps the comparison is against a third, compiled in a
    // process where the pack has been imported and instantiated but not used.
    const untouched = makeApp()
    untouched.get('/things', () => ({ ok: true }))
    void cors({ origin: [ORIGIN] })
    void rateLimit({ limit: 1 })
    await untouched.ready()

    assert.equal(pipelineSource(untouched as never), bareSource)
  })

  test('registering the pack adds exactly four call sites and nothing else', async () => {
    const a = packed()
    await a.ready()
    const record = a.graph().routes.find((r) => r.method === 'GET')
    const all = steps(record as never)

    assert.equal(all.filter((s) => s.kind === 'onRequest').length, 4)
    // Not a middleware, not an `after`, not a second phase: the pack occupies
    // one phase and no other part of the lifecycle.
    assert.equal(all.filter((s) => s.kind === 'phase' || s.kind === 'around' || s.kind === 'after').length, 0)
    assert.equal(all.filter((s) => s.kind === 'onSend' || s.kind === 'onResponse').length, 0)
  })
})

describe('options are checked at boot, before any plugin runs (§8.6, §10.5 step 2)', () => {
  /** The refusal: the codes of the aggregated boot error (§12.7), and its rendered text. */
  async function refusal(register: (a: ReturnType<typeof makeApp>) => void): Promise<{ codes: string[]; message: string }> {
    const a = makeApp()
    register(a)
    a.get('/ok', () => ({ ok: true }))
    try {
      await a.ready()
    } catch (error) {
      const diagnostics = (error as { diagnostics?: ReadonlyArray<{ code: string }> }).diagnostics ?? []
      return { codes: diagnostics.map((d) => d.code), message: (error as Error).message }
    }
    throw new Error('expected ready() to fail, and it did not')
  }

  test('rateLimit({ limt: 100 }) fails at startup with a spelling suggestion — §8.6, verbatim', async () => {
    const failure = await refusal((a) => a.use(rateLimit({ limt: 100 } as never)))
    assert.deepEqual(failure.codes, ['ZEN_PLUGIN_OPTIONS'])
    assert.match(failure.message, /Plugin "rate-limit@0\.1\.0" was given options it does not accept: "limt" is not an option/)
    assert.match(failure.message, /"limt" is not an option of rate-limit — did you mean "limit"\?/)
  })

  test('each of the four names its own misspelt key', async () => {
    const cases: Array<[(a: ReturnType<typeof makeApp>) => void, RegExp]> = [
      [(a) => a.use(cors({ origin: [ORIGIN], credential: true } as never)), /did you mean "credentials"\?/],
      [(a) => a.use(securityHeaders({ frameOption: 'DENY' } as never)), /did you mean "frameOptions"\?/],
      [(a) => a.use(requestId({ trustHeaders: true } as never)), /did you mean "trustHeader"\?/],
      [(a) => a.use(rateLimit({ windw: '1m' } as never)), /did you mean "window"\?/],
    ]
    for (const [register, expected] of cases) {
      const failure = await refusal(register)
      assert.deepEqual(failure.codes, ['ZEN_PLUGIN_OPTIONS'])
      assert.match(failure.message, expected)
    }
  })

  test('a value of the wrong type is refused by option name', async () => {
    const failure = await refusal((a) => a.use(securityHeaders({ frameOptions: 'ALLOW-FROM' } as never)))
    assert.match(failure.message, /frameOptions: expected "DENY", "SAMEORIGIN", false/)
    const limit = await refusal((a) => a.use(rateLimit({ limit: '100' } as never)))
    assert.match(limit.message, /limit: expected a number/)
  })

  test('a refusal names keys, never values — options are where secrets are passed', async () => {
    const failure = await refusal((a) => a.use(rateLimit({ mesage: 'sk_live_do_not_print' } as never)))
    assert.match(failure.message, /"mesage" is not an option/)
    assert.doesNotMatch(failure.message, /sk_live_do_not_print/)
  })

  test('every typo is reported once, though both core and the schema could see it', async () => {
    const failure = await refusal((a) => a.use(rateLimit({ limt: 100 } as never)))
    assert.equal(failure.message.match(/"limt" is not an option(?! of)/g)?.length, 1)
  })

  test('two misconfigured plugins are reported together, not one per restart', async () => {
    const failure = await refusal((a) => {
      a.use(rateLimit({ limt: 1 } as never))
      a.use(cors({ origin: [ORIGIN], maxage: '1m' } as never))
    })
    assert.match(failure.message, /rate-limit@0\.1\.0/)
    assert.match(failure.message, /cors@0\.1\.0/)
  })

  test('the checks a value needs beyond its type stay with the plugin, for configuration too', async () => {
    // `limit: 0` is a number, so the schema accepts it; the plugin's own rule
    // refuses it — the same rule `config.rateLimit.limit` has to meet.
    const failure = await refusal((a) => a.use(rateLimit({ limit: 0 })))
    assert.deepEqual(failure.codes, ['ZEN_CONFIG_INVALID'])
  })

  test('well-formed options boot, and the four are unchanged on the wire', async () => {
    const a = packed()
    await a.ready()
    const res = await a.inject('GET', '/things', { headers: { origin: ORIGIN } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN)
  })
})
