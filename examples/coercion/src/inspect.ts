import { explainRoute } from '@erenthedeveloper0/zen'
import { makeApp } from './app.ts'

/**
 * `npm run explain -w @erenthedeveloper0/zen-example-coercion`
 *
 * The reader half of §11.4 — and the convention that has now found a defect in
 * the producer four times running (CONTRIBUTING.md convention 2), so it is built alongside the
 * writer rather than after it.
 *
 * What it prints is not the *profile* — `numbers: true` tells you a policy and
 * not an outcome. It prints the **plan**: the fields this route will convert,
 * what to, and how a list is spelled. That is the answer to the question people
 * actually have, which is never "is numeric coercion on" but "why did `?sku=00713`
 * survive and `?page=2` not", and it comes from the same structure the coercer
 * was generated from — so it cannot describe a conversion that will not happen.
 *
 * Reading the output, three things are worth looking for:
 *
 *   - `/catalog` lists `page`, `limit`, `inStock`, `tags` — and **not** `sku`,
 *     `q` or `sort`. Those three are declared as strings (or as unions
 *     containing one), so there is nothing to convert them to.
 *   - `/catalog/by-ids` says `split on ","` where `/catalog` says `repeat`.
 *     One line on one route, visible here and in the OpenAPI document.
 *   - `/features` coerces a *header* into a list, which is the default and the
 *     only place a default array style is doing real work.
 */
const app = makeApp({ quiet: true })
await app.ready()

const graph = app.graph()

console.log('\n  Resolved chains — rfcs/0001 §8.5, §11.4\n')
for (const route of graph.routes) {
  console.log(explainRoute(route).split('\n').map((line) => `  ${line}`).join('\n'))
  console.log('')
}

console.log('  Coercion, as the graph holds it\n')
for (const route of graph.routes) {
  if (route.coercion === null) {
    console.log(`  ${route.method} ${route.path.padEnd(24)} — nothing to convert, no coercer emitted`)
    continue
  }
  for (const [source, plan] of route.coercion) {
    console.log(`  ${route.method} ${route.path.padEnd(24)} ${source}`)
    for (const field of plan.fields) {
      const op = field.op
      const to = op === null ? 'blank → absent' : op.kind === 'array'
        ? `array of ${op.items?.kind ?? 'string'}${op.split !== null ? ` (split on "${op.split}")` : ''}`
        : op.kind
      console.log(`      ${field.key.padEnd(12)} → ${to}`)
    }
  }
}

/**
 * The zero-cost rule, checked rather than asserted — §9.4, §11.4.
 *
 * Every generated unit the app produced, so you can see for yourself that a
 * route with nothing to convert has no `coercer:` entry. This is the same claim
 * `benchmarks/coercion/run.ts` fails the build over; printing it here is what
 * makes it inspectable rather than a sentence in a README.
 */
console.log('\n  Generated units\n')
for (const unit of app.generatedSource()) {
  console.log(`  ${String(unit.source.length).padStart(6)} bytes  ${unit.name}`)
}

const coercers = app.generatedSource().filter((u) => u.name.startsWith('coercer:'))
console.log(`\n  ${coercers.length} coercers for ${graph.routes.length} routes.\n`)

console.log('  One of them, in full:\n')
console.log((coercers[0]?.source ?? '').split('\n').map((l) => `    ${l}`).join('\n'))
console.log('')
