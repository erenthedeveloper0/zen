import type { HttpMethod } from './http.ts'
import type { AnySchema, InferOutput } from './standard-schema.ts'
import type { Reply } from './reply.ts'
import type { CoercionRecord, CoercionSpec } from './coercion.ts'
import type { HookRecord, RequestPhase, RouteHooks } from './hook.ts'
import type { TimeoutRecord, TimeoutSpec } from './deadline.ts'
import type { NegotiationRecord, ResponseSpec } from './negotiation.ts'
import type { ConfiguredMiddleware, MiddlewareCondition, PhaseMiddleware } from './middleware.ts'
import type { Token } from './container.ts'
import type { Context } from './context.ts'
import type { Issue } from '../errors/http-errors.ts'
import type { SourceOrigin } from '../primitives/origin.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Path syntax — rfcs/0001 §5.2. No regex, ever: regex paths defeat trie
// compilation, cannot be reflected into OpenAPI, and have a ReDoS CVE history.
// ─────────────────────────────────────────────────────────────────────────────

export type SegmentKind = 'static' | 'param' | 'wildcard'

export interface PathSegment {
  readonly kind: SegmentKind
  /** Literal text for `static`; param name for `param`/`wildcard`. */
  readonly value: string
  /** Registered param type name, e.g. `int` in `:id<int>`. */
  readonly type?: string | undefined
  readonly optional?: boolean | undefined
}

/** Built-in param types. Users register more via `app.paramType()`. */
export type BuiltinParamType = 'int' | 'float' | 'uuid' | 'ulid' | 'date' | 'slug' | 'hex'

