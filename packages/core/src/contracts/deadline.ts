import type { Duration } from '../primitives/time.ts'

/**
 * Deadlines — rfcs/0001 §4.4, §9.7, §19.2.
 *
 * You configure a **timeout**, which is a duration. What the request carries is
 * a **deadline**, which is an instant. The distinction is not pedantry: a
 * duration cannot be handed to anything downstream, and an instant can. A
 * service that received "you have 30 seconds" at the edge and passes "you have
 * 30 seconds" to each of four sequential calls has promised two minutes; one
 * that passes the remaining budget has not. That is the whole difference
 * between a timeout and a deadline, and it is why `ctx.timeLeft` exists.
 *
 * Everything here is resolved at boot. Which routes have a deadline, how long
 * it is, and where it was declared are all functions of static registration
 * (I1), so they live on the `RouteRecord` next to `middleware` and `hooks` and
 * are read by the compiler, `explainRoute`, and the AppGraph from the same
 * place.
 */

/**
 * What a route, collection or app may declare.
 *
 * `false` is not the same as omitting it: omitting inherits from the enclosing
 * scope, `false` refuses the inherited one. Long-poll, SSE and download routes
 * under an otherwise-bounded collection need to say so, and they should have to
 * say it out loud rather than by being registered somewhere else.
 */
export type TimeoutSpec = Duration | false

/**
 * The lifecycle stage a request was in when its deadline expired.
 *
 * These are §4.1's stage names, deliberately, so that a timeout report, a trace
 * span and the `--explain` output all say the same word about the same region
 * of the pipeline. The compiler knows statically where each region starts, so
 * marking the stage is a store of an interned literal — which is what makes
 * "the handler blew the budget" a fact rather than an inference.
 *
 * `'headers'` from the original §9.2 signature is absent, and permanently: the
 * adapter's `headersTimeout` fires before a `Ctx` exists, so a hook taking one
 * could never be called. §9.7's rule applies to parameters as much as phases —
 * a case that cannot occur should not be in the type.
 */
export type TimeoutStage = 'pre' | 'intake' | 'validate' | 'handler'

export const TIMEOUT_STAGES = ['pre', 'intake', 'validate', 'handler'] as const satisfies readonly TimeoutStage[]

/**
 * What an `onTimeout` hook is handed.
 *
 * An object rather than a bare `kind` because the three facts are only useful
 * together: "the handler stage blew a 2 s budget after 2.04 s" is a report, and
 * any one of the three alone is a shrug.
 */
export interface TimeoutInfo {
  readonly stage: TimeoutStage
  /** The budget this request actually got, after any inbound clamp. */
  readonly budgetMs: number
  /** Wall-clock from `ctx.startTime` to expiry. Always ≥ `budgetMs`. */
  readonly elapsedMs: number
  /** The route *template*, or `null` when nothing matched (§31.2). */
  readonly route: string | null
}

/**
 * App-level configuration — `createApp({ timeout: … })`.
 *
 * The default is **off**, and that is a deliberate position rather than an
 * oversight. Arming a deadline costs a timer, a composed `AbortSignal` and a
 * promise per request (measured in `benchmarks/deadlines/run.ts`), and Zen does
 * not levy costs that were not asked for — the same rule that makes a route
 * with no body declare no intake and a phase with no hooks emit no code.
 *
 * It is also the setting every production service should turn on, which the
 * README, the example and §19.2's hardened-defaults table all say. When
 * `zen.config` lands (§16) the hardened profile sets it; until then it is one
 * line at the composition root.
 */
export interface TimeoutOptions {
  /** Applies to every route that does not declare its own. */
  readonly default?: TimeoutSpec | undefined
  /**
   * Read an inbound budget from this header and **shorten** the deadline to it.
   *
   * This is the propagation half of a distributed deadline: a caller that has
   * 400 ms left should not be told to wait 30 s for an answer it will discard.
   * The value is clamped to the route's own budget and can only ever reduce it,
   * so an untrusted client cannot use the header to hold a connection open —
   * which is why the clamp is a one-way `min` and not a substitution.
   *
   * Off unless configured. Trusting a request header is a decision, and
   * silently honouring one nobody enabled is how a header becomes an attack
   * surface.
   */
  readonly header?: string | undefined
}

/**
 * A route's resolved deadline, and where it came from.
 *
 * `from` survives onto the `RouteRecord` for the same reason `HookRecord.scope`
 * does: "why does this route give up after 2 seconds" is a provenance question,
 * and the answer is normally a collection three files away. `explainRoute`
 * prints it.
 */
export interface TimeoutRecord {
  readonly ms: number
  /** `'app'`, a collection id, or `'route'`. */
  readonly from: string
}

/**
 * The status a blown deadline produces.
 *
 * Two codes, because the two situations are not the same failure and should not
 * page the same person. Intake is time spent reading from the client's socket,
 * so a request that dies there is the client being slow — 408, the code that
 * says so. Everything after intake is time we spent, so the honest answer is
 * 504: something behind this endpoint did not answer, and a client retrying
 * immediately will fail the same way.
 *
 * Annex B lists `ZEN_TIMEOUT` as "408/504" and this is the split it meant.
 */
export const TIMEOUT_STATUS: Readonly<Record<TimeoutStage, 408 | 504>> = Object.freeze({
  pre: 504,
  intake: 408,
  validate: 504,
  handler: 504,
})

/**
 * The status for a request whose client vanished before it finished.
 *
 * Nginx's 499. Non-standard because the situation is: there is no client left
 * to receive a status, so this one exists purely to be counted. It is the
 * difference between "1.2% of requests are abandoned by the client" — a
 * latency problem — and those same requests being invisible, which is the
 * default everywhere and the reason p99 dashboards lie.
 */
export const CLIENT_CLOSED = 499
