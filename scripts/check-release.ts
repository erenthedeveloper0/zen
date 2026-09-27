/**
 * Refuse a release whose tag and packages disagree.
 *
 * `node scripts/check-release.ts 0.1.0-alpha.2`
 *
 * Run by `.github/workflows/release.yml` before anything is published. Three
 * ways a lockstep release goes wrong, each of them permanent once on npm:
 * a package left at the old version, an internal pin pointing at a version
 * that will never be published, and a tag that says one thing while the
 * tarballs say another. A fourth, less permanent and just as public: a
 * CHANGELOG with no dated entry for the version, which the GitHub release is
 * made from.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const expected = process.argv[2]
if (expected === undefined) {
  console.error('usage: node scripts/check-release.ts <version>')
  process.exit(1)
}

type Manifest = { name: string; version: string; private?: boolean; [k: string]: unknown }
const manifests: Array<{ file: string; pkg: Manifest }> = []
for (const group of ['packages', 'examples']) {
  for (const entry of readdirSync(group)) {
    const file = join(group, entry, 'package.json')
    if (existsSync(file)) manifests.push({ file, pkg: JSON.parse(readFileSync(file, 'utf8')) as Manifest })
  }
}

const published = manifests.filter((m) => m.file.startsWith('packages'))
const names = new Set(published.map((m) => m.pkg.name))
const problems: string[] = []

for (const { file, pkg } of published) {
  if (pkg.version !== expected) problems.push(`${pkg.name} is ${pkg.version}, the tag says ${expected} (${file})`)
  if (pkg.private === true) problems.push(`${pkg.name} is private and would not publish (${file})`)
}

for (const { file, pkg } of manifests) {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = (pkg[section] ?? {}) as Record<string, string>
    for (const [name, range] of Object.entries(deps)) {
      if (names.has(name) && range !== expected) {
        problems.push(`${pkg.name} pins ${name}@${range} in ${section}, not ${expected} (${file})`)
      }
    }
  }
}

const manifestProblems = problems.length

// The GitHub release is this version's CHANGELOG section (release.yml), so an
// entry that is missing — or still says "unreleased" — would ship a release
// page with nothing true on it. Refused here, before anything reaches npm.
const entry = readFileSync('CHANGELOG.md', 'utf8').split('\n').find((line) => line.startsWith(`## [${expected}]`))
if (entry === undefined) problems.push(`CHANGELOG.md has no "## [${expected}]" entry — write it before tagging`)
else if (!/ — \d{4}-\d{2}-\d{2}$/.test(entry)) problems.push(`CHANGELOG.md's entry is not dated ("${entry}") — put the release date in place of "unreleased"`)

if (problems.length > 0) {
  console.error(`\n  Release ${expected} refused — ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`)
  for (const problem of problems) console.error(`    ✖ ${problem}`)
  if (manifestProblems > 0) console.error('\n  fix: node scripts/version.ts ' + expected)
  console.error('')
  process.exit(1)
}

console.log(`\n  ✔ ${published.length} packages at ${expected}, every internal pin agrees, and CHANGELOG.md has its dated entry\n`)
