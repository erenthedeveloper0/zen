import type { AnySchema } from './standard-schema.ts'
import type { EnvEntry } from '../primitives/dotenv.ts'

/**
 * The configuration system — rfcs/0001 §16.
 *
 * Two questions run through this whole subsystem, and almost every decision
 * below is downstream of one of them.
 *
 * **1. "Where did this value come from?"** — §16.1. It is one of the most
 * frequently asked and least frequently answerable questions during an
 * incident, and it is unanswerable in every framework that resolves config by
 * spreading objects on top of each other: the result of `{...a, ...b}` has no
 * memory of `a`. So resolution here does not produce a value, it produces a
 * `ConfigValue` — the value *and* the layer and the named source that won it.
 * `app.config` is the projection that drops the provenance; the snapshot on the
 * graph is the one that keeps it.
 *
 * **2. "Is this thing about to be printed a secret?"** — §16.2. The answer
 * cannot be "hope nobody logs the config object", because somebody eventually
 * logs the config object. So secrecy is a property carried by the *value's
 * record*, and every projection of config in the framework — the snapshot on
 * the AppGraph, `explainConfig`, the boot diagnostics, `JSON.stringify` of the
 * config object itself — reads that property and substitutes {@link REDACTED}.
 * The real value is reachable only by asking for it by name, which is what a
 * database driver does and a log line does not.
 *
 * ### The layering, and what it is not
 *
 * §16.1 lists eight layers. They are not eight of the same thing: layers 5–7
 * contribute **environment variables**, which are strings keyed by an
 * upper-case name, and layers 1–4 and 8 contribute **configuration values**,
 * which are a typed tree. The environment is resolved and validated *first*,
 * and the tree is then computed as a function of it — which is what
 * `port: env => env.PORT` in §16.2 says, read literally.
 *
 * That ordering is the reason config can be frozen (§16.4) without giving
 * anything up: a configuration that is a pure function of a validated
 * environment has nothing left to decide at runtime.
 *
 * ### What this module deliberately does not do
 *
 * It does not read files. §3.2 assigns that to the CLI or the adapter, and the
 * constraint is not bureaucratic: `@zenjs/core` has no `node:` imports (§3.3
 * B2), so a config store that read `.env` would be a core module that cannot
 * run on workerd. What core owns is the *policy* — which layer beats which,
 * what a `.env` line means, how provenance is recorded — and `parseDotenv`
 * gives a host the parser without asking it to reimplement the precedence
 * rules. The four lines that read the file belong to whoever has a filesystem.
 */

/**
 * The eight layers of §16.1, in precedence order. **Later wins.**
 *
 * Spelled out as a list rather than left implicit in the fold, because the
 * order *is* the specification: a reader who wants to know whether `.env.local`
 * beats `process.env` should be able to answer it from one line, and a test
 * should be able to assert the whole ordering by walking this array rather than
 * by enumerating pairs.
 *
 *   - `default`  — framework defaults (§16.1 layer 1), and the reason a config
 *                  value always has *some* provenance.
 *   - `plugin`   — a plugin's declared defaults, from its manifest (layer 2).
 *   - `config`   — `zen.config.ts`, i.e. what `defineConfig` returned (layer 3).
 *   - `overlay`  — `zen.config.<NODE_ENV>.ts` (layer 4).
 *   - `dotenv`   — `.env` → `.env.local` → `.env.<NODE_ENV>` → … (layer 5).
 *                  Several sources share this layer; among themselves, the
 *                  order they were supplied in decides.
 *   - `env`      — the process environment (layer 6).
 *   - `flag`     — CLI flags (layer 7).
 *   - `override` — programmatic, for tests (layer 8). It is last because a test
 *                  that cannot beat the developer's own `.env.local` is a test
 *                  that passes on one machine.
 */
export type ConfigLayer =
  | 'default'
  | 'plugin'
  | 'config'
  | 'overlay'
  | 'dotenv'
  | 'env'
  | 'flag'
  | 'override'

export const CONFIG_LAYERS: readonly ConfigLayer[] = Object.freeze([
  'default', 'plugin', 'config', 'overlay', 'dotenv', 'env', 'flag', 'override',
] as const)

/** Precedence, as a number, so a fold can compare two contributions directly. */
export const LAYER_RANK: Readonly<Record<ConfigLayer, number>> = Object.freeze(
  Object.fromEntries(CONFIG_LAYERS.map((layer, index) => [layer, index])) as Record<ConfigLayer, number>,
)

/**
 * What a secret looks like everywhere except in the config object itself.
 *
 * A fixed-width mask rather than the value's own length, because the length of
 * a secret is information about the secret — `********` and `****` next to each
 * other tell a reader which key is a 16-byte token and which is a passphrase.
 */
