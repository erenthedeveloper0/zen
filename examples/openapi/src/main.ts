import { build } from './app.ts'
import { loadConfig } from './config/zen.config.ts'

const config = loadConfig()
const app = build({}, config)

const handle = await app.listen({ port: config.port })

console.log(`\n  zen listening on ${handle.url}`)
console.log(`  routes:   ${app.graph().routes.length}`)
console.log(`  docs:     ${handle.url}/docs`)
console.log(`  document: ${handle.url}/openapi.json\n`)
console.log('  try:')
console.log(`    curl ${handle.url}/users/1`)
console.log(`    curl ${handle.url}/orders/1        # returns marginCents and fraudScore — watch the wire`)
console.log(`    curl ${handle.url}/openapi.json | head -40\n`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
