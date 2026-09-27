import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { explainRoute, steps } from '@erenthedeveloper0/zen'
import { audit, makeApp } from '../src/app.ts'
import type { RequestLine } from '../src/plugins/observability.ts'

/**
 * What the hook system buys, asserted rather than described — rfcs/0001 §9, §31.
 *
 * The interesting tests here are not "did the hook run". They are the three
 * properties that are hard to get right in every other framework and that fall
 * out of having phases at all:
 *
 *   - metric labels are bounded, because the label comes from the route
 *     template the AppGraph already holds;
 *   - the recorded duration includes serialization, because `onResponse` runs
 *     after the last byte;
 *   - a stage that did not happen is absent rather than zero, because the phase
 *     was never emitted into that route's pipeline.
 */

const CHECKOUT = {
  customer: { email: 'ada@example.com', name: 'Ada Lovelace', country: 'GB' },
  lines: [{ productId: 1, quantity: 2 }, { productId: 3, quantity: 1 }],
  couponCode: 'SPRING-2026',
}

interface Harness {
  app: ReturnType<typeof makeApp>
  lines: RequestLine[]
}

function harness(): Harness {
  const lines: RequestLine[] = []
  const app = makeApp({ quiet: true, workUnits: 2, onRequestLine: (line) => { lines.push(line) } })
  return { app, lines }
}

async function scrape(app: Harness['app']): Promise<string> {
  return (await app.inject('GET', '/metrics')).text()
}

function series(scraped: string, metric: string): string[] {
  return scraped.split('\n').filter((line) => line.startsWith(metric) && !line.startsWith('#'))
}

function serverTiming(header: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (header ?? '').split(',')) {
    const match = /^\s*(\w+);dur=([\d.]+)\s*$/.exec(part)
    if (match !== null) out[match[1] as string] = Number(match[2])
  }
  return out
}

beforeEach(() => { audit.length = 0 })

describe('cardinality (§31.2)', () => {
  test('metrics label on the route template, so ids do not create series', async () => {
    const { app } = harness()
    for (const id of [1, 2, 3, 4]) await app.inject('GET', `/products/${id}`)

    const scraped = await scrape(app)
    const rows = series(scraped, 'http_requests_total')

    assert.equal(rows.length, 1, `four ids produced ${rows.length} series:\n${rows.join('\n')}`)
    assert.match(rows[0] as string, /route="\/products\/:id<int>"/)
    assert.match(rows[0] as string, / 4$/)
    assert.ok(!scraped.includes('/products/1'), 'a concrete URL reached a label')
  })

  test('an unmatched request is counted without putting the URL in a label', async () => {
    const { app } = harness()
    await app.inject('GET', '/does-not-exist')
    await app.inject('GET', '/also-not-here')

    const scraped = await scrape(app)
    const rows = series(scraped, 'http_requests_total')

    assert.equal(rows.length, 1)
    assert.match(rows[0] as string, /route="<unmatched>"/)
    assert.match(rows[0] as string, /status="404"/)
    assert.ok(!scraped.includes('does-not-exist'))
  })

  test('the scrape endpoint does not measure itself', async () => {
    const { app } = harness()
    await app.inject('GET', '/products/1')
    await scrape(app)
    await scrape(app)

    const scraped = await scrape(app)
    assert.ok(!scraped.includes('/metrics'), 'the metrics route appeared in its own output')
    assert.equal(series(scraped, 'http_requests_total').length, 1)
  })
})

describe('per-stage attribution (§31.3)', () => {
  test('a POST with a body reports parse and validate; a GET reports neither', async () => {
    const { app, lines } = harness()

    const posted = await app.inject('POST', '/checkout', { body: CHECKOUT })
    assert.equal(posted.status, 201)
    const got = await app.inject('GET', '/products/1')
    assert.equal(got.status, 200)

    const post = serverTiming(posted.header('server-timing'))
    const get = serverTiming(got.header('server-timing'))

    assert.ok(post['parse'] !== undefined, 'a body-bearing route should report a parse stage')
    assert.ok(post['validate'] !== undefined, 'a validated route should report a validate stage')
    assert.ok(post['handler'] !== undefined)
    assert.ok(post['total'] !== undefined)

    // Absent, not zero. `/products/:id` declares no body, so intake is not in
    // its pipeline at all and the onParse hook has nothing to run in (§4.2
    // stage 6) — reporting `parse;dur=0` would claim parsing was instant rather
    // than that it did not happen.
    assert.equal(get['parse'], undefined)
    assert.equal(get['validate'], undefined)
    assert.ok(get['handler'] !== undefined)

    const line = lines.find((l) => l.route === '/checkout')
    assert.ok(line !== undefined)
    assert.ok(line.stages.parse > 0)
    assert.ok(line.stages.validate > 0)
  })

  test('the stages add up to no more than the total', async () => {
    const { app, lines } = harness()
    await app.inject('POST', '/checkout', { body: CHECKOUT })

    const line = lines[0]!
    const sum = line.stages.parse + line.stages.validate + line.stages.handler + line.stages.epilogue
    assert.ok(sum <= line.durationMs + 0.001, `stages ${sum.toFixed(3)}ms exceed total ${line.durationMs.toFixed(3)}ms`)
  })

  /**
   * The reason `onResponse` is a phase and not "the last middleware".
   *
   * `onSend` runs before the reply is turned into bytes and handed to the
   * adapter; `onResponse` runs after. A response-time middleware necessarily
   * stops the clock at the former and reports a number smaller than the one the
   * client experienced.
   */
  test('onResponse measures more than onSend can', async () => {
    const { app, lines } = harness()
    const res = await app.inject('POST', '/checkout', { body: CHECKOUT })

    const sent = serverTiming(res.header('server-timing'))['total'] as number
    const settled = lines[0]!.durationMs

    assert.ok(sent > 0)
    assert.ok(settled >= sent, `onResponse total ${settled} should be >= the onSend total ${sent}`)
  })
})

