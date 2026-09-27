import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { diffDocuments, openapiDocument, type OpenApiDocument } from '@erenthedeveloper0/zen-openapi'
import { build } from '../src/app.ts'
import { openapiOptions } from '../src/config/zen.config.ts'

/**
 * The API compatibility gate — rfcs/0001 §29.5. `npm run check-api`.
 *
 * Diffs the document this branch generates against the committed baseline and
 * fails on a breaking change. The point is not the diff; it is that an API
 * change stops being "a diff in a routes file" and becomes a reviewable
 * statement about compatibility, on the pull request, before it ships.
 *
 * Try it: delete a field from `PublicUser`, or rename a route's `name`, and run
 * this. Then add an optional field and see it pass.
 */
const root = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(root, '..', 'api', 'openapi.json')

let baseline: OpenApiDocument
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as OpenApiDocument
} catch {
  console.error(`\n  No baseline at ${baselinePath}. Run \`npm run emit\` first.\n`)
  process.exit(2)
}

const app = build({ dev: false })
await app.ready()
const { document } = openapiDocument(app.graph(), openapiOptions)
await app.close('check')

const result = diffDocuments(baseline, document)

console.log(`\n  API diff — baseline v${baseline.info.version} → current v${document.info.version}\n`)

if (result.changes.length === 0) {
  console.log('  No changes.\n')
  process.exit(0)
}

const show = (title: string, changes: readonly { code: string; message: string; location: string }[]) => {
  if (changes.length === 0) return
  console.log(`  ${title} (${changes.length})`)
  for (const change of changes) {
    console.log(`    ${change.location}`)
    console.log(`      ${change.message}  [${change.code}]`)
  }
  console.log('')
}

show('BREAKING', result.breaking)
show('compatible', result.compatible)
show('documentation', result.documentation)

if (result.breaking.length > 0) {
  console.error(
    `  ${result.breaking.length} breaking change(s). Bump the major version and update the baseline\n` +
    '  with `npm run emit`, or reconsider the change.\n',
  )
  process.exit(1)
}

console.log('  No breaking changes.\n')