export interface ParamType<T = unknown> {
  readonly name: string
  test(raw: string): boolean
  parse(raw: string): T
  readonly jsonSchema?: Record<string, unknown> | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Type-level param extraction. `ctx.params` is typed from the path template
// even when the route declares no `params` schema at all (§5.2).
// ─────────────────────────────────────────────────────────────────────────────

export type Prettify<T> = { [K in keyof T]: T[K] } & {}

/**
 * The static type of a typed path param. The builtins are known; a type the
 * application registered with `app.paramType()` is `unknown`, because its
 * `parse` can return anything — an `ObjectId`, a `bigint` — and typing it as
 * `string` would be the framework widening what it did not narrow (I8).
 * Declare a `params` schema to type it precisely.
 */
type ParamTypeOf<T extends string> =
  T extends 'int' | 'float' ? number :
  T extends 'date' ? Date :
  T extends 'uuid' | 'ulid' | 'slug' | 'hex' ? string :
  unknown

type SegmentParams<S extends string> =
  S extends `:${infer Name}<${infer Ty}>?` ? { [K in Name]?: ParamTypeOf<Ty> } :
  S extends `:${infer Name}<${infer Ty}>` ? { [K in Name]: ParamTypeOf<Ty> } :
  S extends `:${infer Name}?` ? { [K in Name]?: string } :
  S extends `:${infer Name}` ? { [K in Name]: string } :
  S extends `*${infer Name}` ? { [K in Name]: string } :
  // eslint-disable-next-line @typescript-eslint/ban-types
  {}

type PathParams<P extends string> =
  P extends `${infer Head}/${infer Rest}`
    ? SegmentParams<Head> & PathParams<Rest>
    : SegmentParams<P>

export type ExtractParams<P extends string> = Prettify<PathParams<P>>

// ─────────────────────────────────────────────────────────────────────────────
// Route schema & handler typing
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteSchema {
  readonly params?: AnySchema | undefined
  readonly query?: AnySchema | undefined
  readonly headers?: AnySchema | undefined
  readonly cookies?: AnySchema | undefined
  readonly body?: AnySchema | undefined
  /**
   * What this route can return, per status.
   *
   * Two forms, and the form is the declaration:
   *
   * ```ts
   * response: { 200: UserSchema }                              // one representation
   * response: { 200: { 'application/json': U, 'text/csv': C } } // negotiated (§13.4)
   * ```
   *
   * The plain form is not subject to content negotiation and emits no
   * negotiation code — see `contracts/negotiation.ts` for why the shape is the
   * opt-in rather than a flag.
   */
  readonly response?: ResponseSpec | undefined
}

/**
 * What the second argument of `app.get(path, spec, handler)` actually accepts.
 *
 * `name` and `meta` were always read at runtime but never declared, so they
 * type-checked as free-form excess properties and a misspelling was silent.
 * Declaring them costs nothing at runtime and is what lets `hooks` be checked
 * at all: a `RouteSchema`-only constraint would have accepted
 * `hooks: { onRequst: fn }` without a word.
 */
export interface RouteSpec extends RouteSchema {
  readonly name?: string | undefined
  readonly meta?: Readonly<Record<string, unknown>> | undefined
  /**
   * Phase middleware for this route alone — the innermost of §6.3's three
   * middleware scopes (§8.3's `route.use(checkOwnership)`). It runs after the
   * app's and every enclosing collection's, in the order listed, and
   * `explainRoute` labels it `[route]`.
   *
   * Typed as a route hook is (§9.2): the framework surface, without the route's
   * schema — a middleware is written once and listed on many routes, so no one
   * route's `params` or `body` can be its type.
   */
  readonly use?: readonly (PhaseMiddleware<never> | ConfiguredMiddleware)[] | undefined
  /** Route-scoped hooks — the innermost scope of §9.3. */
  readonly hooks?: RouteHooks | undefined
  /**
   * This route's deadline — §4.4.
   *
   * Omitted inherits from the enclosing collection, then the app. `false`
   * refuses an inherited one, which is how a streaming or long-poll route lives
   * under an otherwise-bounded collection without the collection having to know
   * about it.
   */
  readonly timeout?: TimeoutSpec | undefined
  /**
   * This route's coercion profiles — §11.4.
   *
   * Merged onto whatever the enclosing collections and the app declared, field
   * by field. Almost always unnecessary: the defaults match what each wire
   * format implies, and the schema decides the rest. It exists for the endpoint
   * whose clients disagree with the defaults — a legacy consumer sending
   * `?ids=1,2` where the rest of the API repeats the key.
   */
  readonly coercion?: CoercionSpec | undefined
  /**
   * Business rules — §11.7. Runs after the route's schemas have validated,
   * before `postValidation` and `preHandler`, with the whole context and its
   * services; returns nothing, one issue, or several:
   *
   *     check: async (ctx) => {
   *       if (await users.emailTaken(ctx.body.email)) return issue('email', 'taken', 'Email already registered')
   *     }
   *
   * Issues are a 422 `ZEN_VALIDATION` with `source: 'check'`, in the envelope
   * schema failures use, so a client parses one format for both classes of
   * failure while the status tells them apart (400 for malformed, 422 for not
   * allowed). A rule that means something else — a 409, a 403 — throws that.
   *
   * Typed here as `unknown` on purpose: its real type is written by the verb
   * (`RouteSpecOf`), which is the only place TypeScript can see the schemas
   * beside it, so `ctx.body` in a `check` is the route's validated body.
   */
  readonly check?: unknown
  /**
   * Declarative injection — §15.1, L3. The handler receives the services as its
   * second argument:
   *
   *     app.get('/users/:id', { inject: { db: Db } }, (ctx, { db }) => db.find(ctx.params.id))
   *
   * When every token is a singleton, the object is resolved once, at boot, and
   * frozen: the pipeline passes the same reference to every request, so it
   * costs nothing per request. A scoped or transient token is resolved per
   * request, from the request's own scope. A token with no provider is a boot
   * error naming this route; an optional one (§15.2) is `undefined`.
   */
  readonly inject?: Readonly<Record<string, Token<unknown>>> | undefined
  /**
   * This route's body policy — §4.2 stage 6, §19.2. Each field overrides the
   * application's `body` option for this route alone:
   *
   *     app.post('/avatar', { intake: { maxSize: 5 * 1024 * 1024, mode: 'raw' } }, (ctx) => store(ctx.body))
   *
   * `mode: 'parse'` (the default) parses by content type; `'raw'` hands the
   * handler the bytes; `'stream'` hands it an `AsyncIterable<Uint8Array>` with
   * `maxSize` enforced chunk by chunk, for uploads too large to hold. A stream
   * cannot be validated, so `'stream'` with a `body` schema is a boot error.
   * Declaring an intake declares that the route reads its body: without a
   * `body` schema, `ctx.body` is the parsed value, unvalidated.
   */
  readonly intake?: IntakeSpec | undefined
}

/** §4.2 stage 6 — what `RouteSpec.intake` may override. */
export interface IntakeSpec {
  /** Bytes. Enforced during the read — a larger body is aborted at `maxSize + 1`. */
  readonly maxSize?: number | undefined
  readonly maxDepth?: number | undefined
  readonly maxFields?: number | undefined
  readonly mode?: 'parse' | 'raw' | 'stream' | undefined
}

/** What a `check` may answer — §11.7: nothing, one issue, or several. */
export type CheckResult = Issue | readonly Issue[] | void | undefined | null

/** A route's `check`, typed by the route — see {@link RouteSpecOf}. */
export type RouteCheck<S extends RouteSpec, X, P extends string> =
  (ctx: Context<S, X, P>) => MaybePromise<CheckResult>

/**
 * The spec argument of `app.get(path, spec, handler)` — `S` itself, with
 * `check` typed by the route it belongs to.
 *
 * A homomorphic mapped type, and that is the whole trick: TypeScript infers `S`
 * from it property by property, so the schemas beside `check` are known by the
 * time `check`'s own parameter is typed, and `ctx.body` inside it is the
 * route's validated body. Written as `spec: S & { check?: … }` the inference
 * fails — `check` mentions `S`, so `S` falls back to its constraint and every
 * source becomes `never`.
 */
export type RouteSpecOf<S extends RouteSpec, X, P extends string> = {
  readonly [K in keyof S]: K extends 'check' ? RouteCheck<S, X, P> : S[K]
}

/**
 * A spec with no `check` — what the first overload of every verb takes.
 *
 * Two overloads rather than one because each form of inference loses
 * something the other keeps. Inferring `S` directly keeps every literal — a
 * nested `intake: { mode: 'stream', maxSize }` stays `'stream'`, which is what
 * types `ctx.body` as a stream — but cannot type a `check` written beside the
 * schemas it reads. {@link RouteSpecOf} types the `check` and widens such
 * literals. So a spec without a `check` takes the first, and one with a
 * `check` the second.
 */
export interface SpecWithoutCheck {
  readonly check?: undefined
}

/**
 * The second argument a handler of an `inject` route receives (§15.1) — each
 * key's service type. `never` on a route that injects nothing, so a handler
 * that declares one is a mistake the compiler names.
 */
export type DepsOf<S> =
  S extends { readonly inject: infer I }
    ? { readonly [K in keyof I]: I[K] extends Token<infer T> ? T : never }
    : never

export type InferParams<S extends RouteSchema, P extends string> =
  S['params'] extends AnySchema ? InferOutput<S['params']> : ExtractParams<P>

export type InferQuery<S extends RouteSchema> =
  S['query'] extends AnySchema ? InferOutput<S['query']> : Readonly<Record<string, string | string[] | undefined>>

export type InferHeaders<S extends RouteSchema> =
  S['headers'] extends AnySchema ? InferOutput<S['headers']> : Readonly<Record<string, string | undefined>>

export type InferCookies<S extends RouteSchema> =
  S['cookies'] extends AnySchema ? InferOutput<S['cookies']> : Readonly<Record<string, string | undefined>>

/**
 * `never` when the route declares no body — so *reading* `ctx.body` on a GET is
 * a compile error rather than a runtime `undefined`. A route that declares an
 * `intake` without a schema reads its body unvalidated: the bytes in `'raw'`
 * mode, a stream of them in `'stream'` mode, and `unknown` when parsed.
 */
export type InferBody<S extends RouteSchema> =
  S['body'] extends AnySchema ? InferOutput<S['body']> : IntakeBody<S>

type IntakeBody<S> =
  S extends { readonly intake: { readonly mode: 'stream' } } ? AsyncIterable<Uint8Array>
  : S extends { readonly intake: { readonly mode: 'raw' } } ? Uint8Array
  : S extends { readonly intake: object } ? unknown
  : never

/**
 * What one status's declaration permits the handler to return.
 *
 * The variant form widens to the union of its representations, which is the
 * honest type: negotiation picks the media type, and the handler produces one
 * value that every declared representation has to be able to describe. A
 * handler that wants to branch reads `ctx.negotiated` and narrows itself.
 */
type OutputOfDeclaration<D> =
  D extends AnySchema
    ? InferOutput<D>
    : D extends Readonly<Record<string, AnySchema | null>>
      ? { [M in keyof D]: D[M] extends AnySchema ? InferOutput<D[M]> : null }[keyof D]
      : null

/** The union of everything the route's response schemas permit. */
export type ResponseOf<S extends RouteSchema> =
  S['response'] extends ResponseSpec
    ? { [K in keyof S['response']]: OutputOfDeclaration<S['response'][K]> }[keyof S['response']]
    : unknown

export type MaybePromise<T> = T | Promise<T>

export type HandlerResult<S extends RouteSchema> =
  | ResponseOf<S>
  | Reply<ResponseOf<S>>

// ─────────────────────────────────────────────────────────────────────────────
// Records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a registration was written — `src/features/users/routes.ts:31:3`.
 * Declared beside its capture in `primitives/origin.ts`, which stratum 0 needs.
 */
export type { SourceOrigin } from '../primitives/origin.ts'

export type RouteId = string & { readonly __routeId?: unique symbol }
export type CollectionId = string & { readonly __collectionId?: unique symbol }

/**
 * The atom of the system (§5.1). Everything downstream — matcher, pipeline,
 * OpenAPI, client codegen, `zen routes` — is a projection of this.
 */
export interface RouteRecord {
  readonly id: RouteId
  readonly name: string | undefined
  readonly method: HttpMethod
  /** Fully composed, including all ancestor prefixes. Normalised. */
  readonly path: string
  readonly segments: readonly PathSegment[]
  /** The spec as registered — schemas, and `check`, `inject` and `intake` beside them. */
  readonly schema: RouteSpec
  readonly handler: (ctx: never) => unknown
  readonly middleware: readonly MiddlewareRef[]
  /**
   * Every hook that runs on this route, per phase, **already in execution
   * order** — global scope, then each enclosing collection, then the route,
   * reversed for the post-family (§9.3).
   *
   * Resolved here rather than at request time for the same reason `middleware`
   * is: it is a function of static registration, so it belongs in the record
   * the compiler reads. Putting it on the record rather than hiding it in the
   * app also means every tool sees the *same* order the pipeline was generated
   * from, which is what makes `explainRoute` unable to lie.
   */
  readonly hooks: ReadonlyMap<RequestPhase, readonly HookRecord[]>
  /**
   * The resolved deadline for this route, and the scope that declared it —
   * §4.4. `null` when nothing in scope declared one, or when the route refused
   * the inherited one with `timeout: false`.
   *
   * Here rather than in the dispatcher for the same reason `hooks` is here: it
   * is a function of static registration, so the compiler that emits the stage
   * checks, the tool that prints the chain, and the generator that documents a
   * 504 all read one field and cannot disagree about the number.
   */
  readonly timeout: TimeoutRecord | null
  /**
   * What this route converts before validating, per source — §11.4.
   *
   * `null` when nothing is converted, which is the common case and is what the
   * zero-cost gate checks. Non-null, it is the *derived plan* rather than the
   * declared profile: `{ query: { page → integer, tags → array of string } }`
   * and not `{ numbers: true }`. That distinction is the point of putting it on
   * the record at all — a profile is what was asked for and a plan is what will
   * happen, and only the second one can be read by `explainRoute` to answer
   * "why did `?tags=a` arrive as an array" or by the OpenAPI generator to
   * document the parameter's serialization style. One structure, three readers,
   * no way for them to disagree (§2.4).
   */
  readonly coercion: CoercionRecord | null
  /**
   * What this route can produce, and in what order it prefers to — §13.4.
   *
   * `null` when no status used the variant form, which is the common case and
   * is what the zero-cost gate checks: a route with no negotiation record emits
   * no negotiation code, reads no `Accept` header and stages no `Vary`.
   *
   * Non-null, it is here for the same reason `coercion` and `timeout` are: it
   * is a function of static registration, so the step the pipeline emits, the
   * line `explainRoute` prints, and the `content` map `@erenthedeveloper0/zen-openapi` writes
   * all read one structure and cannot disagree about which media types this
   * route serves (§2.4).
   */
  readonly negotiation: NegotiationRecord | null
  readonly meta: ReadonlyMap<string, unknown>
  readonly collection: CollectionId | null
  readonly origin: SourceOrigin | undefined
  /**
   * Every service this route can reach through `inject` (§15.1), transitively
   * through the providers' declared `deps`, by token name, sorted. Empty for a
   * route that injects nothing. What a dependency blast-radius tool reads: the
   * routes that stop working when a service does.
   */
  readonly dependencies: readonly string[]
}

export interface MiddlewareRef {
  readonly kind: 'phase' | 'around' | 'after'
  readonly name: string
  readonly fn: Function
  readonly scope: string
  readonly origin: SourceOrigin | undefined
  /** §8.7 — the registration's condition, as written. */
  readonly when?: MiddlewareCondition<never> | undefined
  /**
   * §8.7 — `true` when `when.env` answered `false` at boot. The step stays on
   * the record, so `explainRoute` and the graph can say it was turned off, and
   * is never compiled: no pipeline holds a line for it.
   */
  readonly omitted?: boolean | undefined
}

export interface RouteDefinition {
  readonly method: HttpMethod
  readonly path: string
  readonly schema?: RouteSpec | undefined
  readonly handler: Function
  readonly name?: string | undefined
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching
// ─────────────────────────────────────────────────────────────────────────────

export type ParamsObject = Record<string, string | number | Date | undefined>

export type MatchResult =
  | { readonly route: RouteRecord; readonly params: ParamsObject }
  /** Path matched but the method did not — free 405 with a correct Allow header. */
  | { readonly route: null; readonly allowed: readonly HttpMethod[] }
  | null
