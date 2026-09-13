import type { RawRequest } from '../contracts/adapter.ts'
import type { Logger } from '../contracts/logger.ts'
import type { HeaderValue } from '../contracts/http.ts'
import type { Reply, ReplyInit, SetCookie, StreamSource } from '../contracts/reply.ts'
import type { RouteInfo, ReplyBuilder } from '../contracts/context.ts'
import type { Slot } from '../contracts/slot.ts'
import type { Container, Token } from '../contracts/container.ts'
import type { Deadline } from './deadline.ts'
import type { Representation } from '../contracts/negotiation.ts'
import { pathnameOf } from '../primitives/path.ts'
import { parseQuery, type QueryRecord } from './query.ts'
import { parseCookies, type CookieRecord } from './cookies.ts'
import {
  jsonReply, textReply, htmlReply, bytesReply, emptyReply, redirectReply, fileReply, streamReply,
} from './reply.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

export const UNSET: unique symbol = Symbol('zen.unset')

export interface ContextEnv {
  readonly log: Logger
  readonly maxQueryParams: number
  readonly trustProxy: boolean
  readonly container: Container
  /**
   * The resolved, frozen configuration — §16.3.
   *
   * On the app-wide `env` object rather than as a field on the context, and
   * that is the whole design decision behind `ctx.config`. Configuration is
   * identical for every request in the process and immutable after boot, so a
   * per-context copy would be one store per request in service of a value that
   * cannot differ between them — and a new field on the context is a permanent
   * cost paid by every request in the application, plus a second place I2's
   * monomorphism fixture has to be kept in step (§7.6). `ctx.config` is
   * therefore a getter over a shared object: one property load, no field, no
   * shape change in either twin.
   */
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * `PlainContext` — the *interpreted twin* of the generated context class
 * (rfcs/0001 §7.6, I6).
 *
 * This is the semantic definition of a Zen context. It is used verbatim when
 * `caps.eval === false` (workerd, CSP-locked runtimes) and is the reference the
 * differential fuzzer compares the compiled class against. It is roughly 2x
 * slower on context-access microbenchmarks and behaviourally identical — if it
 * ever isn't, that is a bug in the compiler, and the fuzzer's job is to find it.
 *
 * Field initialisation order in the constructor is deliberate and load-bearing:
 * one hidden class, no dictionary-mode transitions, no property added after
 * construction anywhere in the framework (I2).
 */
export class PlainContext {
  // ── fixed shape ───────────────────────────────────────────────────────────
  raw: RawRequest
  route: RouteInfo | null
  env: ContextEnv
  method: string
  $params: Record<string, unknown>
  $path: string | typeof UNSET = UNSET
  $query: QueryRecord | typeof UNSET = UNSET
  $headers: Record<string, string | undefined> | typeof UNSET = UNSET
  $cookies: CookieRecord | typeof UNSET = UNSET
  $url: URL | typeof UNSET = UNSET
  $body: unknown = undefined
  $s: unknown[]
  $disposers: Slot<unknown>[] | null = null
  $stage: ReplyStage | null = null
  $resStatus = 0
  $resHeaders: Array<[string, HeaderValue, boolean]> | null = null
  $resCookies: SetCookie[] | null = null
  /**
   * This request's deadline, or `null` on a route that declared no timeout
   * (§4.4). The compiled pipeline writes `stage` on it at every stage boundary
   * and reads `done`; nothing else touches it.
   */
  $deadline: Deadline | null
  /**
   * The representation §13.4 chose, or `null` on a route that is not
   * negotiated.
   *
   * Declared on every context for the same reason `$deadline` is, and the
   * comment there is the argument: the alternative is two hidden classes, and a
   * polymorphic context costs far more than one store of `null` (§7.6, I2). The
   * value is a boot-time constant object shared by every request that picks the
   * same media type, so this is a reference store and never an allocation.
   */
  $negotiated: Representation | null = null
  id = ''
  startTime = 0
  signal: AbortSignal
  aborted = false
  timedOut = false
  log: Logger

