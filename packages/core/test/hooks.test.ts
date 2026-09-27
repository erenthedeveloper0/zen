import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, UNAVAILABLE_PHASES, definePlugin, explainRoute, jsonSchema, steps, type Reply,
} from '@erenthedeveloper0/zen-core'
import { makeApp, schema } from './helpers.ts'

/**
 * The hook system — rfcs/0001 §9.
 *
 * Three things are being asserted here, and only the first is obvious:
 *
 *   1. every phase fires, with the documented signature, in the documented
 *      position;
 *   2. the ordering rules of §9.3 hold across all three scopes, *including* the
 *      mirror on the way out — the property that makes before/after pairs nest;
 *   3. a phase nobody used emits **no source text**, which is the claim §9.4
 *      makes and the reason the hook system is affordable at all. That one is
 *      checked against the generated code, not inferred from a benchmark.
 */

const Ok = jsonSchema<{ ok: boolean }>({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
})

const passthrough = <T>() => schema<T>((value) => ({ value: value as T }))

describe('phases (§9.2)', () => {
  test('all nine pipeline phases fire, in lifecycle order', async () => {
    const order: string[] = []
    const app = makeApp()

    app.hook('onRequest', () => { order.push('onRequest') })
    app.hook('onRoute', (_ctx: unknown, route: { path: string }) => { order.push(`onRoute:${route.path}`) })
    app.hook('onParse', () => { order.push('onParse') })
    app.hook('preValidation', () => { order.push('preValidation') })
    app.hook('postValidation', () => { order.push('postValidation') })
    app.hook('preHandler', () => { order.push('preHandler') })
    app.hook('postHandler', (_ctx: unknown, result: unknown) => {
      order.push(`postHandler:${JSON.stringify(result)}`)
    })
    app.hook('onSerialize', (_ctx: unknown, payload: unknown) => {
      order.push('onSerialize')
      return payload
    })
    app.hook('onSend', () => { order.push('onSend') })
    app.hook('onResponse', () => { order.push('onResponse') })

    app.use(() => { order.push('middleware') })
    app.after((_ctx, reply) => { order.push('after'); return reply })

    app.post('/echo', { body: passthrough<{ n: number }>(), response: { 200: Ok } }, () => {
      order.push('handler')
      return { ok: true }
    })

    const res = await app.inject('POST', '/echo', { body: { n: 1 } })
    assert.equal(res.status, 200)

    assert.deepEqual(order, [
      'onRequest',
      'onRoute:/echo',
      'middleware',
      'onParse',
      'preValidation',
      'postValidation',
      'preHandler',
      'handler',
      'postHandler:{"ok":true}',
      'after',
      'onSerialize',
      'onSend',
      'onResponse',
    ])
  })

  test('onParse supplies the parsed body and the default parser never runs', async () => {
    const app = makeApp()
    app.hook('onParse', async (ctx: { raw: { body: { read(n: number): Promise<Uint8Array> } } }) => {
      const bytes = await ctx.raw.body.read(1024)
      return { received: new TextDecoder().decode(bytes).split(',') }
    })
    app.post('/csv', { body: passthrough<{ received: string[] }>() }, (ctx) => ctx.body)

    const res = await app.inject('POST', '/csv', {
      body: 'a,b,c',
      headers: { 'content-type': 'text/csv' },
    })
    // Without the hook this is a 415: there is no `text/csv` parser registered.
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { received: ['a', 'b', 'c'] })
  })

  test('onParse does not run on a route that declares no body (§4.2 stage 6)', async () => {
    let ran = 0
    const app = makeApp()
    app.hook('onParse', () => { ran++; return { forced: true } })
    app.get('/none', () => ({ ok: true }))

    await app.inject('GET', '/none')
    assert.equal(ran, 0, 'a parse hook must not resurrect a stage the route does not have')
  })

  test('postHandler sees the handler result and may replace it', async () => {
    const app = makeApp()
    app.hook('postHandler', (ctx: { json(v: unknown, i?: unknown): Reply }, result: unknown) => {
      const value = result as { secret?: string }
      if (value.secret !== undefined) return ctx.json({ redacted: true }, { status: 200 })
      return undefined
    })
    app.get('/open', () => ({ fine: true }))
    app.get('/closed', () => ({ secret: 'hunter2' }))

    assert.deepEqual((await app.inject('GET', '/open')).json(), { fine: true })
    assert.deepEqual((await app.inject('GET', '/closed')).json(), { redacted: true })
  })

  test('onSerialize transforms the payload; onSend transforms the reply', async () => {
    const app = makeApp()
    app.hook('onSerialize', (_ctx: unknown, payload: unknown) => ({
      data: payload,
      meta: { version: 1 },
    }))
    app.hook('onSend', (_ctx: unknown, reply: Reply) => { reply.headers.set('x-enveloped', '1') })

    app.get('/thing', () => ({ id: 7 }))

    const res = await app.inject('GET', '/thing')
    assert.deepEqual(res.json(), { data: { id: 7 }, meta: { version: 1 } })
    assert.equal(res.header('x-enveloped'), '1')
  })

  test('onSerialize is skipped for bodies with no payload', async () => {
    let seen = 0
    const app = makeApp()
    app.hook('onSerialize', (_ctx: unknown, payload: unknown) => { seen++; return payload })
    app.get('/empty', (ctx) => ctx.empty(204))
    app.get('/stream', (ctx) => ctx.stream(async function* () { yield 'hi' }))

    await app.inject('GET', '/empty')
    await app.inject('GET', '/stream')
    assert.equal(seen, 0, 'a stream and a 204 have no structured value to hand a hook')
  })

  /**
   * The security property, stated as a test because it is the kind of thing
   * that quietly stops being true: the response contract is bound *after* the
   * transform hooks, so a hook cannot add a field the schema does not declare.
   */
  test('onSerialize cannot smuggle an undeclared field past the response schema (§13.3)', async () => {
    const app = makeApp()
    app.hook('onSerialize', (_ctx: unknown, payload: unknown) => ({
      ...(payload as object),
      internalDebugToken: 'must-not-ship',
    }))
    app.get('/guarded', { response: { 200: Ok } }, () => ({ ok: true }))

    const res = await app.inject('GET', '/guarded')
    assert.equal(res.text(), '{"ok":true}')
  })
})

