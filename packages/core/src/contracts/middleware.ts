import type { Context } from './context.ts'
import type { Reply } from './reply.ts'
import type { RouteSchema, MaybePromise } from './route.ts'

/**
 * Two middleware forms — rfcs/0001 §8.2.
 *
 * Roughly 90% of real middleware never needs to wrap the downstream chain (auth,
 * CORS, rate limiting, request ids, header injection). Charging all of them the
 * cost of a per-request closure is Koa's mistake; refusing to support the other
 * 10% is Fastify's. So: two named forms, with the cost legible at the call site.
 */

/** Form A — the default. Zero closures, no `next`. */
export type PhaseMiddleware<S extends RouteSchema = RouteSchema, X = {}> =
  (ctx: Context<S, X>) => MaybePromise<void | Reply>

export type Next = () => Promise<Reply>

/** Form B — explicit opt-in. Allocates one closure per instance per request. */
export type AroundMiddleware<S extends RouteSchema = RouteSchema, X = {}> =
  (ctx: Context<S, X>, next: Next) => Promise<Reply>

/** Form C — response transform, compiled into the phase machinery. */
export type AfterMiddleware<S extends RouteSchema = RouteSchema, X = {}> =
  (ctx: Context<S, X>, reply: Reply) => MaybePromise<Reply>

export type AnyMiddleware = PhaseMiddleware<never, never> | AroundMiddleware<never, never> | AfterMiddleware<never, never>

export interface MiddlewareOptions {
  readonly name?: string | undefined
  /**
   * @experimental — **not read.** §8.7's conditional middleware is designed
   * and not built: `app.use()` accepts `{ name }` alone, and nothing reads
   * this field, so a `when` passed today does not omit or guard anything. It
   * stays in the contract because the design does (a boot-time predicate over
   * the environment omits the step from the generated source; a request-time
   * one compiles to a guarded call), and it is marked so that nobody mistakes
   * it for a working option. For a subtree that exists only in some
   * environments, a collection's `when` is built (§6.2).
   */
  readonly when?: ((ctx: never) => boolean) | undefined
}

/** Marker attached by `markSync()`; read by the pipeline compiler (§8.4). */
export const SYNC_MARKER = Symbol.for('zen.sync')

export type SyncMarked<F> = F & { readonly [SYNC_MARKER]?: true }
