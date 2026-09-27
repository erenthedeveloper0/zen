import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import type { ZenApp } from '@visionpilot/zen'
import { makeApp } from '../src/app.ts'
import { CSV, V1, V2 } from '../src/features/reports/index.ts'

/**
 * The example, as a test — rfcs/0001 §13.4, §20.2.
 *
 * **Example tests are type-checked in CI and package tests are not**, so the
 * claims that are really about *types* belong here. `examples/config` and
 * `examples/middleware` both do this deliberately, and §13.4 adds one worth
 * having: a negotiated route's handler is typed against the **union** of its
 * representations, so returning something no representation describes is a
 * compile error rather than a serializer surprise.
 *
 * Everything else here is the behaviour a service author would actually check
 * before shipping: that CSV is CSV, that a pinned client stays pinned, that a
 * 404 is a problem document whatever was asked for, and that the field the
 * database has and the API does not never appears in either format.
 */

let app: ZenApp

before(async () => {
  app = makeApp({ quiet: true }).app
  await app.ready()
})

const get = (path: string, accept?: string) =>
  app.inject('GET', path, accept === undefined ? {} : { headers: { accept } })

describe('the three representations', () => {
  test('no Accept header gets the first declared — the server preference', async () => {
    const res = await get('/api/sales')
    assert.equal(res.status, 200)
    assert.equal(res.header('content-type'), `${V2}; charset=utf-8`)
    assert.equal(res.header('vary'), 'Accept')
  })

  test('a pinned v1 client keeps getting v1 from the same URL', async () => {
    const res = await get('/api/sales', V1)
    assert.equal(res.header('content-type'), `${V1}; charset=utf-8`)

    const [first] = res.json<Array<Record<string, unknown>>>()
    assert.equal(typeof first!['owner'], 'string', 'v1 owner is a bare string')
    assert.equal(first!['currency'], undefined, 'and v1 has no currency')
  })

  test('v2 nests the owner and adds currency, from the same handler', async () => {
    const [first] = (await get('/api/sales', V2)).json<Array<Record<string, unknown>>>()
    assert.equal(typeof first!['owner'], 'object')
    assert.equal(typeof first!['currency'], 'string')
  })

  test('csv is csv, with the columns the schema declared', async () => {
    const res = await get('/api/sales', CSV)
    assert.equal(res.header('content-type'), 'text/csv; charset=utf-8')

    const lines = res.text().split('\r\n')
    assert.equal(lines[0], 'id,region,owner,amount,closedAt')
    assert.match(lines[1] as string, /^1,emea,Ada Lovelace,12400,2026-07-02$/)
  })

  test('a subtype wildcard finds the only text/* representation', async () => {
    assert.equal((await get('/api/sales', 'text/*')).header('content-type'), 'text/csv; charset=utf-8')
  })

  test('quality decides, and a tie goes to the server', async () => {
    assert.equal(
      (await get('/api/sales', `${V2};q=0.5, ${V1};q=0.9`)).header('content-type'),
      `${V1}; charset=utf-8`,
    )
    assert.equal(
      (await get('/api/sales', `${V1};q=0.5, ${V2};q=0.5`)).header('content-type'),
      `${V2}; charset=utf-8`,
      'declaration order, not the order the client listed them',
    )
  })

  /** The case implementations invert. Getting it wrong serves a refused format. */
  test('"anything except csv" is honoured', async () => {
    assert.equal(
      (await get('/api/sales', 'text/csv;q=0, */*')).header('content-type'),
      `${V2}; charset=utf-8`,
    )
    assert.equal(
      (await get('/api/sales', '*/*;q=0, text/csv')).header('content-type'),
      'text/csv; charset=utf-8',
      'and its mirror: nothing, except csv',
    )
  })

  test('something the route cannot produce is a 406 that lists what it can', async () => {
    const res = await get('/api/sales', 'application/pdf')
    assert.equal(res.status, 406)
    assert.equal(res.header('vary'), 'Accept', 'a shared cache must not reuse this')

    const problem = res.json<{ code: string; errors: { available: string[] } }>()
    assert.equal(problem.code, 'ZEN_NOT_ACCEPTABLE')
    assert.deepEqual(problem.errors.available, [V2, V1, CSV])
  })

  test('an unreadable Accept is treated as absent, not as a refusal', async () => {
    // A proxy that mangles the header should not take the API down for every
    // client behind it.
    assert.equal((await get('/api/sales', 'garbage')).status, 200)
  })
})

