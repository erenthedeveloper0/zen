/**
 * End-to-end smoke test over a real socket.
 *
 * `inject()` proves the pipeline; this proves the Node adapter, the wire
 * format, and graceful shutdown. Run: `node scripts/smoke.ts`
 */
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import {
  zen, slot, NotFound, jsonSchema, healthPlugin, nodeAdapter, defineConfig, registerMediaEncoder, html,
} from '@erenthedeveloper0/zen'
import { cors, rateLimit, requestId, securityHeaders } from '@erenthedeveloper0/zen-middleware'
import { openapiPlugin } from '@erenthedeveloper0/zen-openapi'

const CurrentUser = slot<{ id: number; name: string }>('smoke.user')

/** §13.3 — the security property has to hold on the wire, not just in inject(). */
const PublicUser = jsonSchema<{ id: number; name: string }>({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
})

// §4.4 — a default budget, and an inbound header that may only shorten it.
// A real socket is the only place a deadline is honestly under test: what has
// to hold is that the *connection* is released on time, and `inject()` has no
// connection to release.
// §4.5 — a real drain window. `readiness reports draining before the server
// stops accepting` is the claim the whole health feature exists for, and it is
// unfalsifiable without a socket that is still open while the flag is already
// red. `inject()` can observe the flag; only this can observe the ordering.
const DRAIN_MS = 300

const app = zen({
  logger: quiet(),
  timeout: { default: '30s', header: 'x-request-timeout' },
  adapter: nodeAdapter({ drainDelay: DRAIN_MS }),
  // ttl 0 so each poll re-probes: the smoke test flips a dependency and expects
  // the very next request to see it, which a cache would (correctly) prevent.
  health: { ttl: 0, details: true },

  // §16 — a configuration with a secret in it, resolved from an explicit
  // environment rather than from this process's own, so the check below is the
  // same on every machine.
  config: defineConfig({
    secrets: ['database.url'],
    service: (env) => env['SERVICE_NAME'] ?? 'unnamed',
    database: { url: (env) => env['DATABASE_URL'] ?? '', pool: 4 },
  }),
  env: [{
    layer: 'env',
    name: 'smoke',
    entries: [
      { key: 'SERVICE_NAME', value: 'smoke' },
      { key: 'DATABASE_URL', value: 'postgres://user:hunter2@db/app' },
    ],
  }],
})

// §31.4 — two endpoints, two questions. Registered here rather than only in
// `inject()` tests because the behaviour under test is a deployment behaviour:
// what an orchestrator sees, over HTTP, while the process is shutting down.
app.use(healthPlugin, { checks: ['smoke.db'], info: { service: 'smoke' } })

let dbFault: 'ok' | 'hang' = 'ok'
app.health('smoke.db', async (signal) => {
  if (dbFault === 'ok') return { status: 'pass' as const, message: 'select 1' }
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}, { timeout: '150ms', description: 'the fake primary' })

// §29 — the document and the viewer are ordinary routes, so they belong in the
// suite that proves the adapter and the wire format rather than only in inject().
app.use(openapiPlugin, { title: 'Zen smoke', version: '0.0.0' })

// §9 — the hook system over a real socket. `inject()` never touches egress, so
// the one phase it cannot honestly exercise is the one that runs after the last
// byte is flushed.
const settled: Array<{ route: string; status: number; afterFlush: boolean }> = []

app.hook('onRequest', function stampStart(ctx) {
  ;(ctx as unknown as { $smokeStart: number }).$smokeStart = performance.now()
})
app.hook('onSend', function stampTiming(ctx, reply) {
  reply.headers.set('x-zen-phase', 'onSend')
  reply.headers.set(
    'server-timing',
    `total;dur=${(performance.now() - (ctx as unknown as { $smokeStart: number }).$smokeStart).toFixed(3)}`,
  )
})
app.hook('onResponse', function record(ctx, reply) {
  settled.push({
    route: (ctx as unknown as { route: { path: string } | null }).route?.path ?? '<unmatched>',
    status: reply.status,
    afterFlush: true,
  })
})

// §9.2 phase 12 — the phase that was a boot error until the deadline arm of
// §4.4 existed. Registering it at all is the assertion; `stage` is the thing
// only a compiled pipeline can report, because it marked the boundary on the
// way past.
const blown: Array<{ route: string | null; stage: string }> = []
app.hook('onTimeout', function recordTimeout(_ctx, info) {
  blown.push({ route: info.route, stage: info.stage })
})

