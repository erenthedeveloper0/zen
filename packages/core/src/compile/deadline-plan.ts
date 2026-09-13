import type { TimeoutRecord, TimeoutSpec } from '../contracts/deadline.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { parseDuration } from '../primitives/time.ts'

/**
 * Deadline resolution — rfcs/0001 §4.4, §6.3.
 *
 * The same shape as hook and middleware resolution, and deliberately so: a
 * route's deadline is a function of where it was registered, resolved once at
 * boot, and stored on the `RouteRecord` the compiler reads. Nothing about it is
 * discoverable at request time (I1), so `explainRoute`, the AppGraph, the
 * OpenAPI generator and the dispatcher all read the same number from the same
 * field and cannot disagree about it.
 *
 * One rule, which is the opposite of how middleware composes: **the innermost
 * declaration wins outright.** Middleware accumulates down the chain because
 * "auth, then rate limit, then the route's own check" is additive and every
 * layer is meant to run. A deadline is not additive — two budgets in scope
 * cannot both apply — so the only question is which one, and the answer that
 * matches how people read code is the nearest one. A route saying `'60s'`
 * inside a collection saying `'5s'` means the route, or writing it there would
 * have no purpose.
 */

/** One scope's declaration, outermost first, with the route's own last. */
export interface TimeoutSource {
  /** `'app'`, a collection id, or `'route'` — surfaced as `TimeoutRecord.from`. */
  readonly where: string
  readonly spec: TimeoutSpec | undefined
}

export type TimeoutResolution =
  | { readonly ok: true; readonly record: TimeoutRecord | null }
  | { readonly ok: false; readonly where: string; readonly reason: string }

/**
 * Fold a scope chain into one deadline, or none.
 *
 * `undefined` inherits; `false` refuses what was inherited. The second is why
 * this is a fold over the whole chain rather than a search for the last defined
 * entry: `false` has to be able to *win*, or a streaming route under a bounded
 * collection would have no way to say that it streams.
 */
export function resolveTimeout(sources: readonly TimeoutSource[]): TimeoutResolution {
  let record: TimeoutRecord | null = null

  for (const source of sources) {
    if (source.spec === undefined) continue
    if (source.spec === false) {
      record = null
      continue
    }

    let ms: number
    try {
      ms = parseDuration(source.spec)
    } catch (error) {
      return {
        ok: false,
        where: source.where,
        reason: error instanceof Error ? error.message : String(error),
      }
    }

    // Zero is not "no deadline" — it is a deadline that has already passed, and
    // it would answer 504 before the handler ran. Someone writing it means
    // `false`, and guessing which is not this layer's job.
    if (ms <= 0) {
      return {
        ok: false,
        where: source.where,
        reason: `a timeout of ${String(source.spec)} expires before the handler can run`,
      }
    }

    record = { ms, from: source.where }
  }

  return { ok: true, record }
}

/**
 * The boot diagnostic for a timeout that could not be resolved.
 *
 * Aggregated with every other registration problem rather than thrown on the
 * spot (§12.7), because a developer wiring up a feature module usually has more
 * than one of these and a fail-fast framework turns that into four restarts.
 */
export function timeoutDiagnostic(route: string, failure: { where: string; reason: string }): Diagnostic {
  return {
    severity: 'error',
    code: Codes.TIMEOUT_INVALID,
    message: `Invalid timeout declared on ${label(failure.where)} and inherited by ${route}: ${failure.reason}`,
    hint: 'Use a duration — 500, "250ms", "5s", "2m" — or `false` to refuse an inherited deadline.',
    locations: [route],
  }
}

function label(where: string): string {
  if (where === 'app') return 'the application'
  if (where === 'route') return 'the route'
  return `collection "${where}"`
}
