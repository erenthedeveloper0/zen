import type { Context } from './context.ts'
import type { Reply } from './reply.ts'
import type { RouteInfo } from './context.ts'
import type { BodySource } from './adapter.ts'
import type { TimeoutInfo } from './deadline.ts'
import type { MaybePromise } from './route.ts'

/**
 * The twelve request phases — rfcs/0001 §9.2.
 *
 * Names are canonical. The informal `beforeX`/`afterX` vocabulary maps onto
 * these; there is deliberately no `afterRequest` distinct from `onResponse`,
 * because two "the response is done" phases immediately raise "which one runs
 * when the client disconnected?" — and that is how frameworks accrue folklore.
 */
export type RequestPhase =
  | 'onRequest'
  | 'onRoute'
  | 'onParse'
  | 'preValidation'
  | 'postValidation'
  | 'preHandler'
  | 'postHandler'
  | 'onSerialize'
  | 'onSend'
  | 'onResponse'
  | 'onError'
  | 'onTimeout'

export type AppPhase = 'onRegister' | 'onBoot' | 'onReady' | 'onListen' | 'onClose'

export type Phase = RequestPhase | AppPhase

export const REQUEST_PHASES = [
  'onRequest',
  'onRoute',
  'onParse',
  'preValidation',
  'postValidation',
  'preHandler',
  'postHandler',
  'onSerialize',
  'onSend',
  'onResponse',
  'onError',
  'onTimeout',
] as const satisfies readonly RequestPhase[]

export const APP_PHASES = [
  'onRegister', 'onBoot', 'onReady', 'onListen', 'onClose',
] as const satisfies readonly AppPhase[]

const REQUEST_PHASE_SET: ReadonlySet<string> = new Set<string>(REQUEST_PHASES)

export function isRequestPhase(phase: string): phase is RequestPhase {
  return REQUEST_PHASE_SET.has(phase)
}

/**
 * The nine phases that live *inside* the compiled pipeline, in emission order.
 *
 * `onResponse` is missing because it runs after the reply has been handed to
 * the adapter (§9.4), and `onError`/`onTimeout` because they are not on the
 * success path at all. Those three are held per route and invoked by the
 * dispatcher, which is why they can observe a request the pipeline never
 * finished.
 */
export const PIPELINE_PHASES = [
  'onRequest',
  'onRoute',
  'onParse',
  'preValidation',
  'postValidation',
  'preHandler',
  'postHandler',
  'onSerialize',
  'onSend',
] as const satisfies readonly RequestPhase[]

export type PipelinePhase = (typeof PIPELINE_PHASES)[number]

/**
 * The resolved hook lists for one route, ready for the pipeline compiler.
 *
 * Every phase is present so the compiler can read it without a lookup guard;
 * the ones nobody registered are the shared `EMPTY` array, and an empty array
 * emits **no code at all** — not an iteration over zero elements, not a
 * `length === 0` check. That is the whole claim of §9.4 and it is asserted in
 * `hooks.test.ts` against the generated source rather than only benchmarked.
 */
export type HookPlan = Readonly<Record<PipelinePhase, readonly Function[]>>

/**
 * Pre-family hooks run outermost-scope-first; post-family run innermost-first,
 * so hook pairs behave like a stack rather than a queue (§9.3).
 *
 * The reversal is total, not per-scope: two `onRequest`/`onResponse` pairs
 * registered A then B on the same scope run A,B going in and B,A coming out.
 * Anything else and "before/after" would not nest, which is the one thing
 * everyone assumes about it.
 *
 * `onTimeout` sits here with `onError` because the innermost scope should get
 * first refusal on *answering* a blown deadline. It differs from `onError` in
 * what happens to the hooks that lose: an `onError` hook that returns a `Reply`
 * ends the chain, while every `onTimeout` hook runs and only the first `Reply`
 * is used. An error is a value one handler owns; a deadline is an event about
 * the request that every scope may need to record, and a global timeout counter
 * that went silent as soon as a route degraded gracefully would read zero on
 * exactly the routes that handled it best (§4.4).
 */
