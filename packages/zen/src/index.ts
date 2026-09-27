import { createApp, ZenApp, type HostLifecycle, type ZenOptions } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { nodeAdapter } from '@erenthedeveloper0/zen-adapter-node'
import { processLifecycle } from './lifecycle.ts'

/**
 * The meta-package — rfcs/0001 §24.1.
 *
 * Beginners install one thing (`zen`); experts install six (`@erenthedeveloper0/zen-core`,
 * `@erenthedeveloper0/zen-router`, an adapter, …). This module is the *only* place the three
 * are wired together, which is what keeps `@erenthedeveloper0/zen-core` free of any router or
 * platform dependency.
 */
export type ZenAppOptions<C = Record<string, never>> =
  Partial<Omit<ZenOptions<C>, 'router' | 'pathParser' | 'lifecycle'>> & {
    readonly router?: ZenOptions['router'] | undefined
    readonly pathParser?: ZenOptions['pathParser'] | undefined
    /**
     * Signals and crash handling — §4.5, §12.8. Defaults to
     * `processLifecycle()`: `SIGTERM`/`SIGINT` drain and exit, an uncaught
     * error is logged and shuts down with exit 1. `false` leaves the process
     * alone, for a host that manages it itself.
     */
    readonly lifecycle?: HostLifecycle | false | undefined
  }

/**
 * The process environment, or nothing — rfcs/0001 §16.1 layer 6.
 *
 * This is the one line in the project that reaches for `process`, and it is
 * here rather than in `@erenthedeveloper0/zen-core` on purpose: `process` does not exist on
 * workerd, where the environment arrives as an argument to the fetch handler,
 * so a core that read it would be a core that cannot run there (§3.3 B2). The
 * meta-package already knows it is on Node — it imports the Node adapter — so
 * it is the right place to know where the environment lives, and an app that
 * wants a different source passes `env:` explicitly.
 *
 * Read through `globalThis` rather than the bare identifier so that a runtime
 * without it produces `{}` instead of a `ReferenceError` on import.
 */
function processEnv(): Readonly<Record<string, string | undefined>> {
  const global = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return global.process?.env ?? {}
}

const defaultPathParser: ZenOptions['pathParser'] = {
  parse(path: string) {
    const parsed = parsePath(path)
    return { path: parsed.path, segments: parsed.segments }
  },
}

/**
 * The five-line app:
 *
 *     import { zen } from '@erenthedeveloper0/zen'
 *     const app = zen()
 *     app.get('/', () => 'Hello world')
 *     app.listen({ port: 3000 })
 *
 * Two concepts — `app.METHOD(path, handler)`, and *the handler returns the
 * response*. That is one fewer than Express, because there is no response
 * object to learn (§1.2).
 */
export function zen<X = {}, C = Record<string, never>>(
  options: ZenAppOptions<C> = {},
): ZenApp<X & { readonly config: C }> {
  return createApp<X, C>({
    ...options,
    router: options.router ?? new ZenRouter(),
    pathParser: options.pathParser ?? defaultPathParser,
    adapter: options.adapter ?? nodeAdapter(),
    // §16.1 layer 6. Explicit `env` — including a list of `.env` sources —
    // always wins; this is only the default nobody should have to write.
    env: options.env ?? processEnv(),
    // §4.5, §12.8 — installed at `listen()`, so an app that is only ever
    // `inject()`ed in a test never touches the process.
    lifecycle: options.lifecycle === false ? undefined : (options.lifecycle ?? processLifecycle()),
  })
}

export default zen

// Re-export the full public surface so `import { … } from '@erenthedeveloper0/zen'` is enough.
export * from '@erenthedeveloper0/zen-core'
export { ZenRouter, parsePath, renderPath, BUILTIN_PARAM_TYPES, analyzeRoutes } from '@erenthedeveloper0/zen-router'
export { nodeAdapter, NODE_CAPABILITIES, mediaTypeFor, type NodeAdapterOptions } from '@erenthedeveloper0/zen-adapter-node'
export { processLifecycle, type ProcessLifecycleOptions } from './lifecycle.ts'

/**
 * The first-party middleware pack — §24.2's "common middleware" row.
 *
 * Re-exported here and importable from `@erenthedeveloper0/zen-middleware` directly; §21.2's
 * example uses the second form and `examples/middleware` follows it, so both
 * paths stay exercised.
 *
 * Adding this row is what turned `@erenthedeveloper0/zen-core`'s `requestId` — the ULID
 * generator, exported since 0.1 and imported by nothing outside core — into a
 * live collision with the plugin of the same name, where `app.use(requestId())`
 * would have registered a *string* as middleware and failed at compile with a
 * message about neither. The generator is now `generateRequestId`, which is
 * what it always was.
 */
export * from '@erenthedeveloper0/zen-middleware'
