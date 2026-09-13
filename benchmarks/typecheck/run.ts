import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generateFixture, type FixtureSpec } from './generate.ts'

/**
 * The M2 go/no-go gate — rfcs/0001 §25, §28.2.
 *
 *     node benchmarks/typecheck/run.ts
 *
 * Reports `tsc --noEmit` wall time for realistically-shaped apps. A type-level
 * performance regression is as user-visible as a runtime one and is usually
 * noticed far too late, so it is measured here rather than hoped about.
 */

const here = dirname(fileURLToPath(import.meta.url))
const generated = join(here, '.generated')
const repoRoot = join(here, '..', '..')

const MATRIX: FixtureSpec[] = [
  { routes: 50, plugins: 4, files: 5, seal: false },
  { routes: 100, plugins: 4, files: 10, seal: false },
  { routes: 250, plugins: 8, files: 10, seal: false },
  { routes: 500, plugins: 12, files: 20, seal: false },
  { routes: 500, plugins: 12, files: 20, seal: true },
]

/**
 * Best of `REPS`, not one cold run.
 *
 * The first version of this harness reported a single run per cell, and §28.2
 * records what that cost: a `seal()` figure that moved between -0.6% and -10.4%
 * across reruns of an unchanged codebase, and an absolute wall time that halved
 * between two sessions on the same machine. A number nobody can reproduce is
 * not evidence, and this gate exists to accept or reject a type strategy.
 */
const REPS = 3

interface Result extends FixtureSpec {
  /** Best of `REPS` — the closest available estimate of the work itself. */
  readonly ms: number
  readonly worstMs: number
  readonly ok: boolean
  readonly output: string
}

function typecheck(dir: string): { ms: number; ok: boolean; output: string } {
  const started = performance.now()
  try {
    execFileSync(
      process.execPath,
      [join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js'), '--noEmit', '-p', join(dir, 'tsconfig.json')],
      { stdio: 'pipe', encoding: 'utf8' },
    )
    return { ms: performance.now() - started, ok: true, output: '' }
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string }
    return {
      ms: performance.now() - started,
      ok: false,
      output: `${shell.stdout ?? ''}${shell.stderr ?? ''}`.split('\n').slice(0, 8).join('\n'),
    }
  }
}

export async function runMatrix(matrix: readonly FixtureSpec[] = MATRIX, reps = REPS): Promise<Result[]> {
  const results: Result[] = []
  for (const spec of matrix) {
    const dir = generateFixture(generated, spec)

    let best = Infinity
    let worst = 0
    let ok = true
    let output = ''
    for (let rep = 0; rep < reps; rep++) {
      const run = typecheck(dir)
      best = Math.min(best, run.ms)
      worst = Math.max(worst, run.ms)
      // A type error is a type error on any run; keep the first one's detail.
      if (!run.ok && ok) { ok = false; output = run.output }
    }

    results.push({ ...spec, ms: best, worstMs: worst, ok, output })
  }
  return results
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('run.ts')) {
  console.log(`\n  Zen — type-check performance (M2 gate) — best of ${REPS}\n`)
  console.log('  routes  plugins  sealed   tsc        per-route   spread   status')
  console.log('  ' + '─'.repeat(70))

  const results = await runMatrix()
  for (const r of results) {
    const perRoute = (r.ms / r.routes).toFixed(2)
    const spread = `${(((r.worstMs - r.ms) / r.ms) * 100).toFixed(0)}%`
    console.log(
      `  ${String(r.routes).padStart(6)}  ${String(r.plugins).padStart(7)}  ` +
      `${(r.seal ? 'yes' : 'no').padStart(6)}   ${(r.ms / 1000).toFixed(2).padStart(6)}s   ` +
      `${perRoute.padStart(7)}ms   ${spread.padStart(6)}   ${r.ok ? 'ok' : 'FAILED'}`,
    )
    if (!r.ok) console.log(`\n${r.output}\n`)
  }

  const worst = results.reduce((a, b) => (a.ms > b.ms ? a : b))
  console.log(`\n  worst case: ${(worst.ms / 1000).toFixed(2)}s at ${worst.routes} routes / ${worst.plugins} plugins`)

  const sealed = results.find((r) => r.seal)
  const open = results.find((r) => !r.seal && r.routes === sealed?.routes && r.plugins === sealed.plugins)
  if (sealed && open) {
    const delta = ((open.ms - sealed.ms) / open.ms) * 100
    // Reported against the run-to-run spread, because a 3% win inside an 8%
    // spread is not a win — and §28.2 says so on the record.
    const noise = Math.max((open.worstMs - open.ms) / open.ms, (sealed.worstMs - sealed.ms) / sealed.ms) * 100
    const verdict = Math.abs(delta) > noise ? 'above noise' : `INSIDE NOISE (spread ${noise.toFixed(0)}%)`
    console.log(`  seal() effect: ${delta >= 0 ? '-' : '+'}${Math.abs(delta).toFixed(1)}% vs unsealed — ${verdict}\n`)
  }

  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}
