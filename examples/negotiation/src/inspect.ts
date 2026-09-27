import { explainRoute } from '@visionpilot/zen'
import { makeApp } from './app.ts'
import { CSV, V1, V2 } from './features/reports/index.ts'

/**
 * `npm run explain -w @visionpilot/zen-example-negotiation` — rfcs/0001 §2.4, §8.5, §13.4.
 *
 * Five questions a service author asks about content negotiation, answered off
 * the frozen graph rather than by reading `routes.ts` and hoping:
 *
 *   1. **What runs on this route, and where does negotiation sit?** The answer
 *      is "before the handler", and it has to be visible: a 406 that happens
 *      before your auth middleware is the one surprising thing about the
 *      feature.
 *   2. **What can this route produce, and which one wins a tie?** Preference
 *      order is a real fact about the API and it is invisible in the routes
 *      file unless you know that object key order is load-bearing.
 *   3. **What does each Accept header actually get?** The table nobody can
 *      derive by reading an RFC, including the two cases every implementation
 *      gets wrong.
 *   4. **Which statuses are negotiated and which are not?** The answer decides
 *      whether your 404 is a problem document or a one-row CSV.
 *   5. **What did the route that declares one representation pay?** Nothing,
 *      and here are the bytes.
 */
const { app } = makeApp({ quiet: true })
await app.ready()

const graph = app.graph()
const list = graph.routes.find((route) => route.name === 'sales.list')
const one = graph.routes.find((route) => route.name === 'sales.get')
const regions = graph.routes.find((route) => route.name === 'sales.regions')

// ── 1. the resolved chain ───────────────────────────────────────────────────

console.log('\n  1. What runs on GET /api/sales\n')
console.log(explainRoute(list as never).split('\n').map((line) => `  ${line}`).join('\n'))

console.log('  `negotiate` is above `validate` and above `handler`, and that placement is')
console.log('  the feature. A 406 is knowable from one header and the graph, so it is')
console.log('  answered before the query is validated and before a database is touched —')
console.log('  the same argument §4.2 stage 5 makes for auth and rate limiting. It also')
console.log('  means `ctx.negotiated` is set before any middleware runs, so an `around`')
console.log('  middleware that caches replies can key on it.')

// ── 2. what the route can produce ───────────────────────────────────────────

console.log('\n  2. What each route can produce, in preference order\n')

for (const route of [list, one, regions]) {
  const offers = route?.negotiation?.offers
  console.log(
    `    ${(route?.name ?? '?').padEnd(18)}` +
    (offers === undefined ? 'not negotiated — one representation' : offers.join('  >  ')),
  )
}

console.log('\n  The `>` is server preference, and it decides two things: what a client')
console.log('  sending `Accept: */*` receives, and how a tie on quality breaks. It comes')
console.log('  from the order the keys were written in `schemas.ts`, which is why that')
console.log('  order is a decision in this example rather than an accident.')

// ── 3. what each Accept header gets ─────────────────────────────────────────

console.log('\n  3. What each Accept header actually gets\n')

/** The vendor types are 34 characters wide, which no terminal table survives. */
const short = (media: string): string =>
  media.replace(V2, 'v2').replace(V1, 'v1').replace(CSV, 'csv').replace('; charset=utf-8', '')

console.log(`    v1 = ${V1}`)
console.log(`    v2 = ${V2}`)
console.log(`    csv = ${CSV}\n`)

const headers: ReadonlyArray<[string | undefined, string]> = [
  [undefined, 'no Accept header — the server preference'],
  ['*/*', 'ditto: the client expressed none'],
  [CSV, 'an exact match'],
  [V1, 'a client pinned to v1, forever'],
  ['text/*', 'a subtype wildcard'],
  [`${V1};q=0.8, ${V2};q=0.9`, 'quality decides'],
  [`${V2};q=0.5, ${V1};q=0.5`, 'a tie — the server decides'],
  ['text/csv;q=0, */*', 'anything EXCEPT csv'],
  ['*/*;q=0, text/csv', 'nothing, EXCEPT csv'],
  ['*/*;q=0', 'nothing at all → 406'],
  ['application/pdf', 'we cannot produce it → 406'],
  ['garbage', 'unreadable — treated as absent, not as a refusal'],
]