export const REDACTED = '********'

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One variable, as one source saw it. `line` is what makes `.env:3` possible.
 *
 * Declared in `primitives/dotenv.ts` — stratum 0 may not import this module, so
 * the shape lives with the parser that produces it and is named here. The same
 * arrangement as `Duration`.
 */
export type { EnvEntry }

/**
 * A named contribution of environment variables — layers 5, 6 and 7.
 *
 * `name` is not decoration: it is the second half of every provenance string
 * this subsystem prints, and the difference between "PORT came from the
 * environment" and "PORT came from `.env.local:2`" is the difference between a
 * message that ends an investigation and one that starts it.
 */
export interface EnvSource {
  readonly layer: ConfigLayer
  readonly name: string
  readonly entries: readonly EnvEntry[]
}

/**
 * A named contribution of *structured* values — layers 1, 2, 4 and 8.
 *
 * The tree is partial and merged key by key, so an overlay that only wants to
 * change `logging.level` says exactly that and inherits everything else. Layer
 * 3 does not appear here because it is the `defineConfig` call itself.
 */
export interface ConfigOverlay {
  readonly layer: ConfigLayer
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One resolved environment variable, with everything a diagnostic needs.
 *
 * `value` is the *validated* value — the schema's output, so `PORT` is a
 * number here even though `raw` is `'3000'`. Both are kept because they answer
 * different questions: `value` is what the application runs on, and `raw` is
 * what the operator typed, which is the one that appears in the error message
 * when they typed it wrong.
 */
export interface EnvValue {
  readonly key: string
  /** The string as supplied, or `undefined` when no source set it. */
  readonly raw: string | undefined
  /** Post-validation. {@link REDACTED} when `secret`. */
  readonly value: unknown
  readonly layer: ConfigLayer
  /** `process.env`, `.env.local:2`, `--port`, or `not set`. */
  readonly source: string
  readonly secret: boolean
  /**
   * Plugins that declared they read this variable, from their manifests.
   *
   * §16.2's `used by:` line. It turns "JWT_SECRET is missing" into "JWT_SECRET
   * is missing, and `@zenjs/plugin-jwt` is what will not work", which is the
   * difference between a message a developer can act on and one they have to
   * grep for.
   */
  readonly usedBy: readonly string[]
}

/** One resolved configuration value, and the layer that won it. */
export interface ConfigValue {
  /** Dotted, from the root: `server.port`, `logging.redact`. */
  readonly path: string
  /** {@link REDACTED} when `secret`. The real value lives on `app.config`. */
  readonly value: unknown
  readonly layer: ConfigLayer
  readonly source: string
  readonly secret: boolean
}

/** A source that contributed, and how much — the header of `explainConfig`. */
export interface ConfigSourceRecord {
  readonly layer: ConfigLayer
  readonly name: string
  /** How many keys this source actually won. Zero means it was fully shadowed. */
  readonly won: number
  /** How many *declared* keys it supplied. `supplied > won` is normal and useful. */
  readonly supplied: number
  /**
   * Keys this source set that nothing declared. Zero for the process
   * environment, always.
   *
   * The distinction is the point. A `.env` file is a statement of intent, so a
   * `STIRPE_KEY=` sitting in one that no schema declares is almost always a
   * typo and is worth a line; the process environment is ambient, and reporting
   * that a laptop has sixty-four variables this service does not read is noise
   * that trains people to ignore the report.
   */
  readonly undeclared: number
}

/**
 * The serialisable projection of config, carried on the `AppGraph` — §22.1.
 *
 * **Already redacted.** That is the load-bearing property: every tool that
 * reads the graph — `explainConfig`, a future `zen inspect config`, anything
 * that serialises the graph for a build artefact — is redacted by construction
 * rather than by remembering. The unredacted values exist in exactly one place,
 * `app.config`, and reaching them requires naming the key you want.
 */
export interface ConfigSnapshot {
  /** Sorted by key. Empty when no `env` schema was declared. */
  readonly env: readonly EnvValue[]
  /** Sorted by path. Every leaf of the resolved tree. */
  readonly values: readonly ConfigValue[]
  /** Every contributing source, in precedence order. */
  readonly sources: readonly ConfigSourceRecord[]
  /** Env keys and config paths marked secret, sorted. */
  readonly secrets: readonly string[]
}

export const EMPTY_SNAPSHOT: ConfigSnapshot = Object.freeze({
  env: Object.freeze([]) as readonly EnvValue[],
  values: Object.freeze([]) as readonly ConfigValue[],
  sources: Object.freeze([]) as readonly ConfigSourceRecord[],
  secrets: Object.freeze([]) as readonly string[],
})

// ─────────────────────────────────────────────────────────────────────────────
// The source language
// ─────────────────────────────────────────────────────────────────────────────

/** Anything that is a value rather than a structure. */
export type ConfigLeaf = string | number | boolean | null | undefined

/**
 * A node in a `defineConfig` tree.
 *
 * The function case is what makes §16.2's `port: env => env.PORT` work, and it
 * is the whole reason config can be frozen: a tree of pure functions of a
 * validated environment has nothing left to decide once the environment is
 * known. A function stored *as* a value is not a special case — `() => handler`
 * is a thunk that returns the handler, which is what you wanted.
 *
 * `AnySchema` is in the union only so the `env` property of the same object
 * literal satisfies the constraint; it is removed from the resolved type. That
 * is a compromise in service of the shape §16.2 documents, where the schema and
 * the namespaces are siblings.
 */
export type ConfigNode<Env> =
  | ((env: Env) => unknown)
  | ConfigLeaf
  | readonly unknown[]
  | AnySchema
  | { readonly [key: string]: ConfigNode<Env> }

export type ConfigShape<Env> = { readonly [key: string]: ConfigNode<Env> }

/**
 * The tree with every thunk replaced by what it returns.
 *
 * Written as a conditional rather than accumulated through the plugin chain for
 * the reason §10.4 gives about type-check cost: this is evaluated **once**, at
 * the `defineConfig` call site, and everything downstream carries the flat
 * object type that falls out of it. The M2 gate in `benchmarks/typecheck`
 * measures whether that stayed true.
 */
export type ResolvedConfig<T> =
  T extends (env: never) => infer R ? R
  : T extends ConfigLeaf ? T
  : T extends readonly unknown[] ? T
  : T extends object ? { readonly [K in keyof T]: ResolvedConfig<T[K]> }
  : T

/**
 * What `defineConfig` returns: data, not behaviour.
 *
 * Deliberately inert — the same principle as a plugin manifest (§10). A
 * definition can be imported, inspected, diffed and merged by a tool that has
 * no application, which is what makes `zen inspect config` possible on an app
 * that fails to boot.
 */
export interface ConfigDefinition<C = unknown, E = unknown> {
  readonly env: AnySchema | undefined
  /** The namespaces, thunks unresolved. */
  readonly shape: Readonly<Record<string, unknown>>
  /** Env keys and config paths the author marked secret by hand. */
  readonly secrets: readonly string[]
  /**
   * Phantom. Never present at runtime; it exists so `C` and `E` have somewhere
   * to be inferred from.
   *
   * Both parameters sit in a **return** position, and that shape is load-bearing
   * rather than stylistic. Two plain properties of type `C` and `E` make
   * `ConfigDefinition<{ server: { port: number } }>` unassignable to
   * `ConfigDefinition<unknown>` — which is the type the application object has
   * to store, so every real definition would need a cast; and `(env: E) => C`
   * puts `E` in a contravariant position, which fails the same way in the other
   * direction under `strictFunctionTypes`. A nullary function returning both is
   * covariant in both, so a narrow definition widens and nothing casts.
   */
  readonly __types?: (() => { readonly config: C; readonly env: E }) | undefined
}

/** The resolved configuration type of a `defineConfig` result. */
export type ConfigFrom<D> = D extends ConfigDefinition<infer C, unknown> ? C : never

/** The validated environment type of a `defineConfig` result. */
export type EnvFrom<D> = D extends ConfigDefinition<unknown, infer E> ? E : never

/**
 * A plugin's configuration declaration — §16.1 layer 2, §16.2's `used by`.
 *
 * On the manifest rather than supplied through `Registrar` during `setup`,
 * because §16.2 requires environment validation to happen *before anything else
 * boots* — and a declaration that is only reachable by running the plugin
 * cannot participate in a check that runs before any plugin has run. Data
 * before behaviour, the same reason `dependsOn` is a field and not a call.
 */
export interface PluginConfig {
  /** The namespace this plugin owns, e.g. `redis` → `config.redis.*`. */
  readonly namespace?: string | undefined
  /** Defaults merged in at layer 2, under `namespace` when one is given. */
  readonly defaults?: Readonly<Record<string, unknown>> | undefined
  /** Environment variables this plugin reads. Populates `used by:`. */
  readonly env?: readonly string[] | undefined
}

/** Zen's own defaults — §16.1 layer 1. Exported so docs and tests cannot drift. */
export const CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  server: Object.freeze({
    port: 3000,
    // Loopback, not `0.0.0.0`. §19.2's rule is that the secure configuration is
    // the default and relaxing it is a visible line of code; a framework whose
    // default binds to every interface publishes a developer's laptop to the
    // coffee shop's network. It also matches what `@zenjs/adapter-node` already
    // did, so introducing config does not silently change where a running app
    // is reachable from.
    host: '127.0.0.1',
  }),
})