describe('scoping and ordering (§9.3)', () => {
  test('pre-family runs outermost-first; post-family is the exact mirror', async () => {
    const order: string[] = []
    const mark = (label: string) => () => { order.push(label) }

    const app = makeApp()
    app.hook('onRequest', mark('in:global-a'))
    app.hook('onRequest', mark('in:global-b'))
    app.hook('onResponse', mark('out:global-a'))
    app.hook('onResponse', mark('out:global-b'))

    app.collection('/api', (api) => {
      api.hook('onRequest', mark('in:api'))
      api.hook('onResponse', mark('out:api'))

      api.collection('/v2', (v2) => {
        v2.hook('onRequest', mark('in:v2'))
        v2.hook('onResponse', mark('out:v2'))

        v2.get('/thing', {
          hooks: { onRequest: mark('in:route'), onResponse: mark('out:route') },
        }, () => ({ ok: true }))
      })
    })

    await app.inject('GET', '/api/v2/thing')

    assert.deepEqual(order, [
      'in:global-a', 'in:global-b', 'in:api', 'in:v2', 'in:route',
      // Total reversal, not merely innermost-scope-first: registering a pair
      // A then B on one scope must produce A,B in and B,A out, or before/after
      // does not nest.
      'out:route', 'out:v2', 'out:api', 'out:global-b', 'out:global-a',
    ])
  })

  test('a collection hook does not leak to sibling collections', async () => {
    const seen: string[] = []
    const app = makeApp()

    app.collection('/api', { hooks: { onRequest: () => { seen.push('api') } } }, (api) => {
      api.get('/inside', () => ({ ok: true }))
    })
    app.collection('/admin', (admin) => {
      admin.get('/outside', () => ({ ok: true }))
    })
    app.get('/root', () => ({ ok: true }))

    await app.inject('GET', '/api/inside')
    await app.inject('GET', '/admin/outside')
    await app.inject('GET', '/root')

    assert.deepEqual(seen, ['api'])
  })

  test('route-level hooks accept a list', async () => {
    const order: string[] = []
    const app = makeApp()
    app.get('/multi', {
      hooks: {
        onRequest: [
          () => { order.push('first') },
          () => { order.push('second') },
        ],
      },
    }, () => ({ ok: true }))

    await app.inject('GET', '/multi')
    assert.deepEqual(order, ['first', 'second'])
  })

  test('plugin hooks register at the global scope and are named after the plugin', async () => {
    const order: string[] = []
    const Timing = definePlugin({
      name: 'timing',
      version: '1.0.0',
      setup(app) {
        app.hook('onRequest', () => { order.push('plugin') })
      },
    })

    const app = makeApp()
    app.use(Timing)
    app.collection('/api', (api) => {
      api.hook('onRequest', () => { order.push('collection') })
      api.get('/x', () => ({ ok: true }))
    })

    await app.inject('GET', '/api/x')
    assert.deepEqual(order, ['plugin', 'collection'])

    const record = app.graph().routes[0]!
    assert.equal(record.hooks.get('onRequest')?.[0]?.name, 'timing')
    assert.equal(record.hooks.get('onRequest')?.[0]?.scope, 'root')
  })
})

