import type { RawRequest } from '../contracts/adapter.ts'
import type { Logger } from '../contracts/logger.ts'
import type { HeaderValue } from '../contracts/http.ts'
import type {
  FileReplyInit, RedirectInit, RedirectStatus, Reply, ReplyInit, SetCookie, StreamSource, SseInit,
} from '../contracts/reply.ts'
import type { SafeHtml } from '../contracts/html.ts'
import type { RedirectPolicy } from './redirect.ts'
import type { RouteInfo, ReplyBuilder } from '../contracts/context.ts'
import type { Slot } from '../contracts/slot.ts'
import type { Container, Token } from '../contracts/container.ts'
import type { Deadline } from './deadline.ts'
import type { Representation } from '../contracts/negotiation.ts'
import { pathnameOf } from '../primitives/path.ts'
import { trackDisposal, type Disposal } from '../primitives/disposal.ts'
import { parseQuery, type QueryRecord } from './query.ts'
import { assertCookie, parseCookies, type CookieRecord } from './cookies.ts'
import { assertHeader } from './headers.ts'
import {
  jsonReply, textReply, htmlReply, bytesReply, emptyReply, redirectReply, fileReply, streamReply,
} from './reply.ts'
import { createSseChannel, type SseChannelWithReply } from './sse.ts'
import { ZenError } from '../errors/zen-error.ts'
import { BadRequest } from '../errors/http-errors.ts'
import { Codes } from '../errors/codes.ts'

export const UNSET: unique symbol = Symbol('zen.unset')

