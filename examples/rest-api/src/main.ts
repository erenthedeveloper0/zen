import { build } from './app.ts'

const app = build({ dev: true })
const handle = await app.listen({ port: Number(process.env['PORT'] ?? 3000) })

const graph = app.graph()
console.log(`\n  zen rest-api on ${handle.url}`)
console.log(`  ${graph.routes.length} routes · ${graph.plugins.length} plugins · ${app.container.providers.length} services\n`)

for (const route of graph.routes) {
  const contracts = Object.keys(route.schema.response ?? {})
  console.log(
    `    ${route.method.padEnd(6)} ${route.path.padEnd(22)}` +
    (contracts.length > 0 ? `response contract: ${contracts.join(', ')}` : ''),
  )
}

console.log(`
  The point of the example — the same row, with and without a contract:

    curl -H 'x-user-id: 1' ${handle.url}/users/1
    → {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin","createdAt":"…"}

  The handler returned passwordHash, totpSecret, stripeCustomerId and
  internalNotes as well. Read the generated serializer to see why they cannot
  reach the wire:

    node examples/rest-api/src/inspect.ts
`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