describe('short-circuiting', () => {
  for (const phase of ['onRequest', 'onRoute', 'preValidation', 'postValidation', 'preHandler'] as const) {
    test(`${phase} may return a Reply, and the epilogue still runs`, async () => {
      const order: string[] = []
      const app = makeApp()

      app.hook(phase, (ctx: { json(v: unknown, i?: unknown): Reply }) => {
        order.push(phase)
        return ctx.json({ halted: phase }, { status: 418 })
      })
      app.hook('onSend', (_ctx: unknown, reply: Reply) => { order.push('onSend'); return reply })
      app.after((_ctx, reply) => { order.push('after'); return reply })
      app.get('/x', { query: passthrough<{}>() }, () => { order.push('handler'); return { ok: true } })

      const res = await app.inject('GET', '/x')
      assert.equal(res.status, 418)
      assert.deepEqual(res.json(), { halted: phase })
      assert.deepEqual(order, [phase, 'after', 'onSend'])
    })
  }
})

describe('the error path (§9.5, §4.6)', () => {
  test('onError runs innermost-first and the first Reply wins', async () => {
    const order: string[] = []
    const app = makeApp()

    app.hook('onError', () => { order.push('global') })
    app.collection('/api', (api) => {
      api.hook('onError', (ctx: { json(v: unknown, i?: unknown): Reply }, error: unknown) => {
        order.push('api')
        return ctx.json({ handled: (error as Error).message }, { status: 503 })
      })
      api.get('/boom', () => { throw new Error('db down') })
    })

    const res = await app.inject('GET', '/api/boom')
    assert.equal(res.status, 503)
    assert.deepEqual(res.json(), { handled: 'db down' })
    // Nearest-handler semantics: the outer hook never sees a handled error.
    assert.deepEqual(order, ['api'])
  })

  test('an onError hook that throws is logged, and the original error still reaches the client', async () => {
    const app = makeApp()
    app.hook('onError', () => { throw new Error('the reporter is broken too') })
    app.get('/boom', () => { throw new Error('original failure') })

    const res = await app.inject('GET', '/boom')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'ZEN_INTERNAL')
  })

  test('onSend runs on error replies; `after` middleware does not', async () => {
    const seen: string[] = []
    const app = makeApp()
    app.hook('onSend', (_ctx: unknown, reply: Reply) => {
      seen.push('onSend')
      reply.headers.set('x-request-cost', '3ms')
    })
    app.after((_ctx, reply) => { seen.push('after'); return reply })
    app.get('/boom', () => { throw new Error('nope') })

    const res = await app.inject('GET', '/boom')
    assert.equal(res.status, 500)
    assert.equal(res.header('x-request-cost'), '3ms')
    assert.deepEqual(seen, ['onSend'], '§4.6 — the error path never re-enters user middleware')
  })

  test('onResponse and onError still fire for a request that matched no route', async () => {
    const seen: Array<{ phase: string; status: number }> = []
    const app = makeApp()
    app.hook('onError', (_ctx: unknown, error: unknown) => {
      seen.push({ phase: 'onError', status: (error as { status: number }).status })
    })
    app.hook('onResponse', (_ctx: unknown, reply: Reply) => {
      seen.push({ phase: 'onResponse', status: reply.status })
    })
    app.get('/exists', () => ({ ok: true }))

    await app.inject('GET', '/nope')
    await app.inject('POST', '/exists')

    assert.deepEqual(seen, [
      { phase: 'onError', status: 404 },
      { phase: 'onResponse', status: 404 },
      { phase: 'onError', status: 405 },
      { phase: 'onResponse', status: 405 },
    ])
  })

  /**
   * The gap the observability example found.
   *
   * `onRequest` is the documented home for rate limiting, CORS and auth. If it
   * only ran on matched routes, every one of those would be bypassed by
   * requesting a path that does not exist — an attacker hammering `/nope` would
   * be invisible to the rate limiter. Only the *global* scope can apply: there
   * is no route, so there is no collection chain to inherit from.
   */
  test('global onRequest hooks run for unmatched requests, and may answer them', async () => {
    const seen: string[] = []
    const app = makeApp()

    let blocked = false
    app.hook('onRequest', (ctx: { path: string; json(v: unknown, i?: unknown): Reply }) => {
      seen.push(ctx.path)
      if (blocked) return ctx.json({ error: 'rate_limited' }, { status: 429 })
      return undefined
    })
    app.collection('/api', (api) => {
      api.hook('onRequest', () => { seen.push('collection-hook') })
      api.get('/known', () => ({ ok: true }))
    })

    await app.inject('GET', '/api/known')
    await app.inject('GET', '/definitely-not-here')
    await app.inject('POST', '/api/known')

    assert.deepEqual(seen, ['/api/known', 'collection-hook', '/definitely-not-here', '/api/known'])

    blocked = true
    const limited = await app.inject('GET', '/still-not-here')
    assert.equal(limited.status, 429, 'a global onRequest hook must be able to answer a 404 path')
    assert.deepEqual(limited.json(), { error: 'rate_limited' })
  })

  test('onResponse cannot fail the request', async () => {
    const app = makeApp()
    app.hook('onResponse', () => { throw new Error('metrics sink is down') })
    app.get('/x', () => ({ ok: true }))

    const res = await app.inject('GET', '/x')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { ok: true })
  })

  test('onResponse observes the reply as the wire will carry it', async () => {
    let observed: string | undefined
    const app = makeApp()
    app.hook('onResponse', (_ctx: unknown, reply: Reply) => {
      observed = reply.headers.get('content-type')
    })
    app.get('/x', () => ({ ok: true }))

    await app.inject('GET', '/x')
    assert.equal(observed, 'application/json; charset=utf-8')
  })
})