  constructor(
    raw: RawRequest,
    route: RouteInfo | null,
    params: Record<string, unknown>,
    env: ContextEnv,
    slotCount: number,
    signal: AbortSignal,
    deadline: Deadline | null = null,
  ) {
    this.raw = raw
    this.route = route
    this.env = env
    this.method = raw.method
    this.$params = params
    this.$s = new Array(slotCount).fill(undefined) as unknown[]
    this.$deadline = deadline
    this.signal = signal
    this.log = env.log
  }

  // ── lazy, memoised request data ───────────────────────────────────────────
  get path(): string {
    const v = this.$path
    if (v !== UNSET) return v
    return (this.$path = pathnameOf(this.raw.url))
  }

  get params(): never {
    return this.$params as never
  }

  get query(): never {
    const v = this.$query
    if (v !== UNSET) return v as never
    return (this.$query = parseQuery(this.raw.url, this.env.maxQueryParams)) as never
  }

  get headers(): never {
    const v = this.$headers
    if (v !== UNSET) return v as never
    return (this.$headers = buildHeaders(this.raw)) as never
  }

  get cookies(): never {
    const v = this.$cookies
    if (v !== UNSET) return v as never
    return (this.$cookies = parseCookies(this.raw.header('cookie'))) as never
  }

  get body(): never {
    return this.$body as never
  }

  get url(): URL {
    const v = this.$url
    if (v !== UNSET) return v
    return (this.$url = new URL(this.raw.url, `${this.secure ? 'https' : 'http'}://${this.host}`))
  }

  get host(): string {
    return this.raw.header('host') ?? 'localhost'
  }

  get secure(): boolean {
    return this.env.trustProxy && this.raw.header('x-forwarded-proto') === 'https'
  }

  /** §16.3 — the app-wide config object, shared and frozen. See `ContextEnv`. */
  get config(): never {
    return this.env.config as never
  }

  // ── deadline (§4.4) ───────────────────────────────────────────────────────
  get deadline(): number | null {
    const d = this.$deadline
    return d === null ? null : d.at
  }

  /** `Infinity` when unbounded, so `Math.min(ctx.timeLeft, n)` always works. */
  get timeLeft(): number {
    const d = this.$deadline
    return d === null ? Infinity : d.at - performance.now()
  }

  // ── content negotiation (§13.4) ───────────────────────────────────────────
  /** The chosen media type, or `null` on a route that is not negotiated. */
  get negotiated(): string | null {
    const n = this.$negotiated
    return n === null ? null : n.media
  }

  /** §19.4 — `X-Forwarded-For` is read *only* when trustProxy is configured.
   *  A spoofable client IP silently breaks rate limiting and audit logs. */
  get ip(): string {
    if (this.env.trustProxy) {
      const fwd = this.raw.header('x-forwarded-for')
      if (fwd !== undefined) {
        const comma = fwd.indexOf(',')
        return (comma === -1 ? fwd : fwd.slice(0, comma)).trim()
      }
    }
    return this.raw.remote.address ?? ''
  }

  // ── slots (§7.4) ──────────────────────────────────────────────────────────
  get<T>(slot: Slot<T>): T {
    const v = this.$s[slot.index]
    if (v === undefined) {
      if (slot.defaultValue !== undefined) {
        const d = slot.defaultValue()
        this.$s[slot.index] = d
        return d
      }
      if (!slot.optional) throw slotEmpty(slot, this)
    }
    return v as T
  }

  find<T>(slot: Slot<T>): T | undefined {
    return this.$s[slot.index] as T | undefined
  }

  set<T>(slot: Slot<T>, value: T): void {
    this.$s[slot.index] = value
    if (slot.dispose !== undefined) {
      // Slot<T> is invariant in `dispose`; the disposer list is heterogeneous by
      // construction and each entry is only ever called with its own value.
      ;(this.$disposers ??= []).push(slot as unknown as Slot<unknown>)
    }
  }

