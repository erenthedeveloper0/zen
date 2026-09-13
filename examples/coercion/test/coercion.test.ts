import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { explainRoute } from 'zen'
import type { ZenApp } from 'zen'
import { makeApp, makeLegacyApp } from '../src/app.ts'
import type { CatalogResult, OrderResult } from '../src/features/catalog/index.ts'

/**
 * The example, tested as an application — rfcs/0001 §20.2, §23.4, §11.4.
 *
 * These tests are typechecked in CI, unlike the ones in `packages/*`, which
 * makes them the place where the *type-level* half of the claim is under test
 * too: `ctx.query.page` is a `number` in `routes.ts`, and if the runtime stopped
 * agreeing, the assertions below would still pass while the service quietly
 * built `LIMIT '20'`. So each one asserts the value **and** its `typeof`.
 *
 * The suite's centrepiece is the last block: the same requests against the same
 * service written both ways — with §11.4, and with `z.coerce` plus a
 * hand-written `preprocess` — must produce identical bodies. That is what makes
 * this a refactor rather than a behaviour change.
 */

let app: ZenApp | null = null

async function ready(): Promise<ZenApp> {
  if (app === null) {
    app = makeApp({ quiet: true })
    await app.ready()
  }
  return app
}

const get = async (url: string): Promise<CatalogResult> =>
  (await (await ready()).inject('GET', url)).json<CatalogResult>()

describe('a query string arrives as the types the schema declared', () => {
  test('numbers are numbers', async () => {
    const body = await get('/catalog?page=2&limit=3')
    assert.equal(body.page, 2)
    assert.equal(typeof body.page, 'number')
    assert.equal(body.limit, 3)
    assert.equal(typeof body.limit, 'number')
  })

  test('defaults still apply when the parameter is absent', async () => {
    const body = await get('/catalog')
    assert.equal(body.page, 1)
    assert.equal(body.limit, 20)
    assert.equal(body.applied.sort, 'name')
  })

  test('booleans accept every spelling a real client sends', async () => {
    for (const spelling of ['true', '1', 'yes', 'on', 'TRUE']) {
      const body = await get(`/catalog?inStock=${spelling}`)
      assert.equal(body.applied.inStock, true, spelling)
    }
    for (const spelling of ['false', '0', 'no', 'off']) {
      const body = await get(`/catalog?inStock=${spelling}`)
      assert.equal(body.applied.inStock, false, spelling)
    }
  })

  test('one tag is a one-element array, not a string', async () => {
    // The single most common query-parsing bug in any language, and the reason
    // `arrays: 'repeat'` is a default rather than an option.
    const one = await get('/catalog?tags=sale')
    assert.deepEqual(one.applied.tags, ['sale'])
    const two = await get('/catalog?tags=sale&tags=new')
    assert.deepEqual(two.applied.tags, ['sale', 'new'])
  })

  test('the filters actually reached the service', async () => {
    const body = await get('/catalog?inStock=false&limit=100')
    assert.ok(body.items.length > 0)
    assert.ok(body.items.every((item) => item.inStock === false))
  })
})