describe('cost (§9.4)', () => {
  test('a phase with no hooks emits no source text at all', async () => {
    const app = makeApp({ dev: true })
    app.get('/bare', () => ({ ok: true }))
    await app.ready()

    const source = app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''
    assert.ok(source.length > 0, 'expected a generated pipeline')
    assert.ok(!source.includes('d.hooks'), `hook machinery leaked into a hookless route:\n${source}`)
  })

  test('a route pays only for the hooks that reach it', async () => {
    const app = makeApp({ dev: true })
    app.collection('/instrumented', (c) => {
      c.hook('onRequest', function trace() {})
      c.hook('onSend', function stamp() {})
      c.get('/x', () => ({ ok: true }))
    })
    app.get('/plain', () => ({ ok: true }))
    await app.ready()

    const units = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
    const instrumented = units.find((u) => u.name.includes('instrumented'))?.source ?? ''
    const plain = units.find((u) => u.name.includes('plain'))?.source ?? ''

    assert.ok(instrumented.includes('d.hooks.onRequest[0]'))
    assert.ok(instrumented.includes('d.hooks.onSend[0]'))
    assert.ok(!plain.includes('d.hooks'), 'a sibling route inherited hook code it can never run')
  })
})

describe('availability (§9.7)', () => {
  test('registering a hook for a phase that cannot fire is a boot error', async () => {
    const app = makeApp()
    app.hook('onRegister', function watchPlugins() {})
    app.get('/x', () => ({ ok: true }))

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const codes = error.diagnostics.map((d) => d.code)
    assert.ok(codes.includes('ZEN_HOOK_PHASE_UNAVAILABLE'))
    assert.match(error.message, /watchPlugins/)
    assert.match(error.message, /onRegister/)
  })

  /**
   * `onTimeout` used to be in this table and is not any more, which is the
   * whole reason the table is data.
   *
   * The §9.7 claim was that when the timeout arm landed, one map entry would be
   * deleted and the diagnostic would disappear — no message to go and find, no
   * `if` to remember. This asserts that it actually did, because "the
   * diagnostic disappears on its own" is only true until someone hard-codes a
   * phase name somewhere else.
   */
  test('onTimeout is live now that the deadline arm exists (§4.4)', async () => {
    const app = makeApp()
    app.hook('onTimeout', function reportTimeout() {})
    app.get('/x', () => ({ ok: true }))

    await app.ready()
    assert.deepEqual([...UNAVAILABLE_PHASES.keys()], ['onRegister'])
  })
})

