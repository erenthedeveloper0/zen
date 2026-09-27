import { explainRoute } from '@visionpilot/zen'
import { makeApp } from './app.ts'

/**
 * `npm run deadlines:explain` — rfcs/0001 §8.5, §4.4.
 *
 * "What is our request timeout" is normally a question with four answers and no
 * way to reconcile them. Here it is a field on the AppGraph, so the answer is a
 * table — and the *provenance* is in the table too, because in a real codebase
 * the surprising budgets are the inherited ones.
 *
 * The chain below is not a reconstruction: `explainRoute` reads the same
 * arrays and the same `timeout` record the pipeline compiler consumed, so it
 * cannot describe a budget the dispatcher does not use.
 */
const app = makeApp({ quiet: true })
await app.ready()

const graph = app.graph()

console.log('\n  Budgets\n')
const width = Math.max(...graph.routes.map((r) => r.path.length + r.method.length + 1))
for (const route of graph.routes) {
  const head = `${route.method} ${route.path}`.padEnd(width + 2)
  const budget = route.timeout === null
    ? 'none'.padStart(8) + '   —'
    : `${route.timeout.ms} ms`.padStart(8) + `   from ${route.timeout.from}`
  console.log(`    ${head}${budget}`)
}

// The number worth putting on a dashboard: routes with no budget at all. Every
// one of them can hold a connection until the process restarts. Plugin-owned
// routes are excluded — `/deadlines` reporting on itself is noise, not data.
const own = graph.routes.filter((r) => r.meta.get('hidden') !== true)
const unbounded = own.filter((r) => r.timeout === null)
console.log(`\n  ${own.length - unbounded.length}/${own.length} application routes are bounded.`)
if (unbounded.length > 0) {
  console.log(`  Unbounded on purpose: ${unbounded.map((r) => r.path).join(', ')}`)
}

console.log('\n  Chains\n')
for (const route of graph.routes) {
  console.log(explainRoute(route).split('\n').map((line) => (line === '' ? '' : `  ${line}`)).join('\n'))
  console.log('')
}

// §4.4 in the same shape as §9.4: the routes that declared no deadline carry no
// deadline code, and that is visible in the emitted bytes rather than asserted.
const units = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
console.log(`  generated pipelines: ${units.length}\n`)
for (const unit of units) {
  const marks = [...unit.source.matchAll(/dl\.stage = '(\w+)'/g)].map((m) => m[1] as string)
  console.log(`    ${unit.name.padEnd(34)} ${String(unit.source.length).padStart(5)} bytes   ` +
    (marks.length === 0 ? 'no deadline code' : `boundaries: ${marks.join(' → ')}`))
}
console.log('')
