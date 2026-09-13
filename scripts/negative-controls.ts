/**
 * Negative controls — HANDOFF convention #3.
 *
 * `node scripts/negative-controls.ts [pattern]`
 *
 * > *A test that passes against the bug is not a test. Before trusting a new
 * > assertion, break the thing it covers and watch it fail.*
 *
 * Every pass of this codebase has run that by hand, and the pass that built the
 * middleware pack wrote down what it cost: *"worth rebuilding as a script next
 * pass rather than doing by hand — it is ~120 lines of patch the source, run one
 * suite, require a failure, restore, and it paid for itself immediately."* This
 * is that script.
 *
 * Each control names a real defect, states which assertion is supposed to catch
 * it, patches exactly one string in one source file, rebuilds, runs one suite,
 * and requires a **failure**. A control that passes is reported as `NOT CAUGHT`
 * and fails the run — the suite it names is proving less than it looks like it
 * is.
 *
 * Three things it refuses to do quietly, because each is a way for a control to
 * become theatre:
 *
 *   - **A `find` string that does not occur exactly once is a stale control**,
 *     not a passing one. Reported as `STALE` and fails the run. This is the
 *     failure mode that would otherwise arrive silently the first time somebody
 *     reformats the line a control depends on.
 *   - **A patch that does not compile is not a control.** The suite would run
 *     against the previous `dist/` and pass, which reads exactly like "the
 *     control was not caught". Reported as `BUILD FAILED`.
 *   - **Sources are restored in a `finally`,** and the run ends with a rebuild,
 *     so an interrupted run leaves the tree as it found it.
 *
 * Note the shape of what is being asserted here: not that the code is correct,
 * but that the *tests* are load-bearing. That is a different property and
 * nothing else in the repo checks it.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

interface Control {
  /** The defect, phrased as what a careless implementation would do. */
  readonly name: string
  readonly file: string
  readonly find: string
  readonly replace: string
  readonly suite: string
  /** Which assertion is supposed to notice. Printed on a miss. */
  readonly caughtBy: string
}

const CORE = 'packages/core/src'

const CONTROLS: readonly Control[] = [
  // ── §13.4: the match ──────────────────────────────────────────────────────
  {
    name: 'score by the highest q among matching ranges, not the most specific one',
    file: `${CORE}/compile/media-type.ts`,
    find: '    if (range.specificity > bestSpecificity) {',
    replace: '    if (range.specificity >= -1) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"an explicit q=0 is honoured even under a wildcard that allows everything"',
  },
  {
    name: 'let an offer the client refused (q=0) win when nothing else matched',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '  let bestIndex = -1\n  let best = 0',
    replace: '  let bestIndex = -1\n  let best = -1',
    suite: 'packages/core/test/negotiation-properties.test.ts',
    caughtBy: 'invariant 5, "a refused representation is never served"',
  },
  {
    name: 'break a quality tie in favour of the last offer instead of the server preference',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '    if (q > best) {',
    replace: '    if (q >= best) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a tie goes to the server, not to the alphabet"',
  },
  {
    name: 'treat a malformed Accept as unsatisfiable instead of as absent',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '  if (ranges === null) return 0',
    replace: '  if (ranges === null) return -1',
    suite: 'packages/core/test/negotiation-properties.test.ts',
    caughtBy: 'invariant 3, "liveness", and the unparseable branch of the property suite',
  },

  // ── §13.4: Vary, and the 406 ──────────────────────────────────────────────
  {
    name: 'stage Vary: Accept only when the request actually sent an Accept header',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '    const staged = ctx.$resHeaders',
    replace: '    if (ctx.raw.header(\'accept\') === undefined) { ctx.$negotiated = negotiator(undefined); return }\n    const staged = ctx.$resHeaders',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"Vary: Accept is present with no Accept header, and on the 406"',
  },
  {
    name: 'answer 406 without saying what the route can produce',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '    { details: { available } },',
    replace: '    {},',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"an unacceptable Accept is a 406 that lists what the route can produce"',
  },

  // ── §13.4: binding the contract ───────────────────────────────────────────
  {
    name: 'give a plain-form status the negotiated Content-Type',
    file: `${CORE}/runtime/response-engine.ts`,
    find: '  if (chosen !== null && chosen.statuses.has(status)) {',
    replace: '  if (chosen !== null) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a status declared in the plain form keeps its own Content-Type"',
  },
  {
    name: 'drop the negotiated media when an onSerialize hook replaces the payload',
    file: `${CORE}/runtime/response-engine.ts`,
    find: "    ;(reply as MutableReply).body = { kind: 'json', value, serialize: body.serialize, media: body.media }",
    replace: "    ;(reply as MutableReply).body = { kind: 'json', value, serialize: body.serialize }",
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"an onSerialize hook that swaps the payload keeps the representation"',
  },

  // ── §9.4: the zero-cost rule ──────────────────────────────────────────────
  {
    name: 'emit the negotiation step on every route, not only on negotiated ones',
    file: `${CORE}/compile/pipeline-compiler.ts`,
    find: '  const negotiates = (spec.negotiate ?? null) !== null',
    replace: '  const negotiates = true',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a plain route emits a pipeline byte-identical to one in an app with no negotiation"',
  },

  // ── §12.7: the boot diagnostics ───────────────────────────────────────────
  {
    name: 'accept the same media type declared twice',
    file: `${CORE}/compile/negotiation.ts`,
    find: '      if (offers.includes(parsed.media)) {',
    // Not `if (false)`: TypeScript reports the `continue` below as unreachable
    // and the patch stops compiling, which this script correctly refuses to
    // score as a caught control. The condition has to be opaque to the checker.
    replace: '      if (offers.includes(parsed.media) && offers.length < 0) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"the same media type twice is refused, because only one could be reached"',
  },
  {
    name: 'let two statuses on one route offer different media types',
    file: `${CORE}/compile/negotiation.ts`,
    find: '    if (offers.length === reference.length && offers.every((m, i) => m === reference[i])) continue',
    replace: '    continue',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"two statuses offering different media types is refused, naming both"',
  },
  {
    name: 'require every key to be a media type, so one typo hides the whole declaration',
    file: `${CORE}/compile/media-type.ts`,
    find: '  for (const key of Object.keys(value)) {\n    if (key.indexOf(\'/\') !== -1) return true\n  }\n  return false',
    replace: '  const keys = Object.keys(value)\n  if (keys.length === 0) return false\n  for (const key of keys) {\n    if (key.indexOf(\'/\') === -1) return false\n  }\n  return true',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a typo alongside real media types names the typo, not the schema"',
  },
]

