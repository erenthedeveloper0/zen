import type { ParamType, PathSegment, RouteDiagnostic, RouteRecord } from '@erenthedeveloper0/zen-core'
import { Codes } from '@erenthedeveloper0/zen-core'
import { BUILTIN_PARAM_TYPES } from './param-types.ts'

/**
 * Conflict classification — rfcs/0001 §5.5.
 *
 * Express resolves routes first-registered-wins with *silent* shadowing, which
 * is the source of a genuinely common production bug: `/users/new` registered
 * after `/users/:id` is unreachable and nothing tells you. Zen classifies every
 * pair at boot and refuses to guess where no priority rule makes the intent
 * obvious.
 */

const SPECIFICITY: Readonly<Record<string, number>> = { static: 3, typed: 2, param: 1, wildcard: 0 }

function rank(segment: PathSegment): number {
  if (segment.kind === 'static') return SPECIFICITY['static'] as number
  if (segment.kind === 'wildcard') return SPECIFICITY['wildcard'] as number
  return segment.type !== undefined ? (SPECIFICITY['typed'] as number) : (SPECIFICITY['param'] as number)
}

export interface AnalyzeOptions {
  readonly paramTypes: ReadonlyMap<string, ParamType>
}

export function analyzeRoutes(
  routes: readonly RouteRecord[],
  opts: AnalyzeOptions,
): RouteDiagnostic[] {
  const diagnostics: RouteDiagnostic[] = []
  const byMethod = new Map<string, RouteRecord[]>()

  for (const route of routes) {
    const list = byMethod.get(route.method)
    if (list) list.push(route)
    else byMethod.set(route.method, [route])
  }

  for (const group of byMethod.values()) {
    // Grouping by segment count keeps this O(n·k) rather than O(n²) overall:
    // routes of different arity can never collide unless a wildcard is involved.
    const byLength = new Map<number, RouteRecord[]>()
    const wildcards: RouteRecord[] = []

    for (const route of group) {
      if (route.segments.some((s) => s.kind === 'wildcard')) wildcards.push(route)
      const list = byLength.get(route.segments.length)
      if (list) list.push(route)
      else byLength.set(route.segments.length, [route])
    }

    for (const bucket of byLength.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i] as RouteRecord
          const b = bucket[j] as RouteRecord
          const { verdict, witness, undecided } = compare(a, b, opts)
          if (undecided !== null) {
            diagnostics.push({
              severity: 'warning',
              code: 'ZEN_ROUTE_TYPES_UNDECIDED',
              message:
                `${a.method} ${a.path} and ${b.method} ${b.path} differ only in parameter types ` +
                `<${undecided[0]}> and <${undecided[1]}>, and whether one value can satisfy both cannot be ` +
                `established. A value both accept is served by <${undecided[0] < undecided[1] ? undecided[0] : undecided[1]}>, the first by name.`,
              routes: [a, b],
              hint:
                'Give each application param type `jsonSchema.examples`, so boot can check them against ' +
                'each other — or make a segment static.',
            })
          }
          if (verdict === 'duplicate') {
            diagnostics.push({
              severity: 'error',
              code: Codes.ROUTE_DUPLICATE,
              message: `Duplicate route: ${a.method} ${a.path} is registered twice.`,
              routes: [a, b],
              hint: 'Remove one registration, or give them different paths.',
            })
          } else if (verdict === 'ambiguous') {
            diagnostics.push({
              severity: 'error',
              code: Codes.ROUTE_AMBIGUOUS,
              message:
                `Ambiguous routes: ${a.method} ${a.path} and ${a.method} ${b.path} ` +
                `can both match the same request${witness === null ? '' : ` (a segment of "${witness}" satisfies both)`}, ` +
                `and no priority rule separates them.`,
              routes: [a, b],
              hint:
                'Make one segment static, or narrow one parameter with a type ' +
                '(e.g. ":id<int>") so the matcher can tell them apart.',
            })
          }
        }
      }
    }

    // Wildcards shadow nothing (static always wins) but an unreachable route is
    // still worth a warning — a `zen doctor` nudge, not a boot failure.
    for (const wildcard of wildcards) {
      const prefix = wildcard.segments.filter((s) => s.kind !== 'wildcard').length
      for (const route of group) {
        if (route === wildcard) continue
        if (route.segments.length > prefix && sharesPrefix(wildcard, route, prefix)) {
          diagnostics.push({
            severity: 'warning',
            code: 'ZEN_ROUTE_SHADOWED_BY_WILDCARD',
            message: `${route.method} ${route.path} is more specific than the wildcard ${wildcard.path} and will win. This is probably what you want.`,
            routes: [wildcard, route],
          })
        }
      }
    }
  }

  return diagnostics
}

type Verdict = 'disjoint' | 'duplicate' | 'ambiguous' | 'ordered'

interface Comparison {
  readonly verdict: Verdict
  /** For an ambiguity between two param types: a value both accept. */
  readonly witness: string | null
  /** Two param types whose overlap could not be decided either way. */
  readonly undecided: readonly [string, string] | null
}

