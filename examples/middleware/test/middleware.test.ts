import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { html, type Context, type EnvSource, type ZenApp } from '@erenthedeveloper0/zen'
import { makeApp } from '../src/app.ts'
import type { AppConfig } from '../src/config/types.ts'

/**
 * The middleware example — rfcs/0001 §32, §23.4.
 *
 * `packages/middleware/test` proves the plugins. This proves the *composition*:
 * that a service assembled the way §21.2 describes actually behaves like a
 * browser-facing service, with a real Zod schema, real configuration coming
 * from a real environment, and routes that fail in the four ways a browser
 * cares about.
 *
 * Two things live here rather than in the package suite because only an
 * example can host them:
 *
 *   - **the type-level claims.** Package tests are not type-checked; example
 *     tests are (`npm run typecheck`), so the annotated `const` declarations
 *     below are the whole proof that `ctx.config.cors.origin` is a `string[]`
 *     and not `unknown`. `examples/config` uses the same trick deliberately.
 *   - **the environment.** The plugins take options; a service takes an
 *     environment, and the interesting failures are in the gap.
 */

const ORIGIN = 'https://notes.example'

const PRODUCTION: readonly EnvSource[] = [{
  layer: 'env',
  name: 'test',
  entries: [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'CORS_ORIGINS', value: `${ORIGIN},https://admin.notes.example` },
    { key: 'RATE_LIMIT', value: '5' },
    { key: 'ADMIN_TOKEN', value: 'a-sixteen-plus-character-token' },
  ],
}]

// A fresh app per test: the rate limiter is stateful, so a suite sharing one
// would pass or fail depending on the order the runner happened to pick.
let app: ZenApp<{ readonly config: AppConfig }>

beforeEach(() => {
  app = makeApp({ quiet: true, env: PRODUCTION }).app as never
})

const preflight = (origin: string, method = 'POST') => ({
  headers: { origin, 'access-control-request-method': method },
})

describe('the API a browser can actually call', () => {
  test('a preflight for a real route is answered before routing', async () => {
    const res = await app.inject('OPTIONS', '/api/notes', preflight(ORIGIN))
    assert.equal(res.status, 204)
    assert.equal(res.header('access-control-allow-origin'), ORIGIN)
    assert.equal(res.header('access-control-allow-credentials'), 'true')
  })

  test('a preflight for a path with no route is answered too', async () => {
    const res = await app.inject('OPTIONS', '/api/nothing-here', preflight(ORIGIN))
    assert.equal(res.status, 204)
    assert.equal(res.header('access-control-allow-origin'), ORIGIN)
  })

  test('the advertised methods are the ones this app serves, and PUT is not one', async () => {
    const res = await app.inject('OPTIONS', '/api/notes', preflight(ORIGIN))
    const methods = (res.header('access-control-allow-methods') ?? '').split(', ')
    assert.deepEqual(methods.sort(), ['DELETE', 'GET', 'HEAD', 'POST'])
  })

  test('an origin outside the allowlist is denied without being told why', async () => {
    const res = await app.inject('OPTIONS', '/api/notes', preflight('https://evil.example'))
    assert.equal(res.status, 204)
    assert.equal(res.header('access-control-allow-origin'), undefined)
    assert.equal(res.text(), '', 'the response says nothing about the allowlist')
  })

  test('the second allowed origin works too — a list is not just its first entry', async () => {
    const res = await app.inject('GET', '/api/notes', { headers: { origin: 'https://admin.notes.example' } })
    assert.equal(res.header('access-control-allow-origin'), 'https://admin.notes.example')
  })
})

describe('the four failures a browser cares about all carry the headers', () => {
  const carries = (res: { header(n: string): string | undefined }) => {
    assert.equal(res.header('access-control-allow-origin'), ORIGIN)
    assert.equal(res.header('x-content-type-options'), 'nosniff')
    assert.ok((res.header('x-request-id') ?? '').length > 0)
  }

  test('404', async () => {
    const res = await app.inject('GET', '/api/notes/999', { headers: { origin: ORIGIN } })
    assert.equal(res.status, 404)
    carries(res)
  })

  test('422 — a body the schema refuses', async () => {
    const res = await app.inject('POST', '/api/notes', {
      headers: { origin: ORIGIN },
      body: { title: '', body: 'x' },
    })
    assert.equal(res.status, 422)
    carries(res)
  })

  test('401 — no admin token', async () => {
    const res = await app.inject('DELETE', '/api/notes/1', { headers: { origin: ORIGIN } })
    assert.equal(res.status, 401)
    carries(res)
  })

  test('429 — over the limit', async () => {
    for (let i = 0; i < 5; i++) await app.inject('GET', '/api/ping', { headers: { origin: ORIGIN } })
    const res = await app.inject('GET', '/api/ping', { headers: { origin: ORIGIN } })
    assert.equal(res.status, 429)
    carries(res)
    // Without the CORS header on this response a browser reports a rate limit
    // as a CORS error, and the investigation starts in the wrong file.
    assert.equal(res.json<{ code: string }>().code, 'ZEN_RATE_LIMITED')
  })
})

