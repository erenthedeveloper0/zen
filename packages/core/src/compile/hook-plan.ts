import type { HookPlan, HookRecord, PipelinePhase, RequestPhase, RouteHooks } from '../contracts/hook.ts'
import { PIPELINE_PHASES, POST_FAMILY, REQUEST_PHASES, UNAVAILABLE_PHASES, isRequestPhase } from '../contracts/hook.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * Hook resolution — rfcs/0001 §9.3.
 *
 * Three scopes (global, collection, route) collapse into one ordered list per
 * phase per route, at boot. The resolution is **lexical**: which hooks apply to
 * a route is a function of where the route was registered, not of anything
 * observable at request time. That is what lets the result live on the
 * RouteRecord and be compiled rather than walked.
 *
 * Ordering, stated once so the two implementations cannot drift:
 *
 *   - **Pre-family** (`onRequest`, `onRoute`, `onParse`, `preValidation`,
 *     `postValidation`, `preHandler`): outermost scope first, then registration
 *     order within a scope.
 *   - **Post-family** (`postHandler`, `onSerialize`, `onSend`, `onResponse`,
 *     `onError`): the *total* reverse of that. Not "innermost scope first with
 *     registration order preserved" — the full mirror, so that two
 *     `onRequest`/`onResponse` pairs registered A then B run A,B going in and
 *     B,A coming out. Anything else and before/after would not nest, which is
 *     the one property everybody assumes it has.
 *
 * Phase-major, not scope-major: all of a phase's hooks run together, wherever
 * they were registered, and middleware occupies its own fixed position in the
 * lifecycle. §8.5's sample `--explain` output originally implied the opposite
 * (hooks interleaved with middleware by scope); §9.1 calls hook granularity
 * "phase-level" and §9.3 orders "within a phase", so the normative text wins
 * and the sample output was the thing that was wrong.
 */

/** A registration scope, as far as hook resolution is concerned. */
export interface HookScope {
  readonly id: string
  readonly parent: HookScope | null
  readonly hooks: readonly HookRecord[]
}

/**
 * Flatten the scope chain plus the route's own hooks into per-phase lists.
 *
 * Phases nobody registered are simply absent from the map, which is what makes
 * "a phase with no hooks emits no code" a structural property rather than an
 * optimisation the compiler has to remember to apply.
 */
export function resolveHooks(
  scope: HookScope,
  routeHooks: RouteHooks | undefined,
): ReadonlyMap<RequestPhase, readonly HookRecord[]> {
  const chain: HookScope[] = []
  for (let s: HookScope | null = scope; s !== null; s = s.parent) chain.unshift(s)

  const out = new Map<RequestPhase, HookRecord[]>()
  const push = (record: HookRecord): void => {
    if (!isRequestPhase(record.phase)) return
    const list = out.get(record.phase)
    if (list === undefined) out.set(record.phase, [record])
    else list.push(record)
  }

  for (const s of chain) for (const record of s.hooks) push(record)
  for (const record of routeHookRecords(routeHooks)) push(record)

  for (const [phase, list] of out) if (POST_FAMILY.has(phase)) list.reverse()

  return out
}

/** Normalise `hooks: { onRequest: fn | [fn, fn] }` into records. */
export function routeHookRecords(hooks: RouteHooks | undefined): HookRecord[] {
  if (hooks === undefined) return []
  const out: HookRecord[] = []
  for (const phase of REQUEST_PHASES) {
    const entry = hooks[phase]
    if (entry === undefined) continue
    const list = Array.isArray(entry) ? entry : [entry]
    for (const fn of list as readonly Function[]) {
      out.push({ phase, fn, scope: 'route', name: fn.name === '' ? undefined : fn.name })
    }
  }
  return out
}

/**
 * Project the resolved map onto the nine phases the pipeline compiler emits.
 *
 * Returns `null` when the route has no pipeline hooks at all, so the compiler
 * can skip the whole feature rather than iterate nine empty arrays deciding to
 * emit nothing nine times.
 */
export function pipelinePlan(
  resolved: ReadonlyMap<RequestPhase, readonly HookRecord[]>,
  empty: HookPlan,
): HookPlan | null {
  let any = false
  const plan: Record<string, readonly Function[]> = {}
  for (const phase of PIPELINE_PHASES) {
    const list = resolved.get(phase)
    if (list === undefined || list.length === 0) {
      plan[phase] = empty[phase]
      continue
    }
    any = true
    plan[phase] = list.map((h) => h.fn)
  }
  return any ? (plan as HookPlan) : null
}

export function functionsFor(
  resolved: ReadonlyMap<RequestPhase, readonly HookRecord[]>,
  phase: RequestPhase,
): readonly Function[] {
  const list = resolved.get(phase)
  return list === undefined || list.length === 0 ? NONE : list.map((h) => h.fn)
}

const NONE: readonly Function[] = Object.freeze([])

/**
 * Reject hooks registered for a phase this build cannot fire — §9.7.
 *
 * A hook that never runs looks exactly like a hook whose condition never
 * occurred, so silence here buys a team a year of believing they have timeout
 * instrumentation. Zen resolves everything at boot; that has to include whether
 * the phase can happen at all.
 */
export function diagnoseUnavailable(records: Iterable<HookRecord>): Diagnostic[] {
  const seen = new Map<string, string[]>()
  for (const record of records) {
    const reason = UNAVAILABLE_PHASES.get(record.phase)
    if (reason === undefined) continue
    const owners = seen.get(record.phase)
    const owner = record.name ?? `an anonymous hook in scope "${record.scope}"`
    if (owners === undefined) seen.set(record.phase, [owner])
    else if (!owners.includes(owner)) owners.push(owner)
  }

  const out: Diagnostic[] = []
  for (const [phase, owners] of seen) {
    out.push({
      severity: 'error',
      code: Codes.HOOK_PHASE_UNAVAILABLE,
      message:
        `The "${phase}" hook phase cannot fire in this build, but ${owners.length} hook(s) are registered ` +
        `for it: ${owners.join(', ')}. ${UNAVAILABLE_PHASES.get(phase as RequestPhase) ?? ''}`,
      hint: `Remove the "${phase}" hook until the phase exists. A hook that silently never runs is ` +
        'indistinguishable from one whose condition never occurred.',
      consequence: 'Boot is refused rather than starting an app whose instrumentation is quietly dead.',
    })
  }
  return out
}

export type { PipelinePhase }
