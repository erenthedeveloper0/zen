import type { RawRequest } from '../contracts/adapter.ts'
import type { RouteInfo } from '../contracts/context.ts'
import { CodeGen, type CodeUnit } from './codegen.ts'
import type { Deadline } from '../runtime/deadline.ts'
import {
  PlainContext, ReplyStage, UNSET, buildHeaders, slotEmpty, forwardedClient, forwardedChain, forwardedProtocol,
  requestUrl, type ContextEnv,
} from '../runtime/context.ts'
import { pathnameOf } from '../primitives/path.ts'
import { parseQuery } from '../runtime/query.ts'
import { parseCookies } from '../runtime/cookies.ts'
import {
  jsonReply, textReply, htmlReply, bytesReply, emptyReply, redirectReply, fileReply, streamReply,
} from '../runtime/reply.ts'
import { createSseChannel } from '../runtime/sse.ts'
import { trackDisposal, trackIntrinsic } from '../primitives/disposal.ts'

export interface Decoration {
  readonly name: string
  /** Slot-backed decorations compile to a constant array index — the fast path. */
  readonly slotIndex: number | null
  readonly accessor: ((ctx: unknown) => unknown) | null
  readonly source: string
}

export interface ContextClass {
  new (
    raw: RawRequest,
    route: RouteInfo | null,
    params: Record<string, unknown>,
    env: ContextEnv,
    signal: AbortSignal,
    deadline?: Deadline | null,
  ): PlainContext
}

export interface CompileContextOptions {
  readonly decorations: readonly Decoration[]
  readonly slotCount: number
  readonly codegen: CodeGen
}

/**
 * The Context Compiler — rfcs/0001 §7.6.
 *
 * Emits one class per application, with every field initialised in the
 * constructor in a fixed order and every plugin decoration inlined to a
 * constant slot index. The result is that V8 sees exactly one hidden class for
 * every context the app will ever create, and `ctx.user` is an array load
 * rather than a map lookup or a prototype walk.
 *
 * This is the mechanical basis for I2 ("no framework object is mutated by user
 * code"). The monomorphism test in §20.7 asserts it holds, so a regression that
 * reintroduces a dynamic property assignment fails CI rather than quietly
 * costing 15% throughput.
 */
export function compileContext(opts: CompileContextOptions): ContextClass {
  const { decorations, slotCount, codegen } = opts

  const unit: CodeUnit = {
    name: 'context',
    source: generateSource(decorations, slotCount, codegen.readable),
    externals: {
      UNSET,
      pathnameOf,
      parseQuery,
      parseCookies,
      buildHeaders,
      slotEmpty,
      forwardedClient,
      forwardedChain,
      forwardedProtocol,
      requestUrl,
      ReplyStage,
      jsonReply,
      textReply,
      htmlReply,
      bytesReply,
      emptyReply,
      redirectReply,
      fileReply,
      streamReply,
      createSseChannel,
      trackDisposal,
      trackIntrinsic,
      accessors: decorations.map((d) => d.accessor),
    },
  }

  return codegen.materialise<ContextClass>(unit, () =>
    fallbackContext(decorations, slotCount),
  )
}

function slotArrayLiteral(count: number): string {
  // A packed array literal keeps element kind PACKED_ELEMENTS from birth;
  // `new Array(n)` starts HOLEY and never recovers.
  if (count === 0) return '[]'
  if (count <= 32) return `[${new Array(count).fill('undefined').join(', ')}]`
  return `new Array(${count}).fill(undefined)`
}

