import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Remove build output — `npm run clean`.
 *
 * Worth having for one specific failure: `tsc -b` decides what to rebuild from
 * `.tsbuildinfo`, so a stale one after a branch switch produces a `dist/` that
 * does not match `src/`. Tests import the built `dist/` through the package
 * `exports` map, which means the symptom is a test asserting against code that
 * is no longer in the repository — and no amount of re-reading the source
 * explains it.
 */
const roots = ['packages', 'examples']
let removed = 0

for (const root of roots) {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    continue
  }
  for (const name of entries) {
    const pkg = join(root, name)
    if (!isDirectory(pkg)) continue
    for (const target of ['dist', 'tsconfig.tsbuildinfo', '.tsbuildinfo']) {
      const path = join(pkg, target)
      if (!exists(path)) continue
      rmSync(path, { recursive: true, force: true })
      console.log(`  removed ${path}`)
      removed++
    }
  }
}

console.log(removed === 0 ? '\n  nothing to clean\n' : `\n  cleaned ${removed} path(s)\n`)

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
