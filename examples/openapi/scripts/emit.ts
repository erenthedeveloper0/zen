import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { openapiDocument } from '@zenjs/openapi'
import { build } from '../src/app.ts'
import { openapiOptions } from '../src/config/zen.config.ts'

/**
 * Write the document to `api/openapi.json` — `npm run emit`.
 *
 * This is what `zen openapi --out` will do when the CLI (§17) exists. It is a
 * separate script rather than a build step for a reason: the committed document
 * is the *baseline the next change is diffed against* (`check-api.ts`), so it
 * should move when someone decides it moves, in a reviewable commit.
 */
const app = build({ dev: false })
await app.ready()

const { document, diagnostics } = openapiDocument(app.graph(), openapiOptions)
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'openapi.json')

writeFileSync(target, JSON.stringify(document, null, 2) + '\n', 'utf8')

console.log(`\n  wrote ${target}`)
console.log(`  ${Object.keys(document.paths).length} paths · ` +
  `${Object.keys(document.components?.schemas ?? {}).length} components · ` +
  `${JSON.stringify(document).length.toLocaleString()} bytes`)

if (diagnostics.length > 0) {
  console.log('\n  diagnostics:')
  for (const diagnostic of diagnostics) {
    console.log(`    ${diagnostic.severity.padEnd(7)} ${diagnostic.code}  ${diagnostic.where}`)
    console.log(`            ${diagnostic.message}`)
  }
}
console.log('')

await app.close('emit')