describe('what is deliberately not converted', () => {
  test('a SKU declared as a string keeps its leading zeros', async () => {
    const body = await get('/catalog?sku=00713')
    assert.equal(body.applied.sku, '00713')
    assert.equal(body.items[0]?.name, 'Aeron chair')
  })

  test('a union containing a string is left as the string it arrived as', async () => {
    const res = await (await ready()).inject('GET', '/catalog?q=2024')
    assert.equal(res.status, 200, 'a numeric-looking search term is still a search term')
  })

  test('a JSON body is not coerced — a stringly-typed field is a client bug', async () => {
    const res = await (await ready()).inject('POST', '/catalog/00713/order', {
      body: { quantity: '2' },
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(res.status, 422)
  })
})

describe('what happens when a value will not convert', () => {
  test('the schema answers, with its own path and message', async () => {
    const res = await (await ready()).inject('GET', '/catalog?page=banana')
    assert.equal(res.status, 400)
    const problem = res.json<{ code: string; errors: Array<{ path: string[]; message: string }> }>()
    assert.equal(problem.code, 'ZEN_VALIDATION')
    assert.deepEqual(problem.errors[0]?.path, ['page'])
  })

  test('an id too large for a double is refused, not silently rounded', async () => {
    // 9007199254740993 → 9007199254740992 under `Number()`. Rounding a primary
    // key is a data-corruption bug produced by a convenience feature; a 400 is
    // the honest outcome.
    const res = await (await ready()).inject('GET', '/catalog?page=9007199254740993')
    assert.equal(res.status, 400)
  })

  test('a value outside the schema\'s range still fails on the schema\'s terms', async () => {
    const res = await (await ready()).inject('GET', '/catalog?limit=500')
    assert.equal(res.status, 400)
    const problem = res.json<{ errors: Array<{ path: string[] }> }>()
    assert.deepEqual(problem.errors[0]?.path, ['limit'])
  })
})

describe('per-route and per-source profiles', () => {
  test('one route splits its list on commas; the rest repeat', async () => {
    const res = await (await ready()).inject('GET', '/catalog/by-ids?ids=0,1,2')
    assert.equal(res.status, 200)
    const items = res.json<Array<{ name: string }>>()
    assert.deepEqual(items.map((i) => i.name), ['Aeron chair', 'Standing desk', 'Split keyboard'])
  })

  test('the same spelling on the repeat route is one value, as it should be', async () => {
    const body = await get('/catalog?tags=sale,new')
    assert.deepEqual(body.applied.tags, ['sale,new'])
  })

  test('a header list is split, because RFC 9110 says a list header is', async () => {
    const res = await (await ready()).inject('GET', '/features', { headers: { 'x-feature': 'a, b' } })
    assert.deepEqual(res.json<{ enabled: string[] }>().enabled, ['a', 'b'])
  })

  test('a form body is coerced, and a blank optional field is absent rather than empty', async () => {
    const res = await (await ready()).inject('POST', '/catalog/00713/order', {
      body: 'quantity=2&giftWrap=on&note=',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.equal(res.status, 200)
    const order = res.json<OrderResult>()
    assert.equal(order.quantity, 2)
    assert.equal(order.giftWrap, true)
    assert.equal(order.note, null, "an untouched form input must not become ''")
    assert.equal(order.total, 1395 * 2 + 5)
  })
})

describe('the plan is on the graph, and the graph is what runs', () => {
  test('explainRoute names the fields, not the policy', async () => {
    const graph = (await ready()).graph()
    const search = graph.routes.find((r) => r.name === 'catalog.search')
    assert.ok(search !== undefined)

    const explained = explainRoute(search)
    assert.match(explained, /coerce\s+query:/)
    assert.match(explained, /page → integer/)
    assert.match(explained, /tags → array of string \(repeat\)/)
    assert.doesNotMatch(explained, /sku →/, 'a declared string has no entry')
    assert.doesNotMatch(explained, /\bq →/, 'a union containing a string has no entry')
  })

  test('the comma route says so on the graph too', async () => {
    const graph = (await ready()).graph()
    const legacy = graph.routes.find((r) => r.name === 'catalog.byIds')
    const op = legacy?.coercion?.get('query')?.fields[0]?.op
    assert.equal(op?.kind, 'array')
    assert.equal(op?.kind === 'array' ? op.split : null, ',')
  })

  test('a route with nothing to convert emits no coercer (§9.4)', async () => {
    const instance = await ready()
    const units = instance.generatedSource().filter((u) => u.name.startsWith('coercer:'))
    // catalog.search (query), catalog.byIds (query), catalog.order (body),
    // features (headers) — and nothing for the response-only paths.
    assert.equal(units.length, 4)
    assert.ok(units.every((u) => u.source.includes('coerce$')))
  })
})

describe('the document describes the serialization the server actually parses', () => {
  test("the comma route's parameter is documented as explode: false", async () => {
    // §29.1 applied to request parameters. A client generated from a document
    // that said `explode: true` would send `?ids=0&ids=1`, which this route
    // reads as one element — so the mapping has to come from the same plan the
    // coercer was built from, and it does.
    const { openapiDocument } = await import('@zenjs/openapi')
    const { document } = openapiDocument((await ready()).graph(), { title: 'catalog', version: '1' })
    const parameters = document.paths['/catalog/by-ids']?.get?.parameters ?? []
    const ids = parameters.find((p) => 'name' in p && p.name === 'ids')
    assert.equal((ids as { explode?: boolean } | undefined)?.explode, false)

    const repeated = (document.paths['/catalog']?.get?.parameters ?? [])
      .find((p) => 'name' in p && p.name === 'tags')
    assert.equal((repeated as { explode?: boolean } | undefined)?.explode, undefined,
      'the default needs no restating')
  })
})

describe('§11.4 is a refactor of what people already write by hand', () => {
  const cases = [
    '/catalog?page=2&limit=3',
    '/catalog',
    '/catalog?inStock=true&tags=sale',
    '/catalog?inStock=on',
    '/catalog?tags=sale&tags=new',
    '/catalog?sku=00713',
    '/catalog?sort=price',
  ]

  test('the coerced app and the z.coerce app answer identically', async () => {
    // The strongest form of the claim: adopting this cannot change behaviour,
    // because the behaviour is the one people were already hand-writing. If
    // these ever diverge, the framework has taken a position its users did not
    // ask it to take.
    const modern = await ready()
    const legacy = makeLegacyApp({ quiet: true })
    await legacy.ready()

    for (const url of cases) {
      const a = (await modern.inject('GET', url)).json<CatalogResult>()
      const b = (await legacy.inject('GET', url)).json<CatalogResult>()
      assert.deepEqual(
        { page: a.page, limit: a.limit, applied: a.applied },
        { page: b.page, limit: b.limit, applied: b.applied },
        `diverged on ${url}`,
      )
    }

    await legacy.close()
  })
})