  has(slot: Slot<unknown>): boolean {
    return this.$s[slot.index] !== undefined
  }

  // ── services (§15) ────────────────────────────────────────────────────────
  // Request-scoped services reuse the slot array, so resolving one is an array
  // read and a request that resolves nothing allocates nothing.
  resolve<T>(token: Token<T>): T {
    return this.env.container.resolve(token, this)
  }

  resolveAsync<T>(token: Token<T>): Promise<T> {
    return this.env.container.resolveAsync(token, this)
  }

  // ── response builders: pure ───────────────────────────────────────────────
  json<T>(body: T, init?: ReplyInit): Reply<T> { return jsonReply(body, init) }
  text(body: string, init?: ReplyInit): Reply<string> { return textReply(body, init) }
  html(body: string, init?: ReplyInit): Reply<string> { return htmlReply(body, init) }
  bytes(body: Uint8Array, init?: ReplyInit): Reply<Uint8Array> { return bytesReply(body, init) }
  empty(status: 204 | 205 | 304 = 204): Reply<null> { return emptyReply(status) }
  redirect(to: string, status: 301 | 302 | 303 | 307 | 308 = 302): Reply<null> { return redirectReply(to, status) }
  file(path: string, init?: ReplyInit): Reply<null> { return fileReply(path, init) }
  stream(source: StreamSource, init?: ReplyInit): Reply<null> { return streamReply(source, init) }
  respond<T>(reply: Reply<T>): Reply<T> { return reply }

  get res(): ReplyBuilder {
    return (this.$stage ??= new ReplyStage(this))
  }
}

/** Structural target so the *generated* context class can reuse ReplyStage. */
export interface StageTarget {
  $resStatus: number
  $resHeaders: Array<[string, HeaderValue, boolean]> | null
  $resCookies: SetCookie[] | null
}

/** Staged response metadata, applied at egress (§13.6). */
export class ReplyStage implements ReplyBuilder {
  #ctx: StageTarget

  constructor(ctx: StageTarget) {
    this.#ctx = ctx
  }

  status(code: number): this {
    this.#ctx.$resStatus = code
    return this
  }

  header(name: string, value: HeaderValue): this {
    ;(this.#ctx.$resHeaders ??= []).push([name, value, false])
    return this
  }

  appendHeader(name: string, value: string): this {
    ;(this.#ctx.$resHeaders ??= []).push([name, value, true])
    return this
  }

  removeHeader(name: string): this {
    ;(this.#ctx.$resHeaders ??= []).push([name, '', false])
    return this
  }

  vary(name: string): this {
    return this.appendHeader('vary', name)
  }

  cookie(name: string, value: string, opts: Omit<SetCookie, 'name' | 'value'> = {}): this {
    ;(this.#ctx.$resCookies ??= []).push({ name, value, ...opts })
    return this
  }

  clearCookie(name: string, opts: Omit<SetCookie, 'name' | 'value'> = {}): this {
    ;(this.#ctx.$resCookies ??= []).push({ name, value: '', ...opts, maxAge: 0 })
    return this
  }
}

export function buildHeaders(raw: RawRequest): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>
  for (const name of raw.headerNames()) {
    out[name] = raw.header(name)
  }
  return out
}

/**
 * §7.4 — reading a slot before writing it names the slot *and* the route.
 * Vastly better than `undefined` propagating three layers into business logic,
 * which is the actual daily experience of `req.user`.
 */
export function slotEmpty(slot: { readonly name: string }, ctx: { route: RouteInfo | null }): ZenError {
  const where = ctx.route ? `${ctx.route.method} ${ctx.route.path}` : 'this request'
  return new ZenError(
    Codes.SLOT_EMPTY,
    `Slot "${slot.name}" was read before it was set on ${where}. ` +
      `Set it in a middleware or hook that runs before the handler, ` +
      `or declare it with { optional: true } / { default: … }.`,
    { status: 500, expose: false, meta: { slot: slot.name } },
  )
}
