import type { HeaderBag, Reply } from '../contracts/reply.ts'
import type { PlainContext } from './context.ts'
import { MutableReply } from './reply.ts'
import { effectiveStatus, jsonMedia, jsonText } from './response-engine.ts'
import { serializeCookie } from './cookies.ts'
import { SmallHeaderBag } from './headers.ts'
import { utf8Length } from '../primitives/utf8.ts'

/**
 * The longest JSON or text body, in UTF-16 units, that egress hands to the
 * adapter as a string rather than encoding it (§13.7). Below it, counting the
 * bytes costs less than the encoding and the second write buffer it saves;
 * above it, encoding wins.
 */
export const INLINE_TEXT_LIMIT = 512

const encoder = new TextEncoder()

/**
 * Egress — rfcs/0001 §4.2 stage 9, §13.6.
 *
 * Ordering here is fixed and documented, because "why did compression run
 * before my ETag" is a real class of bug:
 *
 *     serialize → staged metadata → cookies → content headers → write
 *
 * Compression and ETag plug in as `onSend` hooks around this, so an ETag
 * identifies the resource rather than its encoding.
 */
export function prepareForWire(ctx: PlainContext, reply: Reply): Reply {
  const mutable = reply as MutableReply

  // ── staged metadata (ctx.res.*) ─────────────────────────────────────────
  // One rule for "which status is this", shared with the serializer so the two
  // cannot drift (§13.3).
  mutable.status = effectiveStatus(ctx, mutable)

  const staged = ctx.$resHeaders
  if (staged !== null) {
    // Checked when `ctx.res` staged them (`ReplyStage`), so not again here —
    // unless the reply brought its own bag: `isReply` is structural, so a
    // handler may return any object shaped like one.
    const bag: HeaderBag = mutable.headers
    const checked = bag instanceof SmallHeaderBag
    for (let i = 0; i < staged.length; i++) {
      const entry = staged[i]
      if (entry === undefined) continue
      const [name, value, append] = entry
      if (value === '' && !append) bag.delete(name.toLowerCase())
      else if (append) checked ? bag.appendChecked(name, value as string) : bag.append(name, value as string)
      else checked ? bag.setChecked(name, value) : bag.set(name, value)
    }
  }

  // ── cookies: staged as values so a later writer overrides by name rather
  //    than emitting two conflicting Set-Cookie headers ──────────────────────
  const cookies = ctx.$resCookies
  if (cookies !== null || reply.cookies.length > 0) {
    // Read once, and only when a cookie is being set: `ctx.secure` is a header
    // lookup, and a response without cookies should not pay for it (§19.2).
    const secure = ctx.secure
    if (cookies !== null) {
      const seen = new Set<string>()
      for (let i = cookies.length - 1; i >= 0; i--) {
        const cookie = cookies[i]
        if (cookie === undefined || seen.has(cookie.name)) continue
        seen.add(cookie.name)
        mutable.headers.append('set-cookie', serializeCookie(cookie, secure))
      }
    }
    for (const cookie of reply.cookies) {
      mutable.headers.append('set-cookie', serializeCookie(cookie, secure))
    }
  }

  // ── body encoding ───────────────────────────────────────────────────────
  // §13.7: the serializer builds one string, and a short one reaches the
  // adapter as that string. Node writes a string body in the same write as the
  // head; bytes go out as a second buffer beside it, which costs more than
  // counting a short body's bytes here does. A long body is encoded once,
  // because counting it would cost more than encoding it.
  const body = mutable.body
  if (body.kind === 'json' || body.kind === 'text') {
    const text = body.kind === 'json' ? jsonText(body) : body.value
    const media = body.kind === 'json' ? jsonMedia(body) : body.media
    if (!mutable.headers.has('content-type')) mutable.headers.set('content-type', media)
    if (text.length <= INLINE_TEXT_LIMIT) {
      mutable.headers.set('content-length', String(utf8Length(text)))
      if (body.kind === 'json') mutable.body = { kind: 'text', value: text, media }
    } else {
      const bytes = encoder.encode(text)
      mutable.headers.set('content-length', String(bytes.byteLength))
      mutable.body = { kind: 'bytes', value: bytes, media }
    }
  } else if (body.kind === 'bytes') {
    if (!mutable.headers.has('content-type')) mutable.headers.set('content-type', body.media)
    mutable.headers.set('content-length', String(body.value.byteLength))
  } else if (body.kind === 'empty') {
    mutable.headers.delete('content-type')
    if (mutable.status !== 304) mutable.headers.set('content-length', '0')
  } else if (body.kind === 'stream') {
    if (!mutable.headers.has('content-type')) mutable.headers.set('content-type', body.media)
  } else if (body.kind === 'sse') {
    // `ctx.sse()` sets this already; a reply assembled by hand around a channel
    // still has to announce itself as an event stream or `EventSource` refuses it.
    if (!mutable.headers.has('content-type')) mutable.headers.set('content-type', 'text/event-stream; charset=utf-8')
  }
  // `file` is deliberately absent: its Content-Type, Content-Length and
  // validators come from a `stat`, and only the adapter can make one (§14.1).

  // ── HEAD: identical headers, no body (RFC 9110 §9.3.2) ──────────────────
  // A file keeps its body kind so the adapter can still `stat` it and answer
  // with the real length; it writes no bytes for a HEAD either way.
  if (ctx.method === 'HEAD' && mutable.body.kind !== 'empty' && mutable.body.kind !== 'file') {
    discardBody(mutable.body)
    mutable.body = { kind: 'empty' }
  }

  return mutable
}

/** 304 and 204 must not carry a body or content headers. */
export function stripBodyIfNeeded(reply: Reply): Reply {
  if (reply.status === 204 || reply.status === 304) {
    const mutable = reply as MutableReply
    discardBody(mutable.body)
    mutable.body = { kind: 'empty' }
    mutable.headers.delete('content-length')
    mutable.headers.delete('content-type')
  }
  return reply
}

/**
 * A body that is dropped rather than written still has to be released.
 *
 * Only an SSE channel holds anything: a handler that produced one for a `HEAD`
 * may also have subscribed it to an event bus, and a channel nobody will ever
 * read must be closed so its `send` becomes a no-op instead of a queue that
 * grows until `maxBuffered` finally closes it.
 */
function discardBody(body: Reply['body']): void {
  if (body.kind === 'sse') body.channel.close()
}
