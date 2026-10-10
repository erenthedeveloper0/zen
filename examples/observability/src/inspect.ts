import { explainRoute } from '@erenthedeveloper0/zen'
import { makeApp } from './app.ts'

/**
 * `npm run observability:explain` — rfcs/0001 §8.5.
 *
 * "I can't tell what runs on this route" is the standard complaint about a
 * mature Express codebase, and the standard answer is to read every file that
 * calls `app.use` in import order. Here the resolved chain is on the
 * RouteRecord, so printing it is a function call.
 *
 * The chain below is not a reconstruction: `explainRoute` reads the same
 * arrays the pipeline compiler consumed, so it cannot describe an order the
 * pipeline does not have.
 */
const app = makeApp({ quiet: true, inspect: true })
await app.ready()

const graph = app.graph()

console.log(`\n  ${graph.routes.length} routes\n`)
for (const route of graph.routes) {
  console.log(explainRoute(route).split('\n').map((line) => (line === '' ? '' : `  ${line}`)).join('\n'))
  console.log('')
}

// The §9.4 claim, on this application rather than in a benchmark: the routes
// that registered no extra hooks generate no extra code for them.
const units = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
console.log(`  generated pipelines: ${units.length}`)
for (const unit of units) {
  const phases = [...unit.source.matchAll(/d\.hooks\.(\w+)\[/g)].map((m) => m[1] as string)
  console.log(`    ${unit.name.padEnd(38)} ${String(unit.source.length).padStart(5)} bytes   ` +
    (phases.length === 0 ? 'no hook code' : `${new Set(phases).size} phases, ${phases.length} call sites`))
}
console.log('')
