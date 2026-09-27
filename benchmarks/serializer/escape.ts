/**
 * Where the string-escape fast path stops being fast.
 *
 * `node benchmarks/serializer/escape.ts`
 *
 * `escapeString` scans with a regex and, if the string is clean, emits
 * `'"' + s + '"'` — avoiding `JSON.stringify` entirely. That is a win only up to
 * a point: V8's `JSON.stringify` has a C++ path for strings that scales better
 * than a JS-level scan plus concatenation. `NATIVE_ABOVE` in
 * `compile/serializer-runtime.ts` is the threshold this script measured, and it
 * is committed so the constant can be re-derived rather than trusted.
 *
 * Strings that *do* need escaping end in `JSON.stringify` either way, so above
 * the crossover the scan is pure overhead in both directions.
 */
import { escapeString } from '@visionpilot/zen-core'

const FILLER = 'abcdefghij klmnopqrs tuvwxyz0123456789'.repeat(20)
const LENGTHS = [4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 512] as const
const ITERATIONS = 500_000
const REPS = 5

function time(fn: (s: string) => string, input: string): number {
  let sink = 0
  for (let i = 0; i < 30_000; i++) sink += fn(input).length

  let best = Infinity
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < ITERATIONS; i++) sink += fn(input).length
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6)
  }
  if (sink < 0) throw new Error('unreachable')
  return (best * 1e6) / ITERATIONS
}

/** The scan-first strategy, without the length threshold `escapeString` applies. */
const NEEDS_ESCAPE = /[\u0000-\u001f"\\\ud800-\udfff]/
const scanFirst = (value: string): string =>
  NEEDS_ESCAPE.test(value) ? JSON.stringify(value) : `"${value}"`

console.log(`\n  String escaping — ns/op, best of ${REPS} × ${ITERATIONS.toLocaleString()}`)
console.log(`  node ${process.version}\n`)
console.log('   len   scan-first   JSON.stringify   winner')

for (const length of LENGTHS) {
  const sample = FILLER.slice(0, length)
  const scan = time(scanFirst, sample)
  const native = time(JSON.stringify, sample)
  const ratio = Math.max(scan, native) / Math.min(scan, native)
  console.log(
    `  ${String(length).padStart(4)}   ${scan.toFixed(1).padStart(8)}   ${native.toFixed(1).padStart(14)}   ` +
    `${scan < native ? 'scan-first' : 'JSON.stringify'} (${ratio.toFixed(2)}x)`,
  )
}

// Sanity: whatever the threshold, output must not change.
const cases = ['', 'plain', FILLER, `has "quotes"`, `${FILLER}"quote at the end"`]
const mismatched = cases.filter((value) => escapeString(value) !== JSON.stringify(value))
console.log(
  mismatched.length === 0
    ? '\n  escapeString output is identical to JSON.stringify on every sample\n'
    : `\n  MISMATCH on ${mismatched.length} sample(s)\n`,
)
process.exitCode = mismatched.length === 0 ? 0 : 1
