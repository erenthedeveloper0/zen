import type { HttpMethod, HeaderValue, StatusCode } from './http.ts'
import type { RawRequest } from './adapter.ts'
import type { Logger } from './logger.ts'
import type { Slot } from './slot.ts'
import type { Token } from './container.ts'
import type {
  FileReplyInit, Reply, ReplyInit, SetCookie, StreamSource, SseChannel, SseEvent, SseInit,
} from './reply.ts'
import type {
  RouteSchema, InferParams, InferQuery, InferHeaders, InferCookies, InferBody, RouteId,
} from './route.ts'

export interface RouteInfo {
  readonly id: RouteId
  readonly name: string | undefined
  readonly method: HttpMethod
  /** The path *template* (`/users/:id`), never the concrete URL. Metrics and
   *  tracing label on this — it is what makes cardinality bounded (§31.2). */
  readonly path: string
  readonly meta: ReadonlyMap<string, unknown>
}

/** Staged response metadata. Applied at egress; throws once the reply is sent. */
export interface ReplyBuilder {
  status(code: StatusCode): this
  header(name: string, value: HeaderValue): this
  appendHeader(name: string, value: string): this
  removeHeader(name: string): this
  vary(name: string): this
  cookie(name: string, value: string, opts?: Omit<SetCookie, 'name' | 'value'>): this
  clearCookie(name: string, opts?: Omit<SetCookie, 'name' | 'value'>): this
}

/**
 * The Context — rfcs/0001 §7.
 *
 * Request-derived data is immutable: the accessors are lazy, memoised, and have
 * no setters *in the generated class at all*. Immutability is enforced by the
 * type system and by the absence of setters, not by `Object.freeze` on a hot
 * object (dev mode freezes; production does not — §7.3).
 */
export interface BaseContext<S extends RouteSchema = RouteSchema, P extends string = string> {
  // ── Request data (lazy, memoised, typed by S) ─────────────────────────────
  readonly method: HttpMethod
  readonly path: string
  readonly url: URL
  readonly params: InferParams<S, P>
  readonly query: InferQuery<S>
  readonly headers: InferHeaders<S>
  readonly cookies: InferCookies<S>
  readonly body: InferBody<S>
  readonly raw: RawRequest

  // ── Connection ────────────────────────────────────────────────────────────
  readonly ip: string
  readonly secure: boolean
  readonly host: string
  /** Aborts on client disconnect *and* on the route's deadline (§4.4). */
  readonly signal: AbortSignal
  readonly aborted: boolean

  // ── Deadline (§4.4) ───────────────────────────────────────────────────────
  /**
   * `performance.now()` at which this request expires, or `null` when the route
   * declared no timeout.
   */
  readonly deadline: number | null
  /**
   * Milliseconds of budget left, or `Infinity` when there is no deadline.
   *
   * `Infinity` rather than `null` so it composes: `Math.min(ctx.timeLeft, 2000)`
   * is the right call whether or not a deadline exists, and the alternative is
   * every call site writing the same ternary. This is the value you hand
   * downstream — a service that forwards its *original* timeout to four
   * sequential calls has quietly promised four times what it has.
   */
  readonly timeLeft: number
  /**
   * True when this request's deadline expired. Published at settle time
   * alongside `aborted`, so `onResponse` can tell "we ran out of time" from
   * "the client hung up" without touching the signal.
   */
  readonly timedOut: boolean

  // ── Content negotiation (§13.4) ───────────────────────────────────────────
  /**
   * The media type this response will carry, or `null` on a route that declares
   * one representation and is therefore not negotiated.
   *
   * Set at stage 5 — before middleware, intake, validation and the handler — so
   * it is readable everywhere, including from an `around` middleware that needs
   * it as a cache key. The value is one of the strings the route declared,
   * without parameters: `'text/csv'`, not `'text/csv; charset=utf-8'`.
   *
   * `null` is not "the client did not say"; it is "this route has nothing to
   * decide". A route with a single declared representation never inspects
   * `Accept` at all, which is what makes negotiation free for the routes that
   * do not use it.
   */
  readonly negotiated: string | null

  // ── Identity & timing ─────────────────────────────────────────────────────
  readonly id: string
  readonly startTime: number
  readonly route: RouteInfo | null
  readonly log: Logger

  // ── Typed mutable channel (§7.4) ──────────────────────────────────────────
  get<T>(slot: Slot<T>): T
  find<T>(slot: Slot<T>): T | undefined
  set<T>(slot: Slot<T>, value: T): void
  has(slot: Slot<unknown>): boolean

  // ── Services (§15) — optional; nothing forces you into the container ──────
  resolve<T>(token: Token<T>): T
  resolveAsync<T>(token: Token<T>): Promise<T>

  // ── Response builders: pure. They return, they do not send. ───────────────
  json<T>(body: T, init?: ReplyInit): Reply<T>
  text(body: string, init?: ReplyInit): Reply<string>
  html(body: string, init?: ReplyInit): Reply<string>
  bytes(body: Uint8Array, init?: ReplyInit): Reply<Uint8Array>
  empty(status?: 204 | 205 | 304): Reply<null>
  redirect(to: string, status?: 301 | 302 | 303 | 307 | 308): Reply<null>
  /**
   * A file on disk. Pass `root` whenever any part of `path` came from the
   * request — see `FileReplyInit.root`. The adapter answers 404 for a missing
   * file or an escaping path, and handles `HEAD`, `ETag`/`Last-Modified`
   * revalidation (304) and single byte ranges (206) itself (§13.5).
   */
  file(path: string, init?: FileReplyInit): Reply<null>
  stream(source: StreamSource, init?: ReplyInit): Reply<null>
  /**
   * Open a server-sent event stream (§13.5). Return the channel from the
   * handler, keep the reference, and `send` on it:
   *
   *     app.get('/events', { timeout: false }, (ctx) => {
   *       const sse = ctx.sse({ retry: 3000 })
   *       const off = bus.on('update', (e) => sse.send({ event: 'update', data: e, id: e.seq }))
   *       ctx.signal.addEventListener('abort', off)
   *       return sse
   *     })
   *
   * The response carries `text/event-stream`, `Cache-Control: no-cache,
   * no-transform` and `X-Accel-Buffering: no`, so it streams through nginx
   * without a config change. A route deadline bounds the work before the first
   * byte and stops there (§4.4); `ctx.signal` still aborts when the client
   * leaves, for as long as the stream is open.
   */
  sse(init?: SseInit): SseChannel & { readonly $reply: Reply<SseEvent> }
  respond<T>(reply: Reply<T>): Reply<T>

  readonly res: ReplyBuilder
}

/**
 * `X` carries plugin decorations. It is intersected rather than merged into a
 * mapped type on purpose: intersections of *flat* object types are cheap for
 * tsc, conditional/mapped accumulations are not (§10.4, §28.2).
 */
export type Context<
  S extends RouteSchema = RouteSchema,
  X = {},
  P extends string = string,
> = BaseContext<S, P> & X