function compare(a: RouteRecord, b: RouteRecord, opts: AnalyzeOptions): Comparison {
  let aWins = false
  let bWins = false
  let witness: string | null = null
  let undecided: readonly [string, string] | null = null

  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i] as PathSegment
    const sb = b.segments[i] as PathSegment

    // Two *different* param types in one position. The same rank, so no
    // priority rule separates them: if some value satisfies both, which route
    // answers it is not decided by anything the author wrote — so it is
    // ambiguous (§5.5), not the "duplicate" equal ranks would otherwise read as.
    if (sa.kind === 'param' && sb.kind === 'param' && sa.type !== undefined && sb.type !== undefined && sa.type !== sb.type) {
      const shared = sharedValue(sa.type, sb.type, opts)
      if (shared === false) return { verdict: 'disjoint', witness: null, undecided: null }
      if (shared === null) {
        // Cannot be established either way. Treated as disjoint, with the
        // trie's deterministic order as the tie-break, and said out loud.
        undecided ??= [sa.type, sb.type]
        return { verdict: 'disjoint', witness: null, undecided }
      }
      witness = shared
      aWins = true
      bWins = true
      continue
    }

    if (!overlaps(sa, sb, opts)) return { verdict: 'disjoint', witness: null, undecided: null }

    const ra = rank(sa)
    const rb = rank(sb)
    if (ra > rb) aWins = true
    else if (rb > ra) bWins = true
  }

  if (!aWins && !bWins) return { verdict: 'duplicate', witness, undecided }
  if (aWins && bWins) return { verdict: 'ambiguous', witness, undecided }
  return { verdict: 'ordered', witness, undecided }
}

/** Can these two segments ever match the same concrete path segment? */
function overlaps(a: PathSegment, b: PathSegment, opts: AnalyzeOptions): boolean {
  if (a.kind === 'static' && b.kind === 'static') return a.value === b.value
  if (a.kind === 'static') return dynamicAccepts(b, a.value, opts)
  if (b.kind === 'static') return dynamicAccepts(a, b.value, opts)
  return true
}

/**
 * A value both param types accept; `false` when they provably share none;
 * `null` when it cannot be established.
 *
 * Deciding whether two predicates intersect is not possible in general, so this
 * is a search over *witnesses* — values each type is known to accept, tried
 * against the other type's test. For the builtins they are listed below and
 * chosen to hit every overlap there is: `42` is an int, a float, a slug and hex
 * at once. An application type contributes `jsonSchema.examples`, which it is
 * worth writing anyway because the OpenAPI document publishes them. A type with
 * no witnesses can only be proven to overlap by the *other* type's, which is
 * why an application type without examples usually lands in `null`.
 */
function sharedValue(left: string, right: string, opts: AnalyzeOptions): string | false | null {
  const a = opts.paramTypes.get(left)
  const b = opts.paramTypes.get(right)
  // An unknown type is reported by the router build, with the list of known
  // ones; this is not the place to report it twice.
  if (a === undefined || b === undefined) return false
  const fromA = witnessesOf(a)
  const fromB = witnessesOf(b)
  for (const value of fromA) if (safeTest(b, value)) return value
  for (const value of fromB) if (safeTest(a, value)) return value
  // Both sides were exercised and nothing crossed over: disjoint, as far as
  // anything can know. One side with nothing to offer is not evidence.
  return fromA.length > 0 && fromB.length > 0 ? false : null
}

function witnessesOf(type: ParamType): readonly string[] {
  // The builtin list belongs to the builtin itself — not to an application
  // type that was registered under the same name and accepts something else.
  if (BUILTIN_PARAM_TYPES.get(type.name) === type) return BUILTIN_WITNESSES[type.name] ?? []
  const examples = type.jsonSchema?.['examples']
  if (!Array.isArray(examples)) return []
  return examples.filter((value): value is string => typeof value === 'string' && safeTest(type, value))
}

function safeTest(type: ParamType, value: string): boolean {
  try {
    return type.test(value)
  } catch {
    return false
  }
}

/**
 * Values each builtin type accepts, chosen so that every pair of builtins that
 * can share a value is shown to by one of them. `42` alone ties int, float,
 * slug and hex together; a lower-case UUID and a date are also slugs; a ULID of
 * digits is also hex.
 */
const BUILTIN_WITNESSES: Readonly<Record<string, readonly string[]>> = {
  int: ['0', '42', '-7'],
  float: ['42', '1.5', '-0.25'],
  uuid: ['123e4567-e89b-12d3-a456-426614174000'],
  ulid: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01arz3ndektsv4rrffq69g5fav', '01234567890123456789012345'],
  date: ['2024-01-31', '2024-01-31T10:00:00Z'],
  slug: ['hello', 'hello-world', '42', 'a1'],
  hex: ['42', 'ff', 'deadbeef', 'ABCDEF'],
}

function dynamicAccepts(segment: PathSegment, literal: string, opts: AnalyzeOptions): boolean {
  if (segment.kind === 'wildcard') return true
  if (segment.type === undefined) return true
  const type = opts.paramTypes.get(segment.type)
  return type === undefined ? true : type.test(literal)
}

function sharesPrefix(wildcard: RouteRecord, route: RouteRecord, prefixLength: number): boolean {
  for (let i = 0; i < prefixLength; i++) {
    const w = wildcard.segments[i] as PathSegment
    const r = route.segments[i] as PathSegment
    if (w.kind === 'static' && (r.kind !== 'static' || r.value !== w.value)) return false
  }
  return true
}
