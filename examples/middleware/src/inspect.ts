import { explainConfig, explainRoute } from '@visionpilot/zen'
import { makeApp } from './app.ts'

/**
 * `npm run explain -w @visionpilot/zen-example-middleware` — rfcs/0001 §2.4, §8.5, §16.1.
 *
 * Four questions a service author asks about middleware, answered off the
 * frozen graph rather than by reading `app.ts` and hoping:
 *
 *   1. **What actually runs on this route, and in what order?** The pack
 *      reorders itself, so the order in `app.ts` is not the answer.
 *   2. **Which origins are allowed, and who said so?** The value *and* the
 *      layer and the file it came from.
 *   3. **What does a preflight advertise?** Read off the graph's own method
 *      set, so it cannot claim a verb the router would 405.
 *   4. **Which responses carry which headers?** The one that is normally
 *      guessed, because the answer depends on whether a middleware stamps or a
 *      hook stages.
 */
const { app } = makeApp({
  quiet: true,
  env: [{
    layer: 'dotenv',
    name: '.env.production',
    entries: [
      { key: 'NODE_ENV', value: 'production' },
      { key: 'CORS_ORIGINS', value: 'https://notes.example,https://admin.notes.example', line: 7 },
      { key: 'RATE_LIMIT', value: '120', line: 11 },
      { key: 'ADMIN_TOKEN', value: 'a-real-production-secret-value', line: 14 },
    ],
  }],
})
await app.ready()

const graph = app.graph()

// ── 1. the resolved chain ────────────────────────────────────────────────────

console.log('\n  1. What runs on GET /api/notes\n')

const list = graph.routes.find((route) => route.name === 'notes.list')
console.log(explainRoute(list as never).split('\n').map((line) => `  ${line}`).join('\n'))

console.log('  Registered in app.ts as: securityHeaders, cors, rateLimit, requestId —')
console.log('  in that file, after the health plugin. The order above is the pack\'s own,')
console.log('  from the `before`/`after` hints in each manifest (§10.5 step 4), and it is')
console.log('  load-bearing twice: security headers have to be staged before anything can')
console.log('  short-circuit, and CORS headers before the limiter can refuse.')

// ── 2. where the allowlist came from ────────────────────────────────────────

console.log('\n  2. Which origins are allowed, and who said so\n')

const width = Math.max(...graph.config.values.map((v) => v.path.length))
for (const value of graph.config.values) {
  if (!value.path.startsWith('cors.') && !value.path.startsWith('rateLimit.') && !value.path.startsWith('admin.')) continue
  console.log(
    `    ${value.path.padEnd(width + 2)}${JSON.stringify(value.value).padEnd(56)}` +
    `${value.layer.padEnd(10)}${value.source}`,
  )
}

console.log('\n  `admin.token` is redacted at the source — this table reads the snapshot on')
console.log('  the graph, which never held the value (§22.1). No printer here has a branch')
console.log('  to forget, which is the property `benchmarks/config` gates.')

// ── 3. what a preflight advertises ──────────────────────────────────────────

console.log('\n  3. What a preflight advertises, read off the graph\n')

const served = new Set(graph.routes.map((route) => route.method))
if (served.has('GET')) served.add('HEAD')
served.delete('OPTIONS')

console.log(`    routes declared            ${graph.routes.length}`)
console.log(`    methods this app serves    ${[...served].join(', ')}`)
console.log('\n  Every other framework hardcodes GET, HEAD, POST, PUT, PATCH, DELETE here.')
console.log('  This app has no PUT, so it does not advertise one — and if somebody adds a')
console.log('  PUT route tomorrow the preflight starts advertising it with no second file')
console.log('  to remember. The graph is the only description (§2.4).')

// ── 4. which responses carry which headers ──────────────────────────────────

console.log('\n  4. Which responses carry the pack\'s headers\n')

const cases: ReadonlyArray<[string, string, string, Record<string, string>]> = [
  ['a served request', 'GET', '/api/notes', { origin: 'https://notes.example' }],
  ['a 404', 'GET', '/api/notes/999', { origin: 'https://notes.example' }],
  ['a 422 (bad body)', 'POST', '/api/notes', { origin: 'https://notes.example', 'content-type': 'application/json' }],
  ['a 401', 'DELETE', '/api/notes/1', { origin: 'https://notes.example' }],
  ['a preflight', 'OPTIONS', '/api/notes', { origin: 'https://notes.example', 'access-control-request-method': 'POST' }],
  ['a preflight, no route', 'OPTIONS', '/nothing-here', { origin: 'https://notes.example', 'access-control-request-method': 'POST' }],
  ['a 404, no Origin', 'GET', '/nothing-here', {}],
]

const WATCHED = ['access-control-allow-origin', 'x-content-type-options', 'ratelimit', 'x-request-id'] as const
console.log(`    ${'case'.padEnd(24)}${'status'.padEnd(8)}${WATCHED.map((h) => h.padEnd(30)).join('')}`)

for (const [label, method, path, headers] of cases) {
  const res = await app.inject(method, path, {
    headers,
    ...(method === 'POST' ? { body: { title: '' } } : {}),
  })
  const cells = WATCHED.map((name) => {
    const value = res.header(name)
    return (value === undefined ? '—' : value.length > 26 ? value.slice(0, 26) + '…' : value).padEnd(30)
  })
  console.log(`    ${label.padEnd(24)}${String(res.status).padEnd(8)}${cells.join('')}`)
}

console.log('\n  Only the first row is one an `after` middleware would have filled in. §4.6')
console.log('  says the error path never re-enters user middleware, and an unmatched')
console.log('  request has no middleware chain at all — so the 404, the 422, the 401 and')
console.log('  both preflights would have gone out bare, and a browser reports every one')
console.log('  of those as a CORS failure rather than as the status it actually is.')
console.log('  Staging through `ctx.res` is what fills the other six (§13.6, §32.2).')
console.log('\n  Two cells are deliberately empty. The preflights carry no `RateLimit`,')
console.log('  because counting them would spend a browser\'s budget on requests it did')
console.log('  not choose to make; and the last row has no `Origin`, so there is no CORS')
console.log('  decision to state — though it still varies on `Origin`, because the')
console.log('  response would have been different if it had one:\n')

const noOrigin = await app.inject('GET', '/nothing-here')
console.log(`    Vary on the last row: ${JSON.stringify(noOrigin.reply.headers.getAll('vary'))}`)

// ── the full configuration, for completeness ────────────────────────────────

console.log('\n  5. The whole configuration\n')
console.log(explainConfig(graph.config).split('\n').map((line) => `  ${line}`).join('\n'))