describe('errors', () => {
  test('errors are counted by stable code, and the request is still counted', async () => {
    const { app } = harness()
    const res = await app.inject('GET', '/products/999')
    assert.equal(res.status, 404)

    const scraped = await scrape(app)
    const errorRows = series(scraped, 'http_request_errors_total')

    assert.equal(errorRows.length, 1)
    assert.match(errorRows[0] as string, /code="ZEN_NOT_FOUND"/)
    assert.match(errorRows[0] as string, /route="\/products\/:id<int>"/)

    // The failed request is a request: it appears in the request counter too,
    // which is what makes an error rate computable from one scrape.
    assert.match(series(scraped, 'http_requests_total')[0] as string, /status="404"/)
  })

  test('a validation failure is attributed to the route that failed it', async () => {
    const { app } = harness()
    const res = await app.inject('POST', '/checkout', { body: { customer: {}, lines: [] } })
    assert.equal(res.status, 422)

    const scraped = await scrape(app)
    assert.match(series(scraped, 'http_request_errors_total')[0] as string, /code="ZEN_VALIDATION".*route="\/checkout"|route="\/checkout".*code="ZEN_VALIDATION"/)
  })
})

describe('scopes (§9.3)', () => {
  test('the collection audit hook sees admin routes and nothing else', async () => {
    const { app } = harness()
    await app.inject('GET', '/products/1')
    await app.inject('POST', '/checkout', { body: CHECKOUT })
    await app.inject('GET', '/admin/orders', { headers: { 'x-admin-key': 'let-me-in' } })

    assert.deepEqual(audit, [{ route: '/admin/orders', status: 200 }])
  })

  test('a collection onRequest hook can refuse the whole subtree', async () => {
    const { app } = harness()
    const denied = await app.inject('GET', '/admin/orders')
    assert.equal(denied.status, 403)

    const allowed = await app.inject('GET', '/admin/orders', { headers: { 'x-admin-key': 'let-me-in' } })
    assert.equal(allowed.status, 200)

    // The refusal is still audited: `onResponse` runs on the error path too.
    assert.deepEqual(audit.map((e) => e.status), [403, 200])
  })

  test('a route-scoped onSend hook applies to exactly one route', async () => {
    const { app } = harness()
    const one = await app.inject('GET', '/products/1')
    const list = await app.inject('GET', '/products')

    assert.equal(one.header('cache-control'), 'public, max-age=60')
    assert.equal(list.header('cache-control'), undefined)
    // Both still get the global hook's header.
    assert.ok(one.header('server-timing') !== undefined)
    assert.ok(list.header('server-timing') !== undefined)
  })
})

describe('transform hooks meet the response contract (§13.3)', () => {
  test('a global onSerialize envelope survives where nothing declares the shape', async () => {
    const { app } = harness()
    const res = await app.inject('GET', '/admin/orders', { headers: { 'x-admin-key': 'let-me-in' } })

    assert.equal(res.json<{ generatedBy?: string }>().generatedBy, 'dev')
  })

  test('…and is dropped where a response schema does not declare it', async () => {
    const { app } = harness()
    const res = await app.inject('GET', '/products/1')
    const body = res.json<Record<string, unknown>>()

    assert.equal(body['generatedBy'], undefined)
    assert.deepEqual(Object.keys(body).sort(), ['id', 'name', 'priceCents', 'tags'])
  })

  test('the private columns on the row never reach the wire', async () => {
    const { app } = harness()
    const text = (await app.inject('GET', '/products/1')).text()

    assert.ok(!text.includes('costCents'))
    assert.ok(!text.includes('supplier'))
    assert.ok(!text.includes('Shenzhen'))
  })
})

describe('explainRoute (§8.5)', () => {
  test('every route can print its resolved chain', async () => {
    const { app } = harness()
    await app.ready()

    for (const route of app.graph().routes) {
      const text = explainRoute(route)
      assert.ok(text.includes('handler'), `no handler line for ${route.path}`)
      assert.ok(!text.includes('anonymous'), `unnamed step on ${route.path}:\n${text}`)
    }
  })

  test('the admin route names both scopes it inherits from', async () => {
    const { app } = harness()
    await app.ready()

    const record = app.graph().routes.find((r) => r.name === 'admin.orders')!
    const chain = steps(record).map((s) => `${s.kind} ${s.scope}`)

    assert.ok(chain.includes('onRequest [global]'))
    assert.ok(chain.includes('onRequest [root/admin]'))
    // Mirrored on the way out: the collection's onResponse runs before the
    // global one (§9.3).
    assert.ok(chain.indexOf('onResponse [root/admin]') < chain.indexOf('onResponse [global]'))
  })
})
