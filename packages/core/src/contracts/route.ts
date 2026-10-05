import type { HttpMethod } from './http.ts'
import type { AnySchema, InferOutput } from './standard-schema.ts'
import type { Reply } from './reply.ts'
import type { CoercionRecord, CoercionSpec } from './coercion.ts'
import type { HookRecord, RequestPhase, RouteHooks } from './hook.ts'
import type { TimeoutRecord, TimeoutSpec } from './deadline.ts'
import type { NegotiationRecord, ResponseSpec } from './negotiation.ts'
import type { PhaseMiddleware } from './middleware.ts'

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
  readonly use?: readonly PhaseMiddleware<never>[] | undefined
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
}

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
 * a compile error rather than a runtime `undefined`.
 */
export type InferBody<S extends RouteSchema> =
  S['body'] extends AnySchema ? InferOutput<S['body']> : never

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

export interface SourceOrigin {
  readonly file: string
  readonly line: number
  readonly column: number
}

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
  readonly schema: RouteSchema
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
}

export interface MiddlewareRef {
  readonly kind: 'phase' | 'around' | 'after'
  readonly name: string
  readonly fn: Function
  readonly scope: string
  readonly origin: SourceOrigin | undefined
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