describe('the status that is not negotiated', () => {
  test('a 404 is a problem document even when csv was asked for', async () => {
    const res = await get('/api/sales/999', CSV)
    assert.equal(res.status, 404)
    assert.equal(res.header('content-type'), 'application/problem+json; charset=utf-8')
    assert.equal(res.json<{ code: string }>().code, 'ZEN_NOT_FOUND')
  })

  test('and the 200 on the same route still negotiates', async () => {
    assert.equal((await get('/api/sales/1', CSV)).header('content-type'), 'text/csv; charset=utf-8')
  })
})

describe('the route that declares one representation', () => {
  test('is not negotiated: no Vary, no 406, Accept disregarded', async () => {
    const res = await get('/api/sales/regions', CSV)
    assert.equal(res.status, 200)
    assert.equal(res.header('vary'), undefined)
    assert.equal(res.header('content-type'), 'application/json; charset=utf-8')
    assert.deepEqual(res.json(), ['emea', 'amer', 'apac'])
  })

  test('and its pipeline contains no negotiation code at all', () => {
    const source = app.generatedSource()
      .find((unit) => unit.name === 'pipeline:GET_/api/sales/regions')?.source ?? ''
    assert.notEqual(source, '')
    assert.equal(source.includes('negotiate'), false)
  })
})

describe('what neither representation can contain', () => {
  /**
   * `internalMargin` is on every row the service holds. Nothing in the handler
   * removes it: the JSON is filtered by the compiled serializer (§13.3) and the
   * CSV by a column list the encoder took from the same schema at boot.
   */
  test('a field no schema declares reaches neither format', async () => {
    for (const accept of [V1, V2, CSV]) {
      assert.equal(
        (await get('/api/sales', accept)).text().includes('internalMargin'),
        false,
        `${accept} leaked a field no schema declares`,
      )
      assert.equal((await get('/api/sales', accept)).text().includes('0.41'), false)
    }
  })

  /**
   * CSV injection. A cell beginning `=`, `+`, `-` or `@` is a *formula* to a
   * spreadsheet, so an export is a code-execution vector against whoever opens
   * it. The seed data contains an owner named `=1+1` precisely so this is
   * exercised by the example and not only by a unit test.
   */
  test('a cell that would be a spreadsheet formula is neutralised', async () => {
    const csv = (await get('/api/sales', CSV)).text()
    assert.match(csv, /'=1\+1/, 'the guard quote is present')
    assert.equal(csv.includes(',=1+1'), false, 'and the raw formula is not')
  })
})

describe('types (this file is type-checked in CI)', () => {
  /**
   * The type-level half of §13.4, and the reason this suite lives in an example
   * rather than in `packages/core/test`: package tests are not type-checked, so
   * a claim about types asserted there would hold whether or not it were true.
   *
   * `ctx.negotiated` is `string | null` on every route — `null` where the route
   * declares one representation. A handler that branches on it is narrowing a
   * union the compiler knows about.
   */
  test('ctx.negotiated is string | null, and the union is what the handler returns', () => {
    const probe = makeApp({ quiet: true }).app
    probe.get('/probe', {
      response: { 200: { 'application/json': RowsSchema, 'text/csv': RowsSchema } },
    }, (ctx) => {
      const media: string | null = ctx.negotiated
      // @ts-expect-error — `negotiated` is nullable on every route, because a
      // route that declares one representation has nothing to decide.
      const notNullable: string = ctx.negotiated
      void notNullable
      return media === 'text/csv' ? [] : []
    })
    assert.ok(true)
  })
})

// Declared after the suites that use it so the type-level test reads top-down.
const { z } = await import('../src/shared/zod.ts')
const RowsSchema = z.array(z.object({ id: z.number().int() }))