function generateSource(decorations: readonly Decoration[], slotCount: number, readable: boolean): string {
  const decorationGetters = decorations
    .map((d, i) => {
      if (d.slotIndex !== null) {
        return `  get ${d.name}() { return this.$s[${d.slotIndex}] }` +
          (readable ? `   // ← ${d.source}` : '')
      }
      return `  get ${d.name}() { return accessors[${i}](this) }` +
        (readable ? `   // ← ${d.source} (accessor)` : '')
    })
    .join('\n')

  return `
return class Ctx {
  constructor(raw, route, params, env, signal, deadline) {
    // Fixed field order → one hidden class, no dictionary mode, no transitions.
    this.raw = raw
    this.route = route
    this.env = env
    this.method = raw.method
    this.$params = params
    this.$path = UNSET
    this.$query = UNSET
    this.$headers = UNSET
    this.$cookies = UNSET
    this.$url = UNSET
    this.$body = undefined
    this.$s = ${slotArrayLiteral(slotCount)}
    this.$disposers = null
    this.$stage = null
    this.$resStatus = 0
    this.$resHeaders = null
    this.$resCookies = null
    // Every context declares the field even though most requests carry no
    // deadline: the alternative is two hidden classes, and a polymorphic
    // context is a far larger tax than one store of null (§7.6, I2).
    this.$deadline = deadline === undefined ? null : deadline
    // §13.4 — same argument, same position as in PlainContext. The field order
    // here *is* the hidden class, and the monomorphism fixture compares it
    // against the twin's declaration order, so a field added to one and not the
    // other fails CI rather than quietly costing throughput.
    this.$negotiated = null
    this.id = ''
    this.startTime = 0
    this.signal = signal
    this.aborted = false
    this.timedOut = false
    this.log = env.log
  }

  get path() { const v = this.$path; return v !== UNSET ? v : (this.$path = pathnameOf(this.raw.url)) }
  get params() { return this.$params }
  get query() { const v = this.$query; return v !== UNSET ? v : (this.$query = parseQuery(this.raw.url, this.env.maxQueryParams)) }
  get headers() { const v = this.$headers; return v !== UNSET ? v : (this.$headers = buildHeaders(this.raw)) }
  get cookies() { const v = this.$cookies; return v !== UNSET ? v : (this.$cookies = parseCookies(this.raw.header('cookie'))) }
  get body() { return this.$body }
  get url() { const v = this.$url; return v !== UNSET ? v : (this.$url = requestUrl(this.raw.url, this.secure, this.host)) }
  get host() { const h = this.raw.header('host'); return h !== undefined ? h : 'localhost' }
  get secure() {
    const trust = this.env.trustProxy
    if (trust === false || trust === 0) return false
    const proto = this.raw.header('x-forwarded-proto')
    return proto !== undefined && forwardedProtocol(proto) === 'https'
  }
  get protocol() { return this.secure ? 'https' : 'http' }
  get config() { return this.env.config }
  get deadline() { const d = this.$deadline; return d !== null ? d.at : null }
  get timeLeft() { const d = this.$deadline; return d !== null ? d.at - performance.now() : Infinity }
  get negotiated() { const n = this.$negotiated; return n !== null ? n.media : null }
  get ip() {
    const trust = this.env.trustProxy
    if (trust !== false && trust !== 0) {
      const fwd = this.raw.header('x-forwarded-for')
      if (fwd !== undefined) return forwardedClient(fwd, trust)
    }
    const a = this.raw.remote.address
    return a !== undefined ? a : ''
  }
  get ips() { return forwardedChain(this.raw, this.env.trustProxy) }

  get(slot) {
    const v = this.$s[slot.index]
    if (v === undefined) {
      if (slot.defaultValue !== undefined) { const d = slot.defaultValue(); this.$s[slot.index] = d; return d }
      if (!slot.optional) throw slotEmpty(slot, this)
    }
    return v
  }
  find(slot) { return this.$s[slot.index] }
  set(slot, value) {
    this.$s[slot.index] = value
    if (slot.dispose !== undefined) trackDisposal(this, slot.name, slot.dispose, value)
    else if (typeof value === 'object' && value !== null) trackIntrinsic(this, slot.name, value)
  }
  has(slot) { return this.$s[slot.index] !== undefined }

  resolve(token) { return this.env.container.resolve(token, this) }
  resolveAsync(token) { return this.env.container.resolveAsync(token, this) }

  json(body, init) { return jsonReply(body, init) }
  text(body, init) { return textReply(body, init) }
  html(body, init) { return htmlReply(body, init) }
  bytes(body, init) { return bytesReply(body, init) }
  empty(status) { return emptyReply(status === undefined ? 204 : status) }
  redirect(to, init) { return redirectReply(to, init, this.env.redirect) }
  file(path, init) { return fileReply(path, init) }
  stream(source, init) { return streamReply(source, init) }
  sse(init) { return createSseChannel(init) }
  respond(reply) { return reply }

  get res() { return this.$stage !== null ? this.$stage : (this.$stage = new ReplyStage(this)) }

${decorationGetters}
}
`.trim()
}

/**
 * The `caps.eval === false` path: `PlainContext` with decorations attached as
 * prototype getters. Semantically identical, measurably slower, and covered by
 * the same conformance suite.
 */
function fallbackContext(decorations: readonly Decoration[], slotCount: number): ContextClass {
  class InterpretedContext extends PlainContext {
    constructor(
      raw: RawRequest,
      route: RouteInfo | null,
      params: Record<string, unknown>,
      env: ContextEnv,
      signal: AbortSignal,
      deadline: Deadline | null = null,
    ) {
      super(raw, route, params, env, slotCount, signal, deadline)
    }
  }

  for (const d of decorations) {
    const getter = d.slotIndex !== null
      ? function (this: PlainContext) { return this.$s[d.slotIndex as number] }
      : function (this: PlainContext) { return d.accessor!(this) }

    Object.defineProperty(InterpretedContext.prototype, d.name, {
      get: getter,
      enumerable: false,
      configurable: false,
    })
  }

  return InterpretedContext as unknown as ContextClass
}