describe('explainRoute (§8.5)', () => {
  test('the printed chain is the order the steps actually ran in', async () => {
    const order: string[] = []
    const named = (label: string) => {
      const fn = () => { order.push(label) }
      Object.defineProperty(fn, 'name', { value: label })
      return fn
    }

    const app = makeApp()
    app.hook('onRequest', named('requestId'))
    app.use(named('cors'), { name: 'cors' })
    app.after((_ctx, reply) => { order.push('auditLog'); return reply }, { name: 'auditLog' })
    app.hook('onSend', named('compress'))
    app.hook('onResponse', named('metrics'))

    app.collection('/api', (api) => {
      api.hook('preHandler', named('authorize'))
      api.post('/users', {
        name: 'users.create',
        body: passthrough<{ n: number }>(),
        response: { 200: Ok },
        hooks: { postHandler: named('cacheWrite') },
      }, function createUser() {
        order.push('createUser')
        return { ok: true }
      })
    })

    await app.inject('POST', '/api/users', { body: { n: 1 } })

    const record = app.graph().routes[0]!
    const printed = steps(record)
      .filter((step) => !['intake', 'validate', 'serialize'].includes(step.kind))
      .map((step) => step.name)

    assert.deepEqual(printed, order)

    // And the human-readable form carries the provenance, which is the half
    // that makes it useful on an unfamiliar codebase.
    const text = explainRoute(record)
    assert.match(text, /POST \/api\/users\s+→ users\.create/)
    assert.match(text, /onRequest\s+\[global\]\s+requestId/)
    assert.match(text, /preHandler\s+\[root\/api\]\s+authorize/)
    assert.match(text, /postHandler\s+\[route\]\s+cacheWrite/)
    assert.match(text, /handler\s+createUser/)
  })
})
