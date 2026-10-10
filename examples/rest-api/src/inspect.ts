/**
 * Print what this application compiled to.
 *
 * `node examples/rest-api/src/inspect.ts`
 *
 * Every claim Zen makes about its per-request path is checkable from here.
 * There is no hidden runtime doing something other than what this prints.
 */
import { build } from './app.ts'
import { UserRepoToken } from './services.ts'

const app = build({ logger: quiet(), inspect: true })
await app.ready()

const units = app.generatedSource()
const serializers = units.filter((u) => u.name.startsWith('serializer:'))
const pipelines = units.filter((u) => u.name.startsWith('pipeline:'))

console.log(`\n  ${units.length} generated units — ${serializers.length} serializers, ${pipelines.length} pipelines\n`)

// ─── 1. the serializer for GET /users/:id ────────────────────────────────────

const target = serializers.find((u) => u.name.includes('/users/:id<int>#200'))
console.log('─'.repeat(74))
console.log(`  ${target?.name}\n`)
console.log(target?.source)

console.log('\n' + '─'.repeat(74))
console.log('  What the handler returned vs what ships\n')

const row = app.resolve(UserRepoToken).find(1)
console.log('  handler returned:')
console.log('   ', JSON.stringify(row))

const response = await app.inject('GET', '/users/1', { headers: { 'x-user-id': '1' } })
console.log('\n  wire:')
console.log('   ', response.text())

const leaked = ['passwordHash', 'totpSecret', 'stripeCustomerId', 'internalNotes', 'deletedAt']
  .filter((field) => response.text().includes(field))

console.log(
  leaked.length === 0
    ? '\n  ✔ none of the 5 private columns reached the wire'
    : `\n  ✖ LEAKED: ${leaked.join(', ')}`,
)

// ─── 2. the pipeline for the same route ──────────────────────────────────────

console.log('\n' + '─'.repeat(74))
const pipeline = pipelines.find((u) => u.name.includes('/users/:id<int>'))
console.log(`  ${pipeline?.name}\n`)
console.log(pipeline?.source)

// ─── 3. the graph, as data ───────────────────────────────────────────────────

const graph = app.graph()
console.log('\n' + '─'.repeat(74))
console.log('  AppGraph — the same data OpenAPI, the typed client and `zen routes` read\n')
for (const plugin of graph.plugins) {
  const deps = Object.entries(plugin.dependsOn)
  console.log(`    plugin ${plugin.name}@${plugin.version}${deps.length > 0 ? `  depends on ${deps.map(([n, r]) => `${n}${r}`).join(', ')}` : ''}`)
}
for (const provider of app.container.providers) {
  console.log(`    service ${provider.token.name.padEnd(16)} ${provider.lifetime}${provider.eager ? ', eager' : ''}`)
}
console.log('')

process.exitCode = leaked.length === 0 ? 0 : 1

function quiet() {
  const noop = () => {}
  return { level: 'fatal' as const, child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
}
