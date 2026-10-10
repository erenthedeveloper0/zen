import { zen, explainConfig, NotFound } from '@erenthedeveloper0/zen'
import type { EnvSource } from '@erenthedeveloper0/zen'
import './shared/zod.ts'
import config from './config/zen.config.ts'
import { envSources } from './config/sources.ts'
import { mailerPlugin } from './plugins/mailer.ts'
import { orderRoutes } from './features/orders/index.ts'

/**
 * The composition root — rfcs/0001 §23.4, §16.
 *
 * Three lines carry the whole subsystem: `config` says what the service is
 * configurable in, `env` says where variables come from, and `overrides` is the
 * seam a test uses. Everything else in this directory tree reads `ctx.config`
 * and knows nothing about the environment.
 *
 * The shape to notice is that **`process.env` appears exactly once in this
 * application**, inside `src/config/sources.ts`, and it appears there as I/O
 * rather than as configuration. Compare the five earlier examples, each of
 * which reads it in `src/config/*.config.ts` and each of which has a comment
 * apologising for it.
 */

export interface AppOptions {
  readonly quiet?: boolean
  /** Keep the compiled source after boot, for `generatedSource()` — `inspect.ts` and the tests read it. */
  readonly inspect?: boolean
  /** Layer 8. A test states the environment instead of inheriting the machine's. */
  readonly env?: readonly EnvSource[]
  readonly overrides?: Readonly<Record<string, unknown>>
}

export function makeApp(options: AppOptions = {}) {
  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    inspect: options.inspect === true,
    config,
    env: options.env ?? envSources(),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  })

  // The plugin declares its own namespace and its own environment need; this
  // line is all the composition root says about mail (§23.4's fifth lesson).
  app.use(mailerPlugin)

  // `zen.config.ts` overrides one of the plugin's three defaults, which is what
  // makes the per-field merge visible in `npm run explain`: `mailer.timeout`
  // comes from the application, `mailer.from` and `mailer.retries` from the
  // plugin.
  app.collection('/orders', { name: 'orders', tags: ['orders'] }, orderRoutes)

  /**
   * The configuration endpoint, and the reason it is safe to have one.
   *
   * `app.graph().config` is the snapshot from §22.1 — **already redacted**, at
   * the source, because every projection of configuration in the framework
   * reads one structure and the secrets are not in it. So this route cannot
   * leak a secret by forgetting to check, only by the store being wrong, and
   * the store is what `benchmarks/config` gates.
   *
   * It is still behind `config.debug`, because provenance is topology: telling
   * an anonymous caller that `DATABASE_URL` came from `.env.production:4` says
   * something about the deployment even when it does not say the value.
   */
  app.get('/_config', { name: 'config.inspect' }, function inspectConfig(ctx) {
    if (!ctx.config.debug) throw new NotFound('Not available outside development')
    return ctx.text(explainConfig(app.graph().config), { media: 'text/plain' })
  })

  /**
   * Proof, on a route, that `ctx.config` is typed without any cast at all when
   * the handler is registered on the app object.
   *
   * `ctx.config.pagination.pageSize` is a `number` because `PAGE_SIZE` is
   * declared `z.coerce.number().int()`, and the chain from the environment
   * variable to this expression is checked end to end by the compiler.
   */
  app.get('/_typed', { name: 'config.typed' }, function typedConfig(ctx) {
    const pageSize: number = ctx.config.pagination.pageSize
    const mode: 'development' | 'test' | 'production' = ctx.config.mode
    return { pageSize, mode, poolSize: ctx.config.database.poolSize }
  })

  return app
}

function quiet() {
  const noop = () => {}
  return {
    level: 'fatal' as const, child() { return this },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
}
