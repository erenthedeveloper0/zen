/**
 * §3.1's dependency rule, checked — no module in `@erenthedeveloper0/zen-core`
 * imports from a higher stratum than its own.
 *
 * `node scripts/check-strata.ts`
 *
 * §3.1 said the strata were "enforced in CI by `dependency-cruiser`", and until
 * `0.1.0-alpha.4` nothing enforced them; HANDOFF said "by convention", which
 * was the true sentence. This is the enforcement, with no dependency: it reads
 * every `import`, `export … from` and `import()` specifier under
 * `packages/core/src`, places both ends on the ladder by their directory, and
 * fails on an edge that points up unless {@link ALLOWED} names it with the
 * reason it exists. An allowance whose import is gone fails too, so the list
 * cannot outlive the code it excuses.
 *
 * Same-stratum imports are allowed — `di/` reads the slot table in `registry/`
 * the way two files in one directory read each other. `index.ts` is the
 * package's entry point and re-exports every stratum, so it is not on the
 * ladder.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'packages', 'core', 'src')

/** §3.1, §3.2 and HANDOFF §4. `errors` imports nothing and sits with the contracts. */
const STRATA: Readonly<Record<string, number>> = {
  primitives: 0,
  contracts: 1,
  errors: 1,
  registry: 2,
  di: 2,
  compile: 3,
  runtime: 4,
  api: 5,
}

/**
 * Upward imports that are the design, not a slip — `from → to`, and why.
 *
 * All three are compilers whose output must call exactly what its interpreted
 * twin calls (I6): a generated function that re-implemented the runtime's
 * helpers would be a second implementation that could disagree with the first,
 * which is the failure the differential suites exist to catch.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'compile/validation.ts → runtime/context.ts':
    'type only: the context shape validation writes `ctx.body`/`ctx.query` into',
  'compile/validation.ts → runtime/body.ts':
    "`mediaTypeOf`, so validation's media-type decisions are intake's, not a second parse",
  'compile/pipeline-compiler.ts → runtime/response-engine.ts':
    'the generated pipeline finalises replies through the same engine as the interpreted one',
  'compile/pipeline-compiler.ts → runtime/deadline.ts':
    'the generated stage boundaries check the deadline the interpreted pipeline checks (§4.4)',
  'compile/context-compiler.ts → runtime/context.ts':
    "the generated context class shares PlainContext's helpers, so the twins cannot diverge",
  'compile/context-compiler.ts → runtime/query.ts': 'the same query parser in both context twins',
  'compile/context-compiler.ts → runtime/cookies.ts': 'the same cookie parser in both context twins',
  'compile/context-compiler.ts → runtime/reply.ts': 'the same reply constructors in both context twins',
  'compile/context-compiler.ts → runtime/sse.ts': 'the same SSE channel in both context twins',
  'compile/context-compiler.ts → runtime/deadline.ts': 'type only: the deadline field both twins carry',
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
  })
}

/** `compile/serializer.ts`, and the directory that places it on the ladder. */
function place(path: string): { readonly name: string; readonly layer: string | null } {
  const name = relative(SRC, path).split(sep).join('/')
  const top = name.includes('/') ? (name.split('/')[0] as string) : null
  return { name, layer: top }
}

const failures: string[] = []
const used = new Set<string>()
let edges = 0

for (const path of files(SRC)) {
  const from = place(path)
  if (from.layer === null) continue
  const fromRank = STRATA[from.layer]
  if (fromRank === undefined) {
    failures.push(`${from.name}: directory "${from.layer}" is on no stratum — add it to STRATA in scripts/check-strata.ts`)
    continue
  }

  // Comment lines are documentation, not imports: a `@example` showing
  // `import … from '../runtime/x.ts'` is not an edge.
  const code = readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
  for (const match of code.matchAll(SPECIFIER)) {
    const to = place(resolve(dirname(path), match[1] as string))
    if (to.layer === null || to.layer === from.layer) continue
    edges++
    const toRank = STRATA[to.layer]
    if (toRank === undefined || toRank <= fromRank) continue
    const edge = `${from.name} → ${to.name}`
    if (ALLOWED[edge] !== undefined) {
      used.add(edge)
      continue
    }
    failures.push(
      `${edge}\n    ${from.layer} is stratum ${fromRank} and ${to.layer} is stratum ${toRank}: an import may only point down (§3.1).\n` +
        '    fix: move what is shared to the lower stratum, or depend on a contract; an upward edge that is the design goes in ALLOWED, with its reason',
    )
  }
}

for (const edge of Object.keys(ALLOWED)) {
  if (!used.has(edge)) failures.push(`${edge}\n    is allowed, and no longer exists — remove it from ALLOWED`)
}

console.log(`${edges} cross-directory imports in packages/core/src; ${used.size} upward, each allowed with its reason.`)
if (failures.length > 0) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log('Every other import points down the ladder (§3.1).')
