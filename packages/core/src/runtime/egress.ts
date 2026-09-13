import type { Reply } from '../contracts/reply.ts'
import type { PlainContext } from './context.ts'
import { MutableReply } from './reply.ts'
import { effectiveStatus, encodeBody } from './response-engine.ts'
import { serializeCookie } from './cookies.ts'

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
    for (let i = 0; i < staged.length; i++) {
      const entry = staged[i]
      if (entry === undefined) continue
      const [name, value, append] = entry
      if (value === '' && !append) mutable.headers.delete(name.toLowerCase())
      else if (append) mutable.headers.append(name, value as string)
      else mutable.headers.set(name, value)
    }
  }

  // ── cookies: staged as values so a later writer overrides by name rather
  //    than emitting two conflicting Set-Cookie headers ──────────────────────
  const cookies = ctx.$resCookies
  if (cookies !== null) {
    const seen = new Set<string>()
    for (let i = cookies.length - 1; i >= 0; i--) {
      const cookie = cookies[i]
      if (cookie === undefined || seen.has(cookie.name)) continue
      seen.add(cookie.name)
      mutable.headers.append('set-cookie', serializeCookie(cookie))
    }
  }
  for (const cookie of reply.cookies) {
    mutable.headers.append('set-cookie', serializeCookie(cookie))
  }

  // ── body encoding ───────────────────────────────────────────────────────
  const kind = mutable.body.kind
  if (kind === 'json' || kind === 'text') {
    const { bytes, media } = encodeBody(mutable)
    if (bytes !== null) {
      if (!mutable.headers.has('content-type') && media !== null) {
        mutable.headers.set('content-type', media)
      }
      mutable.headers.set('content-length', String(bytes.byteLength))
      mutable.body = { kind: 'bytes', value: bytes, media: media ?? 'application/octet-stream' }
    }
  } else if (kind === 'bytes') {
    if (!mutable.headers.has('content-type')) mutable.headers.set('content-type', mutable.body.media)
    mutable.headers.set('content-length', String(mutable.body.value.byteLength))
  } else if (kind === 'empty') {
    mutable.headers.delete('content-type')
    if (mutable.status !== 304) mutable.headers.set('content-length', '0')
  } else if (kind === 'stream') {
    if (!mutable.headers.has('content-type')) mutable.headers.set('content-type', mutable.body.media)
  }

  // ── HEAD: identical headers, no body (RFC 9110 §9.3.2) ──────────────────
  if (ctx.method === 'HEAD' && mutable.body.kind !== 'empty') {
    mutable.body = { kind: 'empty' }
  }

  return mutable
}

/** 304 and 204 must not carry a body or content headers. */
export function stripBodyIfNeeded(reply: Reply): Reply {
  if (reply.status === 204 || reply.status === 304) {
    const mutable = reply as MutableReply
    mutable.body = { kind: 'empty' }
    mutable.headers.delete('content-length')
    mutable.headers.delete('content-type')
  }
  return reply
}
