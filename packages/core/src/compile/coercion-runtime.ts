import type { BooleanWords } from '../contracts/coercion.ts'

/**
 * The primitive conversions — rfcs/0001 §11.4.
 *
 * Shared verbatim by the compiled coercer and the walking twin, which is what
 * makes the differential suite meaningful: the two engines differ in *control
 * flow* (unrolled call sites versus a loop over a plan) and not in what a
 * string becomes. A bug found by the fuzzer is therefore always a bug in the
 * traversal, never a disagreement about arithmetic.
 *
 * Every function here obeys the rule that decides the whole subsystem's
 * character: **a value it will not convert is returned unchanged.** Coercion is
 * not a second validator and has no error channel. `?page=banana` reaches the
 * schema as the string `'banana'` and is rejected by the schema, with the
 * schema's message, its path, and its issue code — rather than by a coercion
 * layer that would have to invent all three and would then own an error format
 * nobody else in the framework speaks.
 */

/**
 * A deliberately strict decimal grammar, and the reason this is a regex rather
 * than a bare `Number()`.
 *
 * `Number('')` is `0`, `Number(' ')` is `0`, `Number('0x1f')` is `31`,
 * `Number('Infinity')` is `Infinity` and `Number('1_000')` is `NaN`. Three of
 * those five are silent, wrong, and reachable from a query string, and the one
 * that hurts is the first: an app that reads `?limit=` and gets `0` back has a
 * pagination bug that looks like a database bug.
 *
 * Linear-time by construction: no nested quantifiers, no alternation that can
 * backtrack across the same input twice.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * `'42'` → `42`. Everything else — including `''`, `'0x10'`, `'Infinity'` and
 * `'NaN'` — is returned as it arrived.
 */
export function coerceNumber(value: string): string | number {
  if (value.length === 0 || value.length > 32 || !DECIMAL.test(value)) return value
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

/**
 * As `coerceNumber`, but refuses to lose precision silently.
 *
 * `'9007199254740993'` — a perfectly ordinary Postgres `bigint` id — becomes
 * `9007199254740992` under `Number()`, and the request then updates the wrong
 * row. That is a data-corruption bug produced by a convenience feature, so an
 * integer-typed position whose value does not survive the round trip is left as
 * a string and the schema reports a type error. A visible 400 beats a silent
 * off-by-one on a primary key.
 *
 * A value that converts to a *non-integer* — `'3.5'` against `z.number().int()`
 * — is still coerced, because the schema's own "expected integer, received
 * 3.5" is a better message than the type error the string would have produced.
 */
export function coerceInteger(value: string): string | number {
  const n = coerceNumber(value)
  if (typeof n !== 'number') return value
  return Number.isInteger(n) && !Number.isSafeInteger(n) ? value : n
}

/** The default word lists, pre-lowercased and closed over as a `switch`. */
export function coerceBoolean(value: string): string | boolean {
  switch (value.length > 5 ? '' : value.toLowerCase()) {
    case 'true': case '1': case 'yes': case 'on': return true
    case 'false': case '0': case 'no': case 'off': return false
    default: return value
  }
}

/** Custom word lists — `booleans: { true: ['y'], false: ['n'] }`. */
export function coerceBooleanIn(value: string, words: BooleanWords): string | boolean {
  const lower = value.toLowerCase()
  for (const word of words.true) if (word === lower) return true
  for (const word of words.false) if (word === lower) return false
  return value
}

/**
 * `'a, b'` → `['a', 'b']`, with RFC 9110's optional whitespace trimmed.
 *
 * An empty input yields `[]` rather than `['']`, which is what an empty list
 * header means. A single value with no separator yields a one-element array —
 * the *point* of the array style, not an accident of it.
 */
export function splitList(value: string, separator: string): string[] {
  if (value.length === 0) return []
  const out: string[] = []
  let start = 0
  for (;;) {
    const at = value.indexOf(separator, start)
    const end = at === -1 ? value.length : at
    out.push(trimOws(value, start, end))
    if (at === -1) return out
    start = at + separator.length
  }
}

function trimOws(source: string, start: number, end: number): string {
  let a = start
  let b = end
  while (a < b && isOws(source.charCodeAt(a))) a++
  while (b > a && isOws(source.charCodeAt(b - 1))) b--
  return a === start && b === end ? source.slice(start, end) : source.slice(a, b)
}

function isOws(code: number): boolean {
  return code === 32 || code === 9
}

/**
 * The runtime table handed to generated code, mirroring
 * `serializer-runtime.ts`'s `makeRuntime`.
 *
 * Named so that emitted source reads as `$num(v)` rather than carrying a
 * duplicate copy of the decimal grammar — one definition of what a number on
 * the wire is, shared by both engines and by anything that later wants to
 * document it.
 */
export interface CoerceRuntime {
  readonly num: typeof coerceNumber
  readonly int: typeof coerceInteger
  readonly bool: typeof coerceBoolean
  readonly boolIn: typeof coerceBooleanIn
  readonly split: typeof splitList
}

export const COERCE_RUNTIME: CoerceRuntime = Object.freeze({
  num: coerceNumber,
  int: coerceInteger,
  bool: coerceBoolean,
  boolIn: coerceBooleanIn,
  split: splitList,
})
