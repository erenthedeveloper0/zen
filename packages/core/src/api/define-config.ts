import type { AnySchema, InferOutput } from '../contracts/standard-schema.ts'
import type { ConfigDefinition, ConfigShape, ResolvedConfig } from '../contracts/config.ts'

/**
 * `defineConfig` — rfcs/0001 §16.2.
 *
 * ```ts
 * export default defineConfig({
 *   env: z.object({
 *     NODE_ENV:     z.enum(['development', 'test', 'production']),
 *     PORT:         z.coerce.number().int().min(1).max(65535).default(3000),
 *     DATABASE_URL: z.url().meta({ format: 'password' }),
 *     LOG_LEVEL:    z.enum(['trace','debug','info','warn','error']).default('info'),
 *   }),
 *
 *   server:  { port: env => env.PORT, keepAliveTimeout: '65s' },
 *   logging: { level: env => env.LOG_LEVEL, redact: ['req.headers.authorization'] },
 * })
 * ```
 *
 * It returns **data**, not behaviour — the same discipline as a plugin manifest
 * (§10). Nothing is read, validated or resolved here; a definition can be
 * imported by a tool that has no application, which is what makes inspecting
 * the configuration of an app that fails to boot possible at all.
 *
 * ### The two things worth understanding about the shape
 *
 * **A function in the tree is a function *of the environment*.** That is what
 * makes the whole subsystem freezable (§16.4): a configuration that is a pure
 * function of a validated environment has nothing left to decide once the
 * environment is known. It also means the environment is a *parameter* rather
 * than an ambient global, so the same definition resolves differently under a
 * test harness without anything being monkey-patched. Storing a callable is not
 * a special case — `handler: () => fn` is a thunk that returns `fn`.
 *
 * **`env` and `secrets` are reserved at the top level.** Everything else
 * becomes a namespace on `app.config`. A service that genuinely wants
 * `config.env` names it `environment`; the collision is worth the two words
 * §16.2's shape saves everywhere else.
 *
 * ### On typing
 *
 * The mapped type that turns thunks into their return types is evaluated
 * **once**, here, at the call site — and everything downstream (`app.config`,
 * `ctx.config`, `ZenOptions`) carries the flat object type that falls out of
 * it. §10.4 is explicit that flat intersections are cheap for tsc and
 * accumulating conditionals are not, and the M2 gate in `benchmarks/typecheck`
 * is what keeps that claim from quietly becoming false.
 */
export function defineConfig<
  E extends AnySchema,
  const S extends ConfigShape<InferOutput<E>>,
>(
  spec: { readonly env: E } & S,
): ConfigDefinition<ResolvedConfig<Omit<S, 'env' | 'secrets'>>, InferOutput<E>>

/**
 * Without an `env` schema, thunks receive the raw environment as supplied —
 * `Record<string, string | undefined>`.
 *
 * Supported because a small service's config is often just "the port, and
 * whether we are in development", and forcing a schema on it would make the
 * cheap case the annoying one. What it gives up is exactly §16.2's subject: an
 * unvalidated variable fails when the code that reads it runs, not at boot.
 */
export function defineConfig<
  const S extends ConfigShape<Readonly<Record<string, string | undefined>>>,
>(
  spec: S & { readonly env?: undefined },
): ConfigDefinition<ResolvedConfig<Omit<S, 'env' | 'secrets'>>, Readonly<Record<string, string | undefined>>>

export function defineConfig(spec: Readonly<Record<string, unknown>>): ConfigDefinition<unknown, unknown> {
  const shape: Record<string, unknown> = {}
  for (const key of Object.keys(spec)) {
    if (key === 'env' || key === 'secrets') continue
    shape[key] = spec[key]
  }

  const declared = spec['secrets']
  return Object.freeze({
    env: (spec['env'] as AnySchema | undefined) ?? undefined,
    shape: Object.freeze(shape),
    secrets: Object.freeze(
      Array.isArray(declared) ? declared.filter((s): s is string => typeof s === 'string') : [],
    ) as readonly string[],
  }) as ConfigDefinition<unknown, unknown>
}
