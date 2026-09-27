/**
 * Bump every package to one version, and every internal pin with it.
 *
 * `node scripts/version.ts 0.1.0-alpha.2`
 *
 * The packages publish in lockstep and depend on each other by **exact**
 * version, which makes "which core does this adapter want"
 * a question with one answer. `npm version --workspaces` bumps the `version`
 * fields and leaves every internal dependency pointing at the old one — five
 * files to fix by hand and the sort of thing to get wrong exactly once, on a
 * release. This does all of it, including the examples: they are workspaces,
 * and a workspace dependency whose range the local package no longer satisfies
 * is one npm goes to the registry for.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const next = process.argv[2]
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
if (next === undefined || !SEMVER.test(next)) {
  console.error('usage: node scripts/version.ts <version>    e.g. 0.1.0-alpha.2')
  process.exit(1)
}

const manifests: string[] = []
for (const group of ['packages', 'examples']) {
  for (const entry of readdirSync(group)) {
    const file = join(group, entry, 'package.json')
    if (existsSync(file)) manifests.push(file)
  }
}

type Manifest = {
  name: string
  version: string
  private?: boolean
  [section: string]: unknown
}

const read = (file: string): Manifest => JSON.parse(readFileSync(file, 'utf8')) as Manifest
const published = new Set(manifests.filter((f) => f.startsWith('packages')).map((f) => read(f).name))

let changed = 0
for (const file of manifests) {
  const pkg = read(file)
  if (file.startsWith('packages')) pkg.version = next
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[section] as Record<string, string> | undefined
    if (deps === undefined) continue
    for (const name of Object.keys(deps)) {
      if (published.has(name)) deps[name] = next
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  changed++
}

console.log(`\n  ${published.size} packages → ${next}  (${changed} manifests updated)\n`)
console.log('  Next:')
console.log('    npm install              # refresh package-lock.json')
console.log(`    update CHANGELOG.md      # "## [${next}] — <date>"; check-release.ts refuses a release without it`)
console.log(`    git commit -am "release: v${next}" && git tag -a v${next} -m v${next} && git push --follow-tags\n`)
