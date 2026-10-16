import type { Capabilities } from '../contracts/capabilities.ts'
import type {
  Connection, HostLifecycle, RawRequest, RuntimeAdapter, ListenOptions, ServerHandle,
} from '../contracts/adapter.ts'
import type { AppGraph, DecorationRecord, SchemaRecord } from '../contracts/graph.ts'
import type { HookFn, HookPlan, HookRecord, Phase, RequestPhase, RouteHooks } from '../contracts/hook.ts'
import type { TimeoutInfo, TimeoutOptions, TimeoutSpec } from '../contracts/deadline.ts'
import type { CheckOptions, HealthProbe, HealthReport, ProbeKind } from '../contracts/health.ts'
import type { CoercionRecord, CoercionSpec, ValidationSource } from '../contracts/coercion.ts'
import type {
  ConfigDefinition, ConfigOverlay, ConfigSnapshot, EnvSource,
} from '../contracts/config.ts'
import type { Logger } from '../contracts/logger.ts'
import type {
  AfterMiddleware, AroundMiddleware, ConfiguredMiddleware, MiddlewareOptions, MiddlewareSetup, PhaseMiddleware,
} from '../contracts/middleware.ts'
import type { Reply } from '../contracts/reply.ts'
import type { CompiledRouter, PathParser, Router } from '../contracts/router.ts'
import type { Slot, SlotOptions } from '../contracts/slot.ts'
import type { Container, ProviderSpec, Token } from '../contracts/container.ts'
import type { OptionsOf, Plugin, ProvidesOf, Registrar } from '../contracts/plugin.ts'
import type { Prettify } from '../contracts/route.ts'
import type { HttpMethod, RemoteInfo } from '../contracts/http.ts'
import type { ParamType } from '../contracts/route.ts'
import type {
  CollectionId, DepsOf, MiddlewareRef, RouteId, RouteRecord, RouteSchema, RouteSpec, RouteSpecOf, SpecWithoutCheck,
  HandlerResult, MaybePromise,
} from '../contracts/route.ts'
import type { Context } from '../contracts/context.ts'
import type { AnySchema } from '../contracts/standard-schema.ts'
import type { UrlParams, UrlQuery } from '../contracts/url.ts'

