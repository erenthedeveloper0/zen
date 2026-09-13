import type { Capabilities } from './capabilities.ts'
import type { PluginConfig } from './config.ts'
import type { Token, ProviderSpec } from './container.ts'
import type { CheckOptions, HealthProbe, HealthReport, ProbeKind } from './health.ts'
import type { Slot, SlotOptions } from './slot.ts'
import type { Phase } from './hook.ts'
import type { AfterMiddleware, AroundMiddleware, PhaseMiddleware } from './middleware.ts'
import type { RouteDefinition } from './route.ts'
import type { AnySchema } from './standard-schema.ts'

/**
 * The plugin API — rfcs/0001 §10.
 *
 * A plugin is a *manifest plus a setup function*: data before it is behaviour.
 * That ordering is what lets the Plugin Registry resolve dependencies, detect
 * conflicts, and print a dependency graph before executing anything — so
 * `zen plugin graph` can inspect a plugin tree that fails to boot.
 */
export interface Plugin<O = void, P extends object = {}> {
  readonly name: string
  readonly version: string
  /** name → semver range. Missing or mismatched dependencies are boot errors. */
  readonly dependsOn?: Readonly<Record<string, string>> | undefined
  readonly conflictsWith?: readonly string[] | undefined
  /** Declared capability needs; `{ fs: true }` fails at boot on workerd. */
  readonly requires?: Partial<Capabilities> | undefined
  readonly options?: AnySchema | undefined
  /**
   * What this plugin contributes to, and reads from, configuration — §16.1
   * layer 2 and §16.2's `used by:`.
   *
   * A manifest field rather than a `Registrar` call, because §16.2 requires
   * environment validation to run *before anything else boots* — and a
   * declaration only reachable by executing `setup` cannot participate in a
   * check that runs before any `setup` has. Data before behaviour, the same
   * reason `dependsOn` is a field.
   */
  readonly config?: PluginConfig | undefined
  readonly multiple?: boolean | undefined
  /** Ordering hints, applied after dependency edges. */
  readonly before?: readonly string[] | undefined
  readonly after?: readonly string[] | undefined
  setup(app: Registrar, options: O): PluginResult<P> | Promise<PluginResult<P>> | void | Promise<void>
}

export interface PluginResult<P extends object> {
  /**
   * The type-level contribution to `Context`. Kept a *flat object type* on
   * purpose: intersections of flat object types are cheap for tsc, whereas
   * conditional or mapped accumulation over other plugins' output is what makes
   * type-heavy frameworks slow to check (§10.4, §28.2).
   */
  readonly provides?: P | undefined
  readonly exports?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The scoped registrar handed to `setup`. Deliberately *not* the application
 * object: this enumerates exactly what a plugin is allowed to do. Mutating
 * another plugin's registrations, patching `Context.prototype`, or reading the
 * global registry are all absent by construction.
 */
export interface Registrar {
  readonly pluginName: string
  readonly caps: Capabilities
  /**
   * The resolved, frozen configuration — §16.3, read from `setup`.
   *
   * Available here because §16.2 already guarantees the ordering: the
   * environment is validated and the tree is folded at the head of `ready()`,
   * *before* any plugin's `setup` runs. The value existed at this point all
   * along; until now there was simply no seam to reach it through, so a plugin
   * could declare layer-2 defaults it was unable to read back.
   *
   * That gap is why this exists. A plugin that takes an allowlist wants to
   * compile it into a matcher once, at boot — and the allowlist is exactly the
   * kind of value that belongs in configuration, with a layer and a source
   * behind it. Reading it per request from `ctx.config` works and is what the
   * first draft did, but it moves a boot-time decision onto the hot path and
   * gives up the provenance in the boot log.
   *
   * Frozen and identical for every request (§16.4), so a plugin may close over
   * anything it derives from it.
   */
  readonly config: Readonly<Record<string, unknown>>

  use(middleware: PhaseMiddleware<never, never>, opts?: { name?: string }): void
  around(middleware: AroundMiddleware<never, never>, opts?: { name?: string }): void
  after(middleware: AfterMiddleware<never, never>, opts?: { name?: string }): void

  /**
   * Register a route from a plugin — how a docs, health or metrics plugin
   * serves an endpoint (§29.2, §31.4).
   *
   * It goes through the same registry as `app.get()`, which is the point:
   * a plugin's route is not a special case that bypasses conflict analysis,
   * middleware, or the AppGraph. A docs plugin colliding with an application
   * route is a boot error naming both, not a silent shadowing.
   *
   * `meta: { hidden: true }` keeps a route out of the generated document; the
   * docs endpoints set it on themselves.
   */
  route(definition: RouteDefinition): void

  /**
   * Register a hook at the global scope — §9.3, §10.2.
   *
   * `Function` rather than `HookFn` on purpose. A plugin is written before the
   * application's decoration set exists, so its hooks are typed *structurally*
   * against what they actually touch (`examples/rest-api` and
   * `examples/observability` both do this) — and pinning the parameter to
   * `Context<never, X>` here would reject exactly that pattern, for an `X` the
   * plugin author cannot know. `app.hook` on the application object is fully
   * typed, because there `X` is known.
   */
  hook(phase: Phase, fn: Function, name?: string): void
  slot<T>(name: string, opts?: SlotOptions<T>): Slot<T>
  decorate<T>(name: string, slotOrAccessor: Slot<T> | ((ctx: unknown) => T)): void
  provide<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T)): void
  /**
   * Contribute a health check — §31.4.
   *
   * This is how a plugin that owns a connection publishes whether it works,
   * which is the only place that answer actually lives: the application does
   * not know how to probe someone else's pool, and a plugin that keeps the
   * answer to itself forces every service using it to reimplement the check.
   *
   * Readiness by default. A liveness check must say `{ kind: 'liveness' }`.
   */
  health(name: string, probe: HealthProbe, opts?: CheckOptions): void
  /** Run the registered probes — how a health endpoint answers (§31.4). */
  probe(kind: ProbeKind): Promise<HealthReport>
  errorMap<E>(ctor: new (...args: never[]) => E, map: (error: E, ctx: unknown) => unknown): void
  meta(key: string, value: unknown): void
  /** Final look at the frozen AppGraph before compilation — how OpenAPI works. */
  onBoot(fn: (graph: unknown) => void | Promise<void>): void
  /** Values other plugins can consume via `dependsOn`. */
  exportsOf(pluginName: string): Readonly<Record<string, unknown>> | undefined
}

export type OptionsOf<P> = P extends Plugin<infer O, object> ? O : never
export type ProvidesOf<P> = P extends Plugin<never, infer R> ? R : {}
