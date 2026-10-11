import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, graphFingerprint, NoopLogger, type GraphDocument } from '@erenthedeveloper0/zen'
import { createTestApp } from '@erenthedeveloper0/zen/testing'
import { makeApp } from '../src/app.ts'

/**
 * The hello-world application, tested the way §20.2 says to test one: the
 * whole pipeline through `inject()`, no sockets.
 */

const quiet = () => makeApp({ logger: new NoopLogger(), lifecycle: false, env: {} })

describe('hello world', () => {
  test('the routes answer, and the slot carries the user', async () => {
    const t = await createTestApp(quiet)
    assert.equal((await t.get('/')).text(), 'Hello world')
    assert.deepEqual((await t.get('/json')).json(), { framework: 'zen', compiled: true })
    assert.deepEqual((await t.get('/users/1')).json(), { id: 1, name: 'ada' })
    assert.equal((await t.get('/users/2')).status, 404)
    assert.equal((await t.get('/admin/stats')).status, 403)
    assert.equal((await t.get('/admin/stats', { headers: { 'x-api-key': 'secret' } })).status, 200)
    // `inject()` captures a stream's reply without draining it; the socket test is `scripts/smoke.ts`.
    assert.equal((await t.get('/stream')).status, 200)
    const boom = await t.get('/boom')
    assert.equal(boom.status, 500)
    assert.doesNotMatch(boom.text(), /must never reach the client/)
    await t.close()
  })
})

describe('the graph as data, and responses held to their schemas', () => {
  test('the graph round-trips to canonical JSON, with one fingerprint across ten shuffled boots', async () => {
    const prints = new Set<string>()
    for (let boot = 0; boot < 10; boot++) {
      const app = quiet()
      await app.ready()
      const document = await app.graphDocument()
      const parsed = JSON.parse(JSON.stringify(document)) as GraphDocument
      assert.equal(canonicalJson(parsed), canonicalJson(document))
      const k = boot % parsed.routes.length
      const reordered = { ...parsed, routes: [...parsed.routes.slice(k), ...parsed.routes.slice(0, k)] }
      assert.equal(await graphFingerprint(reordered), document.fingerprint)
      prints.add(document.fingerprint)
      await app.close()
    }
    assert.equal(prints.size, 1)
  })

  test('a wrong-type value in a response is refused, not sent', async () => {
    const t = await createTestApp(() => {
      const app = quiet()
      // Seeded: `compiled` is a boolean in the schema, and here it is not.
      app.hook('onSerialize', (ctx, payload) =>
        ctx.path === '/json' ? { ...(payload as object), compiled: 'yes' } : payload)
      return app
    }, { config: { validation: { response: 'error' } } })
    const res = await t.get('/json')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_RESPONSE_INVALID')
    assert.equal((await t.get('/users/1')).status, 200, 'and only that response')
    await t.close()
  })
})
