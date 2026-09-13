import type { StatusCode } from './http.ts'
import type { AnySchema } from './standard-schema.ts'
import type { JsonSchema } from './json-schema.ts'

/**
 * Content negotiation — rfcs/0001 §13.4.
 *
 * A route that can produce more than one representation of the same resource
 * declares them as a record keyed by media type:
 *
 * ```ts
 * app.get('/users/:id', {
 *   response: {
 *     200: {
 *       'application/json': UserSchema,
 *       'text/csv':         UserCsvSchema,
 *     },
 *   },
 * }, ctx => users.get(ctx.params.id))
 * ```
 *
 * Three decisions this vocabulary encodes, each of which is load-bearing
 * somewhere else in the subsystem.
 *
 * ### 1. The variant *form* is the opt-in, not a flag
 *
 * `200: UserSchema` is not negotiated. `200: { 'application/json': UserSchema }`
 * — the same single representation, written the other way — is. No `negotiate:
 * true` option exists, because the shape of the declaration already says which
 * one the author meant, and an option would let the two disagree.
 *
 * That matters for §9.4's zero-cost rule, which is the reason it is worth
 * spelling out: the overwhelming majority of routes serve exactly one
 * representation and must emit **no negotiation code at all** — no `Accept`
 * read, no `Vary`, no branch. They get that by writing the plain form, which is
 * also the form they were already writing. Negotiation is not a thing you turn
 * off; it is a thing that does not exist until you ask for it.
 *
 * The corollary is the one honest gap, and it is recorded rather than hidden:
 * a JSON-only route ignores `Accept: text/csv` and answers 200 with JSON. RFC
 * 9110 §12.5.1 permits exactly that ("or disregard the header field"), and the
 * alternative — every route in every application parsing `Accept` to discover
 * it has nothing to decide — is the per-request cost this framework exists to
 * refuse. A route that wants the strict answer writes one media type in the
 * variant form and gets a 406.
 *
 * ### 2. The media types are a *route* property, not a status property
 *
 * The negotiation happens at stage 5 — before intake, before validation, before
 * the handler — because a 406 is knowable from the `Accept` header and the
 * graph alone, and discovering it after a database round trip would make the
 * refusal cost more than the success. But the status is not known until the
 * handler returns.
 *
 * So the offer list is the route's, and `ready()` refuses a route whose statuses
 * disagree about it (`ZEN_NEGOTIATION_INCONSISTENT`). A route that offers CSV on
 * 200 and only XML on 201 cannot answer "can I produce CSV?" before running, and
 * a framework that guessed would have to guess wrong somewhere.
 *
 * Statuses declared in the *plain* form are untouched by this: they have exactly
 * one representation and are not subject to negotiation, which is what lets
 * `{ 200: { json, csv }, 404: ProblemSchema }` mean the obvious thing. Error
 * envelopes are RFC 9457 problem documents whatever the client asked for (§12.1).
 *
 * ### 3. A media type needs an *encoder*, and core ships one
 *
 * JSON-family types (`application/json` and anything `+json`) are written by the
 * compiled serializer of §13.3 — the same one, with the same guarantee that an
 * undeclared field cannot be emitted. Everything else needs an encoder, supplied
 * through `registerMediaEncoder` for the same reason schema conversion is
 * supplied through `registerSchemaConverter`: `@zenjs/core` has no runtime
 * dependencies and is not going to grow a CSV writer (B3, §19.8).
 *
 * A declared media type with no encoder is a **boot error**, not a silent
 * fallback to JSON. Serving a JSON body under `Content-Type: text/csv` is worse
 * than refusing to boot, and it is the exact shape of failure §13.3.6 spends a
 * page arguing against: half a promise, quietly.
 */

/** `type/subtype`, lowercase, no parameters. `application/json`, `text/csv`. */
export type MediaType = string

/**
 * What one status can produce, keyed by media type — the variant form.
 *
 * Key order is **server preference** and is used to break quality ties, which
 * is why §13.4's matcher reads it rather than sorting: RFC 9110 gives the
 * client a way to express preference and the server the final say, and
 * declaration order is the only place the server's preference is written down.
 * `null` means "this representation carries no body", exactly as it does in the
 * plain form.
 */