app.use(function attachUser(ctx) {
  ctx.set(CurrentUser, { id: 1, name: 'ada' })
})

app.around(async function timing(_ctx, next) {
  return next()
})

app.get('/', () => 'Hello world')
app.get('/json', () => ({ framework: 'zen' }))
app.get('/users/:id<int>', (ctx) => {
  if (ctx.params.id !== 1) throw new NotFound(`User ${ctx.params.id} not found`)
  return ctx.get(CurrentUser)
})
app.get('/search', (ctx) => ({ q: ctx.query['q'] ?? null }))

// §11.4 — coercion, on the wire.
//
// `inject()` covers the conversions; one thing here it genuinely cannot. Node
// folds repeated request headers into a single comma-joined value before any
// framework sees them, so "two `x-tags` headers arrive as a two-element array"
// is a claim about the *adapter's* header view, and the only way to make it is
// to have a real client send two of them.
//
// The schema is hand-written for the same reason `PublicUser` above is: it has
// to both describe a shape and validate one, and dragging a schema library into
// the smoke test would test the library rather than the wire.
const CatalogQuery = shaped({
  type: 'object',
  properties: {
    page: { type: 'integer' },
    active: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    zip: { type: 'string' },
  },
})
const TagHeaders = shaped({
  type: 'object',
  properties: { 'x-tags': { type: 'array', items: { type: 'string' } } },
})

app.get('/catalog', { query: CatalogQuery }, (ctx) => ctx.query as never)
app.get('/tagged', { headers: TagHeaders }, (ctx) => ({ tags: (ctx.headers as Record<string, unknown>)['x-tags'] ?? null }))
app.get('/profile', { response: { 200: PublicUser } }, () => ({
  id: 1,
  name: 'ada',
  passwordHash: '$2b$12$must-not-ship',
  stripeCustomerId: 'cus_must_not_ship',
}) as never)
app.get('/boom', () => { throw new Error('secret internals') })

// §19.5 — the injection defences, on the wire. What a browser receives is the
// claim: the escaped page as the body a socket carries, and — for the redirect
// — a `Location` header a real client would follow, or none at all.
app.get('/page', (ctx) => html`<p>${ctx.query['name'] ?? ''}</p><a href="${ctx.query['back'] ?? '/'}">back</a>`)
app.get('/go', (ctx) => ctx.redirect(String(ctx.query['to'] ?? '/')))

// §5.7 — a link the app builds to itself, followed over TCP. `inject()` hands
// the router a string; here llhttp parses the request line first, so this is
// where an encoding Node refused, or a target it rewrote, would show — and the
// redirect is followed by `fetch`, the way a browser follows `Location`.
app.get('/link/:name', { name: 'smoke.link' }, (ctx) => ({ name: ctx.params.name, query: ctx.query }))
app.get('/tree/*path', { name: 'smoke.tree' }, (ctx) => ({ path: ctx.params.path }))
app.get('/linked', (ctx) => ctx.redirect(app.url('smoke.link', { name: 'redirected here' }, { via: 'url()' }), 303))

// §13.4 — content negotiation, over a real socket.
//
// `inject()` covers the matching. What it cannot cover is the thing that went
// wrong the last time a subsystem added a response header: `Vary` is a
// *repeated* header on the wire and `InjectedResponse` used to keep one value
// of it (§32.5). Negotiation stages `Vary: Accept` on every response of a
// negotiated route, and on this route CORS is also staging `Vary: Origin` — so
// the two must accumulate rather than overwrite, and only a socket can say.
//
// The CSV encoder is registered inline for the same reason the schemas here are
// hand-written: pulling a real one in would test the encoder rather than the
// wire.
const ReportRow = jsonSchema<Array<{ id: number; name: string }>>({
  type: 'array',
  items: {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id', 'name'],
  },
})

registerMediaEncoder('text/csv', (schema) => {
  const items = schema?.['items'] as Record<string, unknown> | undefined
  const columns = Object.keys((items?.['properties'] ?? {}) as Record<string, unknown>)
  return (value) => {
    const rows = value as Array<Record<string, unknown>>
    return [columns.join(','), ...rows.map((r) => columns.map((c) => String(r[c] ?? '')).join(','))].join('\n')
  }
})

app.get('/report', {
  response: { 200: { 'application/json': ReportRow, 'text/csv': ReportRow } },
}, () => [{ id: 1, name: 'ada', passwordHash: '$2b$12$must-not-ship' }] as never)

/** The plain form, for the zero-cost contrast — no `Vary`, `Accept` ignored. */
app.get('/report-json-only', { response: { 200: ReportRow } }, () => [{ id: 1, name: 'ada' }] as never)

