import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generateFixture } from '../../../benchmarks/typecheck/generate.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const tsc = join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js')

function typecheck(project: string): { ok: boolean; output: string; ms: number } {
  const started = performance.now()
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', project], { stdio: 'pipe', encoding: 'utf8' })
    return { ok: true, output: '', ms: performance.now() - started }
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${shell.stdout ?? ''}${shell.stderr ?? ''}`, ms: performance.now() - started }
  }
}

describe('type-level tests (§20.4)', () => {
  /**
   * The inference suite is checked, not executed. Every `@ts-expect-error` in it
   * is a negative assertion: if one stops being an error, tsc reports an unused
   * directive and this test fails — so "reading ctx.body on a route with no body
   * schema is a compile error" cannot silently regress into `any`.
   */
  test('packages/core/test/types compiles with no errors', () => {
    const result = typecheck(join(here, 'types', 'tsconfig.json'))
    assert.equal(result.ok, true, `type tests failed:\n${result.output}`)
  })
})

describe('type-check performance gate (§28.2, M2)', () => {
  /**
   * The M2 go/no-go. Plugin type accumulation through the `.use()` builder chain
   * is the pattern that has made other type-heavy frameworks slow to check in
   * large codebases, and by the time users complain the API is frozen.
   *
   * The budget is deliberately loose — this guards against a *catastrophic*
   * regression (an accidentally-quadratic conditional type), not against normal
   * variance on shared CI hardware. `node benchmarks/typecheck/run.ts` reports
   * the full matrix for tracking real numbers.
   */
  test('250 routes across 8 plugins type-checks within budget', () => {
    const dir = generateFixture(join(repoRoot, 'benchmarks', 'typecheck', '.generated'), {
      routes: 250,
      plugins: 8,
      files: 10,
      seal: false,
    })

    const result = typecheck(join(dir, 'tsconfig.json'))
    assert.equal(result.ok, true, `fixture failed to type-check:\n${result.output.split('\n').slice(0, 20).join('\n')}`)

    const BUDGET_MS = 15_000
    assert.ok(
      result.ms < BUDGET_MS,
      `type-check took ${(result.ms / 1000).toFixed(2)}s, over the ${BUDGET_MS / 1000}s budget. ` +
        `Run \`node benchmarks/typecheck/run.ts\` and \`tsc --generateTrace\` to find the regression.`,
    )
  })

  test('a route handler on every verb infers ctx (no `any` fallback)', () => {
    // put/patch/delete/head/options originally lacked typed overloads, so `ctx`
    // silently degraded to `any` — an I8 violation the fixture caught. This
    // pins every verb so a newly added one cannot ship with half a surface.
    const dir = generateFixture(join(repoRoot, 'benchmarks', 'typecheck', '.generated'), {
      routes: 8,
      plugins: 1,
      files: 1,
      seal: false,
    })

    const result = typecheck(join(dir, 'tsconfig.json'))
    assert.equal(result.ok, true, result.output.split('\n').slice(0, 20).join('\n'))
    assert.doesNotMatch(result.output, /implicitly has an 'any' type/)
  })
})
