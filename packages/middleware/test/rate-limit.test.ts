import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, rateLimit, type Store, type Tally } from '../src/index.ts'
import { bootFailure, frozenClock, makeApp } from './helpers.ts'

/**
 * Rate limiting — rfcs/0001 §9.2, §19.2, §19.4, Annex B `ZEN_RATE_LIMITED`.
 *
 * The claim that decides the design is §9.2's: *"a rate limiter that only sees
 * matched routes is bypassed by requesting a path that does not exist."* The
 * suite below asserts it directly against `/no/such/path`, and `pack.test.ts`
 * shows the failure a `.use()`-registered limiter would have.
 *
 * Everything else follows from being an ordinary `HttpError`: the refusal goes
 * through the error engine, so it is RFC 9457, it carries a stable code, and
 * `onError` hooks see it. A limiter whose refusals bypass the error path is one
 * whose refusals no error-rate dashboard counts.
 *
 * ### On clocks
 *
 * A fixed window is defined against wall time, so a suite that called
 * `Date.now()` for real would fail whenever a run straddled a window boundary
 * — rarely, and never on the machine that wrote it. The HTTP behaviour here is
 * tested against a store whose counting is deterministic, and the window
 * semantics are tested against `MemoryStore` directly with a clock the test
 * owns. That split keeps both halves honest.
 */