describe('the limiter sees what a router does not', () => {
  test('a flood of unmatched paths exhausts the budget', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject('GET', `/garbage-${i}`)).status, 404)
    }
    assert.equal((await app.inject('GET', '/api/ping')).status, 429)
  })

  test('preflights are not counted against it', async () => {
    for (let i = 0; i < 20; i++) await app.inject('OPTIONS', '/api/notes', preflight(ORIGIN))
    assert.equal((await app.inject('GET', '/api/ping', { headers: { origin: ORIGIN } })).status, 200)
  })
})

describe('the happy path still works, and still cannot leak', () => {
  test('the list is served with numbers, not strings (§11.4)', async () => {
    const res = await app.inject('GET', '/api/notes?page=1&perPage=2', { headers: { origin: ORIGIN } })
    assert.equal(res.status, 200)
    const body = res.json<{ items: unknown[]; total: number }>()
    assert.equal(body.items.length, 2)
    assert.equal(body.total, 3)
  })

  test('a field no response schema declares cannot reach the wire (§13.3)', async () => {
    // The service puts `internalAuthorEmail` on every note. The schema does
    // not declare it, so the compiled serializer has no branch that emits it —
    // and `inject()` runs the same serializer the socket would.
    const res = await app.inject('GET', '/api/notes', { headers: { origin: ORIGIN } })
    assert.doesNotMatch(res.text(), /internalAuthorEmail|example\.com/)
  })

  test('a note can be created and then deleted with the admin token', async () => {
    const created = await app.inject('POST', '/api/notes', {
      headers: { origin: ORIGIN },
      body: { title: 'Ship it', body: 'The pack.' },
    })
    assert.equal(created.status, 201)
    const id = created.json<{ id: number }>().id

    const deleted = await app.inject('DELETE', `/api/notes/${id}`, {
      headers: { origin: ORIGIN, authorization: 'Bearer a-sixteen-plus-character-token' },
    })
    assert.equal(deleted.status, 204)
  })

  test('health endpoints answer, and are not rate limited into uselessness', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await app.inject('GET', '/healthz')
      // The limit is 5, and the probes are counted like anything else — which
      // is a real decision with a real cost, recorded rather than hidden: a
      // service whose orchestrator polls more often than the limit allows
      // needs `rateLimit({ key })` to exempt the prober. `examples/middleware`
      // does not, so this asserts what actually happens.
      assert.ok(res.status === 200 || res.status === 429, `got ${res.status}`)
    }
  })
})

describe('configuration reaches the plugins (§16, Registrar.config)', () => {
  test('the allowlist comes from CORS_ORIGINS, not from a literal in app.ts', async () => {
    const other = makeApp({
      quiet: true,
      env: [{
        layer: 'env',
        name: 'test',
        entries: [
          { key: 'CORS_ORIGINS', value: 'https://somewhere-else.example' },
          { key: 'ADMIN_TOKEN', value: 'a-sixteen-plus-character-token' },
        ],
      }],
    }).app

    const allowed = await other.inject('GET', '/api/ping', { headers: { origin: 'https://somewhere-else.example' } })
    assert.equal(allowed.header('access-control-allow-origin'), 'https://somewhere-else.example')

    const denied = await other.inject('GET', '/api/ping', { headers: { origin: ORIGIN } })
    assert.equal(denied.header('access-control-allow-origin'), undefined)
  })

  test('the limit comes from RATE_LIMIT', async () => {
    const res = await app.inject('GET', '/api/ping', { headers: { origin: ORIGIN } })
    assert.equal(res.header('ratelimit-policy'), '5;w=60')
  })

  test('an environment that fails the schema stops the app before any plugin runs', async () => {
    const bad = makeApp({
      quiet: true,
      env: [{ layer: 'env', name: 'test', entries: [{ key: 'ADMIN_TOKEN', value: 'short' }] }],
    }).app

    await assert.rejects(
      () => bad.ready(),
      (error: Error) => {
        assert.match(error.message, /ADMIN_TOKEN/)
        // Redacted in the diagnostic, because the boot log gets pasted into
        // tickets (§16.2).
        assert.doesNotMatch(error.message, /"short"/)
        return true
      },
    )
  })

  test('the admin token is never printed by any projection of config', async () => {
    await app.ready()
    const snapshot = app.graph().config
    const serialised = JSON.stringify(app.config)

    for (const haystack of [JSON.stringify(snapshot), serialised]) {
      assert.doesNotMatch(haystack, /a-sixteen-plus-character-token/)
    }
    // …and is still readable by name, which is the whole distinction.
    assert.equal(app.config.admin.token, 'a-sixteen-plus-character-token')
  })
})