export const POST_FAMILY: ReadonlySet<Phase> = new Set<Phase>([
  'postHandler', 'onSerialize', 'onSend', 'onResponse', 'onError', 'onTimeout',
])

/**
 * Phases this build cannot fire, and what is missing — §9.7.
 *
 * Registering a hook here is a **boot error**, not a silent no-op. A hook that
 * never runs is indistinguishable from a hook whose condition never occurred,
 * so the failure mode is a team believing they have timeout instrumentation for
 * a year. Zen resolves everything at boot (I1); that has to include "can this
 * phase actually happen".
 *
 * `onTimeout` was here until the deadline arm of §4.4 landed. Deleting its
 * entry is the entire change that made the phase live, which was the point of
 * making the availability table data in the first place: the diagnostic
 * disappears when the condition it describes stops being true, rather than when
 * somebody remembers to go and delete a message.
 */
export const UNAVAILABLE_PHASES: ReadonlyMap<Phase, string> = new Map<Phase, string>([
  [
    'onRegister',
    'Plugin registration order is resolved before any hook can be registered, so an onRegister hook ' +
      'would always be too late to observe the plugins registered before it.',
  ],
])

// ─────────────────────────────────────────────────────────────────────────────
// Signatures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook signatures — rfcs/0001 §9.2.
 *
 * The context is typed as `Context<never, X>`: framework surface plus plugin
 * decorations, but no route schema. That is deliberate rather than a
 * limitation. A hook runs on *every* route in its scope, so there is no single
 * route schema for it to be typed against — and a cross-cutting concern that
 * needs `ctx.body` typed is not a hook, it is middleware (§9.1). Making this
 * a compile-time fact rather than a documentation note is the point.
 */
export type HookFn<P extends Phase = Phase, X = {}> =
  P extends 'onRequest' | 'preValidation' | 'postValidation' | 'preHandler'
    ? (ctx: Context<never, X>) => MaybePromise<void | Reply>
  : P extends 'onRoute'
    ? (ctx: Context<never, X>, route: RouteInfo) => MaybePromise<void | Reply>
  : P extends 'onParse'
    ? (ctx: Context<never, X>, source: BodySource) => MaybePromise<unknown>
  : P extends 'postHandler'
    ? (ctx: Context<never, X>, result: unknown) => MaybePromise<void | Reply>
  : P extends 'onSerialize'
    ? (ctx: Context<never, X>, payload: unknown) => MaybePromise<unknown>
  : P extends 'onSend'
    ? (ctx: Context<never, X>, reply: Reply) => MaybePromise<void | Reply>
  : P extends 'onResponse'
    ? (ctx: Context<never, X>, reply: Reply) => MaybePromise<void>
  : P extends 'onError'
    ? (ctx: Context<never, X>, error: unknown) => MaybePromise<void | Reply>
  : P extends 'onTimeout'
    ? (ctx: Context<never, X>, info: TimeoutInfo) => MaybePromise<void | Reply>
  : (...args: never[]) => MaybePromise<unknown>

/**
 * Route-scoped hooks — the innermost of the three scopes of §9.3.
 *
 * A list is accepted anywhere a function is, so `onRequest: [a, b]` does not
 * need two keys and cannot silently overwrite one with the other, which is what
 * an object literal with duplicate keys would do.
 */
export type RouteHooks<X = {}> = {
  readonly [P in RequestPhase]?: HookFn<P, X> | readonly HookFn<P, X>[]
}

/**
 * One registered hook, with the scope that registered it.
 *
 * `scope` survives into the AppGraph because it is what makes `explainRoute`
 * (§8.5) able to print *where* a hook came from. "I cannot tell what runs on
 * this route" is the most common complaint about mature Express codebases, and
 * the answer has to include provenance, not just a list of anonymous functions.
 */
export interface HookRecord {
  readonly phase: Phase
  readonly fn: Function
  readonly scope: string
  readonly name: string | undefined
}