import { DEFAULT_CAPABILITIES } from '../contracts/capabilities.ts'
import { joinPath, normalizePath, pathnameOf } from '../primitives/path.ts'
import { generateRequestId as makeRequestId } from '../primitives/id.ts'
import { CodeGen } from '../compile/codegen.ts'
import { compileContext, thawingCoercer, type ContextClass, type Decoration } from '../compile/context-compiler.ts'
import {
  compilePipeline, simplePipeline, NO_HOOKS, type CompiledPipeline, type PipelineSpec, type PipelineStep,
} from '../compile/pipeline-compiler.ts'
import {
  diagnoseMisplaced, diagnoseUnavailable, diagnoseUnknown, functionsFor, pipelinePlan, resolveHooks,
  routeHookRecords,
} from '../compile/hook-plan.ts'
import { resolveTimeout, timeoutDiagnostic, type TimeoutSource } from '../compile/deadline-plan.ts'
import { VALIDATION_SOURCES } from '../contracts/coercion.ts'
import { Deadline, EXPIRED, budgetFor, timeoutError } from '../runtime/deadline.ts'
import { HealthRegistry, type HealthRegistryOptions } from '../runtime/health.ts'
import { isRequestPhase } from '../contracts/hook.ts'
import { combineValidators, compileCheck, compileValidator } from '../compile/validation.ts'
import { describeField, planRoute, resolveCoercion } from '../compile/coercion-plan.ts'
import { compileCoercer } from '../compile/coercion-compiler.ts'
import {
  buildSerializerTable, createSerializerMemo, type SerializerMode, type SerializerTable,
} from '../compile/serializer.ts'
import { buildNegotiation } from '../compile/negotiation.ts'
import { makeNegotiationStep, makeNegotiator } from '../runtime/negotiation.ts'
import type { Representation } from '../contracts/negotiation.ts'
import { isDescribeOnly } from '../compile/json-schema.ts'
import {
  BODY_DEFAULTS, DEFAULT_PARSERS, makeIntake, makeRawIntake, makeStreamIntake, withParseHooks,
  type BodyOptions, type BodyParser,
} from '../runtime/body.ts'
import { ConsoleLogger } from '../runtime/logger.ts'
import { compileResponseValidator, type ResponseValidator } from '../runtime/response-validation.ts'
import { SAME_ORIGIN_ONLY, compileRedirectPolicy, type RedirectOptions, type RedirectPolicy } from '../runtime/redirect.ts'
import { UrlTable } from '../runtime/url.ts'
import { ErrorEngine, type DevFacts, type ErrorContextInfo } from '../runtime/error-engine.ts'
import { steps as explainedSteps } from './explain.ts'
import { parseAccept, qualityFor } from '../compile/media-type.ts'
import { prepareForWire, stripBodyIfNeeded } from '../runtime/egress.ts'
import { encodeBody, finalize } from '../runtime/response-engine.ts'
import { MutableReply } from '../runtime/reply.ts'
import type { PlainContext, ContextEnv } from '../runtime/context.ts'
import { CONTEXT_MEMBERS, SEALED_STAGE } from '../runtime/context.ts'
import { ZenError, BootError, isZenError, withoutStack, type Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { NotFound, MethodNotAllowed } from '../errors/http-errors.ts'
import { declareSlot, slotCount, declaredSlots } from '../registry/slot-registry.ts'
import { ZenContainer } from '../di/container.ts'
import { resolvePlugins, type PendingPlugin } from '../registry/plugin-registry.ts'
import { validateMiddlewareOptions, validatePluginOptions, type OptionsVerdict } from '../compile/plugin-options.ts'
import { conditionOf, pipelineSteps } from '../compile/middleware-plan.ts'
import { isConfiguredMiddleware } from './define-middleware.ts'
import { serializeGraph } from './graph-document.ts'
import { Trace, instrumentRoute, type TraceEvent } from './explain-request.ts'
import type { GraphDocument } from '../contracts/graph-document.ts'
import {
  PROFILES, devDefaults, optionsOverlay, profileDefaults, readPolicy,
  type Policy, type Profile, type ResponseValidation,
} from './policy.ts'
import { checkParamsSchema } from '../compile/params-check.ts'
import { resolveConfig, type ResolvedConfigResult } from '../registry/config-store.ts'
import { EMPTY_SNAPSHOT } from '../contracts/config.ts'
import { SETTLED } from '../primitives/disposal.ts'
import { regexHazards, regexLiterals } from '../primitives/regex-safety.ts'
import { closest } from '../primitives/nearest.ts'
import { toJsonSchema } from '../compile/json-schema.ts'
import {
  applicationFrame, captureOrigin, errorOrigin, formatOrigin, relativeOrigin, type CaptureMode, type SourceOrigin,
} from '../primitives/origin.ts'

// ─────────────────────────────────────────────────────────────────────────────

export interface ZenOptions<C = unknown> {
  /** Required: core does not depend on a router implementation (§3.3 B1). */
  readonly router: Router
  readonly pathParser: PathParser
  readonly adapter?: RuntimeAdapter | undefined
  readonly dev?: boolean | undefined
  /**
   * Keep the generated source of every compiled unit after boot, for
   * `generatedSource()` — §3.4. On with `dev`. Off otherwise since
   * `0.1.0-alpha.5`: every unit used to be held for the life of the process,
   * which at 10,000 routes is megabytes of strings nothing reads after boot.
   */
  readonly inspect?: boolean | undefined
  /**
   * The directory registration origins are written relative to — §5.1.
   *
   * Every route, middleware, hook, plugin, service and check records the
   * `file:line:column` that registered it, and a diagnostic, `explainRoute`
   * and the graph document print it. Under `root` it is printed as
   * `src/features/users/routes.ts:31:3`; elsewhere, absolute. The `zen`
   * meta-package passes `process.cwd()`: core reads no process state (§3.3 B2).
   */
  readonly root?: string | undefined
  /**
   * A named set of defaults — §19.2. `'hardened'` is the production profile:
   * a 30 s deadline, 1000 requests per keep-alive connection, thrown probe
   * errors kept off the wire, and in production response validation that logs
   * rather than throws. It is configuration, not composition — it registers
   * nothing — and every value it sets can be beaten by any later layer;
   * `explainConfig` shows each as `← profile: hardened`. Under it, a
   * `trustProxy` nobody set is warned about at boot, and the first
   * `X-Forwarded-For` that arrives is reported once.
   */
  readonly profile?: Profile | undefined
  /**
   * Response validation — §11.5. `'error'` validates each JSON response against
   * the schema its status declares and refuses one that does not match with
   * `ZEN_RESPONSE_INVALID` (a 500, never exposed); `'log'` reports it and
   * serves the response; `'off'` emits nothing for it; `{ sample: n }` logs
   * one response in `n`. Defaults to `'error'` with `dev`, `'off'` without.
   * Sugar for `validation.response` in configuration.
   */
  readonly validation?: { readonly response?: ResponseValidation | undefined } | undefined
  /**
   * Stamp every response with the application's fingerprint (`Zen-Graph`) and
   * the matched route's contract fingerprint (`Zen-Contract`) — §2.4. Off by
   * default: a fingerprint is topology-adjacent, and only a client that pins a
   * contract has a use for it. On, the document is computed once at boot and
   * each response pays one global `onSend` hook.
   */
  readonly fingerprintHeaders?: boolean | undefined
  /**
   * The two halves of development error rendering that need a host — §12.6.
   * `readSource` reads a file for the code frame around the line an error was
   * raised at; `report` receives each 5xx's development problem document, to
   * render where a developer is looking. The `zen` meta-package supplies both
   * in development: the filesystem, and stderr when it is a terminal. Core
   * reads no file and writes to no stream (§3.3 B2). Ignored without `dev`.
   */
  readonly devErrors?: {
    readonly readSource?: ((file: string) => string | undefined) | undefined
    readonly report?: ((problem: Readonly<Record<string, unknown>>) => void) | undefined
  } | undefined
  readonly logger?: Logger | undefined
  readonly caps?: Capabilities | undefined
  /**
   * Whether to believe `X-Forwarded-For` / `X-Forwarded-Proto` — §19.4. Off by
   * default. Behind proxies, set it to **how many** there are: `1` for one load
   * balancer. `ctx.ip` is then the address the outermost trusted proxy saw,
   * which a client cannot forge. `true` reads the leftmost entry and is only
   * safe when every proxy *overwrites* the header rather than appending to it.
   *
   * Sugar for `policy.trustProxy` in configuration (§16.1), like `timeout`,
   * `body`, `redirect` and `maxQueryParams`: each contributes at layer
   * `config` under the source `zen()`, where a configuration file beats it.
   */
  readonly trustProxy?: boolean | number | undefined
  /**
   * Where `ctx.redirect()` may send a client — §19.5.
   *
   * By default, nowhere but this origin: a path, a query or a fragment, and
   * any other target is `ZEN_REDIRECT_EXTERNAL`. That is what makes
   * `ctx.redirect(ctx.query.next)` a bug rather than an open redirect. An
   * application that sends clients to an identity provider says so here:
   *
   *     zen({ redirect: { allowExternal: ['https://accounts.google.com'] } })
   */
  readonly redirect?: RedirectOptions | undefined
  readonly maxQueryParams?: number | undefined
  readonly body?: Partial<BodyOptions> | undefined
  readonly parsers?: ReadonlyMap<string, BodyParser> | undefined
  /** `'simple'` selects the interpreted pipeline — the one-line opt-out of §8.4. */
  readonly pipeline?: 'optimized' | 'simple' | undefined
  readonly serialization?: SerializationOptions | undefined
  /**
   * The default request deadline — §4.4.
   *
   * `timeout: '30s'` is the short form of `timeout: { default: '30s' }`. Off
   * unless set: arming a deadline costs a timer, a composed signal and a promise
   * per request, and Zen does not levy costs nobody asked for. It is also the
   * one line that closes "a hung handler holds its connection until the process
   * restarts", so a production service should set it, and §19.2's hardened
   * defaults say 30 s.
   */
  readonly timeout?: TimeoutSpec | TimeoutOptions | undefined
  /**
   * Defaults for every health check — §31.4.
   *
   * The checks themselves come from `app.health()` and from plugins; this only
   * sets the budget and cache window they inherit, and whether a thrown error's
   * text is allowed onto the wire.
   */
  readonly health?: HealthRegistryOptions | undefined
  /**
   * How string-typed request sources become the types their schemas declare —
   * §11.4.
   *
   * The defaults match what each wire format actually implies and are the right
   * answer for almost every application: `?page=2` against `z.number()` is a
   * number, `?zip=01234` against `z.string()` is untouched, and a JSON body is
   * never coerced at all. Set this to change a policy, or to `false` to turn the
   * whole subsystem off and go back to writing `z.coerce.number()` by hand.
   */
  readonly coercion?: CoercionSpec | undefined
  /**
   * The application's configuration — §16.
   *
   *     zen({ config: defineConfig({ env: EnvSchema, server: { port: e => e.PORT } }) })
   *
   * The definition is *data*: nothing is read, resolved or validated by the
   * call that produces it. Resolution happens here, at construction, and the
   * environment is validated **before anything else boots** (§16.2) — which is
   * literal rather than aspirational: env diagnostics are pushed at the head of
   * `ready()`'s list, and `ready()` does not run a single plugin's `setup` while
   * any diagnostic is outstanding.
   */
  readonly config?: ConfigDefinition<C, unknown> | undefined
  /**
   * Where environment variables come from — §16.1 layers 5–7.
   *
   * A plain record is the common case and is what the `zen` meta-package fills
   * in with `process.env`. `@erenthedeveloper0/zen-core` does not read it itself, and that is
   * not pedantry: `process` does not exist on workerd, where the environment
   * arrives as an argument to the fetch handler, so a core that reached for a
   * global would be a core that cannot run there (§3.3 B2).
   *
   * The array form is what a host uses to layer `.env` files under the process
   * environment, keeping per-line provenance:
   *
   *     env: [
   *       { layer: 'dotenv', name: '.env', entries: parseDotenv(text).entries },
   *       { layer: 'env', name: 'process.env', entries: entriesOf(process.env) },
   *     ]
   */
  readonly env?: Readonly<Record<string, string | undefined>> | readonly EnvSource[] | undefined
  /**
   * The host process's side of the lifecycle — §4.5, §12.8.
   *
   * Installed by `listen()` and removed at the end of `close()`. The `zen`
   * meta-package supplies `processLifecycle()` by default: `SIGTERM`/`SIGINT`
   * run the graceful shutdown, and an uncaught exception or unhandled rejection
   * is logged at `fatal` and does the same with exit code 1 — because Zen never
   * keeps serving from a process whose state is unknown (§12.8).
   */
  readonly lifecycle?: HostLifecycle | undefined
  /** Layers 2, 4 and 8 as raw sources — `zen.config.<NODE_ENV>.ts`, and tests. */
  readonly overlays?: readonly ConfigOverlay[] | undefined
  /**
   * Layer 8: programmatic overrides, which beat everything.
   *
   * Last on purpose. A test that cannot beat the developer's own `.env.local`
   * is a test that passes on one machine.
   */
  readonly overrides?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The resolved configuration type, read back off the app's extension type.
 *
 * `ctx.config` is typed through `X` — the same channel plugin decorations use —
 * rather than through a fourth type parameter on `BaseContext`. It costs one
 * conditional evaluated once per app and no churn anywhere else, and it is
 * honest about what `ctx.config` *is*: a context extension contributed by the
 * composition root instead of by a plugin.
 */
export type ConfigOf<X> = X extends { readonly config: infer C } ? C : Readonly<Record<string, never>>

export interface SerializationOptions {
  /**
   * `'walk'` selects the interpreted serializer (the §13.3 twin), `'off'`
   * disables response-schema serialization entirely and falls back to
   * `JSON.stringify` — which also disables the undeclared-field filtering, so it
   * is an escape hatch rather than a performance switch.
   */
  readonly mode?: SerializerMode | undefined
  /**
   * Throw when a response value does not match its declared types. Defaults to
   * `dev`. Missing *required* properties throw in both modes — see
   * `SerRuntime.missing` for why the two cases are treated differently.
   */
  readonly strict?: boolean | undefined
}

export interface CollectionOptions {
  readonly name?: string | undefined
  readonly use?: readonly (PhaseMiddleware<never, never> | ConfiguredMiddleware)[] | undefined
  /** Hooks for every route in this subtree — the middle scope of §9.3. */
  readonly hooks?: RouteHooks | undefined
  /**
   * The deadline for every route in this subtree, unless a route overrides it.
   *
   * This is the scope where a deadline usually belongs: "nothing under /api
   * takes more than two seconds" is a property of the subtree, and writing it
   * on the collection means a route added next year inherits it without anyone
   * remembering to.
   */
  readonly timeout?: TimeoutSpec | undefined
  /**
   * Coercion profiles for every route in this subtree — §11.4.
   *
   * Merged with what the app declared rather than replacing it, so a collection
   * that only wants comma-separated lists says exactly that and inherits the
   * rest.
   */
  readonly coercion?: CoercionSpec | undefined
  readonly tags?: readonly string[] | undefined
  readonly meta?: Readonly<Record<string, unknown>> | undefined
  /**
   * Whether this subtree exists at all — §6.2. Evaluated **once, at boot**,
   * against the validated environment (§16.2), never per request:
   *
   *     app.collection('/debug', { when: (env) => env['NODE_ENV'] !== 'production' }, …)
   *
   * A subtree for which it returns `false` is absent — not in the router, not
   * on the graph, not in the OpenAPI document — so it costs nothing, because
   * it is not there. It must answer with a boolean, synchronously: a promise
   * is truthy, and an environment string `'false'` is too, so either would turn
   * a subtree on that its author meant to turn off. Request-time conditions are
   * middleware's (§8.7).
   */
  readonly when?: ((env: Readonly<Record<string, unknown>>) => boolean) | undefined
}

interface Scope {
  readonly id: CollectionId
  readonly prefix: string
  readonly name: string | undefined
  readonly parent: Scope | null
  readonly middleware: MiddlewareRef[]
  /** Request-phase hooks registered on this scope, in registration order (§9.3). */
  readonly hooks: HookRecord[]
  /** This scope's declared deadline; the root scope holds the app default, set at boot from `policy.timeout`. */
  timeout: TimeoutSpec | undefined
  /** This scope's coercion profiles; the root scope holds the app default. */
  readonly coercion: CoercionSpec | undefined
  readonly tags: string[]
  readonly meta: Map<string, unknown>
  /** §6.2's boot-time condition; `undefined` means the subtree always exists. */
  readonly when: ((env: Readonly<Record<string, unknown>>) => boolean) | undefined
  /** Where the collection was opened — or, for the root scope, where the app was built (§5.1). */
  readonly origin: SourceOrigin | undefined
}

interface PendingRoute {
  readonly method: HttpMethod
  readonly path: string
  readonly schema: RouteSpec
  readonly handler: Function
  readonly name: string | undefined
  readonly meta: Map<string, unknown>
  readonly scope: Scope
  readonly middleware: MiddlewareRef[]
  /** Where `app.get(…)` — or a plugin's `route()` — was called (§5.1). */
  readonly origin: SourceOrigin | undefined
}

/**
 * What the dispatcher needs per route.
 *
 * `onError`, `onResponse` and `onSend` sit here rather than inside the compiled
 * pipeline because all three have to be reachable when the pipeline did not
 * finish — an error thrown in validation still has to be observable by the
 * route's own error hooks, and the response has to be observable after it has
 * left for the socket (§9.4).
 */
interface CompiledRoute extends GlobalHooks {
  readonly record: RouteRecord
  readonly pipeline: CompiledPipeline
  /**
   * What the pipeline was compiled from — kept so `explainRequest` (§8.5) can
   * compile an instrumented copy of it, on demand, without compiling a second
   * coercer or serializer for the route.
   */
  readonly spec: PipelineSpec
  /** Resolved budget in ms; `0` means this route runs without a deadline. */
  readonly timeoutMs: number
}

/** Everything `ready()` compiled, which the dispatcher serves from. */
interface CompiledApp {
  readonly router: CompiledRouter
  readonly Ctx: ContextClass
  readonly byId: ReadonlyMap<RouteId, CompiledRoute>
  readonly graph: AppGraph
  readonly globalHooks: GlobalHooks
  readonly unmatchedOnRequest: readonly Function[]
  /** The app default, applied to 404/405 too — global `onRequest` runs there. */
  readonly unmatchedTimeoutMs: number
  readonly env: ContextEnv
  readonly errors: ErrorEngine
  /** §5.7 — every named route, planned for `url()`. Off the request path entirely. */
  readonly urls: UrlTable
}

/** The same lists for requests that never matched a route (404/405). */
interface GlobalHooks {
  readonly onError: readonly Function[]
  readonly onResponse: readonly Function[]
  readonly onSend: readonly Function[]
  readonly onTimeout: readonly Function[]
}

/**
 * Shared handler shapes for the route-method overloads.
 *
 * Every verb must carry both, or `ctx` silently degrades to `any` on the verbs
 * that don't — which is exactly what the M2 type fixture caught on
 * put/patch/delete/head/options. Naming them once means a new verb cannot be
 * added with only half the surface.
 */
export type RouteHandler<S extends RouteSpec, X, P extends string> =
  (ctx: Context<S, X, P>, deps: DepsOf<S>) => MaybePromise<HandlerResult<S>>

export type BareHandler<X, P extends string> =
  (ctx: Context<{}, X, P>) => unknown

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Zen application — rfcs/0001 §2.
 *
 * Registration is a *source language*. Nothing dynamic survives `ready()`: the
 * router, the per-route pipelines, and the context class itself are compiled
 * once from a frozen graph, and the per-request path contains no registry
 * lookups, no filtering, and no `Object.keys`.
 */
export class ZenApp<X = {}> {
  readonly #opts: ZenOptions<unknown>
  readonly #log: Logger
  readonly #caps: Capabilities
  readonly #codegen: CodeGen
  /** §16.1 — `policy.body`, read at boot; the app's intake limits. */
  #bodyOptions: BodyOptions = BODY_DEFAULTS
  readonly #parsers: ReadonlyMap<string, BodyParser>
  /** The request policy configuration resolved to, read once at boot. */
  #policy: Policy | null = null
  /** `ZenOptions.root` — what origins are written relative to (§5.1). */
  readonly #root: string | undefined
  /** Where this application was built: the `zen()` or `createApp()` call. */
  readonly #origin: SourceOrigin | undefined

  readonly #routes: PendingRoute[] = []
  readonly #scopes: Scope[] = []
  readonly #plugins: PendingPlugin[] = []
  readonly #pluginExports = new Map<string, Readonly<Record<string, unknown>>>()
  readonly #container: ZenContainer = new ZenContainer()
  readonly #health: HealthRegistry
  /** Deferred so a bad check joins every other boot problem, not its own restart. */
  readonly #healthDiagnostics: Diagnostic[] = []
  /** §19.5 — compiled once; its diagnostics are reported by `ready()` with the rest. */
  #redirect: { readonly policy: RedirectPolicy; readonly diagnostics: readonly Diagnostic[] } = {
    policy: SAME_ORIGIN_ONLY,
    diagnostics: [],
  }
  /**
   * The resolved configuration — §16.
   *
   * Cached rather than recomputed, and invalidated by `use()` because a plugin
   * manifest can contribute layer-2 defaults (§16.1). Resolution is a few
   * microseconds over a tree with tens of leaves, it happens a handful of times
   * at boot and never again, and the alternative — resolving once in the
   * constructor — would mean a plugin registered on the next line could not
   * contribute a default at all.
   */
  #config: ResolvedConfigResult | null = null
  readonly #hooks = new Map<Phase, HookRecord[]>()
  /** §5.2 — application param types, merged over the router's builtins. */
  readonly #paramTypes = new Map<string, ParamType>()
  readonly #decorations: Decoration[] = []
  /** Layer-8 values `overrideConfig` added — the testing kit's seam (§15.5). */
  readonly #testOverrides: Array<Readonly<Record<string, unknown>>> = []
  /** §10.2 — `app.schema(name, schema)`, in registration order; checked at boot. */
  readonly #schemas: SchemaRecord[] = []
  readonly #errorMappers: Array<{ ctor: Function; map: (e: unknown, c: unknown) => unknown }> = []
  #rootScope: Scope

  #frozen = false
  /** §2.4 — the graph as a document, computed once, on first request for it or at boot. */
  #document: Promise<GraphDocument> | null = null
  /** `fingerprintHeaders` — what the hook stamps, filled once the document exists. */
  #fingerprints: { readonly app: string; readonly contracts: ReadonlyMap<string, string> } | null = null
  #compiled: CompiledApp | null = null

  /** Lowercased once at construction; `undefined` disables inbound propagation. */
  #timeoutHeader: string | undefined = undefined

  #handle: ServerHandle | null = null
  /** Removes whatever `lifecycle.install` put on the host process. */
  #uninstall: (() => void) | null = null
  /** The shutdown in progress, so a second `close()` joins it rather than re-running it. */
  #closing: Promise<void> | null = null
  /** The boot, once started — shared by concurrent callers and kept when it fails. */
  #booting: Promise<this> | null = null
  /** Detaches `listen({ signal })`'s abort listener once shutdown has begun. */
  #unlistenSignal: (() => void) | null = null

  constructor(opts: ZenOptions<unknown>) {
    this.#opts = opts
    this.#root = opts.root
    this.#origin = this.#here()
    if (typeof opts.trustProxy === 'number' && !(Number.isInteger(opts.trustProxy) && opts.trustProxy >= 0)) {
      throw new ZenError(
        Codes.CONFIG_INVALID,
        `trustProxy must be true, false, or the number of proxies in front of the app; got ${opts.trustProxy}.`,
        { status: 500, expose: false },
      )
    }
    if (opts.profile !== undefined && !(PROFILES as readonly string[]).includes(opts.profile)) {
      throw new ZenError(
        Codes.CONFIG_INVALID,
        `profile ${JSON.stringify(opts.profile)} is not one Zen has; the profiles are ${PROFILES.join(', ')}.`,
        { status: 500, expose: false },
      )
    }
    this.#log = opts.logger ?? new ConsoleLogger(opts.dev === true ? 'debug' : 'info')
    // §14.1 — what the runtime can do is the adapter's to say. This read
    // `opts.caps` alone until `0.1.0-alpha.4`, so `Plugin.requires` was checked
    // against core's defaults whatever the adapter was: a plugin requiring
    // `{ fs: true }` would have booted on a runtime with no filesystem, which is
    // the one thing §14.2 promises it will not. An explicit `caps` still wins,
    // for tests.
    this.#caps = opts.caps ?? opts.adapter?.caps ?? DEFAULT_CAPABILITIES
    this.#codegen = new CodeGen({
      caps: this.#caps,
      readable: opts.dev === true,
      retain: opts.dev === true || opts.inspect === true,
    })
    this.#parsers = opts.parsers ?? DEFAULT_PARSERS
    this.#health = new HealthRegistry({ logger: this.#log, ...opts.health })
    this.#rootScope = {
      id: 'root' as CollectionId,
      prefix: '/',
      name: undefined,
      parent: null,
      middleware: [],
      hooks: [],
      // The root scope *is* the app default, so deadline resolution walks one
      // uniform chain rather than special-casing the outermost level. Read
      // from `policy.timeout` at boot (§16.1).
      timeout: undefined,
      coercion: opts.coercion,
      tags: [],
      meta: new Map(),
      when: undefined,
      origin: this.#origin,
    }
    this.#scopes.push(this.#rootScope)
  }

  /**
   * Where the application's caller is — the first frame outside Zen, relative
   * to `root` (§5.1). `'setup'` is a plugin's `Registrar` asking: see
   * `captureOrigin`. Boot-only; nothing on the request path calls it.
   */
  #here(mode: CaptureMode = 'call'): SourceOrigin | undefined {
    return relativeOrigin(captureOrigin(mode), this.#root)
  }

  /** @internal — for `Collection`, whose registrations are the app's (§5.1). */
  originHere(): SourceOrigin | undefined {
    return this.#here()
  }

  // ── configuration (§16) ──────────────────────────────────────────────────

  /**
   * The resolved, frozen configuration — §16.3.
   *
   *     app.config.server.port          // number, no `get('server.port')`
   *     ctx.config.logging.level        // the same object, on every context
   *
   * Typed property access rather than a string-keyed getter, because string
   * keys defeat autocomplete, refactoring and the compiler, and there is no
   * reason to accept that when the shape is known at boot.
   *
   * Readable *before* `ready()`, which is what `app.listen({ port:
   * app.config.server.port })` in §21.2 requires — and it is why resolution is
   * lazy rather than part of `ready()`. Reading it does not validate: a missing
   * `JWT_SECRET` is a boot diagnostic, reported by `ready()` alongside every
   * other registration problem, not an exception thrown from a property access
   * in the middle of a composition root.
   */
  get config(): ConfigOf<X> {
    return this.#resolved().config as ConfigOf<X>
  }

  /**
   * The configuration with its provenance, redacted — §16.1.
   *
   * The same structure that lands on the AppGraph, available before `ready()`
   * so a `doctor` command can print it for an application that does not boot.
   */
  get configSnapshot(): ConfigSnapshot {
    return this.#resolved().snapshot
  }

  #resolved(): ResolvedConfigResult {
    const cached = this.#config
    if (cached !== null) return cached

    const definition = this.#opts.config
    // Layer 1 holds the framework's own defaults (`CONFIG_DEFAULTS`), the ones
    // that depend on `dev`, and then the profile's (§19.2).
    const dev = this.#opts.dev === true
    const overlays: ConfigOverlay[] = [devDefaults(dev)]
    if (this.#opts.profile !== undefined) overlays.push(profileDefaults(this.#opts.profile, dev))

    // Layer 2 — plugin defaults, read off the *manifest*. Available here
    // because a manifest is data: no plugin has run yet, and §16.2 requires
    // that the environment be settled before any of them does.
    for (const pending of this.#plugins) {
      const declared = pending.plugin.config
      if (declared?.defaults === undefined) continue
      overlays.push({
        layer: 'plugin',
        name: pending.plugin.name,
        values: declared.namespace === undefined
          ? declared.defaults
          : { [declared.namespace]: declared.defaults },
      })
    }

    // `zen({ timeout, body, … })` — layer `config`, ahead of the configuration
    // file in the same layer, so the file wins (see `api/policy.ts`).
    const sugar = optionsOverlay(this.#opts)
    if (sugar !== null) overlays.push(sugar)

    overlays.push(...(this.#opts.overlays ?? []))
    if (this.#opts.overrides !== undefined) {
      overlays.push({ layer: 'override', name: 'overrides', values: this.#opts.overrides })
    }
    // The testing kit's, last of all (§15.5).
    for (const values of this.#testOverrides) overlays.push({ layer: 'override', name: 'test overrides', values })

    const usedBy = new Map<string, readonly string[]>()
    for (const pending of this.#plugins) {
      const declared = pending.plugin.config?.env
      if (declared !== undefined && declared.length > 0) usedBy.set(pending.plugin.name, declared)
    }

    const result = resolveConfig({
      definition: definition as ConfigDefinition<unknown, unknown> | undefined,
      envSources: envSourcesOf(this.#opts.env),
      overlays,
      usedBy,
      // Injected rather than imported by the store: `toJsonSchema` is stratum 3
      // and the store is stratum 2, and this class is above them both (§3.1).
      describe: toJsonSchema,
    })
    this.#config = result
    return result
  }

  /**
   * @internal — `createTestApp(make, { config })` (§15.5): configuration that
   * beats every other source, given to an application before it boots. Layer
   * 8, where a test's values belong — a test that cannot beat the developer's
   * own `.env.local` passes on one machine.
   */
  overrideConfig(values: Readonly<Record<string, unknown>>): this {
    this.#assertOpen()
    this.#testOverrides.push(values)
    this.#config = null
    return this
  }

  // ── registration ─────────────────────────────────────────────────────────

  #assertOpen(): void {
    if (this.#frozen) {
      throw new ZenError(
        Codes.APP_FROZEN,
        'The application is frozen. Routes, middleware and hooks must be registered before ready()/listen(). ' +
          'This is what lets Zen compile the request path once and guarantee it can never be stale.',
        { status: 500, expose: false },
      )
    }
  }

  #register(
    scope: Scope,
    method: HttpMethod,
    path: string,
    a: unknown,
    b: unknown,
    origin: SourceOrigin | undefined,
  ): this {
    this.#assertOpen()
    const hasSpec = typeof a === 'object' && a !== null
    const schema = (hasSpec ? a : {}) as RouteSpec
    const handler = (hasSpec ? b : a) as Function

    if (typeof handler !== 'function') {
      throw new ZenError(
        Codes.ROUTE_INVALID_PATH,
        `Handler for ${method} ${path} is not a function (received ${typeof handler}).`,
        { status: 500, expose: false },
      )
    }

    this.#routes.push({
      method,
      path: joinPath(scope.prefix, path),
      schema,
      handler,
      name: schema.name ?? undefined,
      meta: new Map(Object.entries(schema.meta ?? {})),
      scope,
      origin,
      // §8.3's `route.use(checkOwnership)` — the innermost of the three
      // middleware scopes, appended last by `flattenMiddleware`, so it runs
      // after the app's and every enclosing collection's, and `explainRoute`
      // labels it `[route]`. Always an empty list until `0.1.0-alpha.4`: the
      // README called middleware "route-scoped" and nothing could put one there.
      // Listed in the route's own spec, so the route's call site is theirs.
      middleware: (schema.use ?? []).map((fn) => middlewareRef('phase', fn, undefined, 'route', origin, 'anonymous')),
    })
    return this
  }

  get<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  get<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  get<P extends string>(path: P, handler: BareHandler<X, P>): this
  get(path: string, a: unknown, b?: unknown): this {
    return this.#register(this.#rootScope, 'GET', path, a, b, this.#here())
  }

  post<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  post<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  post<P extends string>(path: P, handler: BareHandler<X, P>): this
  post(path: string, a: unknown, b?: unknown): this {
    return this.#register(this.#rootScope, 'POST', path, a, b, this.#here())
  }

  put<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  put<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  put<P extends string>(path: P, handler: BareHandler<X, P>): this
  put(path: string, a: unknown, b?: unknown): this { return this.#register(this.#rootScope, 'PUT', path, a, b, this.#here()) }

  patch<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  patch<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  patch<P extends string>(path: P, handler: BareHandler<X, P>): this
  patch(path: string, a: unknown, b?: unknown): this { return this.#register(this.#rootScope, 'PATCH', path, a, b, this.#here()) }

  delete<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  delete<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  delete<P extends string>(path: P, handler: BareHandler<X, P>): this
  delete(path: string, a: unknown, b?: unknown): this { return this.#register(this.#rootScope, 'DELETE', path, a, b, this.#here()) }

  head<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  head<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  head<P extends string>(path: P, handler: BareHandler<X, P>): this
  head(path: string, a: unknown, b?: unknown): this { return this.#register(this.#rootScope, 'HEAD', path, a, b, this.#here()) }

  options<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  options<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  options<P extends string>(path: P, handler: BareHandler<X, P>): this
  options(path: string, a: unknown, b?: unknown): this { return this.#register(this.#rootScope, 'OPTIONS', path, a, b, this.#here()) }

  /**
   * One handler for every method — §22.1.
   *
   * Registers ordinary routes, one per method in {@link ALL_METHODS}, so each is
   * conflict-checked, compiled and documented like any other and a `405` is
   * still impossible for a method it serves. `HEAD` is served by the `GET`
   * route, as everywhere (§4.2). `TRACE` is not included: a handler written for
   * "every method" was not written to reflect a request back (RFC 9110 §9.3.8).
   * A `name` gets the method appended — `proxy.get`, `proxy.post` — because a
   * name identifies one route.
   */
  all<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  all<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  all<P extends string>(path: P, handler: BareHandler<X, P>): this
  all(path: string, a: unknown, b?: unknown): this {
    const origin = this.#here()
    registerAll((method, spec, handler) => this.#register(this.#rootScope, method, path, spec, handler, origin), a, b)
    return this
  }

  /**
   * Register a plugin, widening the app's context type.
   *
   *     const app = zen().use(ConfigPlugin).use(RedisPlugin).use(AuthPlugin)
   *     app.get('/me', ctx => ({ id: ctx.user.id, cached: ctx.redis.status }))
   *
   * Registration is visible in the current scope by default — isolation is a
   * syntactic act (§10.3). Fastify's implicit encapsulation is elegant and is,
   * empirically, its most common source of "why is my decorator undefined",
   * because visibility depends on a wrapper the reader cannot see at the call
   * site. Here the safety that buys is recovered through boot-time conflict
   * detection instead.
   */
  use<P extends Plugin<never, object>>(plugin: P, options?: OptionsOf<P>): ZenApp<X & ProvidesOf<P>>
  /**
   * Phase middleware — free. No `next`, no closure. A `defineMiddleware`
   * factory's result is phase middleware too, set up once at boot (§8.6), and
   * `when` makes either conditional (§8.7).
   */
  use(middleware: PhaseMiddleware<never, X> | ConfiguredMiddleware, opts?: MiddlewareOptions<X>): this
  use(target: unknown, second?: unknown): unknown {
    this.#assertOpen()

    if (isPlugin(target)) {
      this.#plugins.push({
        plugin: target as Plugin<never, object>,
        options: second,
        order: this.#plugins.length,
        origin: this.#here(),
      })
      // A manifest may carry layer-2 config defaults (§16.1), so anything
      // resolved before this registration is now one layer out of date.
      this.#config = null
      return this as unknown as ZenApp<X>
    }

    this.#rootScope.middleware.push(middlewareRef(
      'phase', target, second as MiddlewareOptions<never> | undefined, this.#rootScope.id, this.#here(), 'anonymous',
    ))
    return this
  }

  /** Register a service provider (§15.2). */
  provide<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T)): this {
    this.#assertOpen()
    this.#container.provide(token, spec, this.#here())
    return this
  }

  /**
   * @internal — `createTestApp(make, { override })` (§15.5): a replacement
   * that wins over every `provide()` of the token, before or after it, the
   * ones a plugin makes as the application boots included. Before `ready()`,
   * so the application is compiled with it.
   */
  overrideProvider<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T)): this {
    this.#assertOpen()
    this.#container.override(token, spec, this.#here())
    return this
  }

  resolve<T>(token: Token<T>): T {
    return this.#container.resolve(token)
  }

  /**
   * Register a health check — §31.4.
   *
   *     app.health('db', async (signal) => { await pool.query('select 1', { signal }) })
   *     app.health('recommendations', probe, { critical: false, timeout: '250ms' })
   *
   * A check is **readiness** unless it says otherwise, and that default is the
   * feature. Liveness answers "should I be restarted", so a liveness check that
   * touches a database converts a database blip into a fleet-wide restart storm
   * that then prevents the pool from ever reconnecting. If you genuinely want
   * one there, `{ kind: 'liveness' }` says so in the place a reviewer will see.
   *
   * The probe receives an `AbortSignal` bound to its own budget, so passing it
   * to `fetch` or a driver makes a blown check actually stop working rather
   * than merely stop being waited for.
   */
  health(name: string, probe: HealthProbe, options?: CheckOptions): this {
    this.#assertOpen()
    const diagnostic = this.#health.register(name, probe, options, 'app', this.#here())
    if (diagnostic !== null) this.#healthDiagnostics.push(diagnostic)
    return this
  }

  /**
   * Run the registered probes and return the report — what a health endpoint
   * serves, and what a test asserts on without going near HTTP.
   *
   * Safe to call at any rate: results are cached for their TTL and concurrent
   * calls share one in-flight probe per check (§31.4).
   */
  probe(kind: ProbeKind = 'readiness'): Promise<HealthReport> {
    return this.#health.run(kind)
  }

  /** The lifecycle state readiness is derived from — `starting` until `ready()`. */
  get state(): HealthRegistry['state'] {
    return this.#health.state
  }

  /**
   * Materialise the accumulated plugin intersection into one resolved object
   * type — §10.4, §28.2.
   *
   * Runtime no-op. Large apps call this once after plugin registration so that
   * every subsequent route pays a single type lookup instead of an N-way
   * intersection. This is the documented escape from the type-performance risk
   * that gates M2.
   */
  seal(): ZenApp<Prettify<X>> {
    return this as unknown as ZenApp<Prettify<X>>
  }

  /** Around middleware — one closure per request. Named differently on purpose. */
  around(middleware: AroundMiddleware<never, X>, opts?: MiddlewareOptions<X>): this {
    this.#assertOpen()
    this.#rootScope.middleware.push(middlewareRef(
      'around', middleware, opts as MiddlewareOptions<never> | undefined, this.#rootScope.id, this.#here(), 'anonymous',
    ))
    return this
  }

  after(middleware: AfterMiddleware<never, X>, opts?: MiddlewareOptions<X>): this {
    this.#assertOpen()
    this.#rootScope.middleware.push(middlewareRef(
      'after', middleware, opts as MiddlewareOptions<never> | undefined, this.#rootScope.id, this.#here(), 'anonymous',
    ))
    return this
  }

  /**
   * A registration-time scope, not a runtime object (§6.1). Nesting twenty
   * collections deep costs nothing per request — unlike Express `Router`
   * instances, each of which is a real middleware layer every request traverses.
   */
  collection(prefix: string, build: (c: Collection<X>) => void): this
  collection(prefix: string, opts: CollectionOptions, build: (c: Collection<X>) => void): this
  collection(prefix: string, a: unknown, b?: unknown): this {
    this.#assertOpen()
    this.nestCollection(this.#rootScope, prefix, a, b)
    return this
  }

  /**
   * @internal — the shared implementation of `app.collection` and
   * `Collection#collection`.
   *
   * Nesting matters beyond prefixes: middleware, tags and metadata compose down
   * the chain (§6.3), and OpenAPI reads that chain to give an operation the tags
   * of every collection it sits inside (§29.2).
   */
  nestCollection(parent: Scope, prefix: string, a: unknown, b: unknown): void {
    this.#assertOpen()
    const opts = (typeof a === 'function' ? {} : a) as CollectionOptions
    const build = (typeof a === 'function' ? a : b) as (c: Collection<X>) => void

    const id = `${parent.id}${normalizePath(prefix)}` as CollectionId
    const origin = this.#here()
    const scope: Scope = {
      id,
      prefix: joinPath(parent.prefix, prefix),
      name: opts.name,
      parent,
      origin,
      // Listed in the collection's options, so the collection's call site is theirs.
      middleware: (opts.use ?? []).map((fn) => middlewareRef('phase', fn, undefined, id, origin, 'anonymous')),
      hooks: routeHookRecords(opts.hooks, origin).map((h) => ({ ...h, scope: id })),
      timeout: opts.timeout,
      coercion: opts.coercion,
      tags: [...(opts.tags ?? [])],
      meta: new Map(Object.entries(opts.meta ?? {})),
      when: opts.when,
    }
    this.#scopes.push(scope)
    build(new Collection<X>(this, scope))
  }

  /**
   * @internal — used by Collection. A collection handle can outlive its
   * callback, so its middleware methods check the freeze the same way the app's
   * do; `use()` on one after boot used to be accepted and never compiled.
   */
  assertOpen(): void {
    this.#assertOpen()
  }

  /** @internal — used by Collection#hook. */
  hookScoped(scope: Scope, phase: Phase, fn: Function, name?: string): void {
    this.#assertOpen()
    addHook(scope, this.#hooks, phase, fn, name, this.#here())
  }

  /** @internal — used by Collection. */
  registerScoped(scope: Scope, method: HttpMethod, path: string, a: unknown, b: unknown): void {
    this.#register(scope, method, path, a, b, this.#here())
  }

  /**
   * Register a hook at the global scope — §9.3.
   *
   * Request phases attach to the root *scope*, so they run on every route and
   * compose with collection- and route-level hooks by the ordering rules of
   * §9.3. Application phases (`onReady`, `onListen`, `onClose`, …) have no
   * route to attach to and go to the app-level table instead.
   */
  hook<P extends Phase>(phase: P, fn: HookFn<P, X>, name?: string): this {
    this.#assertOpen()
    addHook(this.#rootScope, this.#hooks, phase, fn as Function, name, this.#here())
    return this
  }

  /**
   * Add a context property without mutating anything — the getter is compiled
   * into the generated class (§7.5). Conflicts are boot errors naming both
   * contributors, rather than last-write-wins.
   */
  decorate<K extends string, T>(name: K, slotOrAccessor: Slot<T> | ((ctx: unknown) => T), source = 'app'): ZenApp<X & { [k in K]: T }> {
    return this.#decorate(name, slotOrAccessor, source, this.#here())
  }

  #decorate<K extends string, T>(
    name: K,
    slotOrAccessor: Slot<T> | ((ctx: unknown) => T),
    source: string,
    origin: SourceOrigin | undefined,
  ): ZenApp<X & { [k in K]: T }> {
    this.#assertOpen()
    // The name becomes a getter in generated source, so it has to be an
    // identifier — `decorate('bad-name')` used to fail inside the compiler with
    // "this is a Zen bug", while the eval-free twin accepted it — and it must
    // not be one of the context's own members, or it silently replaces them.
    if (!DECORATION_NAME.test(name)) {
      throw new ZenError(
        Codes.DECORATOR_CONFLICT,
        `Context property "${name}" (from ${source}) is not a valid decoration name. ` +
          'Use a JavaScript identifier that does not start with "$" — e.g. "currentUser".',
        { status: 500, expose: false },
      )
    }
    if (CONTEXT_MEMBERS.has(name)) {
      throw new ZenError(
        Codes.DECORATOR_CONFLICT,
        `Context property "${name}" (from ${source}) is already owned by the framework: ` +
          `ctx.${name} is part of every context, and a decoration would replace it on every route. ` +
          'Choose another name.',
        { status: 500, expose: false },
      )
    }
    const existing = this.#decorations.find((d) => d.name === name)
    if (existing) {
      throw new ZenError(
        Codes.DECORATOR_CONFLICT,
        `Context property "${name}" is already decorated by ${existing.source}. ` +
          `Two plugins cannot own the same property; rename one or namespace it.`,
        { status: 500, expose: false },
      )
    }
    const isSlot = typeof slotOrAccessor === 'object' && slotOrAccessor !== null && 'index' in slotOrAccessor
    this.#decorations.push({
      name,
      slotIndex: isSlot ? (slotOrAccessor as Slot<T>).index : null,
      accessor: isSlot ? null : (slotOrAccessor as (ctx: unknown) => unknown),
      source,
      origin,
    })
    return this as unknown as ZenApp<X & { [k in K]: T }>
  }

  /**
   * Register a path parameter type — §5.2.
   *
   *     app.paramType('objectId', {
   *       test: (s) => s.length === 24 && /^[0-9a-f]+$/.test(s),
   *       parse: (s) => new ObjectId(s),
   *       jsonSchema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
   *     })
   *     app.get('/posts/:id<objectId>', (ctx) => posts.find(ctx.params.id))
   *
   * One declaration, three consumers: `test` is compiled into the router, so a
   * malformed id 404s instead of reaching the handler; `parse` builds the value
   * `ctx.params` carries; `jsonSchema` is what `@erenthedeveloper0/zen-openapi` documents. The
   * router's "unknown parameter type" diagnostic has always named this method —
   * it now exists.
   *
   * `test` runs on every request that reaches the segment, so keep it linear
   * (§19.3): no nested quantifiers, bounded length first. In development a
   * regex in it that can backtrack without bound is `ZEN_REGEX_UNSAFE`, a
   * warning — `test` is the application's code, so it is reported, not refused.
   */
  paramType<T>(name: string, type: Omit<ParamType<T>, 'name'>): this {
    this.#assertOpen()
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      throw new ZenError(
        Codes.ROUTE_INVALID_PATH,
        `Param type name "${name}" cannot appear in a path as ":x<${name}>". Use letters, digits, "_" and "-".`,
        { status: 500, expose: false },
      )
    }
    if (typeof type.test !== 'function' || typeof type.parse !== 'function') {
      throw new ZenError(
        Codes.ROUTE_INVALID_PATH,
        `Param type "${name}" needs a test(raw) predicate and a parse(raw) function.`,
        { status: 500, expose: false },
      )
    }
    if (this.#opts.dev === true) this.#warnUnsafeTest(name, type.test)
    this.#paramTypes.set(name, { name, test: type.test, parse: type.parse, jsonSchema: type.jsonSchema } as ParamType)
    return this
  }

  /**
   * §19.3, for the one regex on the request path the framework did not write:
   * the literals in a param type's `test`, read from its text and judged by
   * the analyser CI holds the framework's own sources to. A regex the function
   * closes over is not in its text and is not seen — the reason this is a
   * development aid and `scripts/check-regex.ts` is the gate.
   */
  #warnUnsafeTest(name: string, test: Function): void {
    for (const literal of regexLiterals(String(test))) {
      let hazards: ReturnType<typeof regexHazards>
      try {
        hazards = regexHazards(literal.source, literal.flags)
      } catch {
        continue
      }
      for (const hazard of hazards) {
        this.#log.warn(
          { code: Codes.REGEX_UNSAFE, paramType: name },
          `Param type "${name}" tests with /${literal.source}/${literal.flags}, which can backtrack without bound ` +
            `at ${hazard.fragment}, so a crafted path segment makes the matcher take exponential time. ` +
            'fix: make each repetition start or end with a character the repeated part cannot match ' +
            '([a-z0-9]+(?:-[a-z0-9]+)*), or check the length before the regex runs. ' +
            'also: test runs on every request that reaches the segment.',
        )
      }
    }
  }

  /**
   * Name a schema — §10.2.
   *
   *     app.schema('User', UserSchema)
   *
   * `@erenthedeveloper0/zen-openapi` publishes it as the component `User` — ahead of any
   * `title` or `$id` the schema carries — wherever a route's request or
   * response *is* that schema, and publishes it even when no route uses it,
   * which is how a plugin contributes a shared type to a document. A name is
   * one schema's: two registrations of `User`, or one schema under two names,
   * are `ZEN_SCHEMA_NAME` at boot, naming both lines.
   */
  schema(name: string, schema: AnySchema): this {
    this.#assertOpen()
    this.#schemas.push({ name, schema, source: 'app', origin: this.#here() })
    return this
  }

  onError<E>(ctor: new (...args: never[]) => E, map: (error: E, ctx: unknown) => unknown): this {
    this.#assertOpen()
    this.#errorMappers.push({ ctor: ctor as unknown as Function, map: map as (e: unknown, c: unknown) => unknown })
    return this
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  /**
   * Registration → analysis → compilation → freeze (§2.2).
   *
   * Diagnostics are *aggregated*: a developer adding a feature module typically
   * has three or four registration problems at once, and a fail-fast framework
   * turns that into four restart cycles (§12.7).
   */
  ready(): Promise<this> {
    // One boot per application, shared by every caller — and remembered when
    // it fails. Two `inject()`s started together used to run two boots side by
    // side: every plugin's `setup` ran twice, so two connection pools were
    // opened and the second compile silently replaced the first. And a boot
    // that failed after compiling (an `onBoot` check, an eager singleton,
    // `onReady`) left the compiled state in place, so the *next* `ready()`
    // returned "ready" and `inject()`/`listen()` served an application whose
    // boot had been refused.
    return (this.#booting ??= this.#boot())
  }

  async #boot(): Promise<this> {
    const diagnostics: Diagnostic[] = []

    // ── configuration first, and "first" is the specification ──────────────
    // §16.2: "Validation happens before anything else boots." Pushed at the
    // head of the list rather than thrown, because plugin *setup* below is
    // already gated on the list being empty — so a missing JWT_SECRET stops
    // every plugin from running, which is what that sentence means, while
    // still reporting alongside the plugin-resolution and route problems the
    // same refactor caused (§12.7). A framework that threw here would hand
    // back one problem at a time, and an app with no environment file
    // typically has four.
    const config = this.#resolved()
    // Placed at the `defineConfig()` that declared the environment, or the
    // `zen()` call when there is none — the two places the fix is written.
    const declared = relativeOrigin(this.#opts.config?.origin, this.#root) ?? this.#origin
    diagnostics.push(...config.diagnostics.map((d) => placed(d, declared)))
    for (const warning of config.warnings) {
      this.#log.warn({ code: Codes.CONFIG_INVALID }, warning)
    }

    // §16.1, §19.2 — request policy, read once from the resolved configuration.
    // A refusal names the path and the source that set it, and is placed at
    // the `defineConfig()` when the configuration file set it, at the `zen()`
    // call otherwise.
    const read = readPolicy(config)
    for (const problem of read.diagnostics) {
      const fromFile = problem.locations?.some((where) => where.endsWith('← zen.config')) === true
      diagnostics.push(placed(problem, fromFile ? declared : this.#origin))
    }
    const policy = read.policy
    this.#policy = policy
    this.#applyPolicy(policy)
    if (this.#opts.fingerprintHeaders === true) {
      addHook(this.#rootScope, this.#hooks, 'onSend', this.#fingerprintStamp(), 'fingerprint headers', this.#origin)
    }

    // ── plugins: they register routes, hooks, slots and services ───────────
    const resolution = resolvePlugins(this.#plugins, this.#caps)
    diagnostics.push(...resolution.diagnostics)

    // §10.5 step 2 — every plugin's options, against its `options` schema,
    // before any `setup` runs, and all of them reported in one boot (§12.7). A
    // factory plugin (`cors({ … })`) states what it was built with as
    // `boundOptions`; an explicit `app.use(plugin, options)` wins over that.
    // `setup` is then handed the schema's *output*, not what was written.
    const accepted = new Map<PendingPlugin, unknown>()
    for (const entry of this.#plugins) {
      const given = entry.options !== undefined ? entry.options : entry.plugin.boundOptions
      const verdict = await validatePluginOptions(entry.plugin, given)
      if (verdict.diagnostic === null) accepted.set(entry, verdict.value)
      else diagnostics.push(placed(verdict.diagnostic, entry.origin))
    }

    // §8.6 — configured middleware's options, in the same pass and for the same
    // reason: every refusal in one boot, before anything has run. A plugin's
    // `setup` can register more, so this runs again once plugins have.
    const configured = new Map<ConfiguredMiddleware, OptionsVerdict>()
    await this.#checkConfigured(configured, diagnostics)

    if (diagnostics.length === 0) {
      for (const entry of resolution.order) {
        try {
          const result = await entry.plugin.setup(
            this.#registrarFor(entry),
            accepted.get(entry) as never,
          )
          if (result !== undefined && result !== null && result.exports !== undefined) {
            this.#pluginExports.set(entry.plugin.name, result.exports)
          }
        } catch (error) {
          // §10.6 — name the plugin, its version, and what will now not load,
          // rather than surfacing a bare TypeError from inside someone's setup.
          const dependents = this.#plugins
            .filter((p) => Object.hasOwn(p.plugin.dependsOn ?? {}, entry.plugin.name))
            .map((p) => p.plugin.name)
          const skipped = dependents.length > 0
            ? `These plugins depend on it and were skipped: ${dependents.join(', ')}`
            : undefined
          // §12.7 applies to a plugin's own diagnostics too, and until this read
          // `hint` and `consequence` off the thrown error it did not: a plugin
          // could state a message and nothing else, so every rule about naming
          // the fix held for the framework and for none of the ecosystem. A
          // plugin that says nothing still gets the generic pair, which is why
          // this is a `??` and not a replacement.
          const detailed = isZenError(error) ? error : null
          // §10.6 with §5.1's two sites: the line that registered the plugin,
          // and the line in the plugin that threw.
          const sites = ([
            [`use(${entry.plugin.name})`, entry.origin],
            [`${entry.plugin.name} setup`, relativeOrigin(errorOrigin(error), this.#root)],
          ] as const).filter(([, origin]) => origin !== undefined)
          diagnostics.push({
            severity: 'error',
            code: detailed?.code ?? Codes.PLUGIN_OPTIONS,
            message:
              `Plugin "${entry.plugin.name}@${entry.plugin.version}" threw during setup: ` +
              (error instanceof Error ? error.message : String(error)),
            hint: detailed?.hint ?? 'Fix the error reported above inside that plugin\'s setup().',
            consequence: detailed?.consequence ?? skipped,
            ...(sites.length === 0
              ? {}
              : { locations: sites.map(([where]) => where), origins: sites.map(([, origin]) => origin as SourceOrigin) }),
          })
          break
        }
      }
    }

    // §8.6 — every configured middleware set up once, after the plugins whose
    // services it may resolve, and before anything is compiled from it.
    await this.#checkConfigured(configured, diagnostics)
    if (diagnostics.length === 0) await this.#setUpConfigured(configured, config, diagnostics)

    // ── service graph: cycles, missing providers, captive dependencies ─────
    for (const issue of this.#container.analyze()) {
      diagnostics.push({
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        hint: issue.hint,
        ...(issue.origins === undefined ? {} : { origins: issue.origins }),
      })
    }

    // ── health checks registered during plugin setup, plus any from the app ──
    // Deferred to here rather than thrown at the call site so a duplicate check
    // name is reported alongside the other three registration problems the same
    // refactor caused, instead of costing four restarts (§12.7).
    diagnostics.push(...this.#healthDiagnostics)

    // §19.5 — an allowlist entry that can never match looks configured, so a
    // malformed one is refused here, with the spelling that would match.
    // Placed where the allowlist was written: the configuration file, or the
    // `zen()` call whose `redirect` option set it.
    const allowlist = config.snapshot.values.find((v) => v.path === 'policy.redirect.allowExternal')
    const allowedAt = allowlist?.source === 'zen.config' ? declared : this.#origin
    diagnostics.push(...this.#redirect.diagnostics.map((d) => placed(d, allowedAt)))

    // §10.2 — named schemas: usable names, one schema per name, one name per schema.
    const schemas = this.#namedSchemas(diagnostics)

    // ── hooks: reject phases this build cannot fire, before anything else ──
    // A hook that silently never runs is indistinguishable from one whose
    // condition never occurred, which is how a team ends up believing it has
    // timeout instrumentation for a year (§9.7).
    diagnostics.push(...diagnoseUnavailable(this.#allHookRecords()))
    // …and phases that do not exist at all, which were stored and never called,
    // and application phases declared on a route or collection, which likewise.
    diagnostics.push(...diagnoseUnknown(this.#allHookRecords()))
    diagnostics.push(...diagnoseMisplaced(this.#scopedHookRecords()))

    // §6.2 — conditional collections, decided once, against the validated
    // environment. A subtree that is off is absent from everything below: the
    // records, the router, the graph, and so the OpenAPI document.
    const absent = this.#absentScopes(config, diagnostics)
    // §8.7 — the same decision for a middleware's `when.env`, at the same moment.
    const omitted = this.#omittedMiddleware(config, diagnostics)

    /**
     * Routes reading an `integer` from an untyped path segment — §5.2's
     * information row, gathered and logged once rather than per route, for the
     * reason `unreadableSchemas` below is.
     */
    const untypedIntegers: string[] = []

    const records: RouteRecord[] = []
    const seen = new Map<string, PendingRoute>()
    /** Route id → the `METHOD path` that claimed it first, and where. */
    const ids = new Map<string, { readonly key: string; readonly origin: SourceOrigin | undefined }>()
    /**
     * Routes whose request schema could not be read as JSON Schema, so §11.4
     * silently did nothing.
     *
     * Collected rather than warned per route, and warned once at the end. A
     * schema library with no converter produces this on *every* route in the
     * application, and fifty identical lines at boot is how a real signal gets
     * filtered out of a log — the aggregation is the same instinct as §12.7's
     * aggregated diagnostics, applied to the warning half.
     */
    const unreadableSchemas: string[] = []

    /**
     * The compiled half of §13.4, kept out of the graph.
     *
     * `RouteRecord.negotiation` carries what the offer list *is*; this carries
     * the writers and the interned `Content-Type` strings that produce it. Same
     * split as the response serializers, which are compiled at boot and live in
     * `serializers` rather than on the record: the graph is a description and
     * has to stay serialisable (§2.4), and a compiled function is neither.
     */
    const negotiationRepresentations = new Map<RouteId, ReadonlyMap<string, Representation>>()

    /** §11.6 — one compiled serializer per distinct response shape, shared by every route that returns it. */
    const serializerMemo = createSerializerMemo()

    for (const pending of this.#routes) {
      if (absent.size > 0 && inScope(pending.scope, absent)) continue

      let parsed
      try {
        parsed = this.#opts.pathParser.parse(pending.path)
      } catch (error) {
        diagnostics.push(placed({
          severity: 'error',
          code: error instanceof ZenError ? error.code : Codes.ROUTE_INVALID_PATH,
          message: error instanceof Error ? error.message : String(error),
          locations: [`${pending.method} ${pending.path}`],
        }, pending.origin))
        continue
      }

      const key = `${pending.method} ${parsed.path}`
      const duplicate = seen.get(key)
      if (duplicate !== undefined) {
        // Both registrations, both lines: the message used to name the path
        // alone, which is the one thing the two have in common (§5.1).
        diagnostics.push({
          severity: 'error',
          code: Codes.ROUTE_DUPLICATE,
          message: `Duplicate route: ${key} is registered twice.`,
          hint: 'Remove one registration, or give them different paths.',
          ...pairedSites([[key, duplicate.origin], [key, pending.origin]]),
        })
        continue
      }
      seen.set(key, pending)

      // A route's id is its `name`, or its method and path when it has none —
      // and the id is what the compiled route table, the negotiation plan, the
      // OpenAPI operationId and every metrics label are keyed by. Two routes
      // sharing a name used to boot cleanly and then answer each other's
      // requests: the second compiled pipeline replaced the first in the table,
      // so `GET /a` ran `GET /b`'s handler, and nothing said so (§5.5).
      const id = pending.name ?? key
      const owner = ids.get(id)
      if (owner !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: Codes.ROUTE_DUPLICATE,
          message: `Route name "${id}" is used by both ${owner.key} and ${key}.`,
          hint: 'Give each route its own name. A name identifies one route — to URL generation, the OpenAPI operationId and metrics labels.',
          locations: [owner.key, key],
          ...pairedSites([[owner.key, owner.origin], [key, pending.origin]]),
        })
        continue
      }
      ids.set(id, { key, origin: pending.origin })

      // §4.4 — the deadline is resolved from the same scope chain, at the same
      // moment, as the hooks and the middleware. Innermost wins outright; a bad
      // duration is a diagnostic rather than a throw, so it is reported with
      // every other registration problem instead of costing a restart (§12.7).
      const timeout = resolveTimeout(timeoutSources(pending))
      if (!timeout.ok) {
        diagnostics.push(timeoutDiagnostic(key, timeout, {
          route: pending.origin,
          declared: timeout.where === 'route' ? pending.origin : declaringScope(pending.scope, timeout.where)?.origin,
        }))
        continue
      }

      // §11.4 — the same treatment, at the same moment. The profile is folded
      // from the scope chain and then *spent* against the schema, so what lands
      // on the record is the derived plan rather than the declared policy: the
      // question `explainRoute` and the OpenAPI generator both need answered is
      // "what will happen to `?tags=a`", and a profile cannot answer it without
      // re-reading the schema and risking a different conclusion.
      const coercion = planRoute(pending.schema, resolveCoercion(coercionChain(pending)))
      for (const source of coercion.unreadable) unreadableSchemas.push(`${key} (${source})`)

      // §5.2 — the `params` schema against the template it validates. A key
      // the router never supplies is a 400 on every request, so it is refused
      // here, with the name that was probably meant.
      const params = checkParamsSchema(key, parsed.segments, pending.schema.params)
      diagnostics.push(...params.errors.map((d) => placed(d, pending.origin)))
      for (const warning of params.warnings) this.#log.warn(logged(warning.code, pending.origin), warning.message)
      untypedIntegers.push(...params.untypedIntegers)

      // §13.4 — and the same treatment again, for the same reason. What lands
      // on the record is the *offer list in preference order*, which is what
      // `explainRoute` prints and what @erenthedeveloper0/zen-openapi turns into a `content`
      // map; the representations it also produces are the compiled half and
      // stay out of the graph, exactly as the compiled serializers do.
      const negotiated = buildNegotiation(pending.schema.response, {
        routeId: key,
        strict: policy.strict,
        mode: this.#opts.serialization?.mode ?? 'compiled',
        codegen: this.#codegen,
        memo: serializerMemo,
      })
      for (const diagnostic of negotiated.diagnostics) {
        if (diagnostic.severity === 'error') diagnostics.push(placed(diagnostic, pending.origin))
        else this.#log.warn(logged(diagnostic.code, pending.origin), diagnostic.message)
      }
      if (negotiated.representations !== null) {
        negotiationRepresentations.set((pending.name ?? key) as RouteId, negotiated.representations)
      }

      // §15.1 and §4.2 stage 6 — what the route injects has to exist, and its
      // body policy has to be one that can be honoured; both reported here,
      // with the route's line, beside every other registration problem.
      diagnostics.push(...this.#injectionProblems(key, pending))
      diagnostics.push(...intakeProblems(key, pending.schema).map((d) => placed(d, pending.origin)))

      records.push({
        id: (pending.name ?? key) as RouteId,
        name: pending.name,
        method: pending.method,
        path: parsed.path,
        segments: parsed.segments,
        schema: pending.schema,
        handler: pending.handler as (ctx: never) => unknown,
        middleware: flattenMiddleware(pending, omitted),
        // Resolved here, once, from the scope chain plus the route's own
        // `hooks` — for the same reason `middleware` is. Both are functions of
        // static registration, so both belong on the record the compiler and
        // every tool read (§9.3).
        hooks: resolveHooks(pending.scope, pending.schema.hooks, pending.origin),
        timeout: timeout.record,
        coercion: coercion.record,
        negotiation: negotiated.record,
        meta: pending.meta,
        collection: pending.scope.id === 'root' ? null : pending.scope.id,
        origin: pending.origin,
        dependencies: this.#dependenciesOf(pending.schema.inject),
      })
    }

    if (unreadableSchemas.length > 0) {
      const shown = unreadableSchemas.slice(0, 5).join(', ')
      const rest = unreadableSchemas.length - 5
      this.#log.warn(
        { code: Codes.SCHEMA_UNCONVERTIBLE, count: unreadableSchemas.length },
        `Coercion is enabled but ${unreadableSchemas.length} request ${unreadableSchemas.length === 1 ? 'schema' : 'schemas'} ` +
          'could not be converted to JSON Schema, so values will reach handlers as strings — ' +
          `${shown}${rest > 0 ? `, and ${rest} more` : ''}. ` +
          'fix: register a converter — registerSchemaConverter("zod", (s, io) => z.toJSONSchema(s, { io })) — ' +
          'or coerce in the schema with z.coerce.number(). ' +
          'also: the same schemas are undocumented by @erenthedeveloper0/zen-openapi for the same reason.',
      )
    }

    if (untypedIntegers.length > 0) {
      const shown = untypedIntegers.slice(0, 5).join(', ')
      const rest = untypedIntegers.length - 5
      this.#log.info(
        { code: Codes.PARAM_MISMATCH, count: untypedIntegers.length },
        `${untypedIntegers.length} path ${untypedIntegers.length === 1 ? 'parameter is' : 'parameters are'} ` +
          `declared integer by a params schema and untyped in the path — ${shown}${rest > 0 ? `, and ${rest} more` : ''}. ` +
          'Coercion makes that work; a typed segment (:id<int>) would refuse a non-number at the matcher, ' +
          'as a 404 before anything runs, rather than as a 400 after validation.',
      )
    }

    for (const diagnostic of this.#opts.router.analyze(records, { paramTypes: this.#paramTypes })) {
      if (diagnostic.severity === 'error') {
        diagnostics.push({
          severity: 'error',
          code: diagnostic.code,
          message: diagnostic.message,
          hint: diagnostic.hint,
          locations: diagnostic.routes.map((r) => `${r.method} ${r.path}`),
          ...pairedSites(diagnostic.routes.map((r) => [`${r.method} ${r.path}`, r.origin] as const)),
        })
      } else {
        this.#log.warn(logged(diagnostic.code, diagnostic.routes[0]?.origin), diagnostic.message)
      }
    }

    // ── response contracts (§13.3) ─────────────────────────────────────────
    // Built before the diagnostic gate so an unconvertible or ambiguous
    // response schema is reported alongside every other boot problem rather
    // than in a second restart cycle (§12.7).
    const serializers = new Map<RouteId, SerializerTable>()
    // §13.4 — the negotiation step, per route that declares more than one
    // representation. Built here rather than in `#compileRoute` because the
    // plan also has to reach `RouteRecord.negotiation`, and deriving it twice
    // is how the printed answer and the executed one get a chance to differ.
    const negotiators = new Map<RouteId, (ctx: unknown) => void>()
    for (const record of records) {
      for (const source of ['params', 'query', 'headers', 'cookies', 'body'] as const) {
        if (isDescribeOnly(record.schema[source])) {
          diagnostics.push(placed({
            severity: 'error',
            code: Codes.SCHEMA_UNCONVERTIBLE,
            message: `${record.method} ${record.path} uses jsonSchema() to validate "${source}", but jsonSchema() describes a shape and cannot validate.`,
            hint: 'Use a Standard Schema library (Zod, Valibot, ArkType) for request sources. jsonSchema() is for `response` only.',
            locations: [`${record.method} ${record.path}`],
          }, record.origin))
        }
      }

      const serializerOptions = {
        routeId: `${record.method} ${record.path}`,
        strict: policy.strict,
        mode: this.#opts.serialization?.mode ?? 'compiled',
        codegen: this.#codegen,
        memo: serializerMemo,
      } as const

      const built = buildSerializerTable(record.schema.response, serializerOptions)
      for (const diagnostic of built.diagnostics) {
        if (diagnostic.severity === 'error') diagnostics.push(placed(diagnostic, record.origin))
        else this.#log.warn(logged(diagnostic.code, record.origin), diagnostic.message)
      }
      if (built.table !== null) serializers.set(record.id, built.table)

      // §13.4 — the variant form, from the plan already on the record. The plan
      // was derived once, in the registration loop above, next to `coercion`
      // and `timeout`; what happens here is only turning it into the step the
      // pipeline calls. `buildNegotiation` returns a null plan whenever it
      // produced a diagnostic, so this never installs half a negotiator on a
      // route whose boot is about to be refused.
      if (record.negotiation !== null) {
        const representations = negotiationRepresentations.get(record.id)
        if (representations !== undefined) {
          negotiators.set(
            record.id,
            makeNegotiationStep(
              makeNegotiator(record.negotiation.offers, representations),
              record.negotiation.offers,
            ) as (ctx: unknown) => void,
          )
        }
      }
    }

    if (diagnostics.length > 0) throw new BootError(diagnostics)

    // §15.1 — injected singletons, built once, now, so no request pays for them.
    const injections = await this.#resolveInjections(records)

    // ── compile ────────────────────────────────────────────────────────────
    const Ctx = compileContext({
      decorations: this.#decorations,
      slotCount: slotCount(),
      codegen: this.#codegen,
      // §7.3 — sealed and frozen in development; byte-identical otherwise.
      dev: this.#opts.dev === true,
    })

    const router = this.#opts.router.build(records, { codegen: this.#codegen, paramTypes: this.#paramTypes } as never)

    // §5.7 — read from the same records and checked against this router, so a
    // link can only be built to where this application actually routes.
    const urls = new UrlTable(records, { router, maxQueryParams: policy.maxQueryParams })

    const byId = new Map<RouteId, CompiledRoute>()
    for (const record of records) {
      const compiledRoute = this.#compileRoute(
        record, serializers.get(record.id) ?? null, negotiators.get(record.id) ?? null, injections.get(record.id) ?? null,
      )
      byId.set(record.id, {
        record,
        pipeline: compiledRoute.pipeline,
        spec: compiledRoute.spec,
        timeoutMs: record.timeout?.ms ?? 0,
        onError: functionsFor(record.hooks, 'onError'),
        onResponse: functionsFor(record.hooks, 'onResponse'),
        onSend: functionsFor(record.hooks, 'onSend'),
        onTimeout: functionsFor(record.hooks, 'onTimeout'),
      })
    }

    // A request that matches nothing still has to be observable: 404s are the
    // most under-instrumented class of response in most services precisely
    // because there is no route object to hang a hook on.
    const rootOnly = resolveHooks({ ...this.#rootScope, parent: null }, undefined)
    const globalHooks: GlobalHooks = {
      onError: functionsFor(rootOnly, 'onError'),
      onResponse: functionsFor(rootOnly, 'onResponse'),
      onSend: functionsFor(rootOnly, 'onSend'),
      onTimeout: functionsFor(rootOnly, 'onTimeout'),
    }
    const unmatchedOnRequest = functionsFor(rootOnly, 'onRequest')

    // The app default applies to unmatched requests too, for the same reason
    // global `onRequest` hooks do (§9.2): that is where rate limiting and CORS
    // live, and a rate limiter blocking on a store it cannot reach would
    // otherwise hold a 404's connection open with nothing to time it out.
    const unmatched = resolveTimeout([{ where: 'app', spec: this.#rootScope.timeout }])
    const unmatchedTimeoutMs = unmatched.ok ? (unmatched.record?.ms ?? 0) : 0

    const dev = this.#opts.dev === true
    const errors = new ErrorEngine({
      dev,
      logger: this.#log,
      ...(dev ? { explain: (error: ZenError, info: ErrorContextInfo) => this.#devFacts(error, info) } : {}),
      ...(dev && this.#opts.devErrors?.report !== undefined ? { report: this.#opts.devErrors.report } : {}),
    })
    for (const mapper of this.#errorMappers) errors.register(mapper.ctor, mapper.map)

    const graph: AppGraph = Object.freeze({
      routes: records,
      collections: this.#scopes
        .filter((s) => s.parent !== null && !inScope(s, absent))
        .map((s) => ({
          id: s.id, prefix: s.prefix, name: s.name,
          parent: s.parent === null ? null : s.parent.id,
          tags: s.tags, meta: s.meta, origin: s.origin,
        })),
      plugins: resolution.order.map((p) => ({
        name: p.plugin.name,
        version: p.plugin.version,
        dependsOn: p.plugin.dependsOn ?? {},
        scope: 'root',
        origin: p.origin,
      })),
      hooks: this.#hooksByPhase(absent),
      slots: declaredSlots(),
      decorations: this.#decorationRecords(),
      checks: this.#health.checks,
      paramTypes: router.paramTypes,
      config: config.snapshot,
      // §10.2 — what plugins wrote with `Registrar.meta`, keyed `plugin.key`.
      // It was written into the root scope and the graph was handed a fresh
      // empty map, so every write landed nowhere a reader could look until
      // `0.1.0-alpha.4`. A copy, so nothing reaches it after the freeze.
      meta: new Map(this.#rootScope.meta),
      schemas,
      services: this.#container.providers,
      builtAt: Date.now(),
    })

    this.#compiled = {
      router,
      Ctx,
      byId,
      graph,
      globalHooks,
      unmatchedOnRequest,
      unmatchedTimeoutMs,
      env: {
        log: this.#log,
        maxQueryParams: policy.maxQueryParams,
        trustProxy: policy.trustProxy,
        container: this.#container,
        // Shared by every context in the process — see `ContextEnv.config` for
        // why this is not a field on the context itself.
        config: config.config,
        // §19.5 — the same argument: one policy per app, reached through env.
        redirect: this.#redirect.policy,
      },
      errors,
      urls,
    }
    this.#frozen = true

    // §2.4 — the fingerprints the headers carry, before the first request can.
    if (this.#opts.fingerprintHeaders === true) {
      const document = await this.graphDocument()
      this.#fingerprints = {
        app: document.fingerprint,
        contracts: new Map(document.routes.map((route) => [route.id, route.contract])),
      }
    }

    // Plugins get a final look at the frozen graph before it is used — this is
    // how OpenAPI generation and the route inspector work (§10.2).
    //
    // One table, in registration order: `app.hook('onBoot', fn)` and a plugin's
    // `Registrar.onBoot(fn)` are the same registration. `onBoot` was in
    // `APP_PHASES`, so `app.hook('onBoot', fn)` passed every phase diagnostic
    // and was stored — and this loop read a second, separate list that only
    // `Registrar.onBoot` filled, so the hook never ran (§9.7's failure exactly:
    // accepted, stored, silent). Until `0.1.0-alpha.4`.
    for (const hook of this.#hooks.get('onBoot') ?? []) {
      try {
        await (hook.fn as (graph: AppGraph) => unknown)(graph)
      } catch (error) {
        // A boot check refused the graph — OpenAPI's strict mode, the health
        // plugin's required checks. Its diagnostics name what is wrong; the
        // hook's own origin says which registration asked for the check, for
        // the ones that carry no line of their own (§5.1).
        if (error instanceof BootError && hook.origin !== undefined) {
          throw new BootError(error.diagnostics.map((d) => placed(d, hook.origin)))
        }
        throw error
      }
    }

    await this.#container.warm()

    for (const hook of this.#hooks.get('onReady') ?? []) {
      await (hook.fn as () => unknown)()
    }

    // §31.4 — readiness turns true *here*, after warm-up and after `onReady`,
    // and not one line earlier. Everything above this point is a reason a pod
    // is not yet able to serve a request correctly, and a readiness endpoint
    // that answered 200 during it would put a half-built process into the load
    // balancer. Liveness has been passing the whole time, which is the other
    // half: a slow boot must not look like a wedged process.
    this.#health.live()

    this.#log.debug(
      { routes: records.length, engine: router.stats.engine, codegen: this.#codegen.enabled },
      'zen ready',
    )
    return this
  }

  /**
   * §15.1 — every token a route injects must have a provider, unless it is
   * optional (§15.2): the missing service is named with the route that needs
   * it and the route's line, and with the closest registered name.
   */
  #injectionProblems(key: string, pending: PendingRoute): Diagnostic[] {
    const inject = pending.schema.inject
    if (inject === undefined) return []
    const out: Diagnostic[] = []
    if (typeof inject !== 'object' || inject === null) {
      return [placed({
        severity: 'error',
        code: Codes.CONFIG_INVALID,
        message: `${key} declares \`inject\` as ${inject === null ? 'null' : `a ${typeof inject}`}; it maps names to service tokens.`,
        hint: 'Write `inject: { db: Db }`, with tokens from token<T>(name).',
      }, pending.origin)]
    }
    const names = this.#container.providers.map((p) => p.token.name)
    for (const [as, value] of Object.entries(inject)) {
      if (!isToken(value)) {
        out.push(placed({
          severity: 'error',
          code: Codes.CONFIG_INVALID,
          message: `${key} injects "${as}" from something that is not a service token.`,
          hint: 'Each value of `inject` is a token from token<T>(name).',
        }, pending.origin))
        continue
      }
      if (this.#container.has(value) || value.optional === true) continue
      const close = closest(value.name, names)
      out.push(placed({
        severity: 'error',
        code: Codes.DI_MISSING,
        message: `${key} injects "${as}" from service "${value.name}", which has no provider.`,
        hint: close === null
          ? `Register one with app.provide(${value.name}, …), or declare the token { optional: true }.`
          : `Did you mean "${close}"?`,
      }, pending.origin))
    }
    return out
  }

  /** `RouteRecord.dependencies` — the services `inject` reaches, transitively, by name (§15.1). */
  #dependenciesOf(inject: RouteSpec['inject']): readonly string[] {
    if (inject === undefined || typeof inject !== 'object' || inject === null) return NO_NAMES
    const byToken = new Map(this.#container.providers.map((p) => [p.token, p]))
    const seen = new Set<Token<unknown>>()
    const names = new Set<string>()
    const visit = (token: Token<unknown>): void => {
      if (seen.has(token)) return
      seen.add(token)
      names.add(token.name)
      for (const dep of byToken.get(token)?.deps ?? []) visit(dep)
    }
    for (const value of Object.values(inject)) if (isToken(value)) visit(value)
    return names.size === 0 ? NO_NAMES : Object.freeze([...names].sort())
  }

  /**
   * §15.1 — each injecting route's services. Singletons are built now, once,
   * through the container that would have built them on first use, and a route
   * that injects nothing else gets one frozen object every request shares. A
   * scoped or transient service is resolved per request from that request's
   * scope; the singletons beside it are still resolved here.
   */
  async #resolveInjections(records: readonly RouteRecord[]): Promise<ReadonlyMap<RouteId, Injection>> {
    const out = new Map<RouteId, Injection>()
    const lifetimes = new Map(this.#container.providers.map((p) => [p.token, p.lifetime]))
    for (const record of records) {
      const inject = record.schema.inject
      if (inject === undefined) continue
      const fixed: Record<string, unknown> = {}
      const perRequest: Array<readonly [string, Token<unknown>]> = []
      for (const [as, token] of Object.entries(inject)) {
        const lifetime = lifetimes.get(token)
        if (lifetime === undefined) fixed[as] = undefined // an optional token nobody provided (§15.2)
        else if (lifetime === 'singleton') fixed[as] = await this.#container.resolveAsync(token)
        else perRequest.push([as, token])
      }
      out.set(record.id, perRequest.length === 0
        ? { kind: 'static', deps: Object.freeze(fixed) }
        : { kind: 'request', wrap: (handler) => injectedHandler(handler, this.#container, fixed, perRequest) })
    }
    return out
  }

  /**
   * The bounded capability surface handed to `Plugin.setup` — §10.2.
   *
   * Deliberately not the app object. A plugin cannot mutate another plugin's
   * registrations, read the global registry, or patch `Context.prototype`,
   * because none of those are reachable from here.
   */
  #registrarFor(entry: PendingPlugin): Registrar {
    const app = this
    const pluginName = entry.plugin.name
    // §5.1 — a registration made from `setup` is placed at the line in the
    // plugin that made it. A first-party plugin is framework code all the way
    // down, so its registrations are placed where the application wrote
    // `app.use(plugin)` instead: the one line in the application that caused
    // them, and the one a reader can act on.
    const where = (): SourceOrigin | undefined => app.#here('setup') ?? entry.origin
    return {
      pluginName,
      caps: this.#caps,

      // §16.2's ordering, made reachable. `#resolved()` is memoised and was
      // already computed at the head of `ready()`; nothing a plugin can do from
      // `setup` invalidates it, because the `Registrar` has no way to register
      // another plugin. A getter rather than a captured value so that a plugin
      // constructed before `ready()` — `app.use(cors)` in one file, boot in
      // another — cannot close over a stale fold.
      get config() {
        return app.#resolved().config
      },

      use(middleware, opts) {
        app.#rootScope.middleware.push(middlewareRef('phase', middleware, opts, app.#rootScope.id, where(), pluginName))
      },
      around(middleware, opts) {
        app.#rootScope.middleware.push(middlewareRef('around', middleware, opts, app.#rootScope.id, where(), pluginName))
      },
      after(middleware, opts) {
        app.#rootScope.middleware.push(middlewareRef('after', middleware, opts, app.#rootScope.id, where(), pluginName))
      },

      // Plugin routes go through `#register` like every other route: same
      // conflict analysis, same middleware, same AppGraph. A docs plugin whose
      // path collides with an application route is a boot error naming both.
      route(definition) {
        app.#register(
          app.#rootScope,
          definition.method,
          definition.path,
          { ...definition.schema, name: definition.name, meta: definition.meta },
          definition.handler,
          where(),
        )
      },

      hook(phase, fn, name) {
        addHook(app.#rootScope, app.#hooks, phase, fn, name ?? pluginName, where())
      },

      // Slot names are namespaced by plugin, so two plugins declaring "user"
      // collide with a named boot error rather than silently sharing a cell.
      slot<T>(name: string, opts?: SlotOptions<T>) {
        return declareSlot<T>(`${pluginName}.${name}`, opts)
      },

      decorate(name, slotOrAccessor) {
        app.#decorate(name, slotOrAccessor, `plugin "${pluginName}"`, where())
      },

      provide(token, spec) {
        app.#container.provide(token, spec, where())
      },

      // Namespaced by owner, like slots: two plugins each registering "cache"
      // is a boot error naming both rather than one of them silently winning
      // and the other's dependency going unprobed (§31.4).
      health(name, probe, opts) {
        const diagnostic = app.#health.register(name, probe, opts, `plugin "${pluginName}"`, where())
        if (diagnostic !== null) app.#healthDiagnostics.push(diagnostic)
      },

      probe(kind) {
        return app.#health.run(kind)
      },

      errorMap(ctor, map) {
        app.#errorMappers.push({
          ctor: ctor as unknown as Function,
          map: map as (e: unknown, c: unknown) => unknown,
        })
      },

      // Namespaced by plugin, and carried on `graph.meta` (§10.2), where
      // `@erenthedeveloper0/zen-openapi` reads `<plugin>.openapi.*` entries.
      meta(key, value) {
        app.#rootScope.meta.set(`${pluginName}.${key}`, value)
      },

      schema(name, schema) {
        app.#schemas.push({ name, schema, source: `plugin "${pluginName}"`, origin: where() })
      },

      // Sugar for `hook('onBoot', fn)`: one table, so both forms run, in the
      // order they were registered (§9.2).
      onBoot(fn) {
        addHook(app.#rootScope, app.#hooks, 'onBoot', fn, pluginName, where())
      },

      exportsOf(name) {
        return app.#pluginExports.get(name)
      },

      // §5.7 — for the plugin's handlers, at request time; during `setup` the
      // routes are not compiled yet, and `url()` says so.
      url(name, params, query) {
        return app.url(name, params, query)
      },
    }
  }

  #compileRoute(
    record: RouteRecord,
    serialize: SerializerTable | null,
    negotiate: ((ctx: unknown) => void) | null,
    injection: Injection | null,
  ): { readonly pipeline: CompiledPipeline; readonly spec: PipelineSpec } {
    // Middleware only. Hooks used to be smuggled in here as pipeline steps,
    // which worked for the four phases that happened to sit next to a
    // middleware position and could not express the other eight — `preHandler`
    // ran before body intake, which is not what §9.2 says it is.
    // §8.7 applied: an omitted step is absent, a guarded one is behind its
    // predicate, and everything else is the function as registered.
    const steps: PipelineStep[] = pipelineSteps(record.middleware)

    // Stage 6 is emitted only when the route declares a body — this is the
    // single biggest divergence from Express, where json() parses every body.
    // `onParse` composes into it rather than being a separate stage, so a parse
    // hook cannot resurrect an intake the route does not have.
    //
    // §4.2 stage 6, per route: an `intake` declares that the route reads its
    // body, and its fields override the application's limits for this route's
    // intake closure alone — compiled in, so no request looks the policy up.
    const policy = record.schema.intake
    const declaresBody = record.schema.body !== undefined || policy !== undefined
    const bodyOptions = policy === undefined ? this.#bodyOptions : { ...this.#bodyOptions, ...definedOf(policy) }
    const mode = policy?.mode ?? 'parse'
    const intake = !declaresBody
      ? null
      : mode === 'raw'
        ? makeRawIntake(bodyOptions)
        : mode === 'stream'
          ? makeStreamIntake(bodyOptions)
          : withParseHooks(makeIntake(this.#parsers, bodyOptions), functionsFor(record.hooks, 'onParse'))

    // §11.4 — one generated coercer per source that has a plan, and `null`
    // everywhere else. `compileValidator` branches on that once, at boot, so a
    // route with nothing to convert gets back the closure it had before the
    // feature existed rather than one carrying a per-request check.
    const plans = record.coercion
    const validators = VALIDATION_SOURCES
      .filter((source): source is ValidationSource => record.schema[source] !== undefined)
      .map((source) => {
        const plan = plans?.get(source)
        const compiled = plan === undefined
          ? null
          : compileCoercer(plan, `${record.method}_${record.path}#${source}`, this.#codegen)
        // §7.3 — development freezes request data when it is read, and the
        // validation stage reads it; a coercer converts in place, so there it
        // converts a thawed copy. Production builds the coercer alone.
        const coerce = compiled !== null && this.#opts.dev === true ? thawingCoercer(compiled) : compiled
        return compileValidator(record.schema[source] as AnySchema, source, coerce)
      })

    // §4.2 stage 7 — two or more sources are validated as one stage, so every
    // failure reaches the client at once. One source compiles as it always did.
    const stage = validators.length > 1 ? [combineValidators(validators)] : validators
    // §11.7 — `check` is the last validator of the stage: it runs only once the
    // schemas have passed, and before `postValidation` and `preHandler`.
    const check = record.schema.check
    if (typeof check === 'function') stage.push(compileCheck(check))

    const spec = {
      routeId: `${record.method}_${record.path}`,
      steps,
      // §15.1 — a route whose services are all singletons gets them as a
      // frozen object passed by the pipeline; one with a per-request service
      // gets a handler that resolves it from the request's scope first.
      handler: injection?.kind === 'request' ? injection.wrap(record.handler as Function) : record.handler as Function,
      deps: injection?.kind === 'static' ? injection.deps : null,
      intake,
      validators: stage,
      serialize,
      // §13.4 — `null` unless the route declared the variant form, and the
      // generator emits nothing for it when it is null.
      negotiate,
      hooks: pipelinePlan(record.hooks, NO_HOOKS) ?? undefined,
      // §4.4 — three stage marks and three branches, or no emitted text at all.
      deadline: record.timeout !== null,
      // §11.5 — the response checked against its schema, or nothing emitted.
      validateResponse: this.#responseValidator(record),
    }

    const pipeline = this.#opts.pipeline === 'simple'
      ? simplePipeline(spec)
      : compilePipeline(spec, this.#codegen)
    return { pipeline, spec }
  }

  /**
   * §11.5 — one route's response validator under the configured mode, or
   * `null`: when the mode is `'off'`, or the route declares nothing that can
   * validate. Either way a `null` compiles to no text at all.
   */
  #responseValidator(record: RouteRecord): ResponseValidator | null {
    const setting = this.#policy?.responseValidation
    if (setting === undefined || setting.mode === 'off') return null
    return compileResponseValidator(record.schema.response as Readonly<Record<number, unknown>> | undefined, {
      mode: setting.mode,
      sample: setting.sample,
      routeId: `${record.method} ${record.path}`,
      log: this.#log,
      serialization: this.#opts.serialization?.mode ?? 'compiled',
    })
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  /** The Dispatcher (§4.2 stages 3-10). Bound once, at boot. */
  get dispatch(): (raw: RawRequest, conn: Connection) => Promise<void> {
    return (raw, conn) => {
      const compiled = this.#compiled
      if (compiled === null) {
        return Promise.reject(new ZenError(Codes.APP_NOT_READY, 'App.dispatch used before ready()', { status: 500 }))
      }
      return this.#serve(raw, conn, compiled)
    }
  }

  /**
   * Stages 3–10 against one compiled table — the production one from
   * `dispatch`, or a copy holding an instrumented route from `explainRequest`
   * (§8.5). Taking the table as an argument is what lets an explanation run
   * without installing anything: the production table is never written.
   */
  async #serve(raw: RawRequest, conn: Connection, compiled: CompiledApp): Promise<void> {
    const path = pathnameOf(raw.url)
    const match = compiled.router.match(raw.method, path)

    let ctx: PlainContext | null = null
    let hooks: GlobalHooks = compiled.globalHooks
    // §4.4 — armed before the context is built, so `ctx.signal` is the
    // composed one from the very first hook rather than being swapped
    // underneath code that already captured it.
    let deadline: Deadline | null = null
    try {
      if (match === null || match.route === null) {
        deadline = this.#arm(compiled.unmatchedTimeoutMs, raw, conn)
        ctx = new compiled.Ctx(raw, null, EMPTY, compiled.env, signalOf(deadline, conn), deadline)
        ctx.id = makeRequestId()
        ctx.startTime = performance.now()

        // Global `onRequest` hooks run even though no route matched — §9.2.
        //
        // Not a courtesy. `onRequest` is the documented home for rate
        // limiting, CORS and auth, and a rate limiter that only sees matched
        // routes is bypassed by requesting a path that does not exist. Only
        // the global scope can apply: there is no route, so there is no
        // collection chain to inherit from.
        const work = runUnmatched(compiled.unmatchedOnRequest, ctx)
        const early = deadline === null ? await work : await Promise.race([work, deadline.expiry])
        if (early !== null) {
          await this.#send(ctx, conn, early, hooks.onResponse)
          return
        }

        // Routine refusals, built without a stack: it could only ever show
        // these few lines of the dispatcher, and capturing it was most of why
        // a 404 cost ~6× a served request (§28.8, `withoutStack`).
        if (match === null) throw withoutStack(() => new NotFound(`No route matches ${raw.method} ${path}`))
        throw withoutStack(() => new MethodNotAllowed(`${raw.method} is not allowed for ${path}`, {
          headers: { allow: match.allowed.join(', ') },
        }))
      }

      const compiledRoute = compiled.byId.get(match.route.id)
      if (compiledRoute === undefined) {
        throw new ZenError(Codes.INTERNAL, `No compiled pipeline for route ${match.route.id}`, { status: 500 })
      }
      // Captured before the pipeline runs, so a throw from *inside* it still
      // reaches this route's error and response hooks rather than only the
      // global ones (§9.4).
      hooks = compiledRoute
      deadline = this.#arm(compiledRoute.timeoutMs, raw, conn)

      ctx = new compiled.Ctx(
        raw,
        {
          id: match.route.id,
          name: match.route.name,
          method: match.route.method,
          path: match.route.path,
          meta: match.route.meta,
        },
        match.params as Record<string, unknown>,
        compiled.env,
        signalOf(deadline, conn),
        deadline,
      )
      ctx.id = makeRequestId()
      ctx.startTime = performance.now()

      // The race is the *arm*: it guarantees an answer at the deadline even
      // when the pipeline is stuck on an `await` nothing will ever settle.
      // The pipeline's own stage checks then stop the abandoned work at the
      // next boundary — the two together are what make a deadline mean
      // something, and neither is sufficient alone (§4.4).
      //
      // `Promise.race` attaches a handler to both, so a pipeline that rejects
      // *after* the deadline won already has a listener and cannot surface as
      // an unhandled rejection.
      //
      // A pipeline that returned synchronously skips the race entirely, and
      // not as a micro-optimisation: a fully synchronous pipeline never
      // yields, so its deadline provably cannot have fired. §8.4's sync fast
      // path is un-timeoutable by construction — which is fine, because it is
      // also incapable of hanging.
      const running = compiledRoute.pipeline(ctx)
      const reply = deadline === null || !isThenable(running)
        ? await running
        : await Promise.race([running, deadline.expiry])

      // The clock stops before egress on purpose: the deadline bounds stages
      // 5-9, up to handing the reply to the adapter. It does not bound the
      // write. Cancelling a 2 GB download halfway is not a timeout, it is a
      // corrupt response — the status line has already gone out and there is
      // no way to take it back (§4.4). Only the *timer* stops: the connection
      // listener stays until the `finally`, so a streamed body still sees
      // `ctx.signal` abort when its client leaves.
      deadline?.settle()
      await this.#send(ctx, conn, reply, hooks.onResponse)
    } catch (error) {
      const target = ctx ?? new compiled.Ctx(raw, null, EMPTY, compiled.env, conn.signal)
      if (target.id === '') target.id = makeRequestId()
      const info: ErrorContextInfo = {
        requestId: target.id,
        method: raw.method,
        path,
        route: target.route?.path ?? null,
        routeId: target.route?.id ?? null,
        // So the error engine can tell this request's own abort from one the
        // application caused (§12.4) — see `classify`.
        signal: target.signal,
        // §12.6 — read only in development, where a browser gets a page.
        ...(this.#opts.dev === true ? { html: prefersHtml(raw.header('accept')) } : {}),
      }
      const reply = deadline !== null && (error as unknown) === EXPIRED
        ? await this.#timeoutReply(target, deadline, hooks, info)
        : await this.#errorReply(target, error, hooks, info)
      // The error reply is egress too, and §4.4 does not bound egress: a timer
      // left running here could fire mid-write and publish `timedOut` on a
      // request that failed for an unrelated reason.
      deadline?.settle()
      await this.#send(target, conn, reply, hooks.onResponse)
    } finally {
      // In a `finally` because the failure mode of forgetting it is invisible
      // under test and fatal under load: one leaked timer per request.
      deadline?.disarm()
      // Normally already done by `#send`. This covers the exchange whose
      // error reply could not be written either — a request that failed
      // twice still has a transaction to roll back.
      if (ctx !== null && ctx.$disposers !== SETTLED) await this.#release(ctx)
    }
  }

  /**
   * Arm a deadline for one request, or `null` when the route declared none.
   *
   * The budget is the route's, possibly shortened by an inbound header. It can
   * only ever be shortened — see `budgetFor`.
   *
   * An in-process request's timer holds the event loop open; a socket's does
   * not, because the socket already does (`Connection.inProcess`). Before
   * `0.1.0-alpha.4` neither did, so an `inject()` whose handler waited on
   * `ctx.signal` in an otherwise idle script let Node exit before the deadline
   * answered — no reply, no error, and exit code 13.
   */
  #arm(routeMs: number, raw: RawRequest, conn: Connection): Deadline | null {
    if (routeMs <= 0) return null
    const budget = budgetFor(routeMs, this.#timeoutHeader, (name) => raw.header(name as never))
    return new Deadline(budget, conn.signal, conn.inProcess === true)
  }

  /**
   * A blown deadline — §4.4, §9.2 phase 12.
   *
   * **Every** `onTimeout` hook runs, innermost-first, and the *first* one to
   * return a `Reply` answers the request. That is deliberately not `onError`'s
   * nearest-handler rule, and the difference is worth stating because it looks
   * like an inconsistency until you have hit it.
   *
   * An error is a value that one handler owns; `catch` semantics are the right
   * model and everyone already has the intuition. A deadline is an *event about
   * the request*, and "who answers it" and "who records it" are different jobs
   * held by different scopes. Under `catch` semantics a global timeout counter
   * would go silent the moment any route started degrading gracefully — the
   * counter would read zero on exactly the routes that handled their deadlines
   * best, and it would look like it worked until somebody added a route hook.
   * §9.7 refuses to let a hook be registered when it can never fire, for the
   * same reason: a phase that silently stops firing is indistinguishable from a
   * condition that stopped occurring.
   *
   * So: everyone observes, one answers. A hook that throws is logged and
   * skipped, and the deadline still stands — instrumentation must never be able
   * to convert a timeout into a different failure (§9.5).
   *
   * If nothing answered, the deadline becomes an ordinary `ZEN_TIMEOUT` error
   * and takes the ordinary error path, so error mappers, `onError` hooks, the
   * RFC 9457 envelope and `onSend` all cover it exactly as they cover a bad
   * body. A timeout being a special case that skips half the error machinery is
   * how services end up with timeouts that no dashboard counts.
   */
  async #timeoutReply(
    ctx: PlainContext,
    deadline: Deadline,
    hooks: GlobalHooks,
    info: ErrorContextInfo,
  ): Promise<Reply> {
    ctx.timedOut = true
    const detail: TimeoutInfo = deadline.info(ctx.startTime, ctx.route?.path ?? null)

    let answer: Reply | null = null
    for (const hook of hooks.onTimeout) {
      try {
        const result = await (hook as (c: unknown, i: TimeoutInfo) => unknown)(ctx, detail)
        if (result !== undefined && answer === null) answer = finalize(result, true)
      } catch (hookError) {
        this.#log.error({ err: hookError }, 'onTimeout hook threw; the deadline still stands')
      }
    }

    return answer === null
      ? this.#errorReply(ctx, timeoutError(detail), hooks, info)
      : this.#applyOnSend(ctx, answer, hooks.onSend)
  }

  /**
   * The error path — §4.6, §9.5.
   *
   * `onError` hooks run innermost-first and the first one to return a Reply
   * wins, exactly like nested `catch` blocks. A hook that *throws* is logged
   * and skipped: the client is owed the original error, not a second one caused
   * by the instrumentation that was supposed to report the first.
   *
   * `onSend` then runs on the error reply, so compression and header stamping
   * cover failures as well as successes. `after` middleware deliberately does
   * not: §4.6 says the error path never re-enters user middleware, and this is
   * where the hook/middleware line earns itself — **hooks observe the error
   * path, middleware does not.**
   */
  async #errorReply(
    ctx: PlainContext,
    error: unknown,
    hooks: GlobalHooks,
    info: ErrorContextInfo,
  ): Promise<Reply> {
    let reply: Reply | null = null

    for (const hook of hooks.onError) {
      try {
        const result = await (hook as (c: unknown, e: unknown) => unknown)(ctx, error)
        if (result !== undefined) {
          reply = finalize(result, true)
          break
        }
      } catch (hookError) {
        this.#log.error({ err: hookError }, 'onError hook threw; the original error still stands')
      }
    }

    reply ??= (this.#compiled as { errors: ErrorEngine }).errors.handle(error, info)

    return this.#applyOnSend(ctx, reply, hooks.onSend)
  }

  /**
   * `onSend` off the success path — §9.6.
   *
   * Shared by the error path and the timeout path so compression and header
   * stamping cover failures and deadlines as well as successes. A hook that
   * throws here is logged and skipped for the same reason an `onError` hook
   * that throws is: the client is owed the failure that happened, not the one
   * the reporter caused.
   */
  async #applyOnSend(ctx: PlainContext, reply: Reply, onSend: readonly Function[]): Promise<Reply> {
    let current = reply
    for (const hook of onSend) {
      try {
        const result = await (hook as (c: unknown, r: Reply) => unknown)(ctx, current)
        if (result !== undefined) current = result as Reply
      } catch (hookError) {
        this.#log.error({ err: hookError }, 'onSend hook threw off the success path; skipping it')
      }
    }
    return current
  }

  async #send(ctx: PlainContext, conn: Connection, reply: Reply, onResponse: readonly Function[]): Promise<void> {
    const wire = stripBodyIfNeeded(prepareForWire(ctx, reply))
    // §7.3 — the staged metadata has just been applied, so from here a write to
    // `ctx.res` would be accepted and then discarded. It throws
    // `ZEN_REPLY_SENT` instead. One store into a field every context already
    // has, of a shared frozen object: no field, no allocation (I2).
    ctx.$stage = SEALED_STAGE
    await conn.send(wire)

    // Stage 10 — after the last byte. Never able to affect the client (§9.5).
    //
    // `aborted` and `timedOut` are published here rather than polled, so a hook
    // can classify the request without touching the signal (§4.4). The two
    // together decompose the outcome: `aborted && timedOut` is a deadline we
    // blew, `aborted && !timedOut` is a client that left, and neither is the
    // ordinary case. Counting only one of them is how "we have no slow
    // requests" and "8% of clients give up" coexist on the same dashboard.
    ctx.aborted = ctx.signal.aborted
    ctx.timedOut = ctx.$deadline !== null && ctx.$deadline.expired
    for (const hook of onResponse) {
      try {
        await (hook as (c: unknown, r: Reply) => unknown)(ctx, wire)
      } catch (error) {
        this.#log.error({ err: error }, 'onResponse hook threw; ignoring')
      }
    }

    // Almost every request has nothing to release, and it must not pay an
    // `await` to find that out — a call into an async function is a promise
    // and a tick on every request in the application.
    if (ctx.$disposers === null) ctx.$disposers = SETTLED
    else await this.#release(ctx)
  }

  /**
   * Stage 10's last step — release what the request took, newest first: every
   * value a disposable slot held and every request-scoped service with a
   * `dispose` (§4.2, §7.4, §15.3).
   *
   * Idempotent, because it is reached twice on one path: once from `#send`, and
   * once from the dispatcher's `finally` for the exchange whose write threw
   * before `#send` got this far. The list is swapped for `SETTLED` before the
   * first disposer runs, so the second call finds nothing to do — and anything
   * the request acquires *after* this point (a handler still running behind a
   * deadline that has already answered) is released the moment it arrives, by
   * `trackDisposal`, rather than queued on a list nobody will read again.
   */
  async #release(ctx: PlainContext): Promise<void> {
    const disposals = ctx.$disposers
    ctx.$disposers = SETTLED
    if (disposals === null || disposals === SETTLED) return
    for (let i = disposals.length - 1; i >= 0; i--) {
      const disposal = disposals[i] as (typeof disposals)[number]
      try {
        await (disposal.dispose as (value: unknown) => unknown)(disposal.value)
      } catch (error) {
        this.#log.error({ err: error, slot: disposal.name }, 'dispose threw; releasing the rest')
      }
    }
  }

  // ── in-process testing (§20.2) ───────────────────────────────────────────

  /**
   * Runs the *entire* pipeline — hooks, middleware, validation, serialization,
   * error handling — with no sockets, no ports, and no cleanup. 20-50x faster
   * than supertest-style testing and with no flaky-port failure mode.
   *
   * `signal` stands in for the client's connection. Aborting it is how a test
   * says "the browser hit stop", which is otherwise the one lifecycle event
   * in-process testing cannot reach — and therefore the one nobody tests, which
   * is why disconnect handling is usually discovered in production (§4.4).
   */
  async inject(
    method: string,
    url: string,
    init: {
      headers?: Record<string, string>
      body?: unknown
      signal?: AbortSignal
      /**
       * The peer the request comes from — what `ctx.ip` reads when no proxy is
       * trusted, and the last hop when one is (§19.4). `127.0.0.1` unless set,
       * which is the one address a rate limiter keyed on `ctx.ip` and a test of
       * `trustProxy` hop counting both needed to vary.
       */
      remote?: RemoteInfo
    } = {},
  ): Promise<InjectedResponse> {
    await this.ready()
    // `#serve` is awaited here rather than behind a second `async` method: an
    // async function returning another's promise costs the request extra
    // microtask turns, measured at ~60 ns of a ~1.2 µs inject.
    const exchange = injected(method, url, init)
    await this.#serve(exchange.raw, exchange.conn, this.#compiled as CompiledApp)
    return exchange.response()
  }

  /**
   * @internal — EXPLAIN ANALYZE for HTTP (§8.5); call it through
   * `explainRequest(app, method, url, init)`, which renders what this returns.
   *
   * One request, through an *instrumented copy* of its route's pipeline: every
   * hook, step, validator, the handler, the serializer and the response check
   * wrapped with an observer, compiled as the interpreted twin, and served
   * from a copy of the route table that holds it. The production table is
   * never written, so the next request to the route — and every concurrent
   * one — runs the pipeline it always ran.
   */
  async explainTrace(method: string, url: string, init: InjectInit = {}): Promise<{
    readonly route: RouteRecord | null
    readonly response: InjectedResponse
    readonly events: readonly TraceEvent[]
    readonly totalMs: number
  }> {
    await this.ready()
    const compiled = this.#compiled as CompiledApp
    const trace = new Trace()
    const match = compiled.router.match(method.toUpperCase(), pathnameOf(url))
    let state: CompiledApp = { ...compiled, unmatchedOnRequest: observeUnmatched(compiled.unmatchedOnRequest, trace) }
    let route: RouteRecord | null = null
    if (match !== null && match.route !== null) {
      const original = compiled.byId.get(match.route.id)
      if (original !== undefined) {
        route = original.record
        const instrumented = instrumentRoute(original.record, original.spec, original, trace)
        const byId = new Map(compiled.byId)
        byId.set(match.route.id, { ...original, ...instrumented.outside, pipeline: simplePipeline(instrumented.spec) })
        state = { ...compiled, byId }
      }
    }
    const started = performance.now()
    const exchange = injected(method, url, init)
    await this.#serve(exchange.raw, exchange.conn, state)
    const response = exchange.response()
    return { route, response, events: trace.events, totalMs: performance.now() - started }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start serving — §4.2 stage 0, §16.3.
   *
   *     await app.listen(3000)                       // the Express spelling, §1.2
   *     await app.listen({ port: 3000, host: '0.0.0.0' })
   *     await app.listen()                           // config.server.port / .host
   *
   * `app.listen(3000)` is the five-line app of §1.2 and §21.1 — and it used to
   * be ignored: the number was spread into an options object as nothing, so a
   * JavaScript caller asking for port 8080 got the configured default and no
   * error. `signal` aborts into the same graceful shutdown as `close()`.
   */
  listen(port: number, host?: string): Promise<ServerHandle>
  listen(options?: ListenOptions): Promise<ServerHandle>
  async listen(target: number | ListenOptions = {}, host?: string): Promise<ServerHandle> {
    const opts: ListenOptions = typeof target === 'number'
      ? { port: target, ...(host === undefined ? {} : { host }) }
      : target
    // Refused before anything binds: a signal already aborted is a caller that
    // has stopped wanting the server, and opening a port it will not close is
    // how a test suite leaks one.
    if (opts.signal?.aborted === true) throw opts.signal.reason
    if (this.#opts.adapter === undefined) {
      throw new ZenError(
        Codes.CAPABILITY_UNAVAILABLE,
        'No runtime adapter configured. Import `zen` from the `zen` meta-package, ' +
          'or pass `adapter: nodeAdapter()` explicitly.',
        { status: 500, expose: false },
      )
    }
    await this.ready()

    // §16.1 layer 1, made load-bearing. An explicit argument always wins; with
    // none, the address comes from configuration, which is the whole point of
    // there being a `server` namespace — `app.listen()` should be the correct
    // call in a deployed service, not a placeholder somebody has to remember to
    // replace with `app.listen({ port: Number(process.env.PORT) })`.
    const server = (this.#resolved().config['server'] ?? {}) as { port?: unknown; host?: unknown }
    const address: ListenOptions = {
      ...opts,
      ...(opts.port === undefined && typeof server.port === 'number' ? { port: server.port } : {}),
      ...(opts.host === undefined && typeof server.host === 'string' ? { host: server.host } : {}),
    }
    // §16.1 — `policy.http`, for the adapter to apply where its own options
    // are silent. Limits passed to `listen()` itself win.
    const limits = opts.limits ?? this.#policy?.http
    this.#handle = await this.#opts.adapter.listen(this.dispatch, limits === undefined ? address : { ...address, limits })
    // §4.5, §12.8 — only once there is a server to drain; an app that is only
    // ever `inject()`ed never touches the host process.
    this.#uninstall ??= this.#opts.lifecycle?.install({ close: (reason) => this.close(reason), log: this.#log }) ?? null

    // `ListenOptions.signal` was declared and read by nothing: aborting it left
    // the server answering. It now runs §4.5's sequence, exactly as `close()`
    // does — readiness first, then the drain — rather than dropping the socket.
    const signal = opts.signal
    if (signal !== undefined) {
      const onAbort = (): void => {
        this.close('abort').catch((error: unknown) => {
          this.#log.error({ err: error }, 'shutdown after listen({ signal }) aborted failed')
        })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#unlistenSignal = () => signal.removeEventListener('abort', onAbort)
    }

    for (const hook of this.#hooks.get('onListen') ?? []) {
      await (hook.fn as (h: ServerHandle) => unknown)(this.#handle)
    }
    this.#log.info({ url: this.#handle.url, routes: this.#compiled?.graph.routes.length }, 'listening')
    return this.#handle
  }

  /**
   * §4.5's documented sequence, in §4.5's documented order.
   *
   * It used to run inverted — hooks, then disposal, then the drain delay and
   * the socket — which meant the connection pools were closed *before* the
   * window in which the load balancer is still sending traffic. Nothing failed
   * visibly because the drain delay defaults to zero, so the bug was a race
   * that only opened once somebody configured the delay the docs told them to.
   * Having a readiness endpoint is what made the order checkable: the assertion
   * "readiness reports draining before the server stops accepting" has no
   * meaning until something can be asked.
   */
  close(reason = 'shutdown'): Promise<void> {
    // A signal handler and application code can both ask; the sequence runs
    // once, and everybody waits for the same end.
    return (this.#closing ??= this.#shutdown(reason))
  }

  async #shutdown(reason: string): Promise<void> {
    // A signal handed to `listen()` has nothing left to stop once this runs,
    // and a listener on a caller's long-lived signal would outlive the app.
    this.#unlistenSignal?.()
    this.#unlistenSignal = null

    // 1. Readiness fails first, while the process is still answering, so the
    //    load balancer has a window to take this instance out of rotation. This
    //    is the step whose absence causes the 502s.
    this.#health.drain()

    // 2-3. The adapter waits out `drainDelay`, stops accepting, and gives
    //    in-flight requests until `shutdownTimeout` to finish.
    await this.#handle?.close()

    // 4. `onClose` in reverse registration order, so a plugin tears down after
    //    everything that depends on it.
    //
    //    Each hook in its own `try`, per §12.8: an error thrown inside `onClose`
    //    is logged and never stops the sequence. It used to stop it — one
    //    plugin failing to flush a buffer meant no other plugin was closed, no
    //    singleton was disposed, the connection pools stayed open and the state
    //    never reached `stopped`, so a supervisor waiting on it waited forever.
    for (const hook of [...(this.#hooks.get('onClose') ?? [])].reverse()) {
      try {
        await (hook.fn as (r: string) => unknown)(reason)
      } catch (error) {
        this.#log.error({ err: error, hook: hook.name }, 'onClose hook threw; continuing shutdown')
      }
    }

    // 5. Singletons in reverse dependency order. The container runs every
    //    disposer even when one throws, and reports them together.
    try {
      await this.#container.dispose()
    } catch (error) {
      this.#log.error({ err: error }, 'service disposal failed; continuing shutdown')
    }

    this.#health.stop()
    this.#handle = null

    // Last, so a second signal arriving mid-shutdown still reaches the host
    // integration — which is how "press Ctrl+C again to stop waiting" works.
    this.#uninstall?.()
    this.#uninstall = null
  }

  /** The service container, for `zen inspect di` and test overrides. */
  get container(): Container {
    return this.#container
  }

  /**
   * Every hook registered anywhere, by phase — for tools, not for dispatch.
   *
   * `absent` leaves out the subtrees a `when` turned off (§6.2), which is what
   * the graph is given: they do not exist. The phase diagnostics read the full
   * set, because a misspelled phase is a mistake in the source whatever the
   * environment says.
   */
  #hooksByPhase(absent: ReadonlySet<string> = NO_SCOPES): ReadonlyMap<Phase, readonly HookRecord[]> {
    const out = new Map<Phase, HookRecord[]>()
    const push = (record: HookRecord): void => {
      const list = out.get(record.phase)
      if (list === undefined) out.set(record.phase, [record])
      else list.push(record)
    }
    for (const scope of this.#scopes) {
      if (inScope(scope, absent)) continue
      for (const record of scope.hooks) push(record)
    }
    for (const list of this.#hooks.values()) for (const record of list) push(record)
    for (const pending of this.#routes) {
      if (inScope(pending.scope, absent)) continue
      for (const record of routeHookRecords(pending.schema.hooks, pending.origin)) push(record)
    }
    return out
  }

  /**
   * Put the request policy where the boot reads it (§16.1): the intake limits,
   * the app-wide deadline and the header that may shorten it, the redirect
   * allowlist, health's `details`, and the built-in logger's level and
   * redaction. Under the hardened profile, a `trustProxy` nobody set is warned
   * about here and watched for at runtime (§19.2, §19.4).
   */
  #applyPolicy(policy: Policy): void {
    this.#bodyOptions = policy.body
    this.#rootScope.timeout = policy.timeout
    this.#timeoutHeader = policy.timeoutHeader
    this.#redirect = compileRedirectPolicy(policy.redirect)
    this.#health.disclose(policy.healthDetails)
    if (this.#log instanceof ConsoleLogger) this.#log.configure({ level: policy.logging.level, redact: policy.logging.redact })

    if (this.#opts.profile === 'hardened' && !policy.trustProxyExplicit) {
      this.#log.warn(
        { code: Codes.CONFIG_INVALID },
        'The hardened profile expects policy.trustProxy to be set explicitly, and it is not, so X-Forwarded-For is ' +
          'ignored. fix: set trustProxy to the number of proxies in front of the app — 1 for one load balancer — or ' +
          'false to say there are none. also: the first X-Forwarded-For that arrives will be reported once.',
      )
      addHook(this.#rootScope, this.#hooks, 'onRequest', forwardedWatch(), 'hardened: trustProxy', this.#origin)
    }
  }

  /** Every middleware ref the application holds, wherever it was registered. */
  *#middlewareRefs(): Generator<{ readonly list: MiddlewareRef[]; readonly index: number; readonly ref: MiddlewareRef }> {
    for (const scope of this.#scopes) {
      for (let i = 0; i < scope.middleware.length; i++) yield { list: scope.middleware, index: i, ref: scope.middleware[i] as MiddlewareRef }
    }
    for (const pending of this.#routes) {
      for (let i = 0; i < pending.middleware.length; i++) yield { list: pending.middleware, index: i, ref: pending.middleware[i] as MiddlewareRef }
    }
  }

  /**
   * §8.6 — each configured middleware's options, against its definition's
   * schema, once per configured instance however many places list it. A
   * refusal is placed at the first registration that used it.
   */
  async #checkConfigured(verdicts: Map<ConfiguredMiddleware, OptionsVerdict>, diagnostics: Diagnostic[]): Promise<void> {
    for (const { ref } of this.#middlewareRefs()) {
      const target = UNCONFIGURED.get(ref.fn)
      if (target === undefined || verdicts.has(target)) continue
      const verdict = await validateMiddlewareOptions(target.definition, target.options)
      verdicts.set(target, verdict)
      if (verdict.diagnostic !== null) diagnostics.push(placed(verdict.diagnostic, ref.origin))
    }
  }

  /**
   * §8.6 — run each configured middleware's `setup` once, with its options'
   * validated output, and put what it returns where the registration was.
   * A `setup` that throws, or returns something that is not a function, is a
   * boot diagnostic naming the middleware and the line that registered it,
   * reported with everything else (§12.7).
   */
  async #setUpConfigured(
    verdicts: ReadonlyMap<ConfiguredMiddleware, OptionsVerdict>,
    config: ResolvedConfigResult,
    diagnostics: Diagnostic[],
  ): Promise<void> {
    const produced = new Map<ConfiguredMiddleware, Function>()
    const failed = new Set<ConfiguredMiddleware>()
    for (const { list, index, ref } of [...this.#middlewareRefs()]) {
      const target = UNCONFIGURED.get(ref.fn)
      if (target === undefined || failed.has(target)) continue
      let fn = produced.get(target)
      if (fn === undefined) {
        const name = target.definition.name
        const container = this.#container
        const setup: MiddlewareSetup = {
          name,
          config: config.config,
          caps: this.#caps,
          log: this.#log,
          resolve: (token) => container.resolve(token),
          resolveAsync: (token) => container.resolveAsync(token),
        }
        let result: unknown
        try {
          result = await target.definition.setup((verdicts.get(target)?.value) as never, setup)
        } catch (error) {
          failed.add(target)
          const detailed = isZenError(error) ? error : null
          const sites = ([
            [`use(${name}(…))`, ref.origin],
            [`${name} setup`, relativeOrigin(errorOrigin(error), this.#root)],
          ] as const).filter(([, origin]) => origin !== undefined)
          diagnostics.push({
            severity: 'error',
            code: detailed?.code ?? Codes.MIDDLEWARE_OPTIONS,
            message: `Middleware "${name}" threw during setup: ${error instanceof Error ? error.message : String(error)}`,
            hint: detailed?.hint ?? `Fix the error inside ${name}'s setup(); it runs once, at boot, with the validated options.`,
            consequence: detailed?.consequence,
            ...(sites.length === 0
              ? {}
              : { locations: sites.map(([where]) => where), origins: sites.map(([, origin]) => origin as SourceOrigin) }),
          })
          continue
        }
        if (typeof result !== 'function') {
          failed.add(target)
          diagnostics.push(placed({
            severity: 'error',
            code: Codes.MIDDLEWARE_OPTIONS,
            message: `Middleware "${name}"'s setup returned ${result === null ? 'null' : `a ${typeof result}`}, not a middleware function.`,
            hint: 'setup(options, app) returns the phase middleware — `(ctx) => …` — that every pipeline listing it calls.',
          }, ref.origin))
          continue
        }
        fn = result
        produced.set(target, fn)
      }
      list[index] = { ...ref, fn }
    }
  }

  /**
   * §8.7 — every middleware's `when.env`, decided once against the validated
   * environment: the refs it turned off. Not evaluated while the environment
   * is itself invalid, for the reason `#absentScopes` gives.
   */
  #omittedMiddleware(config: ResolvedConfigResult, diagnostics: Diagnostic[]): ReadonlySet<MiddlewareRef> {
    if (config.diagnostics.length > 0) return NO_REFS
    let omitted: Set<MiddlewareRef> | null = null
    for (const { ref } of this.#middlewareRefs()) {
      const decide = ref.when?.env
      if (decide === undefined) continue
      let decided: unknown
      try {
        decided = decide(config.env)
      } catch (error) {
        diagnostics.push(placed({
          severity: 'error',
          code: Codes.CONFIG_INVALID,
          message:
            `The \`when.env\` of middleware "${ref.name}" threw while deciding whether it runs: ` +
            (error instanceof Error ? error.message : String(error)),
          hint: 'A `when.env` is a pure function of the validated environment; read what it needs from the env schema.',
        }, ref.origin))
        continue
      }
      if (typeof decided !== 'boolean') {
        const promise = typeof decided === 'object' && decided !== null && typeof (decided as { then?: unknown }).then === 'function'
        diagnostics.push(placed({
          severity: 'error',
          code: Codes.CONFIG_INVALID,
          message: `The \`when.env\` of middleware "${ref.name}" answered with ${promise ? 'a promise' : `a ${typeof decided}`}, not a boolean.`,
          hint: promise
            ? 'Decide synchronously: `when.env` runs once, at boot, against the validated environment, and a promise is always truthy.'
            : "Return a boolean — `when: { env: (env) => env['FEATURE_X'] === 'on' }` — rather than a value that is merely truthy.",
          consequence: `Read as truthy, "${ref.name}" would run on a deployment that meant to turn it off.`,
        }, ref.origin))
        continue
      }
      if (!decided) (omitted ??= new Set()).add(ref)
    }
    return omitted ?? NO_REFS
  }

  /**
   * §6.2's `when`, evaluated once — the ids of the collections it turned off.
   *
   * Not evaluated while the environment itself is invalid: the boot is already
   * refused, and a predicate reading a variable that failed validation would
   * only add a second, misleading diagnostic to the first.
   */
  #absentScopes(config: ResolvedConfigResult, diagnostics: Diagnostic[]): ReadonlySet<string> {
    if (config.diagnostics.length > 0) return NO_SCOPES
    let absent: Set<string> | null = null
    for (const scope of this.#scopes) {
      if (scope.when === undefined) continue
      let decided: unknown
      try {
        decided = scope.when(config.env)
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: Codes.CONFIG_INVALID,
          message:
            `The \`when\` of collection ${scope.id} threw while deciding whether it exists: ` +
            (error instanceof Error ? error.message : String(error)),
          hint: 'A `when` is a pure function of the validated environment; read what it needs from the env schema.',
          locations: [scope.prefix],
          ...(scope.origin === undefined ? {} : { origins: [scope.origin] }),
        })
        continue
      }
      if (typeof decided !== 'boolean') {
        const promise = typeof decided === 'object' && decided !== null && typeof (decided as { then?: unknown }).then === 'function'
        diagnostics.push({
          severity: 'error',
          code: Codes.CONFIG_INVALID,
          message: `The \`when\` of collection ${scope.id} answered with ${promise ? 'a promise' : `a ${typeof decided}`}, not a boolean.`,
          hint: promise
            ? 'Decide synchronously: `when` runs once, at boot, against the validated environment, and a promise is always truthy.'
            : "Return a boolean — `when: (env) => env['FEATURE_X'] === 'on'` — rather than a value that is merely truthy.",
          consequence: `Read as truthy, ${scope.prefix} would exist on a deployment that meant to turn it off.`,
          locations: [scope.prefix],
          ...(scope.origin === undefined ? {} : { origins: [scope.origin] }),
        })
        continue
      }
      if (!decided) (absent ??= new Set()).add(scope.id)
    }
    return absent ?? NO_SCOPES
  }

  /**
   * `app.schema()` registrations, checked — §10.2. A name OpenAPI cannot use as
   * a component key, a name two schemas claim, and one schema under two names
   * are each `ZEN_SCHEMA_NAME`, with both lines when two registrations are
   * involved. The first registration of a name is the one kept.
   */
  #namedSchemas(diagnostics: Diagnostic[]): ReadonlyMap<string, SchemaRecord> {
    const byName = new Map<string, SchemaRecord>()
    const bySchema = new Map<object, SchemaRecord>()
    for (const record of this.#schemas) {
      if (!SCHEMA_NAME.test(record.name)) {
        diagnostics.push(placed({
          severity: 'error',
          code: Codes.SCHEMA_NAME,
          message: `Schema name ${JSON.stringify(record.name)} (from ${record.source}) cannot be an OpenAPI component name.`,
          hint: 'Use letters, digits, ".", "-" and "_" — e.g. "User" or "billing.Invoice".',
        }, record.origin))
        continue
      }
      const taken = byName.get(record.name)
      if (taken !== undefined) {
        if (taken.schema === record.schema) continue
        diagnostics.push({
          severity: 'error',
          code: Codes.SCHEMA_NAME,
          message: `Schema name "${record.name}" is registered by both ${taken.source} and ${record.source}, for different schemas.`,
          hint: 'A name is one component in the document and one type in every generated client. Rename one of them.',
          ...pairedSites([[`schema("${record.name}")`, taken.origin], [`schema("${record.name}")`, record.origin]]),
        })
        continue
      }
      const named = bySchema.get(record.schema as object)
      if (named !== undefined) {
        diagnostics.push({
          severity: 'error',
          code: Codes.SCHEMA_NAME,
          message: `One schema is registered under two names, "${named.name}" and "${record.name}".`,
          hint: 'A generated client would have two names for one type. Keep one registration.',
          ...pairedSites([[`schema("${named.name}")`, named.origin], [`schema("${record.name}")`, record.origin]]),
        })
        continue
      }
      byName.set(record.name, record)
      bySchema.set(record.schema as object, record)
    }
    return byName
  }

  /**
   * `AppGraph.decorations` as its type says it is — §2.4.
   *
   * The compiler's `Decoration` carries a slot *index*; the graph's record a
   * `Slot`. The two were handed over through `as unknown as`, so the first tool
   * to read `decoration.slot` would have got `undefined` (I8: an `as` in the
   * public surface is a bug). The index is resolved back to its slot here.
   */
  #decorationRecords(): readonly DecorationRecord[] {
    const slots = declaredSlots()
    return this.#decorations.map((d) => ({
      name: d.name,
      slot: d.slotIndex === null ? null : (slots.find((s) => s.index === d.slotIndex) ?? null),
      accessor: d.accessor,
      source: d.source,
      origin: d.origin,
    }))
  }

  #allHookRecords(): HookRecord[] {
    const out: HookRecord[] = []
    for (const [, list] of this.#hooksByPhase()) out.push(...list)
    return out
  }

  /**
   * Records from `hooks: { … }` objects — on collections and on routes — which
   * can only ever hold request phases. `app.hook()` and `Collection#hook()` are
   * not included: an application phase registered through either is filed
   * where it fires.
   */
  #scopedHookRecords(): HookRecord[] {
    const out: HookRecord[] = []
    for (const scope of this.#scopes) out.push(...scope.hooks.filter((h) => !isRequestPhase(h.phase)))
    for (const pending of this.#routes) out.push(...routeHookRecords(pending.schema.hooks, pending.origin))
    return out
  }

  /**
   * The application graph as a document — §2.4: plain JSON with sorted keys,
   * the same graph `graph()` returns with every function reduced to its name
   * and origin, every schema to JSON Schema, the configuration already
   * redacted, and two kinds of SHA-256 fingerprint — the application's, and
   * each route's contract. Computed once and kept: the graph is frozen.
   *
   * What reads it: a tool that diffs two builds, a client that pins a
   * contract, a cache that keys on the application. None of them has to boot
   * this application to do it.
   */
  graphDocument(): Promise<GraphDocument> {
    if (this.#compiled === null) {
      throw new ZenError(Codes.APP_NOT_READY, 'graphDocument() requires ready()', { status: 500, expose: false })
    }
    return (this.#document ??= serializeGraph(this.#compiled.graph))
  }

  /**
   * §12.6 — what the application knows about an error that the error engine
   * does not: the failing route's registration line and resolved chain, and
   * where in the application's own code the error was raised, with the lines
   * around it when the host can read the file. Development only.
   */
  #devFacts(error: ZenError, info: ErrorContextInfo): DevFacts {
    const facts: { origin?: string; thrown?: string; frame?: DevFacts['frame']; chain?: readonly string[] } = {}
    const route = info.routeId === null || info.routeId === undefined
      ? undefined
      : this.#compiled?.byId.get(info.routeId as RouteId)?.record
    if (route?.origin !== undefined) facts.origin = formatOrigin(route.origin)
    if (route !== undefined) {
      facts.chain = explainedSteps(route).map((step) => [step.kind, step.scope, step.name].filter((part) => part !== '').join(' '))
    }
    // The original throw: a wrapped error's cause, when there is one.
    const raised = applicationFrame(error.cause instanceof Error ? error.cause : error)
    if (raised !== undefined) {
      const shown = relativeOrigin(raised, this.#root) ?? raised
      facts.thrown = formatOrigin(shown)
      const source = this.#opts.devErrors?.readSource?.(raised.file)
      if (source !== undefined) facts.frame = codeFrame(shown.file, source, raised.line)
    }
    return facts
  }

  /** The `onSend` hook `fingerprintHeaders` registers — §2.4. */
  #fingerprintStamp(): (ctx: PlainContext, reply: Reply) => undefined {
    return (ctx, reply) => {
      const known = this.#fingerprints
      if (known === null) return undefined
      reply.headers.set('zen-graph', known.app)
      const contract = ctx.route === null ? undefined : known.contracts.get(ctx.route.id)
      if (contract !== undefined) reply.headers.set('zen-contract', contract)
      return undefined
    }
  }

  /** The frozen AppGraph — the input to every tool (§2.4). */
  graph(): AppGraph {
    if (this.#compiled === null) {
      throw new ZenError(Codes.APP_NOT_READY, 'graph() requires ready()', { status: 500 })
    }
    return this.#compiled.graph
  }

  /**
   * The path of a named route, its parameters filled in — rfcs/0001 §5.7.
   *
   *     app.get('/notes/:id<int>', { name: 'notes.show' }, show)
   *
   *     app.url('notes.show', { id: 7 })                    // '/notes/7'
   *     app.url('notes.show', { id: 7 }, { from: 'feed' })  // '/notes/7?from=feed'
   *     ctx.redirect(app.url('notes.show', { id: note.id }), 303)
   *
   * A URL this returns is one the named route answers, with these parameters,
   * or it throws — `ZEN_PARAM_MISMATCH` for a value the route would not match
   * or another route would, `ZEN_ROUTE_UNKNOWN` for a name nothing registered.
   * Each value is encoded as exactly one segment, so `../admin` or `a/b?c`
   * cannot become a different path; its parameter's type has to accept it; and
   * the compiled router is asked whether the path reaches this route, because
   * `/users/:id` given `'me'` is answered by `GET /users/me` when that exists
   * (§5.6). The query string is written the way the route parses it (§11.4).
   *
   * Always a path on this origin, so it is what `isLocalUrl` accepts and what
   * `ctx.redirect()` sends unasked (§19.5.2). Available from `ready()` on —
   * names and segments are compiled at boot — and from a `Collection` or a
   * plugin's registrar, which is how a feature module reaches it.
   *
   * **Checked when it is called, not by `tsc`.** RFC 0001 designed this typed
   * by route name; that needs every name accumulated into the app's type, which
   * a collection's callback cannot pass back out and which is the mapped-type
   * growth §10.4 warns about. So a wrong name or a missing parameter is a
   * refusal on the first call — in the first test that renders the link.
   */
  url(name: string, params?: UrlParams, query?: UrlQuery): string {
    if (this.#compiled === null) {
      throw new ZenError(
        Codes.APP_NOT_READY,
        `url("${name}") requires ready(): route names and segments are compiled at boot.`,
        { status: 500, expose: false },
      )
    }
    return this.#compiled.urls.build(name, params, query)
  }

  /**
   * Generated source for `zen inspect` / `zen build` — kept only by an app
   * built with `inspect: true` or `dev: true`.
   *
   * An app that kept none is refused rather than answered with an empty list,
   * because an empty list is also what "nothing was compiled for this" looks
   * like, and the checks that read this one — a stage that must emit no code,
   * a route that must compile byte-identically — would pass by reading nothing.
   */
  generatedSource(): readonly { name: string; source: string }[] {
    if (!this.#codegen.retains) {
      throw new ZenError(
        Codes.INSPECT_DISABLED,
        'generatedSource() was called on an app that keeps no generated source.',
        {
          status: 500,
          expose: false,
          hint: 'Build the app with zen({ inspect: true }) — or dev: true — where the source is wanted.',
          consequence: 'Production apps keep none since 0.1.0-alpha.5: holding every unit for the life of the process was megabytes of strings at 10,000 routes.',
        },
      )
    }
    return this.#codegen.units.map((u) => ({ name: u.name, source: u.source }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** The builder handed to a `collection()` callback. */
export class Collection<X = {}> {
  #app: ZenApp<X>
  #scope: Scope

  constructor(app: ZenApp<X>, scope: Scope) {
    this.#app = app
    this.#scope = scope
  }

  get<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  get<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  get<P extends string>(path: P, handler: BareHandler<X, P>): this
  get(path: string, a: unknown, b?: unknown): this {
    this.#app.registerScoped(this.#scope, 'GET', path, a, b)
    return this
  }

  post<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  post<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  post<P extends string>(path: P, handler: BareHandler<X, P>): this
  post(path: string, a: unknown, b?: unknown): this {
    this.#app.registerScoped(this.#scope, 'POST', path, a, b)
    return this
  }

  put<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  put<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  put<P extends string>(path: P, handler: BareHandler<X, P>): this
  put(path: string, a: unknown, b?: unknown): this { this.#app.registerScoped(this.#scope, 'PUT', path, a, b); return this }

  patch<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  patch<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  patch<P extends string>(path: P, handler: BareHandler<X, P>): this
  patch(path: string, a: unknown, b?: unknown): this { this.#app.registerScoped(this.#scope, 'PATCH', path, a, b); return this }

  delete<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  delete<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  delete<P extends string>(path: P, handler: BareHandler<X, P>): this
  delete(path: string, a: unknown, b?: unknown): this { this.#app.registerScoped(this.#scope, 'DELETE', path, a, b); return this }

  // `head`, `options`, `all`, `around` and `after` exist on the app, and a
  // collection is the same registration surface one scope down (§6.1). Their
  // absence here meant a `HEAD`-only or `OPTIONS` route, or wrapping middleware,
  // could not be written inside a collection at all.
  head<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  head<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  head<P extends string>(path: P, handler: BareHandler<X, P>): this
  head(path: string, a: unknown, b?: unknown): this { this.#app.registerScoped(this.#scope, 'HEAD', path, a, b); return this }

  options<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  options<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  options<P extends string>(path: P, handler: BareHandler<X, P>): this
  options(path: string, a: unknown, b?: unknown): this { this.#app.registerScoped(this.#scope, 'OPTIONS', path, a, b); return this }

  /** One handler for every method — see {@link ZenApp.all}. */
  all<P extends string, S extends RouteSpec>(path: P, spec: S & SpecWithoutCheck, handler: RouteHandler<S, X, P>): this
  all<P extends string, S extends RouteSpec>(path: P, spec: RouteSpecOf<S, X, P>, handler: RouteHandler<S, X, P>): this
  all<P extends string>(path: P, handler: BareHandler<X, P>): this
  all(path: string, a: unknown, b?: unknown): this {
    registerAll((method, spec, handler) => this.#app.registerScoped(this.#scope, method, path, spec, handler), a, b)
    return this
  }

  use(middleware: PhaseMiddleware<never, X> | ConfiguredMiddleware, opts?: MiddlewareOptions<X>): this {
    return this.#push('phase', middleware, opts)
  }

  /** Around middleware for every route in this subtree — one closure per request (§8.2). */
  around(middleware: AroundMiddleware<never, X>, opts?: MiddlewareOptions<X>): this {
    return this.#push('around', middleware, opts)
  }

  /** After middleware for every route in this subtree (§8.2). */
  after(middleware: AfterMiddleware<never, X>, opts?: MiddlewareOptions<X>): this {
    return this.#push('after', middleware, opts)
  }

  #push(kind: MiddlewareRef['kind'], fn: unknown, opts: MiddlewareOptions<X> | undefined): this {
    this.#app.assertOpen()
    this.#scope.middleware.push(middlewareRef(
      kind, fn, opts as MiddlewareOptions<never> | undefined, this.#scope.id, this.#app.originHere(), 'anonymous',
    ))
    return this
  }

  /**
   * A hook for every route in this collection and its children — the middle
   * scope of §9.3.
   *
   * This is the scope Express cannot express: its error and response middleware
   * is global-by-position, so "log every request under /api, and only those" is
   * a path check inside a global handler rather than a registration.
   */
  hook<P extends Phase>(phase: P, fn: HookFn<P, X>, name?: string): this {
    this.#app.hookScoped(this.#scope, phase, fn as Function, name)
    return this
  }

  /**
   * Nest another collection inside this one — §6.3.
   *
   * Still zero runtime cost: this is a registration-time scope, so twenty
   * levels of nesting produce exactly the same compiled pipeline as none.
   * Express `Router` instances are real middleware layers that every request
   * traverses; these are not.
   */
  collection(prefix: string, build: (c: Collection<X>) => void): this
  collection(prefix: string, opts: CollectionOptions, build: (c: Collection<X>) => void): this
  collection(prefix: string, a: unknown, b?: unknown): this {
    this.#app.nestCollection(this.#scope, prefix, a, b)
    return this
  }

  /**
   * {@link ZenApp.url}, reachable from a feature module — §5.7.
   *
   * A feature registers its routes on the collection it is handed and never
   * sees the app, so a handler inside it links through this. Route names are
   * the application's, not the collection's: `notes.url('pages.note', …)`
   * reaches a route registered anywhere.
   */
  url(name: string, params?: UrlParams, query?: UrlQuery): string {
    return this.#app.url(name, params, query)
  }
}

export class InjectedResponse {
  readonly reply: Reply
  constructor(reply: Reply) { this.reply = reply }

  get status(): number { return this.reply.status }

  /**
   * The header as a client would read it — repeated values comma-joined.
   *
   * `HeaderBag.get` returns the *first* value of a multi-value header and
   * `Object.fromEntries(entries())` kept the *last*, so both disagreed with
   * every HTTP client in existence: WHATWG `Headers.get` joins with `", "`, and
   * so does anything reading a socket. §20.2 says in-process testing exists to
   * observe what the wire would observe, and a test asserting on `Vary` was
   * getting one third of it and passing.
   *
   * Found the same way as the sibling defect in `@erenthedeveloper0/zen-adapter-node`: nothing
   * produced a repeated header other than `Set-Cookie` until CORS varied on
   * three of them (§32.2).
   *
   * `Set-Cookie` is excluded, as it is in the WHATWG spec — two cookies joined
   * by a comma are one malformed cookie. Use {@link headerValues} for it.
   */
  header(name: string): string | undefined {
    const values = this.reply.headers.getAll(name)
    if (values.length === 0) return undefined
    if (values.length === 1) return values[0]
    return name.toLowerCase() === 'set-cookie' ? values[0] : values.join(', ')
  }

  /** Every value of a repeated header, unjoined. The honest accessor for `Set-Cookie`. */
  headerValues(name: string): readonly string[] {
    return this.reply.headers.getAll(name)
  }

  get headers(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name] of this.reply.headers.entries()) {
      if (out[name] === undefined) out[name] = this.header(name) as string
    }
    return out
  }

  text(): string {
    const body = this.reply.body
    if (body.kind === 'bytes') return new TextDecoder().decode(body.value)
    if (body.kind === 'text') return body.value
    if (body.kind === 'json') {
      // Never `JSON.stringify(body.value)`. A reply that has not been through
      // egress still carries its compiled serializer, and the whole value of
      // in-process testing is that it observes what the wire would observe — an
      // `inject()` that showed fields the socket would have filtered would make
      // tests actively misleading about §13.3.
      const { bytes } = encodeBody(this.reply)
      return bytes === null ? '' : new TextDecoder().decode(bytes)
    }
    return ''
  }

  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const EMPTY: Record<string, unknown> = Object.freeze({})

const NO_SCOPES: ReadonlySet<string> = Object.freeze(new Set<string>())

const NO_REFS: ReadonlySet<MiddlewareRef> = Object.freeze(new Set<MiddlewareRef>())

const NO_NAMES: readonly string[] = Object.freeze([])

/**
 * §19.2's hardened profile, for an application that never said whether a proxy
 * is in front of it: the first request that carries `X-Forwarded-For` proves
 * one is — and that every client looks like that proxy to anything keyed on
 * `ctx.ip` — so it is reported, once, at the moment it is provably real. After
 * that the hook is one boolean test. Promoted from `rateLimit()`'s own check.
 */
function forwardedWatch(): (ctx: PlainContext) => undefined {
  let reported = false
  return function trustProxyWatch(ctx: PlainContext): undefined {
    if (reported) return undefined
    const forwarded = ctx.raw.header('x-forwarded-for')
    if (forwarded === undefined) return undefined
    reported = true
    ctx.log.warn(
      { code: Codes.CONFIG_INVALID },
      `A request arrived through a proxy (X-Forwarded-For) and trustProxy is not set, so ctx.ip is the proxy's ` +
        `address (${ctx.ip}) for every client. fix: set trustProxy to the number of proxies in front of the app.`,
    )
    return undefined
  }
}

/**
 * §12.6 — whether a request's `Accept` prefers HTML to JSON: a browser
 * navigating, not an API client. Read only on a development build's error path.
 */
function prefersHtml(accept: string | undefined): boolean {
  const ranges = parseAccept(accept)
  if (ranges === null) return false
  const page = qualityFor(ranges, 'text', 'html')
  return page > 0 && page > qualityFor(ranges, 'application', 'json')
}

/** The lines around `line` — two before, two after — for the development error page and terminal. */
function codeFrame(file: string, source: string, line: number): NonNullable<DevFacts['frame']> {
  const all = source.split('\n')
  const first = Math.max(1, line - 2)
  const last = Math.min(all.length, line + 2)
  const lines: Array<{ line: number; text: string }> = []
  for (let n = first; n <= last; n++) lines.push({ line: n, text: (all[n - 1] ?? '').replace(/\r$/, '') })
  return { file, line, lines }
}

/** What `inject()` takes. */
interface InjectInit {
  readonly headers?: Record<string, string> | undefined
  readonly body?: unknown
  readonly signal?: AbortSignal | undefined
  readonly remote?: RemoteInfo | undefined
}

/**
 * The request and the connection `inject()` serves — no socket, the body in
 * memory, the reply captured instead of written — and the response read off
 * it once served. Synchronous, so the caller awaits the dispatch itself.
 */
function injected(method: string, url: string, init: InjectInit): {
  readonly raw: RawRequest
  readonly conn: Connection
  response(): InjectedResponse
} {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v

  let bodyBytes: Uint8Array
  if (init.body === undefined) {
    bodyBytes = new Uint8Array(0)
  } else if (typeof init.body === 'string') {
    bodyBytes = new TextEncoder().encode(init.body)
  } else if (init.body instanceof Uint8Array) {
    bodyBytes = init.body
  } else {
    bodyBytes = new TextEncoder().encode(JSON.stringify(init.body))
    headers['content-type'] ??= 'application/json'
  }
  if (bodyBytes.length > 0) headers['content-length'] ??= String(bodyBytes.length)

  const raw: RawRequest = {
    method: method.toUpperCase(),
    url,
    header: (name) => headers[name as string],
    headerNames: () => Object.keys(headers),
    body: {
      kind: bodyBytes.length === 0 ? 'none' : 'buffer',
      length: bodyBytes.length,
      read: async () => bodyBytes,
      stream: async function* () { yield bodyBytes },
    },
    remote: init.remote ?? LOOPBACK,
    native: null,
  }

  let captured: Reply | null = null
  const conn: Connection = {
    signal: init.signal ?? new AbortController().signal,
    send: (reply) => { captured = reply },
    native: null,
    // No socket holds the process open for this request, so its deadline
    // has to (§4.4) — the reason a health probe's arm does too.
    inProcess: true,
  }

  return {
    raw,
    conn,
    response() {
      const reply = captured as Reply | null
      if (reply === null) throw new Error('inject: no reply was produced')
      return new InjectedResponse(reply)
    },
  }
}

/** The global `onRequest` hooks a request that matched no route runs, observed for `explainTrace`. */
function observeUnmatched(hooks: readonly Function[], trace: Trace): readonly Function[] {
  return hooks.map((hook) => function observedUnmatched(ctx: unknown): unknown {
    const event = trace.begin('onRequest', '[global]', hook.name === '' ? 'anonymous' : hook.name)
    const started = performance.now()
    const settle = (value: unknown): unknown => {
      event.ms = performance.now() - started
      event.outcome = value === undefined ? 'continue' : 'short-circuit'
      return value
    }
    const result = (hook as (c: unknown) => unknown)(ctx)
    return isThenable(result) ? result.then(settle) : settle(result)
  })
}

/** What a route's `inject` compiled to — see `#resolveInjections`. */
type Injection =
  | { readonly kind: 'static'; readonly deps: Readonly<Record<string, unknown>> }
  | { readonly kind: 'request'; readonly wrap: (handler: Function) => Function }

function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null &&
    typeof (value as Token<unknown>).name === 'string' && typeof (value as Token<unknown>).index === 'number'
}

/**
 * The handler of a route that injects a per-request service: resolve what the
 * request's scope holds, then call the handler with every service. A service
 * whose build is synchronous costs no promise; one that is not is awaited
 * before the handler runs, so the handler never sees a pending value.
 */
function injectedHandler(
  handler: Function,
  container: ZenContainer,
  fixed: Readonly<Record<string, unknown>>,
  perRequest: ReadonlyArray<readonly [string, Token<unknown>]>,
): Function {
  const call = handler as (ctx: unknown, deps: object) => unknown
  return function injected(ctx: unknown): unknown {
    const deps: Record<string, unknown> = { ...fixed }
    let pending: Promise<unknown>[] | null = null
    for (const [as, token] of perRequest) {
      const value = container.resolveEither(token, ctx as PlainContext)
      if (isThenable(value)) (pending ??= []).push(value.then((settled) => { deps[as] = settled }))
      else deps[as] = value
    }
    if (pending === null) return call(ctx, Object.freeze(deps))
    return Promise.all(pending).then(() => call(ctx, Object.freeze(deps)))
  }
}

/** The fields of an `intake` that were written — so an absent one inherits the app's. */
function definedOf(policy: NonNullable<RouteSpec['intake']>): Partial<BodyOptions> {
  const out: { maxSize?: number; maxDepth?: number; maxFields?: number } = {}
  if (policy.maxSize !== undefined) out.maxSize = policy.maxSize
  if (policy.maxDepth !== undefined) out.maxDepth = policy.maxDepth
  if (policy.maxFields !== undefined) out.maxFields = policy.maxFields
  return out
}

/**
 * §4.2 stage 6 — a route's `intake`, checked at boot: limits are positive
 * whole numbers, the mode is one there is an intake for, and a stream is not
 * also handed to a `body` schema it could never be validated by.
 */
function intakeProblems(key: string, schema: RouteSpec): Diagnostic[] {
  const policy = schema.intake
  if (policy === undefined) return []
  if (typeof policy !== 'object' || policy === null) {
    return [{
      severity: 'error',
      code: Codes.CONFIG_INVALID,
      message: `${key} declares \`intake\` as ${policy === null ? 'null' : `a ${typeof policy}`}.`,
      hint: "Write `intake: { maxSize: 10_000, mode: 'raw' }` — every field optional.",
    }]
  }
  const out: Diagnostic[] = []
  for (const field of ['maxSize', 'maxDepth', 'maxFields'] as const) {
    const value = policy[field]
    if (value === undefined) continue
    const floor = field === 'maxDepth' ? 0 : 1
    if (typeof value !== 'number' || !Number.isInteger(value) || value < floor) {
      out.push({
        severity: 'error',
        code: Codes.CONFIG_INVALID,
        message: `${key} sets intake.${field} to ${JSON.stringify(value)}; it is a whole number of ${field === 'maxSize' ? 'bytes' : field === 'maxDepth' ? 'levels' : 'fields'}, at least ${floor}.`,
        hint: field === 'maxSize' ? 'Write the limit in bytes — `5 * 1024 * 1024` for 5 MB.' : `Give ${field} a whole number.`,
      })
    }
  }
  const mode = policy.mode
  if (mode !== undefined && mode !== 'parse' && mode !== 'raw' && mode !== 'stream') {
    out.push({
      severity: 'error',
      code: Codes.CONFIG_INVALID,
      message: `${key} sets intake.mode to ${JSON.stringify(mode)}.`,
      hint: "The modes are 'parse' (the default), 'raw' and 'stream'.",
    })
  }
  if (mode === 'stream' && schema.body !== undefined) {
    out.push({
      severity: 'error',
      code: Codes.CONFIG_INVALID,
      message: `${key} streams its body and also declares a \`body\` schema, which a stream cannot be validated against.`,
      hint: "Drop the `body` schema and validate what the stream carries in the handler — or read the whole body with mode 'raw' and validate that.",
    })
  }
  return out
}

/** Where an `inject()`ed request comes from unless it says otherwise. */
const LOOPBACK: RemoteInfo = Object.freeze({ address: '127.0.0.1', port: 0, family: 'IPv4' })

/** Whether `scope`, or a collection it sits inside, is in `absent` (§6.2). */
function inScope(scope: Scope, absent: ReadonlySet<string>): boolean {
  if (absent.size === 0) return false
  for (let s: Scope | null = scope; s !== null; s = s.parent) {
    if (absent.has(s.id)) return true
  }
  return false
}

/**
 * A configured middleware waiting for boot (§8.6): the function a ref holds
 * until `ready()` has validated its options and run its `setup`, mapped to the
 * configuration it stands for. If one is ever called, a ref escaped boot —
 * which is a framework bug, and it says so rather than doing nothing.
 */
const UNCONFIGURED = new WeakMap<Function, ConfiguredMiddleware>()

/**
 * One middleware registration, as a record — every surface builds its refs
 * here, so a configured middleware (§8.6) and a condition (§8.7) mean the same
 * thing wherever they are written: `app.use`, a collection, a route's `use`, a
 * plugin's registrar.
 */
function middlewareRef(
  kind: MiddlewareRef['kind'],
  target: unknown,
  opts: MiddlewareOptions<never> | undefined,
  scope: string,
  origin: SourceOrigin | undefined,
  fallback: string,
): MiddlewareRef {
  const configured = isConfiguredMiddleware(target)
  if (configured && kind !== 'phase') {
    throw new ZenError(
      Codes.MIDDLEWARE_OPTIONS,
      `Middleware "${target.definition.name}" is phase middleware; register it with use(), not ${kind}().`,
      { status: 500, expose: false },
    )
  }
  if (!configured && typeof target !== 'function') {
    throw new ZenError(
      Codes.MIDDLEWARE_OPTIONS,
      `${kind === 'phase' ? 'use' : kind}() was given ${target === null ? 'null' : `a ${typeof target}`}; ` +
        'it takes a middleware function, a configured middleware, or (use only) a plugin.',
      { status: 500, expose: false },
    )
  }
  const name = opts?.name ?? (configured ? target.definition.name : ((target as Function).name || fallback))
  const when = conditionOf(opts?.when, `middleware "${name}"`)
  let fn = target as Function
  if (configured) {
    fn = function unconfigured(): never {
      throw new ZenError(Codes.INTERNAL, `Middleware "${name}" was called before ready() set it up.`, { status: 500, expose: false })
    }
    UNCONFIGURED.set(fn, target)
  }
  return { kind, name, fn, scope, origin, ...(when === undefined ? {} : { when }) }
}

/**
 * A diagnostic with `origin` as its origin, unless it already names its own —
 * §5.1's rule for every boot diagnostic: the line that registered the thing it
 * is about.
 */
function placed(diagnostic: Diagnostic, origin: SourceOrigin | undefined): Diagnostic {
  if (origin === undefined || diagnostic.origins !== undefined) return diagnostic
  return { ...diagnostic, origins: [origin] }
}

/**
 * `locations` and `origins` for a diagnostic about several registrations, when
 * every one of them has an origin — rendered pairwise, `GET /a  src/a.ts:3:1`.
 * When one does not, the known ones are given without locations rather than
 * paired with the wrong line.
 */
function pairedSites(
  sites: ReadonlyArray<readonly [string, SourceOrigin | undefined]>,
): { locations?: string[]; origins?: SourceOrigin[] } {
  const known = sites.filter(([, origin]) => origin !== undefined)
  if (known.length === 0) return {}
  if (known.length === sites.length) {
    return { locations: sites.map(([where]) => where), origins: sites.map(([, origin]) => origin as SourceOrigin) }
  }
  return { origins: known.map(([, origin]) => origin as SourceOrigin) }
}

/** The payload of a boot warning: its code, and the line it is about when known. */
function logged(code: string, origin: SourceOrigin | undefined): Record<string, unknown> {
  return origin === undefined ? { code } : { code, origin: formatOrigin(origin) }
}

/** The scope in `scope`'s chain whose id is `id` — where an inherited value was declared. */
function declaringScope(scope: Scope, id: string): Scope | undefined {
  for (let s: Scope | null = scope; s !== null; s = s.parent) {
    if (s.id === id || (id === 'app' && s.parent === null)) return s
  }
  return undefined
}

/** What OpenAPI 3.1 accepts as a `components.schemas` key (§4.8.7.1). */
const SCHEMA_NAME = /^[A-Za-z0-9._-]+$/

/** An identifier the generated class can use as a getter name; `$` is reserved for internals. */
const DECORATION_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/

/**
 * What `all()` registers. `HEAD` is absent because the `GET` route serves it
 * (§4.2) and `TRACE` because a handler written for "any method" was not written
 * to echo a request back.
 */
export const ALL_METHODS: readonly HttpMethod[] = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/**
 * `all(path, [spec,] handler)` as one ordinary registration per method.
 *
 * A declared `name` gets the method appended, because route names are unique
 * (§5.5) and six routes cannot share one.
 */
function registerAll(
  register: (method: HttpMethod, spec: unknown, handler: unknown) => unknown,
  a: unknown,
  b: unknown,
): void {
  const hasSpec = typeof a === 'object' && a !== null
  for (const method of ALL_METHODS) {
    if (!hasSpec) {
      register(method, a, undefined)
      continue
    }
    const spec = a as RouteSpec
    register(method, spec.name === undefined ? spec : { ...spec, name: `${spec.name}.${method.toLowerCase()}` }, b)
  }
}

/**
 * A plugin is data before it is behaviour, so it is distinguishable from a
 * middleware function structurally — no marker symbol needed.
 */
function isPlugin(value: unknown): value is Plugin<never, object> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Plugin).name === 'string' &&
    typeof (value as Plugin).version === 'string' &&
    typeof (value as Plugin).setup === 'function'
  )
}

/** Identity helper that pins the plugin's option and provides types. */
export function definePlugin<O = void, P extends object = {}>(plugin: Plugin<O, P>): Plugin<O, P> {
  return plugin
}

/**
 * The `onRequest` chain for a request that matched no route.
 *
 * A loop rather than generated code, because there is no route to generate for:
 * this is the one place in the request path where the work is not a function of
 * a RouteRecord. It runs on 404s and 405s — which is *not* "off the hot path"
 * for a browser-facing service: every CORS preflight lands here until the
 * `cors` hook answers it, and a 404 flood is the cheapest hostile traffic
 * there is (§28.8, §32.5). Its cost is measured in `benchmarks/refusals`.
 */
async function runUnmatched(hooks: readonly Function[], ctx: PlainContext): Promise<Reply | null> {
  for (const hook of hooks) {
    const result = await (hook as (c: unknown) => unknown)(ctx)
    if (result !== undefined) return finalize(result, true)
  }
  return null
}

/**
 * Route a hook registration to the right table — §9.3.
 *
 * Request phases attach to a *scope*, because which routes they run on is a
 * function of where they were registered. Application phases have no scope to
 * belong to: `onReady` fires once for the app, not once per route.
 */
function addHook(
  scope: Scope,
  appHooks: Map<Phase, HookRecord[]>,
  phase: Phase,
  fn: Function,
  name: string | undefined,
  origin: SourceOrigin | undefined,
): void {
  const record: HookRecord = {
    phase,
    fn,
    scope: scope.id,
    name: name ?? (fn.name === '' ? undefined : fn.name),
    origin,
  }
  if (isRequestPhase(phase)) {
    scope.hooks.push(record)
    return
  }
  const list = appHooks.get(phase)
  if (list === undefined) appHooks.set(phase, [record])
  else list.push(record)
}

/**
 * The scope chain a route's deadline is resolved from — §4.4.
 *
 * Outermost first, route last, so `resolveTimeout` can fold it in one pass and
 * `false` at any level can win over an inherited duration. The root scope is
 * labelled `'app'` rather than `'root'` because that is what `explainRoute` and
 * the boot diagnostic should say: nobody thinks of `createApp({ timeout })` as
 * a collection.
 */
function timeoutSources(pending: PendingRoute): TimeoutSource[] {
  const scopes: Scope[] = []
  for (let s: Scope | null = pending.scope; s !== null; s = s.parent) scopes.unshift(s)

  const sources: TimeoutSource[] = scopes.map((s) => ({
    where: s.id === 'root' ? 'app' : s.id,
    spec: s.timeout,
  }))
  sources.push({ where: 'route', spec: pending.schema.timeout })
  return sources
}

/**
 * The same walk as `timeoutSources`, for §11.4's profiles.
 *
 * Sharing the shape rather than the function is deliberate: the two fold
 * differently — a deadline is one value so the innermost wins outright, a
 * profile is six switches so they merge — and a single "resolve the chain"
 * helper parameterised by a fold would hide exactly the difference a reader
 * needs to see.
 */
function coercionChain(pending: PendingRoute): Array<CoercionSpec | undefined> {
  const specs: Array<CoercionSpec | undefined> = []
  for (let s: Scope | null = pending.scope; s !== null; s = s.parent) specs.unshift(s.coercion)
  specs.push(pending.schema.coercion)
  return specs
}

/** `timeout: '30s'` and `timeout: { default: '30s' }` mean the same thing. */
function timeoutOptions(
  value: TimeoutSpec | TimeoutOptions | undefined,
): { default: TimeoutSpec | undefined; header: string | undefined } {
  if (value === undefined) return { default: undefined, header: undefined }
  if (typeof value === 'object' && value !== null) {
    return { default: value.default, header: value.header?.toLowerCase() }
  }
  return { default: value, header: undefined }
}

/** The composed signal when there is a deadline; the connection's when not. */
function signalOf(deadline: Deadline | null, conn: Connection): AbortSignal {
  return deadline === null ? conn.signal : deadline.signal
}

function isThenable(value: unknown): value is Promise<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * §6.3 — outer-first append. Auth before authorization before handler is the
 * near-universal intent, and flattening at boot (rather than at registration)
 * means global middleware added *after* a route still applies to it. Express's
 * position-dependent behaviour is why large apps there fear reordering imports.
 */
function flattenMiddleware(pending: PendingRoute, omitted: ReadonlySet<MiddlewareRef>): MiddlewareRef[] {
  const chain: MiddlewareRef[][] = []
  let scope: Scope | null = pending.scope
  while (scope !== null) {
    chain.unshift(scope.middleware)
    scope = scope.parent
  }
  chain.push(pending.middleware)
  const flat = chain.flat()
  // §8.7 — a step `when.env` turned off stays on the record, marked, so the
  // tools can say so; the compiler reads the mark and emits nothing for it.
  return omitted.size === 0 ? flat : flat.map((ref) => (omitted.has(ref) ? { ...ref, omitted: true } : ref))
}

/**
 * `env: process.env` and `env: [source, …]` are the same thing — §16.1.
 *
 * The record form is sugar for a single `env`-layer source named
 * `process.env`, so there is one code path through the fold and the common case
 * does not have to know the vocabulary. Keys whose value is `undefined` are
 * dropped rather than carried as empty strings: "not set" and "set to nothing"
 * are different states and `.default()` in a schema only fires for the first.
 */
function envSourcesOf(
  env: Readonly<Record<string, string | undefined>> | readonly EnvSource[] | undefined,
): readonly EnvSource[] {
  if (env === undefined) return []
  if (Array.isArray(env)) return env as readonly EnvSource[]

  const record = env as Readonly<Record<string, string | undefined>>
  const entries: Array<{ key: string; value: string }> = []
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (value !== undefined) entries.push({ key, value })
  }
  return [{ layer: 'env', name: 'process.env', entries }]
}

export function createApp<X = {}, C = Record<string, never>>(
  opts: ZenOptions<C>,
): ZenApp<X & { readonly config: C }> {
  return new ZenApp<X & { readonly config: C }>(opts as ZenOptions<unknown>)
}