export interface ContextEnv {
  readonly log: Logger
  readonly maxQueryParams: number
  /**
   * §19.4 — whether, and how far, to believe `X-Forwarded-*`.
   *
   * `false` (the default) ignores them. A number is how many proxies sit in
   * front of the process — `1` for one load balancer — and `ctx.ip` is then the
   * address that many hops from the right of `X-Forwarded-For`: the one the
   * outermost trusted proxy saw, which no client can choose. `true` believes
   * the leftmost entry, which is only safe behind proxies that *overwrite* the
   * header; behind one that appends, the client writes that entry itself.
   */
  readonly trustProxy: boolean | number
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
  /**
   * Where `ctx.redirect()` may send a client — §19.5, compiled at boot from
   * `redirect.allowExternal`. Here for the reason `config` is: identical for
   * every request, so a getter's worth of reach rather than a field on the
   * context. Absent means the default, same-origin only.
   */
  readonly redirect?: RedirectPolicy | undefined
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
  /** What stage 10 releases, newest last — see `primitives/disposal.ts`. */
  $disposers: Disposal[] | null = null
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
    return (this.$url = requestUrl(this.raw.url, this.secure, this.host))
  }

  get host(): string {
    return this.raw.header('host') ?? 'localhost'
  }

  get secure(): boolean {
    const trust = this.env.trustProxy
    if (trust === false || trust === 0) return false
    const proto = this.raw.header('x-forwarded-proto')
    return proto !== undefined && forwardedProtocol(proto) === 'https'
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
    const trust = this.env.trustProxy
    if (trust !== false && trust !== 0) {
      const fwd = this.raw.header('x-forwarded-for')
      if (fwd !== undefined) return forwardedClient(fwd, trust)
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
    // The value is what gets released, not the slot: a slot set twice holds
    // two things that each need disposing (§7.4).
    if (slot.dispose !== undefined) trackDisposal(this, slot.name, slot.dispose, value)
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
  /** §19.5 — `SafeHtml` only; see `htmlReply`. */
  html(body: SafeHtml, init?: ReplyInit): Reply<string> { return htmlReply(body, init) }
  bytes(body: Uint8Array, init?: ReplyInit): Reply<Uint8Array> { return bytesReply(body, init) }
  empty(status: 204 | 205 | 304 = 204): Reply<null> { return emptyReply(status) }
  /** §19.5 — checked against the app's `redirect` policy; see `redirectReply`. */
  redirect(to: string, init?: RedirectStatus | RedirectInit): Reply<null> { return redirectReply(to, init, this.env.redirect) }
  file(path: string, init?: FileReplyInit): Reply<null> { return fileReply(path, init) }
  stream(source: StreamSource, init?: ReplyInit): Reply<null> { return streamReply(source, init) }
  /** §13.5 — the channel is created here and nothing else; see `runtime/sse.ts`. */
  sse(init?: SseInit): SseChannelWithReply { return createSseChannel(init) }
  respond<T>(reply: Reply<T>): Reply<T> { return reply }

  get res(): ReplyBuilder {
    return (this.$stage ??= new ReplyStage(this))
  }
}

/**
 * Every name the framework owns on a context — §7.5.
 *
 * A decoration is compiled into the generated class as a getter, so a plugin
 * decorating `json` replaced `ctx.json()` for the whole application and every
 * route that called it failed at request time, while the app booted cleanly.
 * `decorate()` refuses these names instead, at registration.
 *
 * Kept as data beside the class it describes, and checked against both context
 * twins by `context.test.ts`, so a member added to the context without being
 * added here fails the suite rather than becoming shadowable.
 */
export const CONTEXT_MEMBERS: ReadonlySet<string> = new Set([
  // fields, in declaration order
  'raw', 'route', 'env', 'method', 'id', 'startTime', 'signal', 'aborted', 'timedOut', 'log',
  // lazy request data
  'path', 'params', 'query', 'headers', 'cookies', 'body', 'url', 'host', 'secure', 'ip', 'config',
  'deadline', 'timeLeft', 'negotiated',
  // slots and services
  'get', 'find', 'set', 'has', 'resolve', 'resolveAsync',
  // response builders
  'json', 'text', 'html', 'bytes', 'empty', 'redirect', 'file', 'stream', 'sse', 'respond', 'res',
  // the language's own
  'constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'then',
])

/**
 * The client address in an `X-Forwarded-For` value — §19.4.
 *
 * `trust` is `true` or a positive hop count. A hop count reads the entry that
 * many places from the right: each proxy *appends* the address it received the
 * request from, so the rightmost `n` entries were written by the `n` proxies
 * the application trusts, and the one before them is the client as the
 * outermost of those proxies saw it. Everything further left came from the
 * client and is whatever it chose to send — which is why `true`, reading the
 * leftmost entry, let a client rotate a fake address per request and receive a
 * fresh rate-limit budget each time. With fewer entries than hops, the leftmost
 * is the best address there is.
 *
 * Shared by both context twins, so they cannot disagree about which address a
 * request came from.
 */
export function forwardedClient(header: string, trust: true | number): string {
  if (trust === true) {
    const comma = header.indexOf(',')
    return (comma === -1 ? header : header.slice(0, comma)).trim()
  }
  const entries = header.split(',')
  const index = entries.length - trust
  return (entries[index < 0 ? 0 : index] ?? '').trim()
}

/**
 * The scheme in an `X-Forwarded-Proto` value: its first entry. The TLS
 * terminator is the outermost proxy and writes it, and a header some proxy
 * extended to `https, http` is still a request that arrived over TLS.
 */
export function forwardedProtocol(header: string): string {
  const comma = header.indexOf(',')
  return (comma === -1 ? header : header.slice(0, comma)).trim().toLowerCase()
}

/** Structural target so the *generated* context class can reuse ReplyStage. */
export interface StageTarget {
  $resStatus: number
  $resHeaders: Array<[string, HeaderValue, boolean]> | null
  $resCookies: SetCookie[] | null
}

/**
 * Staged response metadata, applied at egress (§13.6).
 *
 * Checked here, when it is staged, rather than when egress applies it: a
 * header or cookie that cannot be written then fails in the handler that
 * staged it, as an ordinary error. Checked only at egress, the error reply
 * inherited the same staged header and failed again, and the request ended
 * outside the error path altogether (`assertHeader`).
 */
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
    assertHeader(name, value)
    ;(this.#ctx.$resHeaders ??= []).push([name, value, false])
    return this
  }

  appendHeader(name: string, value: string): this {
    assertHeader(name, value)
    ;(this.#ctx.$resHeaders ??= []).push([name, value, true])
    return this
  }

  removeHeader(name: string): this {
    assertHeader(name, '')
    ;(this.#ctx.$resHeaders ??= []).push([name, '', false])
    return this
  }

  vary(name: string): this {
    return this.appendHeader('vary', name)
  }

  cookie(name: string, value: string, opts: Omit<SetCookie, 'name' | 'value'> = {}): this {
    const cookie = { name, value, ...opts }
    assertCookie(cookie)
    ;(this.#ctx.$resCookies ??= []).push(cookie)
    return this
  }

  clearCookie(name: string, opts: Omit<SetCookie, 'name' | 'value'> = {}): this {
    const cookie = { name, value: '', ...opts, maxAge: 0 }
    assertCookie(cookie)
    ;(this.#ctx.$resCookies ??= []).push(cookie)
    return this
  }
}

/**
 * `ctx.url`, built once — shared by both context twins.
 *
 * The base comes from the `Host` header, which the client writes, and a host
 * that is not a host — `Host: exa mple` passes Node's parser — made
 * `new URL` throw a `TypeError` that surfaced as a 500 from whichever handler
 * first read `ctx.url`. RFC 9112 §3.2 says a request with an invalid `Host` is
 * answered 400, and that is now what it gets.
 */
export function requestUrl(target: string, secure: boolean, host: string): URL {
  try {
    return new URL(target, `${secure ? 'https' : 'http'}://${host}`)
  } catch {
    throw new BadRequest('The request target or its Host header is not a valid URL.')
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
