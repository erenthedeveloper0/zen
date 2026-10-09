/**
 * Every regular expression in the framework's sources, checked for unbounded
 * backtracking — rfcs/0001 §19.3.
 *
 * `node scripts/check-regex.ts`
 *
 * §19.3 said a CI lint "rejects regexes with nested quantifiers in framework
 * source", and until `0.1.0-alpha.4` nothing did. This is that lint, with no
 * ESLint: TypeScript's own parser finds every regex literal and every
 * `RegExp(…)` call under `packages/*\/src`, and the analyser core uses for
 * `app.paramType()`'s development warning (`primitives/regex-safety.ts`)
 * judges each one. A pattern it refuses fails the build with its file, line
 * and the repetition that is ambiguous.
 *
 * Two things fail it besides a hazard, because each is a way for the check to
 * pass without having looked:
 *
 *   - **A `RegExp` built from something that is not a literal** cannot be read
 *     here. Each one must be named in {@link DYNAMIC} with the reason it is
 *     safe, or the run fails.
 *   - **A pattern the analyser cannot parse** is reported, not skipped: it
 *     compiled, so the analyser is wrong about it, and a silent skip is how a
 *     lint quietly stops covering a file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { regexHazards } from '../packages/core/src/primitives/regex-safety.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * `RegExp` calls whose pattern is not a literal, by `file:line`, and why each
 * is outside this check.
 */
const DYNAMIC: Readonly<Record<string, string>> = {
  'packages/middleware/src/cors.ts:379':
    "the application's own `origin: RegExp`, copied once at boot without the `g` flag; its pattern is the user's choice (§32.1)",
}

interface Found {
  readonly where: string
  readonly source: string
  readonly flags: string
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) out.push(path)
  }
  return out
}

function literalText(node: ts.Expression | undefined): string | null {
  if (node === undefined) return ''
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

const found: Found[] = []
const dynamic: string[] = []
let files = 0

for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  let paths: string[]
  try {
    paths = sourceFiles(join(ROOT, 'packages', pkg, 'src'))
  } catch {
    continue
  }
  for (const path of paths) {
    files++
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const where = (node: ts.Node): string =>
      `${relative(ROOT, path).split('\\').join('/')}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`

    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const text = (node as ts.RegularExpressionLiteral).text
        const close = text.lastIndexOf('/')
        found.push({ where: where(node), source: text.slice(1, close), flags: text.slice(close + 1) })
      } else if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) && node.expression.text === 'RegExp'
      ) {
        const source = literalText(node.arguments?.[0])
        const flags = literalText(node.arguments?.[1])
        if (source === null || flags === null) dynamic.push(where(node))
        else found.push({ where: where(node), source, flags })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
}

const failures: string[] = []
for (const regex of found) {
  try {
    for (const hazard of regexHazards(regex.source, regex.flags)) {
      failures.push(
        `${regex.where}  /${regex.source}/${regex.flags}\n` +
          `    ${hazard.kind === 'nested-quantifier' ? 'a variable repetition inside an unbounded one' : 'alternatives under a repetition that can match the same text'}: ${hazard.fragment}\n` +
          '    fix: make each repetition start or end with a character the repeated part cannot match, or bound it',
      )
    }
  } catch (error) {
    failures.push(`${regex.where}  /${regex.source}/${regex.flags}\n    the analyser cannot read it: ${(error as Error).message}`)
  }
}

const unlisted = dynamic.filter((where) => DYNAMIC[where] === undefined)
for (const where of unlisted) {
  failures.push(`${where}  RegExp(…) from a value that is not a literal\n    fix: name it in DYNAMIC in scripts/check-regex.ts with the reason it is safe`)
}
const stale = Object.keys(DYNAMIC).filter((where) => !dynamic.includes(where))
for (const where of stale) {
  failures.push(`${where}  is listed in DYNAMIC, and no dynamic RegExp is there any more\n    fix: remove the entry`)
}

console.log(`${found.length} regular expressions in ${files} source files; ${dynamic.length} built from a value, each listed.`)
if (failures.length > 0) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'} (§19.3):\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log('No regular expression in framework source can backtrack without bound.')