export type ResponseVariants = Readonly<Record<MediaType, AnySchema | null>>

/** One status's declaration: a schema, a variant record, or nothing. */
export type ResponseDeclaration = AnySchema | ResponseVariants | null

export type ResponseSpec = Readonly<Record<StatusCode, ResponseDeclaration>>

/**
 * The negotiation plan for one route, derived at boot — the sibling of
 * `RouteRecord.coercion` and `RouteRecord.timeout`, and here for the same
 * reason (§5.1, §2.4).
 *
 * `null` on `RouteRecord.negotiation` means the route declared no variant form
 * and emits no negotiation code. Non-null, it is what *will happen*: the offers
 * in preference order and the statuses that vary by media type. `explainRoute`
 * renders it, `@zenjs/openapi` documents it, and the runtime matches against it
 * — one structure, three readers, no way for them to disagree.
 */
export interface NegotiationRecord {
  /**
   * Every media type this route can produce, in declaration order.
   *
   * Order is the answer to "the client said `Accept: * / *`" and to any tie on
   * quality, so it is preserved from the source rather than sorted.
   */
  readonly offers: readonly MediaType[]
  /** The statuses whose declaration was the variant form. */
  readonly statuses: readonly StatusCode[]
}

/**
 * Turns a value into the bytes of one media type — the seam §13.4 needs and
 * `@zenjs/core` cannot fill (B3).
 *
 * A **factory**, not a function, and that is the interesting part of the
 * signature. It is called once per (route, status) at boot with the declared
 * schema already converted to JSON Schema, so an encoder can do at boot what
 * §13.3's serializer does: resolve the column list, intern the header row, pick
 * the per-field writers. The per-request function it returns should be doing
 * arithmetic and string appends, not reading a schema.
 *
 * `schema` is `null` when the status declared `null` (no body) or when the
 * schema could not be converted — the same honest `null` §13.3.6 row 2 reports.
 * An encoder that needs the shape should say so by throwing from the factory;
 * `ready()` turns that into a boot diagnostic naming the route and the status.
 *
 * The returned function must produce a **string**. Binary representations are a
 * `ctx.bytes()` reply, which the handler already controls completely, and
 * widening the hot path to `string | Uint8Array` for a case nothing exercises
 * is the surface §9.7 argues against.
 */
export type MediaEncoderFactory = (
  schema: JsonSchema | null,
  where: { readonly routeId: string; readonly status: StatusCode; readonly media: MediaType },
) => (value: unknown) => string

/**
 * One chosen representation, resolved at boot and selected per request.
 *
 * The whole object is a boot-time constant — one per media type per route — so
 * choosing a representation is a reference store and never an allocation. That
 * is why the negotiated media type and its serializer table travel together
 * rather than being looked up separately at egress: by the time the epilogue
 * runs, "which serializer" has already been answered, and answering it twice is
 * how the two answers get a chance to differ.
 */
export interface Representation {
  /** Exactly as declared — `text/csv`, not `text/csv; charset=utf-8`. */
  readonly media: MediaType
  /** What goes on the wire, including the charset. */
  readonly contentType: string
  /**
   * The statuses this representation covers — every status that declared the
   * variant form.
   *
   * Separate from `writers` because the two answer different questions and the
   * difference is observable. `writers` is "is there a compiled contract for
   * this status", which is `false` under `serialization.mode: 'off'` and for a
   * schema that would not convert. `statuses` is "did the route negotiate this
   * status", which decides the `Content-Type` and is true in both of those
   * cases. Collapsing them would make a route silently answer
   * `application/json` for a CSV request the moment its schema stopped
   * converting — the half-a-promise failure §13.3.6 exists to prevent.
   */
  readonly statuses: ReadonlySet<number>
  /** Status → writer, for this media type only. Absent where there is none. */
  readonly writers: ReadonlyMap<number, (value: unknown) => string>
}

/**
 * What the pipeline calls, once, at stage 5.
 *
 * Returns the chosen representation, or `null` when the request's `Accept`
 * excludes every one of them — which the caller turns into a 406 listing what
 * the route can produce.
 */
export type Negotiator = (accept: string | undefined) => Representation | null
