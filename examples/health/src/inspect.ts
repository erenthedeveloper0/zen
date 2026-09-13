import { makeApp } from './app.ts'

/**
 * `npm run health:explain` — rfcs/0001 §31.4, §2.4.
 *
 * "Which of our dependencies is actually probed?" is normally answered by
 * reading the health handler and hoping it is up to date. Here the checks are
 * on the frozen AppGraph with every default resolved, so it is a table — and
 * the *owner* is in the table too, because in a real codebase the checks that
 * surprise you are the ones a plugin registered.
 *
 * The last section is the one worth having in a boot log: a component with no
 * check is a component whose failure your readiness endpoint will report as
 * healthy.
 */
const { app, deps } = makeApp({ quiet: true })
await app.ready()

const graph = app.graph()

console.log('\n  Health checks\n')
const width = Math.max(...graph.checks.map((c) => c.name.length))
for (const check of graph.checks) {
  const flags = [
    check.kind.padEnd(9),
    `${check.timeoutMs}ms`.padStart(7),
    `ttl ${check.ttlMs}ms`.padStart(10),
    check.critical ? 'critical' : 'advisory',
  ].join('  ')
  console.log(`    ${check.name.padEnd(width + 2)}${flags}   ${check.source}`)
  if (check.description !== undefined) {
    console.log(`    ${' '.repeat(width + 2)}${check.description}`)
  }
}

// Liveness and readiness are different lists, and printing them apart is the
// cheapest way to catch the mistake that matters: a dependency probe that has
// drifted into liveness will restart the fleet during the next outage.
const readiness = graph.checks.filter((c) => c.kind === 'readiness')
const liveness = graph.checks.filter((c) => c.kind === 'liveness')
console.log(`\n  /readyz runs ${readiness.length}: ${readiness.map((c) => c.name).join(', ')}`)
console.log(`  /healthz runs ${liveness.length}: ${liveness.map((c) => c.name).join(', ') || '—'}`)

// The coverage question. Every component this service depends on, against the
// ones something actually probes.
const components = Object.keys(deps.faults)
const probed = new Set(readiness.map((c) => c.name))
const unprobed = components.filter((name) => !probed.has(name))
console.log(`\n  ${components.length - unprobed.length}/${components.length} dependencies are probed by readiness.`)
if (unprobed.length > 0) {
  console.log(`  Unprobed: ${unprobed.join(', ')} — a failure here reports as healthy.`)
}

// §31.4's zero-cost claim, in the same shape as §9.4 and §4.4: the health
// endpoints are ordinary routes, so nothing about them reaches an application
// route's generated pipeline.
const pipelines = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
console.log(`\n  generated pipelines: ${pipelines.length}\n`)
for (const unit of pipelines) {
  console.log(`    ${unit.name.padEnd(38)} ${String(unit.source.length).padStart(5)} bytes`)
}

console.log('\n  Probes, run once each\n')
for (const kind of ['liveness', 'readiness'] as const) {
  const report = await app.probe(kind)
  console.log(`    ${kind.padEnd(10)} ${report.status.padEnd(5)} ${report.durationMs.toFixed(2)}ms`)
  for (const row of report.checks) {
    console.log(`      ${row.name.padEnd(width + 2)}${row.status.padEnd(6)}${row.durationMs.toFixed(2)}ms  ${row.message ?? ''}`)
  }
}
console.log('')

await app.close()
