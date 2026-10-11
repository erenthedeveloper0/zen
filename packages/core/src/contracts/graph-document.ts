import type { SourceOrigin } from '../primitives/origin.ts'
import type { ConfigSnapshot } from './config.ts'

/**
 * The application graph as data — rfcs/0001 §2.4.
 *
 * §2.4 calls the graph's serialisability "deliberate and load-bearing": every
 * tool — `zen routes`, `inspect`, `doctor`, OpenAPI, SDK generation, the LSP —
 * reads one canonical structure. The `AppGraph` itself is not that structure:
 * it holds handler functions, schema objects and `Map`s, so a tool that wanted
 * it had to boot the application in its own process. A `GraphDocument` is the
 * same graph in plain JSON, with sorted keys and stable ids, so it can be
 * written to a file, diffed, hashed and read by something that has never seen
 * the application.
 *
 * Functions appear by identity only — a name and, where it is known, an
 * origin. Schemas appear as JSON Schema: the request side as the validator
 * receives it (`io: 'input'`), the response side as the serializer emits it
 * (`io: 'output'`). Configuration appears as the already-redacted snapshot
 * (§16.1), so a document carries no secret by construction.
 */

/** Any JSON value. A document holds nothing else. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** The version of the document's shape. A tool refuses a version it does not know. */
export const GRAPH_DOCUMENT_VERSION = 1

export interface GraphDocument {
  readonly zenGraph: typeof GRAPH_DOCUMENT_VERSION
  /**
   * `sha256-<hex>` over the canonical form of everything in this document
   * except itself, `config`, `slots`, and every `origin`.
   *
   * What it identifies is *what the application is* — its routes, their
   * contracts and chains, its plugins, services and checks. Where the code that
   * registered them sits (`origin`) and what this deployment is configured with
   * (`config`) are left out on purpose: moving a route to another file, or
   * deploying the same build with a different port, is not a different
   * application. `slots` are left out because they are not the application's:
   * a slot is declared once per process (§7.4), so the list holds every slot
   * any module loaded so far declared, and a fingerprint over it would change
   * with what else the process happened to import.
   */
  readonly fingerprint: string
  /** Sorted by path, then method — never by registration order. */
  readonly routes: readonly GraphRoute[]
  readonly collections: readonly GraphCollection[]
  readonly plugins: readonly GraphPlugin[]
  /**
   * Hooks registered at the global and collection scopes, and the application
   * phases. A route's own `hooks:` are on the route, in execution order.
   */
  readonly hooks: readonly GraphHook[]
  /** Every slot declared in this process so far (§7.4) — not only this application's. */
  readonly slots: readonly GraphSlot[]
  readonly decorations: readonly GraphDecoration[]
  readonly checks: readonly GraphCheck[]
  readonly paramTypes: readonly GraphParamType[]
  /** Named schemas — `app.schema(name, schema)` (§10.2). */
  readonly schemas: readonly GraphSchema[]
  readonly services: readonly GraphService[]
  /** What plugins wrote with `Registrar.meta`, made JSON-safe. */
  readonly meta: { readonly [key: string]: JsonValue }
  /** The configuration snapshot, redacted at its source (§16.1). */
  readonly config: ConfigSnapshot
}

/** A function, by identity: its name, and where it was written when that is known. */
export interface GraphFunction {
  readonly name: string | null
  readonly origin: SourceOrigin | null
}

export interface GraphRoute {
  readonly id: string
  readonly name: string | null
  readonly method: string
  readonly path: string
  readonly origin: SourceOrigin | null
  readonly collection: string | null
  readonly timeout: { readonly ms: number; readonly from: string } | null
  /** The derived coercion plan per source (§11.4), or `null` when nothing is converted. */
  readonly coercion: { readonly [source: string]: JsonValue } | null
  readonly negotiation: { readonly offers: readonly string[]; readonly statuses: readonly number[] } | null
  /** Every hook that runs here, phase by phase, in execution order (§9.3). */
  readonly hooks: readonly GraphHook[]
  /** The middleware chain in execution order, including steps omitted at boot (§8.7). */
  readonly middleware: readonly GraphMiddleware[]
  readonly handler: GraphFunction
  /** Request schemas by source, as JSON Schema (`io: 'input'`). */
  readonly request: { readonly [source: string]: JsonValue }
  /**
   * Response schemas by status, then media type, as JSON Schema (`io: 'output'`).
   * A status declared `null` — no body — is `null`.
   */
  readonly responses: { readonly [status: string]: { readonly [media: string]: JsonValue } | null }
  readonly meta: { readonly [key: string]: JsonValue }
  /** §11.7 — the route's business rule, by identity, or `null`. */
  readonly check: GraphFunction | null
  /** §15.1 — what the handler is handed: name → service token name, or `null`. */
  readonly inject: { readonly [as: string]: string } | null
  /** §15.1 — every service `inject` reaches, transitively, sorted. */
  readonly dependencies: readonly string[]
  /** §4.2 stage 6 — the route's own body policy, or `null` for the application's. */
  readonly intake: { readonly [key: string]: JsonValue } | null
  /**
   * `sha256-<hex>` over the route's *contract*: its method, its path, and its
   * request and response schemas with documentation-only keywords removed
   * (`title`, `description`, `examples`, …). A change to what a client may
   * send or will receive changes it; rewording a description does not.
   */
  readonly contract: string
}

export interface GraphHook {
  readonly phase: string
  readonly scope: string
  readonly name: string | null
  readonly origin: SourceOrigin | null
}

export interface GraphMiddleware {
  readonly kind: string
  readonly scope: string
  readonly name: string
  readonly origin: SourceOrigin | null
  /** §8.7 — `'omitted'` when a boot-time `when` turned it off, `'guarded'` for a request-time one. */
  readonly when: 'omitted' | 'guarded' | null
}

export interface GraphCollection {
  readonly id: string
  readonly prefix: string
  readonly name: string | null
  readonly parent: string | null
  readonly tags: readonly string[]
  readonly origin: SourceOrigin | null
  readonly meta: { readonly [key: string]: JsonValue }
}

export interface GraphPlugin {
  readonly name: string
  readonly version: string
  readonly dependsOn: { readonly [name: string]: string }
  readonly origin: SourceOrigin | null
}

export interface GraphSlot {
  readonly name: string
  readonly optional: boolean
  readonly hasDefault: boolean
  readonly disposes: boolean
}

export interface GraphDecoration {
  readonly name: string
  readonly source: string
  /** The slot it reads, or `null` for an accessor decoration. */
  readonly slot: string | null
  readonly origin: SourceOrigin | null
}

export interface GraphCheck {
  readonly name: string
  readonly kind: string
  readonly timeoutMs: number
  readonly ttlMs: number
  readonly critical: boolean
  readonly description: string | null
  readonly source: string
  readonly origin: SourceOrigin | null
}

export interface GraphParamType {
  readonly name: string
  readonly jsonSchema: JsonValue
}

export interface GraphSchema {
  readonly name: string
  readonly schema: JsonValue
  /** `'app'`, or `plugin "<name>"`. */
  readonly source: string
  readonly origin: SourceOrigin | null
}

export interface GraphService {
  readonly name: string
  readonly lifetime: string
  readonly eager: boolean
  readonly optional: boolean
  readonly deps: readonly string[]
  readonly origin: SourceOrigin | null
}
