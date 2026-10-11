import type { Context } from './context.ts'
import type { Reply } from './reply.ts'
import type { RouteSchema, MaybePromise } from './route.ts'
import type { Capabilities } from './capabilities.ts'
import type { Logger } from './logger.ts'
import type { Token } from './container.ts'
import type { AnySchema } from './standard-schema.ts'

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

/**
 * What `app.use(mw, options)`, `around`, `after` and their collection and
 * plugin counterparts take as their second argument.
 */
export interface MiddlewareOptions<X = {}> {
  readonly name?: string | undefined
  /**
   * Conditional middleware — §8.7. Two explicit forms rather than one function
   * whose parameter decides what it means, because the two cost different
   * things and the call site should say which it pays:
   *
   *     app.use(devToolbar(), { when: { env: (env) => env['NODE_ENV'] === 'development' } })
   *     app.use(compress, { when: { request: (ctx) => ctx.headers['accept-encoding']?.includes('br') === true } })
   *
   * `env` is decided **once, at boot**, against the validated environment, as
   * a collection's `when` is (§6.2): a step it turns off is omitted from every
   * pipeline's source, so it costs nothing. `request` is decided per request:
   * the step compiles to a guarded call and runs only when the predicate
   * returns `true` — a truthy string or a promise does not count. Given both,
   * `env` decides whether the guard exists at all. `explainRoute` prints
   * `[omitted at boot]` or `[guarded]`.
   */
  readonly when?: MiddlewareCondition<X> | undefined
}

export interface MiddlewareCondition<X = {}> {
  /** Boot-time: `false` omits the step from the generated source. Must answer a boolean, synchronously. */
  readonly env?: ((env: Readonly<Record<string, unknown>>) => boolean) | undefined
  /** Request-time: the step runs when this returns `true`. */
  readonly request?: ((ctx: Context<never, X>) => boolean) | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// §8.6 — middleware as configured factories
// ─────────────────────────────────────────────────────────────────────────────

/** Marks the value `defineMiddleware`'s factory returns. Never on a function. */
export const CONFIGURED_MIDDLEWARE = Symbol.for('zen.configuredMiddleware')

/**
 * What `setup` is handed — the boot-time capabilities a configured middleware
 * needs, and nothing that could change the application under it.
 */
export interface MiddlewareSetup {
  /** The definition's name, or the `name` the registration gave it. */
  readonly name: string
  /** The resolved, frozen configuration (§16.3). */
  readonly config: Readonly<Record<string, unknown>>
  readonly caps: Capabilities
  readonly log: Logger
  /** A service, resolved at boot — singletons only; a scoped service has no request yet. */
  resolve<T>(token: Token<T>): T
  resolveAsync<T>(token: Token<T>): Promise<T>
}

/**
 * A middleware definition — §8.6. Data until boot: the factory it produces
 * records options, `ready()` validates them with the same engine as a plugin's
 * (§10.5 step 2), and `setup` runs once per configured instance to produce the
 * function that is compiled into every pipeline that lists it.
 */
export interface MiddlewareDefinition<O = unknown> {
  readonly name: string
  /** A Standard Schema for the options; `setup` receives its output. */
  readonly options?: AnySchema | undefined
  setup(options: O, app: MiddlewareSetup): PhaseMiddleware<never, never> | Promise<PhaseMiddleware<never, never>>
}

/** What `rateLimit({ limit: 100 })` returns: a definition and the options it was given. */
export interface ConfiguredMiddleware {
  readonly [CONFIGURED_MIDDLEWARE]: true
  readonly definition: MiddlewareDefinition<never>
  readonly options: unknown
}

/** A phase middleware, or one a `defineMiddleware` factory configured. */
export type UsableMiddleware<X = {}> = PhaseMiddleware<never, X> | ConfiguredMiddleware

/** Marker attached by `markSync()`; read by the pipeline compiler (§8.4). */
export const SYNC_MARKER = Symbol.for('zen.sync')

export type SyncMarked<F> = F & { readonly [SYNC_MARKER]?: true }