// §4.4 — a handler that never returns. Without a deadline this holds its socket
// until the process dies, which is the hole the arm exists to close, and the
// only honest way to see it closed is to hold a real socket and watch it come
// back. The route's own budget is short so the suite does not wait 30 seconds.
app.get('/hang', { timeout: '120ms' }, async (ctx) => {
  await new Promise((resolve) => { ctx.signal.addEventListener('abort', resolve, { once: true }) })
  return { neverSent: true }
})
// The one an inbound header shortens — the caller's budget wins because it is
// smaller, and only because it is smaller.
app.get('/patient', { timeout: '30s' }, async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 400))
  return { left: Math.round(ctx.timeLeft) }
})
app.get('/stream', (ctx) =>
  ctx.stream(async function* () {
    for (let i = 1; i <= 3; i++) yield `chunk ${i}\n`
  }, { media: 'text/plain' }))
app.collection('/api', (api) => api.get('/health', () => ({ ok: true })))

// §4.4 — a request body, under the app's 30 s default deadline, over a socket.
// For eight passes this file never sent a body, and that is how every POST on a
// bounded route came to be answered 499: Node closes an IncomingMessage once
// its body is read, the adapter took that for a disconnect, and the stage check
// after intake abandoned the request. `inject()` could not see it.
const AnyBody = { '~standard': { version: 1 as const, vendor: 'smoke', validate: (value: unknown) => ({ value }) } }
app.post('/echo', { body: AnyBody }, (ctx) => ({ echo: ctx.body, aborted: ctx.signal.aborted }))

// §13.5 — server-sent events and files, which only an adapter can write.
app.get('/events', (ctx) => {
  const sse = ctx.sse({ retry: 1000, keepAlive: 0 })
  sse.send({ event: 'hello', id: '1', data: { n: 1 } })
  sse.close()
  return sse
})
app.get('/file', (ctx) => ctx.file(fileURLToPath(import.meta.url)))
app.get('/file-missing', (ctx) => ctx.file('this-file-does-not-exist.txt', { root: dirname(fileURLToPath(import.meta.url)) }))

// §16 — configuration, on the wire.
//
// The leak check here is the sibling of `/profile` above and belongs in the
// same suite for the same reason: `JSON.stringify(config)` redacting is a claim
// about what a real response body contains, and the response body is produced
// by the response engine, not by `inject()`'s convenience wrapper. A handler
// that returns `ctx.config` is not a thing anyone should write — which is
// exactly why it has to be safe.
app.get('/config', (ctx) => (ctx as never as { config: unknown }).config as never)

// §32 — the first-party middleware pack, on the wire.
//
// `inject()` covers the protocol thoroughly. Three things here it cannot:
//
//   - **`Vary` is a repeated header.** `SmallHeaderBag` stores multi-value
//     names as an array and `entries()` flattens them into one line each, so
//     "a preflight varies on three things" is a claim about what the *socket*
//     carries. `InjectedResponse.headers` is `Object.fromEntries`, which keeps
//     the last of them — a test written against it would have asserted a third
//     of the truth and passed.
//   - **A preflight is a method a real client sends.** `OPTIONS` with
//     `Access-Control-Request-Method` reaching an app with no `OPTIONS` route
//     is the exact shape the design exists for, and it is worth seeing it come
//     back over TCP once.
//   - **A 429 is a response an operator reads in a terminal.** It has to carry
//     `Retry-After`, the CORS headers and the security headers all at once,
//     and each of those is staged by a different plugin at a different point.
//
// The limiter is keyed so that only `/limited` counts. Every other check in
// this file shares one client address, and a limiter that saw them would make
// the suite's result depend on the order the checks are written in.
app.use(securityHeaders({ hsts: { maxAge: 63_072_000, includeSubDomains: true } }))
app.use(cors({ origin: ['https://smoke.example'], credentials: true, exposedHeaders: ['x-zen-phase'] }))
app.use(requestId())
app.use(rateLimit({ limit: 2, window: '1m', key: (ctx) => (ctx.path === '/limited' ? 'smoke' : null) }))
app.get('/limited', () => ({ ok: true }))

const handle = await app.listen({ port: 0 })
const base = handle.url

let failures = 0

