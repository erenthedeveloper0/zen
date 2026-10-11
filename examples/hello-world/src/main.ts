import { makeApp } from './app.ts'

const app = makeApp()

const handle = await app.listen({ port: 3000 })
console.log(`\n  zen listening on ${handle.url}`)
console.log(`  routes: ${app.graph().routes.length}`)
console.log(`  try:    curl ${handle.url}/users/1\n`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
