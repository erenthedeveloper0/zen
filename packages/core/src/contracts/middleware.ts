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
   * Boot-time predicates (arity 1 over `Env`) eliminate the middleware from the
   * generated source entirely. Request-time predicates compile to a guarded
   * call. Same API, very different costs — `zen routes --explain` shows which.
   */
  readonly when?: ((ctx: never) => boolean) | undefined
}

/** Marker attached by `markSync()`; read by the pipeline compiler (§8.4). */
export const SYNC_MARKER = Symbol.for('zen.sync')

export type SyncMarked<F> = F & { readonly [SYNC_MARKER]?: true }