async function check(
  name: string,
  path: string,
  expect: { status: number; body?: string | RegExp; init?: RequestInit; header?: [string, RegExp] },
) {
  const res = await fetch(base + path, expect.init)
  const text = await res.text()
  const statusOk = res.status === expect.status
  const bodyOk =
    expect.body === undefined ? true :
    typeof expect.body === 'string' ? text === expect.body : expect.body.test(text)
  const headerOk =
    expect.header === undefined ? true : expect.header[1].test(res.headers.get(expect.header[0]) ?? '')

  if (statusOk && bodyOk && headerOk) {
    console.log(`  ✔ ${name.padEnd(34)} ${res.status}  ${truncate(text)}`)
  } else {
    failures++
    const detail = headerOk
      ? `got ${res.status} ${JSON.stringify(text)}, expected ${expect.status} ${String(expect.body)}`
      : `header ${expect.header?.[0]} was ${JSON.stringify(res.headers.get(expect.header?.[0] ?? ''))}`
    console.log(`  ✖ ${name.padEnd(34)} ${detail}`)
  }
}

console.log(`\n  zen smoke test — ${base}\n`)

await check('GET /', '/', { status: 200, body: 'Hello world' })
await check('GET /json', '/json', { status: 200, body: '{"framework":"zen"}' })
await check('GET /users/1', '/users/1', { status: 200, body: /"name":"ada"/ })
await check('GET /users/2 (typed 404)', '/users/2', { status: 404, body: /User 2 not found/ })
await check('GET /users/abc (type mismatch)', '/users/abc', { status: 404 })
await check('GET /search?q=hi', '/search?q=hi', { status: 200, body: '{"q":"hi"}' })
await check('GET /catalog (§11.4 on the wire)', '/catalog?page=2&active=yes&tags=a', {
  status: 200,
  body: '{"page":2,"active":true,"tags":["a"]}',
})
await check('GET /catalog (a declared string keeps its zeros)', '/catalog?zip=01234', {
  status: 200,
  body: '{"zip":"01234"}',
})
await check('GET /catalog (the schema reports what would not convert)', '/catalog?page=banana', {
  status: 400,
  body: /"code":"ZEN_VALIDATION".*"path":\["page"\]/s,
})
// The socket-only one: two headers, folded by Node, recovered by the profile.
await check('GET /tagged (two headers → one list)', '/tagged', {
  status: 200,
  body: '{"tags":["a","b"]}',
  init: { headers: [['x-tags', 'a'], ['x-tags', 'b']] as unknown as HeadersInit },
})
await check('GET /api/health', '/api/health', { status: 200, body: '{"ok":true}' })
await check('POST /echo (body, 30 s deadline)', '/echo', {
  status: 200,
  body: '{"echo":{"sku":"x"},"aborted":false}',
  init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sku":"x"}' },
})
await check('GET /events (§13.5 SSE)', '/events', {
  status: 200,
  body: 'retry: 1000\n\nevent: hello\nid: 1\ndata: {"n":1}\n\n',
  header: ['content-type', /^text\/event-stream/],
})
await check('GET /file (§13.5, typed and sized)', '/file', {
  status: 200,
  body: /End-to-end smoke test over a real socket/,
  header: ['etag', /^W\/"/],
})
await check('GET /file-missing (404, not a dropped socket)', '/file-missing', {
  status: 404,
  body: /ZEN_NOT_FOUND/,
})
await check('GET /config (§16 public values)', '/config', {
  status: 200,
  body: /"service":"smoke".*"pool":4/s,
})
// The sibling of the `/profile` leak check. A handler returning `ctx.config` is
// not something anyone should write, which is precisely why it has to be safe:
// the redaction has to survive the response engine, not just `JSON.stringify`
// in a unit test.
await check('GET /config (no secret on the wire)', '/config', {
  status: 200,
  body: /^(?!.*hunter2).*"url":"\*{8}"/s,
})
await check('GET /profile (no leak)', '/profile', { status: 200, body: '{"id":1,"name":"ada"}' })
await check('GET /stream', '/stream', { status: 200, body: 'chunk 1\nchunk 2\nchunk 3\n' })
await check('GET /boom (no leak)', '/boom', { status: 500, body: /^(?!.*secret internals).*ZEN_INTERNAL/s })
await check('GET /page (§19.5 escaped)', `/page?name=${encodeURIComponent('<script>alert(1)</script>')}`, {
  status: 200, body: /^<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/,
})
await check('GET /page (text/html)', '/page?name=ada', { status: 200, header: ['content-type', /^text\/html; charset=utf-8$/] })
await check('GET /page (javascript: href)', `/page?back=${encodeURIComponent('javascript:alert(1)')}`, {
  status: 200, body: /<a href="about:invalid#zen-unsafe-url">back<\/a>/,
})
await check('GET /go (a path is followed)', '/go?to=%2Fjson', {
  status: 302, header: ['location', /^\/json$/], init: { redirect: 'manual' },
})
await check('GET /go (// is refused)', `/go?to=${encodeURIComponent('//evil.example')}`, {
  status: 500, body: /ZEN_REDIRECT_EXTERNAL/, init: { redirect: 'manual' },
})
await check('GET /go (no Location leaves)', `/go?to=${encodeURIComponent('/\\evil.example')}`, {
  status: 500, header: ['location', /^$/], init: { redirect: 'manual' },
})
const LINK_NAME = 'a b/c?d#e%f+g&é'
await check('GET url() (§5.7, a hostile segment)', app.url('smoke.link', { name: LINK_NAME }, { q: 'x y+z', tag: ['1', '2'] }), {
  status: 200, body: JSON.stringify({ name: LINK_NAME, query: { q: 'x y+z', tag: ['1', '2'] } }),
})
await check('GET url() (§5.7, a wildcard)', app.url('smoke.tree', { path: ['docs', 'a?b c.md'] }), {
  status: 200, body: JSON.stringify({ path: 'docs/a?b c.md' }),
})
await check('GET /linked (§5.7, followed)', '/linked', {
  status: 200, body: JSON.stringify({ name: 'redirected here', query: { via: 'url()' } }),
})
await check('GET /nope (404)', '/nope', { status: 404 })
await check('POST / (405 + Allow)', '/', { status: 405, init: { method: 'POST' } })
await check('HEAD / (no body)', '/', { status: 200, body: '', init: { method: 'HEAD' } })
await check('GET /openapi.json', '/openapi.json', { status: 200, body: /"openapi": "3\.1\.0"/ })
await check('GET /openapi.json (no leak)', '/openapi.json', { status: 200, body: /^(?!.*passwordHash).*$/s })
await check('GET /docs (self-contained)', '/docs', { status: 200, body: /^(?!.*(src|href)=["']https?:).*<title>/s })

await check('GET / (onSend header)', '/', { status: 200, header: ['x-zen-phase', /^onSend$/] })
await check('GET /boom (onSend on errors)', '/boom', { status: 500, header: ['server-timing', /^total;dur=/] })

// §4.4 — the socket comes back. A 504 arriving over a real connection is the
// difference between "the framework stopped waiting" and "the connection was
// released", and only the second one keeps a server alive under load.
{
  const started = Date.now()
  await check('GET /hang (504 on time)', '/hang', { status: 504, body: /ZEN_TIMEOUT/ })
  const elapsed = Date.now() - started
  console.log(`  ${elapsed < 3000 ? '✔' : '✖'} deadline released the socket after ${elapsed}ms (budget 120ms)`)
  if (elapsed >= 3000) failures++
}
await check('GET /hang (onSend covers timeouts)', '/hang', { status: 504, header: ['x-zen-phase', /^onSend$/] })
await check('GET /patient (header shortens)', '/patient', {
  status: 504, init: { headers: { 'x-request-timeout': '100' } },
})
await check('GET /patient (header cannot lengthen)', '/patient', {
  status: 200, body: /"left":/, init: { headers: { 'x-request-timeout': '600000' } },
})

// ── §32 — the middleware pack, on the wire ──────────────────────────────────

const ORIGIN = 'https://smoke.example'
const PREFLIGHT: RequestInit = {
  method: 'OPTIONS',
  headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
}

await check('OPTIONS / (preflight, no OPTIONS route)', '/', {
  status: 204, body: '', init: PREFLIGHT, header: ['access-control-allow-origin', /^https:\/\/smoke\.example$/],
})
await check('OPTIONS /nope (preflight, no route at all)', '/nope', {
  status: 204, init: PREFLIGHT, header: ['access-control-allow-methods', /GET/],
})
await check('OPTIONS / (hostile origin gets nothing)', '/', {
  status: 204,
  init: { ...PREFLIGHT, headers: { ...(PREFLIGHT.headers as Record<string, string>), origin: 'https://evil.example' } },
  header: ['access-control-allow-origin', /^$/],
})
await check('GET /nope (404 still carries CORS)', '/nope', {
  status: 404, init: { headers: { origin: ORIGIN } }, header: ['access-control-allow-origin', /smoke\.example/],
})
await check('GET /boom (500 still carries nosniff)', '/boom', {
  status: 500, header: ['x-content-type-options', /^nosniff$/],
})
await check('GET / (§19.2 header set)', '/', {
  status: 200, header: ['strict-transport-security', /^max-age=63072000; includeSubDomains$/],
})
await check('GET / (request id echoed)', '/', {
  status: 200, header: ['x-request-id', /^[0-9A-Z]{26}$/],
})

/**
 * The claim `inject()` structurally cannot make: `Vary` is a *repeated* header
 * on the wire, and `InjectedResponse.headers` keeps only the last value.
 */
{
  const res = await fetch(base + '/', PREFLIGHT)
  // `getSetCookie` is the only multi-value accessor `Headers` exposes, so the
  // repeated `Vary` lines arrive already comma-joined — which is what a cache
  // sees and what has to be complete.
  const vary = (res.headers.get('vary') ?? '').split(',').map((v) => v.trim().toLowerCase())
  const wanted = ['origin', 'access-control-request-method', 'access-control-request-headers']
  const ok = wanted.every((token) => vary.includes(token))
  if (ok) {
    console.log(`  ✔ ${'preflight Vary (all three)'.padEnd(34)} ${res.status}  ${vary.join(', ')}`)
  } else {
    failures++
    console.log(`  ✖ ${'preflight Vary (all three)'.padEnd(34)} got ${JSON.stringify(vary)}, wanted ${JSON.stringify(wanted)}`)
  }
}

/**
 * A 429 an operator would read in a terminal: the status from the error engine,
 * `Retry-After` from the limiter, the CORS headers from a plugin that ran
 * before it, and the security headers from one that ran before that. Four
 * plugins, one response, and nothing wrote a reply directly.
 */
await check('GET /limited (1 of 2)', '/limited', { status: 200, init: { headers: { origin: ORIGIN } } })
await check('GET /limited (2 of 2)', '/limited', { status: 200, header: ['ratelimit', /remaining=0/] })
await check('GET /limited (429)', '/limited', {
  status: 429, body: /ZEN_RATE_LIMITED/, init: { headers: { origin: ORIGIN } },
  header: ['retry-after', /^\d+$/],
})
await check('GET /limited (429 carries CORS)', '/limited', {
  status: 429, init: { headers: { origin: ORIGIN } },
  header: ['access-control-allow-origin', /smoke\.example/],
})
await check('GET /limited (429 carries nosniff)', '/limited', {
  status: 429, header: ['x-content-type-options', /^nosniff$/],
})
await check('GET / (exempt key is not counted)', '/', { status: 200, body: 'Hello world' })

// ── §13.4 — content negotiation on the wire ─────────────────────────────────

await check('GET /report (no Accept → first)', '/report', {
  status: 200, body: /^\[\{"id":1,"name":"ada"\}\]$/,
  header: ['content-type', /^application\/json; charset=utf-8$/],
})
await check('GET /report (Accept: text/csv)', '/report', {
  status: 200, body: 'id,name\n1,ada', init: { headers: { accept: 'text/csv' } },
  header: ['content-type', /^text\/csv; charset=utf-8$/],
})
// §13.3's guarantee, per representation, on the wire — the sibling of the
// `/profile` check. A field no schema declares must not reach either format.
await check('GET /report (no leak, csv)', '/report', {
  status: 200, body: /^(?!.*must-not-ship).*$/s, init: { headers: { accept: 'text/csv' } },
})
await check('GET /report (no leak, json)', '/report', {
  status: 200, body: /^(?!.*must-not-ship).*$/s,
})
// The case implementations invert: a specific `q=0` beats a permissive wildcard.
await check('GET /report (csv;q=0 → json)', '/report', {
  status: 200, init: { headers: { accept: 'text/csv;q=0, */*' } },
  header: ['content-type', /^application\/json; charset=utf-8$/],
})
await check('GET /report (406 lists what it has)', '/report', {
  status: 406, body: /application\/json.*text\/csv/s, init: { headers: { accept: 'application/pdf' } },
})
await check('GET /report (406 still varies)', '/report', {
  status: 406, init: { headers: { accept: 'application/pdf' } },
  header: ['vary', /accept/i],
})
await check('HEAD /report (headers, no body)', '/report', {
  status: 200, body: '', init: { method: 'HEAD', headers: { accept: 'text/csv' } },
  header: ['content-type', /^text\/csv; charset=utf-8$/],
})
// The zero-cost contrast, observable from outside the process: one declared
// representation means `Accept` is disregarded and never varied on.
//
// The assertion is "`Accept` is absent from `Vary`", not "`Vary` is absent" —
// CORS stages `Vary: Origin` on every response in this app, and correctly so
// (§32.2). The first version of this check asserted the header was empty and
// failed, which is the right way round: a smoke check that expects a subsystem
// two files away to be silent is asserting something it does not own.
await check('GET /report-json-only (never varies on Accept)', '/report-json-only', {
  status: 200, init: { headers: { accept: 'text/csv' } },
  header: ['vary', /^(?!.*accept).*$/is],
})

/**
 * The claim `inject()` came closest to getting wrong last pass, in its new
 * form: **two subsystems staging `Vary` on one response must accumulate.**
 *
 * CORS stages `Vary: Origin`; negotiation stages `Vary: Accept`. Both go
 * through `ctx.res.appendHeader`, both are applied by `prepareForWire`, and the
 * adapter has to emit both values. A reader of `entries()` that assigns instead
 * of accumulating drops one of them — which is exactly the defect §32.5 found
 * in `@erenthedeveloper0/zen-adapter-node`, and the only place it was visible was here.
 *
 * A cache that sees only `Vary: Origin` will serve a CSV body to a client that
 * asked for JSON from the same origin.
 */
{
  const res = await fetch(base + '/report', { headers: { origin: ORIGIN, accept: 'text/csv' } })
  const vary = (res.headers.get('vary') ?? '').split(',').map((v) => v.trim().toLowerCase())
  const ok = vary.includes('origin') && vary.includes('accept')
  if (ok) {
    console.log(`  ✔ ${'Vary accumulates (CORS + §13.4)'.padEnd(34)} ${res.status}  ${vary.join(', ')}`)
  } else {
    failures++
    console.log(`  ✖ ${'Vary accumulates (CORS + §13.4)'.padEnd(34)} got ${JSON.stringify(vary)}, wanted origin + accept`)
  }
}

// A conditional request must round-trip: the document is a boot-time constant,
// so re-sending 20 kB per docs page load would be pure waste.
{
  const etag = (await fetch(base + '/openapi.json')).headers.get('etag') ?? ''
  await check('GET /openapi.json (304)', '/openapi.json', {
    status: 304, body: '', init: { headers: { 'if-none-match': etag } },
  })
}

const allow = (await fetch(base + '/', { method: 'POST' })).headers.get('allow')
console.log(`\n  Allow header on 405: ${allow}`)

// §9.4 stage 10 — this can only be checked here. `onResponse` runs after the
// adapter has flushed, so a run over real sockets is the only place its
// contract ("it saw everything, and it could not have changed anything") is
// actually under test.
{
  const unmatched = settled.filter((s) => s.route === '<unmatched>').length
  const ok = settled.length > 15 && unmatched >= 2 && settled.every((s) => s.afterFlush)
  console.log(`  ${ok ? '✔' : '✖'} onResponse fired for ${settled.length} responses (${unmatched} unmatched)`)
  if (!ok) failures++
}

// §9.2 phase 12 — and the fact only a compiled pipeline can report: *which*
// stage the budget was blown in. The pipeline marked it on the way past, so the
// answer is a field read rather than a guess from a stack trace.
{
  const stages = new Set(blown.map((b) => b.stage))
  const ok = blown.length >= 3 && stages.size === 1 && stages.has('handler')
  console.log(`  ${ok ? '✔' : '✖'} onTimeout fired ${blown.length}× in stage(s) [${[...stages].join(', ')}]`)
  if (!ok) failures++
}

// §31.4 — over a real socket, because everything interesting about a health
// endpoint is what an orchestrator sees on the wire.
await check('GET /healthz', '/healthz', {
  status: 200, body: /"status":\s*"pass"/, header: ['content-type', /application\/health\+json/],
})
await check('GET /readyz', '/readyz', { status: 200, body: /"smoke\.db"/ })
await check('GET /healthz (no-store)', '/healthz', {
  status: 200, header: ['cache-control', /no-store/],
})

// A dependency that never answers. The endpoint must still answer, on time,
// naming the culprit — this is the failure that takes hand-written health
// endpoints down, because the orchestrator's own probe times out and restarts a
// process that was perfectly alive.
{
  dbFault = 'hang'
  const started = Date.now()
  await check('GET /readyz (dependency hangs)', '/readyz', {
    status: 503, body: /exceeded its 150ms budget/,
  })
  const elapsed = Date.now() - started
  console.log(`  ${elapsed < 2000 ? '✔' : '✖'} readiness answered in ${elapsed}ms with a wedged dependency (budget 150ms)`)
  if (elapsed >= 2000) failures++

  // …and liveness stays green throughout, which is the half that stops a
  // dependency outage becoming a fleet-wide restart storm.
  await check('GET /healthz (unaffected)', '/healthz', { status: 200, body: /"status":\s*"pass"/ })
  dbFault = 'ok'
  await check('GET /readyz (recovers)', '/readyz', { status: 200 })
}

// §16.1 layer 1, made load-bearing — and the one config claim that genuinely
// needs a socket. `app.listen()` with no arguments must bind the *configured*
// address, because "the correct call in a deployed service" is the whole reason
// the `server` namespace exists. If configuration were ignored the adapter's
// own default would take over and this would come up on 3000; nothing about
// that is visible in-process.
{
  const configured = zen({
    logger: quiet(),
    config: defineConfig({ server: { port: 0, host: '127.0.0.1' } }),
  })
  configured.get('/where', (ctx) => ({
    port: ((ctx as never as { config: { server: { port: number } } }).config).server.port,
  }))

  const bound = await configured.listen()
  const port = bound.address?.port ?? 0
  const answered = await fetch(`${bound.url}/where`).then((r) => r.json() as Promise<{ port: number }>)

  const ok = port > 0 && port !== 3000 && answered.port === 0
  console.log(
    `  ${ok ? '✔' : '✖'} app.listen() bound the configured address`.padEnd(38) +
    `  ephemeral ${port}, and ctx.config.server.port is still the declared 0`,
  )
  if (!ok) failures++
  await configured.close('smoke')
}

console.log(`\n  generated units: ${app.generatedSource().map((u) => u.name).join(', ')}`)
console.log(`  routes: ${app.graph().routes.length}`)

// §4.5 step 1, and the one assertion in this file that needs a socket that is
// open and a process that is shutting down at the same time. Readiness must go
// red *first*, and the server must keep answering for the whole drain window —
// a service that stops accepting and then reports itself unready has already
// 502'd everything the load balancer sent in between.
{
  const closeStarted = Date.now()
  const closing = app.close()

  await check('GET /readyz (draining)', '/readyz', { status: 503, body: /"state":\s*"draining"/ })
  await check('GET /healthz (draining is not dying)', '/healthz', { status: 200 })

  await closing
  const drained = Date.now() - closeStarted
  const ok = drained >= DRAIN_MS - 30
  console.log(`  ${ok ? '✔' : '✖'} socket stayed open for ${drained}ms of a ${DRAIN_MS}ms drain window`)
  if (!ok) failures++
}

console.log(failures === 0 ? '\n  all smoke checks passed\n' : `\n  ${failures} smoke check(s) failed\n`)
// Set exitCode rather than calling process.exit(): forcing exit while libuv
// handles are still closing trips an assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1

function truncate(s: string): string {
  const flat = s.replace(/\n/g, '\\n')
  return flat.length > 40 ? flat.slice(0, 40) + '…' : flat
}

/**
 * A Standard Schema that also exposes its shape, in about twenty lines.
 *
 * §11.4 needs both halves at once — the plan comes from the shape, the verdict
 * from the validator — and `jsonSchema()` deliberately supplies only the first.
 */
function shaped(json: Record<string, unknown>) {
  const issuesFor = (value: unknown, node: Record<string, unknown>, path: PropertyKey[]): Array<{ message: string; path: PropertyKey[] }> => {
    const type = node['type'] as string | undefined
    const ok = type === undefined
      || (type === 'string' && typeof value === 'string')
      || (type === 'boolean' && typeof value === 'boolean')
      || (type === 'integer' && Number.isInteger(value))
      || (type === 'number' && typeof value === 'number')
      || (type === 'array' && Array.isArray(value))
      || (type === 'object' && typeof value === 'object' && value !== null)
    if (!ok) return [{ message: `expected ${String(type)}, received ${typeof value}`, path }]

    const properties = node['properties'] as Record<string, Record<string, unknown>> | undefined
    if (properties === undefined) return []
    const record = value as Record<string, unknown>
    const out: Array<{ message: string; path: PropertyKey[] }> = []
    for (const key of Object.keys(properties)) {
      if (record[key] === undefined) continue
      out.push(...issuesFor(record[key], properties[key] as Record<string, unknown>, [...path, key]))
    }
    return out
  }

  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-smoke',
      validate: (value: unknown) => {
        const issues = issuesFor(value, json, [])
        return issues.length > 0 ? { issues } : { value }
      },
    },
    toJSONSchema: () => json,
  } as never
}

function quiet() {
  const noop = () => {}
  return { level: 'fatal' as const, child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
}