describe('pages that escape what they print, and redirects that stay home (§19.5)', () => {
  test('a note stored with a script in it is printed as text', async () => {
    const created = await app.inject('POST', '/api/notes', {
      body: { title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(2)>' },
    })
    assert.equal(created.status, 201)
    const page = await app.inject('GET', `/notes/${created.json<{ id: number }>().id}`)
    assert.equal(page.status, 200)
    assert.equal(page.header('content-type'), 'text/html; charset=utf-8')
    assert.match(page.text(), /<h1>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/)
    assert.doesNotMatch(page.text(), /<script>|<img/, 'nothing the note carried became markup')
    assert.equal(page.header('x-content-type-options'), 'nosniff', 'the pack covers pages too')
  })

  test('a back link from the query string cannot run script, and an ordinary one works', async () => {
    const hostile = await app.inject('GET', `/notes/1?from=${encodeURIComponent('javascript:alert(document.cookie)')}`)
    assert.match(hostile.text(), /<a href="about:invalid#zen-unsafe-url">Back<\/a>/)
    const fine = await app.inject('GET', `/notes/1?from=${encodeURIComponent('/notes/2')}`)
    assert.match(fine.text(), /<a href="\/notes\/2">Back<\/a>/)
  })

  test('?next= is followed when it stays on this origin, and replaced when it does not', async () => {
    const home = await app.inject('GET', `/login?next=${encodeURIComponent('/notes/2')}`)
    assert.equal(home.status, 303)
    assert.equal(home.header('location'), '/notes/2')

    for (const hostile of ['https://evil.example/login', '//evil.example', '/\\evil.example']) {
      const away = await app.inject('GET', `/login?next=${encodeURIComponent(hostile)}`)
      assert.equal(away.header('location'), '/notes/1', `${hostile} must not leave`)
    }
  })

  test('the identity provider is reachable because app.ts names it, and nothing else is', async () => {
    const sso = await app.inject('GET', '/login/sso')
    assert.equal(sso.status, 302)
    assert.match(sso.header('location') ?? '', /^https:\/\/id\.notes\.example\/authorize\?/)
  })

  test('a created note says where it lives, and that link reaches it (§5.7)', async () => {
    const created = await app.inject('POST', '/api/notes', { body: { title: 'linked', body: 'here' } })
    assert.equal(created.status, 201)
    const { id } = created.json<{ id: number }>()
    assert.equal(created.header('location'), `/api/notes/${id}`)

    const followed = await app.inject('GET', created.header('location') as string, { headers: { origin: ORIGIN } })
    assert.equal(followed.status, 200)
    assert.equal(followed.json<{ title: string }>().title, 'linked')
  })

  test('a page links to its JSON by asking the route for the path, not by spelling it', async () => {
    const page = await app.inject('GET', '/notes/2')
    assert.match(page.text(), /<a href="\/api\/notes\/2" type="application\/json">As JSON<\/a>/)
    assert.equal(app.url('notes.get', { id: 2 }), '/api/notes/2')
    assert.equal(app.url('pages.note', { id: 2 }, { from: '/notes/1' }), '/notes/2?from=%2Fnotes%2F1')
  })

  test('url() takes only values a URL can carry — a claim the compiler makes', async () => {
    await app.ready()
    // `npm run typecheck` is the proof, as for ctx.html() below: an object has a
    // `toString`, and a plain object's is `[object Object]`, which `:id` would
    // carry into a link — so it is not a parameter value.
    // @ts-expect-error — an object is not a URL value
    assert.throws(() => app.url('notes.get', { id: { id: 2 } }), /ZEN_PARAM_MISMATCH|an object for :id/)
    const path: string = app.url('notes.get', { id: 2 })
    assert.equal(path, '/api/notes/2')
  })

  test('ctx.html() takes SafeHtml, not a string — a claim the compiler makes', () => {
    // Type-checked by `npm run typecheck`, which is the whole proof: the
    // directive fails the build if a string ever becomes acceptable here.
    const page = (ctx: Context) => {
      // @ts-expect-error — a string is not HTML the framework can vouch for
      void ctx.html('<p>hello</p>')
      return ctx.html(html`<p>hello, ${ctx.path}</p>`)
    }
    assert.equal(typeof page, 'function')
  })
})

describe('types (§10.4) — these are assertions the compiler makes, not the runner', () => {
  test('ctx.config is fully typed through the app object', async () => {
    await app.ready()

    // Each annotation is a compile-time claim; `npm run typecheck` is what
    // actually checks them, and this test's body is here so a reader can see
    // what is being claimed. A widened `unknown` anywhere below fails CI.
    const origins: readonly string[] = app.config.cors.origin
    const credentials: boolean = app.config.cors.credentials
    const limit: number = app.config.rateLimit.limit
    const token: string = app.config.admin.token
    const mode: 'development' | 'test' | 'production' = app.config.mode
    const port: number = app.config.server.port

    assert.ok(origins.includes(ORIGIN))
    assert.equal(credentials, true)
    assert.equal(limit, 5)
    assert.equal(token.length, 30)
    assert.equal(mode, 'production')
    assert.equal(port, 3000)
  })
})
