import type { ConfigSnapshot } from './config.ts'
import type { HookRecord, Phase } from './hook.ts'
import type { CheckRecord } from './health.ts'
import type { ParamType, RouteRecord, CollectionId } from './route.ts'
import type { Slot } from './slot.ts'
import type { AnySchema } from './standard-schema.ts'
import type { ProviderRecord } from './container.ts'
import type { SourceOrigin } from '../primitives/origin.ts'

export interface CollectionRecord {
  readonly id: CollectionId
  readonly prefix: string
  readonly name: string | undefined
  readonly parent: CollectionId | null
  readonly tags: readonly string[]
  readonly meta: ReadonlyMap<string, unknown>
  /** Where the collection was opened (§5.1). */
  readonly origin?: SourceOrigin | undefined
}

export interface PluginRecord {
  readonly name: string
  readonly version: string
  readonly dependsOn: Readonly<Record<string, string>>
  readonly scope: string
  /** Where `app.use(plugin)` was called (§5.1). */
  readonly origin?: SourceOrigin | undefined
}

/**
 * A schema registered under a name — `app.schema('User', UserSchema)` (§10.2).
 *
 * The name is what `@erenthedeveloper0/zen-openapi` publishes the schema's component as,
 * ahead of a `title` or `$id` the schema carries, and the schema is published
 * whether or not a route uses it — which is how a plugin contributes a shared
 * component (an error shape, a pagination envelope) to an application's
 * document.
 */
export interface SchemaRecord {
  readonly name: string
  readonly schema: AnySchema
  /** `'app'`, or `plugin "<name>"`. */
  readonly source: string
  readonly origin?: SourceOrigin | undefined
}

export interface DecorationRecord {
  readonly name: string
  readonly slot: Slot<unknown> | null
  readonly accessor: ((ctx: unknown) => unknown) | null
  readonly source: string
  /** Where `decorate()` was called — for a plugin's, in its `setup` or at its `use()` (§5.1). */
  readonly origin?: SourceOrigin | undefined
}

/**
 * The frozen, serialisable description of the whole application — rfcs/0001 §2.4.
 *
 * That this is serialisable is load-bearing: every developer tool (`routes`,
 * `inspect`, `doctor`, OpenAPI, SDK generation, the LSP) reads one canonical
 * structure instead of re-implementing route introspection. Express's lack of
 * this is why `express-list-endpoints` exists and is wrong half the time.
 */
export interface AppGraph {
  readonly routes: readonly RouteRecord[]
  readonly collections: readonly CollectionRecord[]
  readonly plugins: readonly PluginRecord[]
  readonly hooks: ReadonlyMap<Phase, readonly HookRecord[]>
  readonly slots: readonly Slot<unknown>[]
  readonly decorations: readonly DecorationRecord[]
  /**
   * Registered health checks, with every default resolved (§31.4).
   *
   * On the graph rather than hidden in the registry so the same question every
   * other subsystem answers statically — "what will actually run?" — has an
   * answer here too. It is what lets the health plugin assert that `redis` is
   * genuinely probed by something, and what a boot report needs to say "4 of
   * your 6 dependencies are checked".
   */
  readonly checks: readonly CheckRecord[]
  /** The router's param-type registry, so `:id<int>` can be documented as an
   *  integer by a package that does not depend on the router (§5.2, §29.2). */
  readonly paramTypes: ReadonlyMap<string, ParamType>
  /**
   * The resolved configuration, with provenance and **already redacted** (§16.1).
   *
   * On the graph for the same reason `checks` is: every tool reads one
   * structure, so no tool can disagree with another about what this service is
   * configured to do. That it is redacted here rather than at each printer is
   * the load-bearing half — a projection that has to remember to hide secrets
   * eventually forgets, and there is now exactly one place that holds the real
   * values and it is not this one.
   */
  readonly config: ConfigSnapshot
  /**
   * What plugins wrote with `app.meta(key, value)` (§10.2), keyed
   * `<plugin>.<key>` so two plugins cannot overwrite each other.
   *
   * Read by tools, not by the request path: `@erenthedeveloper0/zen-openapi`
   * merges `<plugin>.openapi.securitySchemes` into the document's
   * `components.securitySchemes`. Empty on every release before
   * `0.1.0-alpha.4`, whatever plugins wrote.
   */
  readonly meta: ReadonlyMap<string, unknown>
  /** Named schemas, by name — `app.schema()` and `Registrar.schema()` (§10.2). */
  readonly schemas: ReadonlyMap<string, SchemaRecord>
  /**
   * Every service provider, with its lifetime, its declared dependencies and
   * where it was registered (§15.4) — what a dependency graph, or the routes
   * that stop working when a service does, is read from.
   */
  readonly services: readonly ProviderRecord[]
  readonly builtAt: number
}
