import type { ParamType, PathSegment, RouteDiagnostic, RouteRecord } from '@zenjs/core'
import { Codes } from '@zenjs/core'

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
          const verdict = compare(a, b, opts)
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
                `can both match the same request, and no priority rule separates them.`,
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

function compare(a: RouteRecord, b: RouteRecord, opts: AnalyzeOptions): Verdict {
  let aWins = false
  let bWins = false

  for (let i = 0; i < a.segments.length; i++) {
    const sa = a.segments[i] as PathSegment
    const sb = b.segments[i] as PathSegment

    if (!overlaps(sa, sb, opts)) return 'disjoint'

    const ra = rank(sa)
    const rb = rank(sb)
    if (ra > rb) aWins = true
    else if (rb > ra) bWins = true
  }

  if (!aWins && !bWins) return 'duplicate'
  if (aWins && bWins) return 'ambiguous'
  return 'ordered'
}

/** Can these two segments ever match the same concrete path segment? */
function overlaps(a: PathSegment, b: PathSegment, opts: AnalyzeOptions): boolean {
  if (a.kind === 'static' && b.kind === 'static') return a.value === b.value
  if (a.kind === 'static') return dynamicAccepts(b, a.value, opts)
  if (b.kind === 'static') return dynamicAccepts(a, b.value, opts)
  // Two dynamic segments: disjoint only when both are typed with different types.
  if (a.kind === 'param' && b.kind === 'param' && a.type !== undefined && b.type !== undefined) {
    return a.type === b.type
  }
  return true
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
