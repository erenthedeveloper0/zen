import type { AnySchema, InferInput, InferOutput } from '../contracts/standard-schema.ts'
import type {
  ConfiguredMiddleware, MiddlewareDefinition, MiddlewareSetup, PhaseMiddleware,
} from '../contracts/middleware.ts'
import { CONFIGURED_MIDDLEWARE } from '../contracts/middleware.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/** What a factory with these options takes: optional when every option is. */
type FactoryOf<I> = undefined extends I
  ? (options?: I) => ConfiguredMiddleware
  : {} extends I
    ? (options?: I) => ConfiguredMiddleware
    : (options: I) => ConfiguredMiddleware

/**
 * Middleware as a configured factory — rfcs/0001 §8.6.
 *
 *     export const rateLimit = defineMiddleware({
 *       name: 'rateLimit',
 *       options: RateLimitOptions,         // checked at boot, not at request time
 *       setup(opts, app) {
 *         const store = app.resolve(Store)
 *         return (ctx) => { if (store.hit(ctx.ip) > opts.limit) return ctx.json(TOO_MANY, { status: 429 }) }
 *       },
 *     })
 *
 *     app.use(rateLimit({ limit: 100 }))
 *
 * The factory records its options and does nothing else. `ready()` validates
 * them with the engine a plugin's go through (§10.5 step 2) — a schema's own
 * verdict, plus every key it does not declare named with the one it was
 * probably meant to be — and only then runs `setup`, once per configured
 * instance however many routes list it, after every plugin's `setup`. What
 * `setup` returns is the phase middleware every pipeline that lists it calls:
 * the closure is made once, at boot, and the request path holds a direct
 * reference to it.
 */
export function defineMiddleware<S extends AnySchema>(definition: {
  readonly name: string
  readonly options: S
  setup(options: InferOutput<S>, app: MiddlewareSetup): PhaseMiddleware<never, never> | Promise<PhaseMiddleware<never, never>>
}): FactoryOf<InferInput<S>>
export function defineMiddleware(definition: {
  readonly name: string
  readonly options?: undefined
  setup(options: undefined, app: MiddlewareSetup): PhaseMiddleware<never, never> | Promise<PhaseMiddleware<never, never>>
}): () => ConfiguredMiddleware
export function defineMiddleware(
  definition: MiddlewareDefinition<unknown>,
): (options?: unknown) => ConfiguredMiddleware {
  if (typeof definition !== 'object' || definition === null || typeof definition.name !== 'string' || definition.name === '') {
    throw new ZenError(Codes.MIDDLEWARE_OPTIONS, 'defineMiddleware() needs a name: it is what explainRoute and every diagnostic call it.', {
      status: 500,
      expose: false,
    })
  }
  if (typeof definition.setup !== 'function') {
    throw new ZenError(
      Codes.MIDDLEWARE_OPTIONS,
      `Middleware "${definition.name}" has no setup(options, app) — the function that returns the middleware.`,
      { status: 500, expose: false },
    )
  }
  const frozen = Object.freeze({ ...definition }) as MiddlewareDefinition<never>
  return (options?: unknown) => Object.freeze({ [CONFIGURED_MIDDLEWARE]: true as const, definition: frozen, options })
}

/** A value `defineMiddleware`'s factory produced. */
export function isConfiguredMiddleware(value: unknown): value is ConfiguredMiddleware {
  return typeof value === 'object' && value !== null && (value as Partial<ConfiguredMiddleware>)[CONFIGURED_MIDDLEWARE] === true
}