// ─────────────────────────────────────────────────────────────────────────────

const filter = process.argv[2]
const selected = filter === undefined
  ? CONTROLS
  : CONTROLS.filter((c) => c.name.includes(filter) || c.file.includes(filter))

if (selected.length === 0) {
  console.error(`No control matches "${filter}".`)
  process.exit(1)
}

type Outcome = 'CAUGHT' | 'NOT CAUGHT' | 'STALE' | 'BUILD FAILED'

/**
 * `process.execPath` and a resolved script path, never a shell.
 *
 * `spawnSync('npx', args, { shell: true })` is the obvious way to write this on
 * Windows and it is the wrong one: with `shell: true` the arguments are
 * concatenated rather than escaped, which Node now warns about (DEP0190), and
 * this script's arguments include file paths from a table anyone can edit.
 */
const run = (args: readonly string[]): number =>
  spawnSync(process.execPath, args as string[], { stdio: 'pipe' }).status ?? 1

const TSC = 'node_modules/typescript/bin/tsc'
const build = (): boolean => run([TSC, '-b']) === 0

console.log('\n  Negative controls — HANDOFF convention #3')
console.log(`  ${selected.length} control${selected.length === 1 ? '' : 's'}, each must make its suite fail\n`)

if (!build()) {
  console.error('  The tree does not compile before any control was applied. Fix that first.')
  process.exit(1)
}

const results: Array<{ control: Control; outcome: Outcome }> = []

for (const control of selected) {
  const original = readFileSync(control.file, 'utf8')
  let outcome: Outcome

  try {
    const occurrences = original.split(control.find).length - 1
    if (occurrences !== 1) {
      // Not a pass and not a failure: the control no longer describes the code,
      // which means it has been proving nothing since whenever that changed.
      outcome = 'STALE'
      results.push({ control, outcome })
      report(control, outcome, `expected 1 occurrence of the patch site, found ${occurrences}`)
      continue
    }

    writeFileSync(control.file, original.replace(control.find, control.replace), 'utf8')

    if (!build()) {
      outcome = 'BUILD FAILED'
    } else {
      const status = run(['--test', control.suite])
      outcome = status === 0 ? 'NOT CAUGHT' : 'CAUGHT'
    }
  } finally {
    writeFileSync(control.file, original, 'utf8')
  }

  results.push({ control, outcome: outcome! })
  report(control, outcome!)
}

// Leave the tree exactly as it was found, compiled.
if (!build()) {
  console.error('\n  The tree does not compile after restoring. This is a bug in this script.')
  process.exit(1)
}

const missed = results.filter((r) => r.outcome !== 'CAUGHT')
console.log(`\n  ${results.length - missed.length}/${results.length} controls caught\n`)

if (missed.length > 0) {
  for (const { control, outcome } of missed) {
    console.log(`  ${outcome}: ${control.name}`)
    console.log(`    ${control.caughtBy} did not fail — that assertion is not load-bearing.`)
  }
  console.log('')
  process.exitCode = 1
}

function report(control: Control, outcome: Outcome, detail?: string): void {
  const mark = outcome === 'CAUGHT' ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} ${outcome.padEnd(12)} ${control.name}`)
  if (detail !== undefined) console.log(`       ${detail}`)
}