console.log(`    ${'Accept'.padEnd(30)}${'status'.padEnd(8)}${'Content-Type'.padEnd(26)}why`)
for (const [accept, why] of headers) {
  const res = await app.inject('GET', '/api/sales', accept === undefined ? {} : { headers: { accept } })
  console.log(
    `    ${short(accept ?? '(none)').padEnd(30)}${String(res.status).padEnd(8)}` +
    `${short(res.header('content-type') ?? '—').padEnd(26)}${why}`,
  )
}

console.log('\n  Rows 8 and 9 are the two every implementation that scores by "the highest')
console.log('  q among matching ranges" gets backwards. RFC 9110 §12.5.1 says the *most')
console.log('  specific* matching range decides an offer\'s quality, so `text/csv;q=0`')
console.log('  overrides the wildcard that would otherwise allow it. Reading it the other')
console.log('  way serves a representation the client named and refused.')

// ── 4. which statuses are negotiated ────────────────────────────────────────

console.log('\n  4. Which statuses are negotiated, and which are not\n')

console.log(`    sales.get negotiates statuses   ${(one?.negotiation?.statuses ?? []).join(', ')}`)
console.log(`    …and declares                   ${Object.keys(one?.schema.response ?? {}).join(', ')}`)

const found = await app.inject('GET', '/api/sales/1', { headers: { accept: CSV } })
const missing = await app.inject('GET', '/api/sales/999', { headers: { accept: CSV } })

console.log(`\n    GET /api/sales/1    Accept: text/csv   → ${found.status}  ${found.header('content-type')}`)
console.log(`    GET /api/sales/999  Accept: text/csv   → ${missing.status}  ${missing.header('content-type')}`)

console.log('\n  The 404 declares a plain schema, so it is not one of this resource\'s')
console.log('  representations — it is RFC 9457\'s problem document, which is what §12.1')
console.log('  means by one envelope. Inheriting the negotiated Content-Type would hand a')
console.log('  CSV parser a JSON object and produce a parse error at line 1, which is a')
console.log('  much worse bug report than a 404.')

// ── 5. what the route that declares one representation paid ─────────────────

console.log('\n  5. What the un-negotiated route paid\n')

const source = (name: string): string =>
  app.generatedSource().find((unit) => unit.name === name)?.source ?? ''

const negotiated = source('pipeline:GET_/api/sales')
const plain = source('pipeline:GET_/api/sales/regions')

console.log(`    GET /api/sales           ${String(negotiated.length).padStart(5)} bytes   negotiate: ${negotiated.includes('d.negotiate(ctx)') ? 'yes' : 'no'}`)
console.log(`    GET /api/sales/regions   ${String(plain.length).padStart(5)} bytes   negotiate: ${plain.includes('d.negotiate(ctx)') ? 'yes' : 'no'}`)
console.log(`    Vary staged on /regions  ${(await app.inject('GET', '/api/sales/regions', { headers: { accept: CSV } })).header('vary') ?? 'none'}`)

console.log('\n  Not "a fast branch" — no branch. The route that declares one representation')
console.log('  compiles to the same bytes it compiled before this feature existed, which')
console.log('  is what §9.4 means and what `benchmarks/negotiation` gates on. Asking it')
console.log('  for CSV gets a 200 of JSON: RFC 9110 §12.5.1 permits disregarding `Accept`,')
console.log('  and a route that wants the strict answer opts in by writing the variant')
console.log('  form — even with a single media type in it.')

console.log('\n  6. And the field that is in no representation\n')

const csv = await app.inject('GET', '/api/sales', { headers: { accept: CSV } })
const json = await app.inject('GET', '/api/sales', { headers: { accept: V2 } })

console.log(`    internalMargin in the CSV    ${csv.text().includes('internalMargin') ? 'LEAKED' : 'no'}`)
console.log(`    internalMargin in the JSON   ${json.text().includes('internalMargin') ? 'LEAKED' : 'no'}`)
console.log(`    columns the encoder resolved ${csv.text().split('\r\n')[0]}`)
console.log('\n  Nothing in the handler removes it. The JSON is filtered by the compiled')
console.log('  serializer (§13.3) and the CSV by a column list the encoder took from the')
console.log('  same schema at boot — one declaration, two wire formats, one guarantee.')
