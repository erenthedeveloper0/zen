import type { HookPlan, HookRecord, PipelinePhase, RequestPhase, RouteHooks } from '../contracts/hook.ts'
import {
  APP_PHASES, PIPELINE_PHASES, POST_FAMILY, REQUEST_PHASES, UNAVAILABLE_PHASES, isRequestPhase,
} from '../contracts/hook.ts'
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
  // Every other key too. They cannot run here — the loop above is the whole of
  // what a scoped hook can be — but reading only known keys meant a typo'd
  // `preHandlr` or an `onReady` written on a route was dropped without a trace.
  // Recorded, they reach `diagnoseUnknown` and `diagnoseMisplaced`, and the boot
  // is refused with the name that was meant.
  for (const key of Object.keys(hooks)) {
    if (isRequestPhase(key)) continue
    const entry = (hooks as Record<string, unknown>)[key]
    const list = (Array.isArray(entry) ? entry : [entry]) as readonly unknown[]
    for (const fn of list) {
      const named = typeof fn === 'function' && fn.name !== '' ? fn.name : undefined
      out.push({ phase: key as RequestPhase, fn: fn as Function, scope: 'route', name: named })
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

/**
 * Hooks registered for a phase that does not exist — §9.7's sibling.
 *
 * `app.hook('onReqest', fn)` type-checks nowhere, but it runs everywhere a
 * phase name arrives as a string: JavaScript, a plugin compiled against an
 * older type surface, `as any`. It used to be filed under the application-phase
 * table, which is keyed by name and read by name, so the hook was stored and
 * never called — exactly the failure §9.7 refuses for a phase that exists and
 * cannot fire. `ZEN_HOOK_PHASE_UNKNOWN` has been in Annex B since 0.1 with
 * nothing producing it; this is its producer.
 */
export function diagnoseUnknown(records: Iterable<HookRecord>): Diagnostic[] {
  const out: Diagnostic[] = []
  const reported = new Set<string>()
  for (const record of records) {
    const phase = record.phase as string
    if (KNOWN_PHASES.has(phase) || reported.has(phase)) continue
    reported.add(phase)
    const guess = closest(phase, [...KNOWN_PHASES])
    out.push({
      severity: 'error',
      code: Codes.HOOK_PHASE_UNKNOWN,
      message:
        `A hook is registered for "${phase}", which is not a hook phase` +
        (record.name === undefined ? '' : ` (hook: ${record.name})`) + '.',
      hint: guess === null
        ? `Use one of: ${[...KNOWN_PHASES].join(', ')}.`
        : `Did you mean "${guess}"?`,
      consequence: 'Registered under an unknown name, the hook would have been stored and never called.',
    })
  }
  return out
}

/**
 * Application phases written where only request phases can go — a route's or a
 * collection's `hooks: { … }`.
 *
 * `onReady` fires once for the application; there is no route for it to be
 * scoped to, so a route declaring one was declaring a hook that could never
 * run. Registered through `app.hook()` it does run, which is the fix the
 * diagnostic names.
 */
export function diagnoseMisplaced(records: Iterable<HookRecord>): Diagnostic[] {
  const out: Diagnostic[] = []
  const reported = new Set<string>()
  for (const record of records) {
    const phase = record.phase as string
    if (!APP_PHASE_SET.has(phase) || reported.has(phase)) continue
    reported.add(phase)
    out.push({
      severity: 'error',
      code: Codes.HOOK_PHASE_UNKNOWN,
      message:
        `"${phase}" is an application phase, so it cannot be declared in a route's or a collection's hooks` +
        (record.name === undefined ? '' : ` (hook: ${record.name})`) + '.',
      hint: `Register it once for the application: app.hook('${phase}', fn).`,
      consequence: 'Declared on a route, the hook would have been stored and never called.',
    })
  }
  return out
}

const KNOWN_PHASES: ReadonlySet<string> = new Set<string>([...REQUEST_PHASES, ...APP_PHASES])
const APP_PHASE_SET: ReadonlySet<string> = new Set<string>(APP_PHASES)

/** The known phase within two edits of `input`, if any. */
function closest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null
  let bestDistance = 3
  const lower = input.toLowerCase()
  for (const candidate of candidates) {
    const d = distance(lower, candidate.toLowerCase())
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        previous + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] as number
}

export type { PipelinePhase }