describe('rate limiting behind a proxy (§19.4)', () => {
  const rotating = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}, 203.0.113.7` })

  test('with trustProxy as a hop count, rotating a fake X-Forwarded-For buys no fresh budget', async () => {
    const app = makeApp({ trustProxy: 1 })
    app.use(rateLimit({ limit: 2, store: fixedStore() }))
    app.get('/', () => 'ok')
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await app.inject('GET', '/', { headers: rotating(i) })).status)
    assert.deepEqual(statuses, [200, 200, 429, 429], 'every request counted against 203.0.113.7')
  })

  test('with trustProxy: true the same attack walks straight through — the reason the warning names a hop count', async () => {
    const app = makeApp({ trustProxy: true })
    app.use(rateLimit({ limit: 2, store: fixedStore() }))
    app.get('/', () => 'ok')
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await app.inject('GET', '/', { headers: rotating(i) })).status)
    assert.deepEqual(statuses, [200, 200, 200, 200])
  })

  test('a trustProxy that is not a count of proxies is refused at construction', () => {
    assert.throws(() => makeApp({ trustProxy: -1 }), { code: 'ZEN_CONFIG_INVALID' })
    assert.throws(() => makeApp({ trustProxy: 1.5 }), { code: 'ZEN_CONFIG_INVALID' })
  })
})

/** A store that counts and never rolls, so a test can assert on verdicts alone. */
function fixedStore(): Store & { readonly hits: ReadonlyMap<string, number> } {
  const hits = new Map<string, number>()
  return {
    hits,
    hit(key: string): Tally {
      const count = (hits.get(key) ?? 0) + 1
      hits.set(key, count)
      return { count, resetAt: Date.now() + 60_000 }
    },
  }
}

function app(options: Parameters<typeof rateLimit>[0] = {}) {
  const a = makeApp()
  a.use(rateLimit({ limit: 3, window: '1m', store: fixedStore(), ...options }))
  a.get('/ok', () => ({ ok: true }))
  a.post('/things', () => ({ created: true }))
  return a
}

describe('the verdict', () => {
  test('requests up to the limit pass and the one after it does not', async () => {
    const a = app()
    for (let i = 1; i <= 3; i++) assert.equal((await a.inject('GET', '/ok')).status, 200, `request ${i}`)
    assert.equal((await a.inject('GET', '/ok')).status, 429)
  })

  test('the refusal is RFC 9457 with the stable code Annex B already reserved', async () => {
    const a = app({ limit: 1 })
    await a.inject('GET', '/ok')
    const res = await a.inject('GET', '/ok')

    assert.equal(res.status, 429)
    assert.match(res.header('content-type') ?? '', /application\/problem\+json/)
    const problem = res.json<{ code: string; status: number; title: string; requestId: string }>()
    assert.equal(problem.code, 'ZEN_RATE_LIMITED')
    assert.equal(problem.status, 429)
    assert.match(problem.title, /Rate limit exceeded: 1 requests per 1m/)
    assert.ok(problem.requestId.length > 0)
  })

  test('it takes the ordinary error path, so onError hooks observe it', async () => {
    const seen: string[] = []
    const a = makeApp()
    a.use(rateLimit({ limit: 1, store: fixedStore() }))
    a.hook('onError', (_ctx: unknown, error: unknown) => {
      seen.push((error as { code?: string }).code ?? 'unknown')
    })
    a.get('/ok', () => ({ ok: true }))

    await a.inject('GET', '/ok')
    await a.inject('GET', '/ok')
    assert.deepEqual(seen, ['ZEN_RATE_LIMITED'])
  })

  test('a custom message reaches the client; the status and code do not move', async () => {
    const a = app({ limit: 1, message: 'Slow down, please.' })
    await a.inject('GET', '/ok')
    const res = await a.inject('GET', '/ok')
    assert.equal(res.json<{ title: string; code: string }>().title, 'Slow down, please.')
    assert.equal(res.json<{ code: string }>().code, 'ZEN_RATE_LIMITED')
  })
})

describe('it is not bypassable (§9.2)', () => {
  test('a path that matches no route is counted', async () => {
    const a = app({ limit: 2 })
    assert.equal((await a.inject('GET', '/no/such/path')).status, 404)
    assert.equal((await a.inject('GET', '/no/such/path')).status, 404)
    // The third is refused rather than 404'd: the limiter saw all three.
    assert.equal((await a.inject('GET', '/no/such/path')).status, 429)
  })

  test('a 404 flood consumes the same budget as real traffic', async () => {
    const a = app({ limit: 2 })
    await a.inject('GET', '/garbage-1')
    await a.inject('GET', '/garbage-2')
    assert.equal((await a.inject('GET', '/ok')).status, 429)
  })

  test('the body of a refused request is never read (§4.2 stage 5)', async () => {
    let reads = 0
    const a = makeApp()
    a.use(rateLimit({ limit: 1, store: fixedStore() }))
    a.post('/things', { body: probe(() => { reads++ }) }, () => ({ created: true }))

    await a.inject('POST', '/things', { body: { n: 1 } })
    assert.equal(reads, 1)

    const res = await a.inject('POST', '/things', { body: { n: 2 } })
    assert.equal(res.status, 429)
    assert.equal(reads, 1, 'the refused request must not have been parsed or validated')
  })
})

describe('headers', () => {
  test('RateLimit and RateLimit-Policy are on the allowed response', async () => {
    const res = await app({ limit: 3 }).inject('GET', '/ok')
    assert.equal(res.header('ratelimit'), 'limit=3, remaining=2, reset=60')
    assert.equal(res.header('ratelimit-policy'), '3;w=60')
  })

  test('remaining floors at zero rather than going negative', async () => {
    const a = app({ limit: 1 })
    await a.inject('GET', '/ok')
    await a.inject('GET', '/ok')
    const res = await a.inject('GET', '/ok')
    assert.equal(res.header('ratelimit'), 'limit=1, remaining=0, reset=60')
  })

  test('the 429 carries Retry-After in seconds, not the error engine default of 1', async () => {
    const a = app({ limit: 1 })
    await a.inject('GET', '/ok')
    const res = await a.inject('GET', '/ok')
    assert.equal(res.header('retry-after'), '60')
  })

  test('legacy X-RateLimit-* are off by default and opt in together', async () => {
    assert.equal((await app().inject('GET', '/ok')).header('x-ratelimit-limit'), undefined)

    const res = await app({ legacyHeaders: true }).inject('GET', '/ok')
    assert.equal(res.header('x-ratelimit-limit'), '3')
    assert.equal(res.header('x-ratelimit-remaining'), '2')
    assert.ok(Number(res.header('x-ratelimit-reset')) > 0)
  })

  test('standardHeaders: false emits neither family', async () => {
    const res = await app({ standardHeaders: false }).inject('GET', '/ok')
    assert.equal(res.header('ratelimit'), undefined)
    assert.equal(res.header('ratelimit-policy'), undefined)
  })
})

describe('keying', () => {
  test('a custom key groups requests', async () => {
    const a = makeApp()
    a.use(rateLimit({
      limit: 1,
      store: fixedStore(),
      key: (ctx) => ctx.raw.header('x-tenant' as never) ?? 'anonymous',
    }))
    a.get('/ok', () => ({ ok: true }))

    assert.equal((await a.inject('GET', '/ok', { headers: { 'x-tenant': 'a' } })).status, 200)
    assert.equal((await a.inject('GET', '/ok', { headers: { 'x-tenant': 'b' } })).status, 200)
    assert.equal((await a.inject('GET', '/ok', { headers: { 'x-tenant': 'a' } })).status, 429)
  })

  test('returning null exempts a request entirely — no counting, no headers', async () => {
    const a = makeApp()
    a.use(rateLimit({
      limit: 1,
      store: fixedStore(),
      key: (ctx) => (ctx.path === '/healthz' ? null : ctx.ip),
    }))
    a.get('/healthz', () => ({ ok: true }))
    a.get('/ok', () => ({ ok: true }))

    for (let i = 0; i < 5; i++) {
      const res = await a.inject('GET', '/healthz')
      assert.equal(res.status, 200)
      assert.equal(res.header('ratelimit'), undefined)
    }
    assert.equal((await a.inject('GET', '/ok')).status, 200)
  })
})

describe('the Store seam (§3.5)', () => {
  test('an async store is awaited, and a sync one is not made async', async () => {
    let awaited = 0
    const asyncStore: Store = {
      async hit(key) { awaited++; return { count: awaited, resetAt: Date.now() + 1000 } },
    }
    const a = makeApp()
    a.use(rateLimit({ limit: 1, store: asyncStore }))
    a.get('/ok', () => ({ ok: true }))

    assert.equal((await a.inject('GET', '/ok')).status, 200)
    assert.equal((await a.inject('GET', '/ok')).status, 429)
    assert.equal(awaited, 2)
  })

  test('close() is called on app shutdown (§4.5)', async () => {
    let closed = 0
    const a = makeApp()
    a.use(rateLimit({ limit: 10, store: { hit: () => ({ count: 1, resetAt: 0 }), close: () => { closed++ } } }))
    a.get('/ok', () => ({ ok: true }))

    await a.ready()
    await a.close()
    assert.equal(closed, 1)
  })

  test('a store with no close() does not break shutdown', async () => {
    const a = app()
    await a.ready()
    await a.close()
  })
})

describe('MemoryStore window semantics', () => {
  test('the count resets when the clock crosses a boundary', () => {
    const store = new MemoryStore({ windowMs: 1000 })
    const clock = frozenClock(10_000)

    assert.equal(store.hit('a', clock.now()).count, 1)
    assert.equal(store.hit('a', clock.now()).count, 2)
    clock.advance(999)
    assert.equal(store.hit('a', clock.now()).count, 3, 'still inside the window')
    clock.advance(1)
    assert.equal(store.hit('a', clock.now()).count, 1, 'a new window')
  })

  test('resetAt is the end of the window the hit landed in', () => {
    const store = new MemoryStore({ windowMs: 1000 })
    assert.equal(store.hit('a', 10_400).resetAt, 11_000)
    assert.equal(store.hit('a', 10_999).resetAt, 11_000)
    assert.equal(store.hit('a', 11_000).resetAt, 12_000)
  })

  test('keys are independent', () => {
    const store = new MemoryStore({ windowMs: 1000 })
    assert.equal(store.hit('a', 0).count, 1)
    assert.equal(store.hit('b', 0).count, 1)
    assert.equal(store.hit('a', 0).count, 2)
  })

  test('memory is bounded by one window, not by traffic — the DoS the map is', () => {
    const store = new MemoryStore({ windowMs: 1000 })
    for (let i = 0; i < 10_000; i++) store.hit(`attacker-${i}`, 5_000)
    assert.equal(store.size, 10_000)

    // One hit in the next window and the whole generation is gone. No sweep, no
    // pause, and nothing an attacker can do to keep the old keys alive.
    store.hit('anyone', 6_000)
    assert.equal(store.size, 1)
  })

  test('a clock that jumps forward many windows still lands in the right one', () => {
    const store = new MemoryStore({ windowMs: 1000 })
    store.hit('a', 1_000)
    const tally = store.hit('a', 900_000)
    assert.equal(tally.count, 1)
    assert.equal(tally.resetAt, 901_000)
  })

  test('reset() empties it', () => {
    const store = new MemoryStore({ windowMs: 1000 })
    store.hit('a', 0)
    store.reset()
    assert.equal(store.size, 0)
    assert.equal(store.hit('a', 0).count, 1)
  })
})

describe('configuration', () => {
  test('a limit below one is a boot error naming what it would break', async () => {
    const a = makeApp()
    a.use(rateLimit({ limit: 0 }))
    a.get('/ok', () => ({ ok: true }))

    const message = await bootFailure(a)
    assert.match(message, /needs a positive whole limit; got 0/)
    assert.match(message, /also: A limit below one refuses every request, including the health probes/)
  })

  test('a fractional limit is refused too', async () => {
    const a = makeApp()
    a.use(rateLimit({ limit: 2.5 }))
    a.get('/ok', () => ({ ok: true }))
    assert.match(await bootFailure(a), /positive whole limit; got 2\.5/)
  })

  test('the plugin declares its own layer-2 config defaults (§16.1)', async () => {
    const a = makeApp()
    a.use(rateLimit({ store: fixedStore() }))
    a.get('/ok', () => ({ ok: true }))
    await a.ready()

    const limit = a.graph().config.values.find((v) => v.path === 'rateLimit.limit')
    assert.equal(limit?.value, 100)
    assert.equal(limit?.layer, 'plugin')
  })
})

/** A Standard Schema that records every validation, so "was the body read" is answerable. */
function probe(onValidate: () => void) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-test',
      validate(value: unknown) { onValidate(); return { value } },
    },
  } as never
}
