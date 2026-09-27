import type { Reply } from '../contracts/reply.ts'
import type { Representation } from '../contracts/negotiation.ts'
import { MutableReply, isReply, jsonReply, textReply, bytesReply, emptyReply } from './reply.ts'
import { isSseChannel } from './sse.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * Normalise a handler's return value into a Reply — rfcs/0001 §13.2.
 *
 * Handlers *return*; nothing is written until this point. A handler that
 * forgets to return is a compile error in typed code and a loud
 * ZEN_HANDLER_NO_RETURN at runtime — never a hung request, which is the
 * Express failure this design exists to eliminate.
 */
export function finalize(value: unknown, allowUndefined = false): Reply {
  if (isReply(value)) return value

  if (value === undefined || value === null) {
    if (allowUndefined || value === null) return emptyReply(204)
    throw new ZenError(
      Codes.HANDLER_NO_RETURN,
      'Handler returned undefined. Return a value, a Reply, or ctx.empty() to send 204.',
      { status: 500, expose: false },
    )
  }

  const t = typeof value
  if (t === 'string') return textReply(value as string)
  if (value instanceof Uint8Array) return bytesReply(value)
  if (isAsyncIterable(value)) {
    // A returned `ctx.sse()` channel is also an async iterable, and without this
    // it would go out as `application/octet-stream` with none of its headers.
    // Checked inside this branch so no other return value pays for it.
    if (isSseChannel(value)) return value.$reply
    return new MutableReply(200, { kind: 'stream', value: value as AsyncIterable<Uint8Array>, media: 'application/octet-stream' })
  }
  return jsonReply(value)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

/**
 * Serialise the body to bytes and set content headers.
 *
 * When a route declares a response schema the compiled serializer is attached
 * to the payload at boot (`body.serialize`), which is 2-5x faster than
 * JSON.stringify *and* structurally prevents emitting undeclared fields —
 * §13.3. Speed is the bonus; not leaking `passwordHash` is the point.
 */
/**
 * Bind the route's compiled serializer to a JSON reply — rfcs/0001 §13.3.
 *
 * Runs at the *end* of the pipeline, after `after` middleware, so the contract
 * covers whatever is actually sent rather than whatever the handler first
 * produced. Two consequences worth stating, because both are the point:
 *
 *   - a middleware that short-circuits with a 200 gets the 200 serializer, so
 *     cached and synthesised replies are filtered exactly like handler output;
 *   - an `after` hook that swaps the body value keeps the contract, because the
 *     serializer is attached to the reply, not baked into a string.
 *
 * A status with no declared schema is left alone. Nothing is serialized here —
 * only chosen; the bytes are produced at egress.
 */
export function attachSerializer(
  ctx: StatusCarrier,
  reply: Reply,
  table: ReadonlyMap<number, (value: unknown) => string>,
): Reply {
  const body = reply.body
  if (body.kind !== 'json' || body.serialize !== undefined) return reply
  const serialize = table.get(effectiveStatus(ctx, reply))
  if (serialize === undefined) return reply
  ;(reply as MutableReply).body = { kind: 'json', value: body.value, serialize, media: undefined }
  return reply
}

/**
 * The same job on a route that negotiated a representation — rfcs/0001 §13.4.
 *
 * A *separate* function rather than a branch inside `attachSerializer`, because
 * §9.4's zero-cost rule is about emitted text: the pipeline compiler emits this
 * call only on routes that declare the variant form, and every other route in
 * every application generates exactly the byte sequence it generated before this
 * feature existed. A shared function with an `if` would put the cost of
 * negotiation on routes that do not negotiate, which is the tax this whole
 * design refuses to levy.
 *
 * Two tables, consulted in order, and the order is the interesting part:
 *
 *   1. **The chosen representation**, when this status is one it covers. The
 *      writer and the `Content-Type` both come from the media type the client
 *      and the route agreed on. The writer may be absent — `serialization.mode:
 *      'off'`, or a schema that would not convert — and the `Content-Type`
 *      still stands, because the media type was negotiated and the body was
 *      produced for it. That asymmetry is the rule §13.4 states: the encoder
 *      seam is not optional, only the compiled JSON serializer is.
 *   2. **The plain table.** The status declared a single schema — an error
 *      envelope, a 201 with a Location and no body. It is *not* subject to
 *      negotiation and must not inherit the negotiated `Content-Type`: a 404
 *      problem document carrying `Content-Type: text/csv` is a worse answer than
 *      no negotiation at all, and it is exactly what one shared table would
 *      have produced. §12.1's "one envelope" says the same thing from the other
 *      side.
 *
 * A status in neither is left alone, exactly as it is on a plain route.
 */
export function attachNegotiated(
  ctx: StatusCarrier & NegotiationCarrier,
  reply: Reply,
  table: ReadonlyMap<number, (value: unknown) => string> | null,
): Reply {
  const body = reply.body
  if (body.kind !== 'json' || body.serialize !== undefined) return reply

  const status = effectiveStatus(ctx, reply)
  const chosen = ctx.$negotiated

  if (chosen !== null && chosen.statuses.has(status)) {
    ;(reply as MutableReply).body = {
      kind: 'json',
      value: body.value,
      serialize: chosen.writers.get(status),
      media: chosen.contentType,
    }
    return reply
  }

  if (table === null) return reply
  const serialize = table.get(status)
  if (serialize === undefined) return reply
  ;(reply as MutableReply).body = { kind: 'json', value: body.value, serialize, media: undefined }
  return reply
}

/** Structural, so the response engine does not have to know what a Context is. */
export interface StatusCarrier {
  readonly $resStatus: number
}

/** Ditto — see `runtime/negotiation.ts`. */
export interface NegotiationCarrier {
  readonly $negotiated: Representation | null
}

/**
 * The sentinel `payloadOf` returns for a reply that has no transformable
 * payload — rfcs/0001 §9.2, phase 8.
 *
 * A distinct value rather than `undefined` because `undefined` is a perfectly
 * good JSON payload (`{ a: undefined }` round-trips as `{}`), and conflating
 * "there is nothing here" with "the value is nothing" is how a transform hook
 * would silently blank a body.
 */
export const NO_PAYLOAD: unique symbol = Symbol('zen.noPayload')

/**
 * The value an `onSerialize` hook may transform, or `NO_PAYLOAD`.
 *
 * Streams, files, byte bodies and 204s are excluded: there is no structured
 * value to hand a hook, and inventing one (a Buffer? the stream itself?) would
 * make the phase mean something different per body kind. Compression and other
 * byte-level work belong in `onSend`, which sees the whole reply.
 */
export function payloadOf(reply: Reply): unknown {
  const body = reply.body
  if (body.kind === 'json') return body.value
  if (body.kind === 'text') return body.value
  return NO_PAYLOAD
}

/**
 * Put a transformed payload back, preserving everything else about the reply —
 * including the compiled serializer, which is the point.
 *
 * A hook cannot use this to escape the response contract: the serializer is
 * still bound afterwards (§13.3), so a field an `onSerialize` hook adds but the
 * schema does not declare is dropped at egress exactly like one the handler
 * invented. That is a security property, not an inconvenience.
 */
export function replacePayload(reply: Reply, value: unknown): Reply {
  const body = reply.body
  if (body.kind === 'json') {
    if (value === body.value) return reply
    // `media` is preserved for the same reason `serialize` is: a hook that
    // swaps the payload has not changed which representation was negotiated,
    // and dropping it would answer a CSV request with `application/json` bytes
    // the moment anybody registered an `onSerialize` hook (§13.4).
    ;(reply as MutableReply).body = { kind: 'json', value, serialize: body.serialize, media: body.media }
    return reply
  }
  if (body.kind === 'text') {
    if (value === body.value) return reply
    ;(reply as MutableReply).body = { kind: 'text', value: String(value), media: body.media }
    return reply
  }
  return reply
}

/**
 * The status this reply will actually carry.
 *
 * `ctx.res.status(201)` *stages* a status that egress applies later, so at the
 * end of the pipeline `reply.status` may still be the handler's default. Reading
 * only one of the two channels would pick the 200 contract for a response that
 * ships as 201 — the contract silently applying to the wrong status is worse
 * than no contract, because it looks like it worked.
 */
export function effectiveStatus(ctx: StatusCarrier, reply: Reply): number {
  return ctx.$resStatus !== 0 ? ctx.$resStatus : reply.status
}

export function encodeBody(reply: Reply): { bytes: Uint8Array | null; media: string | null } {
  const body = reply.body
  switch (body.kind) {
    case 'empty':
      return { bytes: null, media: null }
    case 'text':
      return { bytes: encoder.encode(body.value), media: body.media }
    case 'bytes':
      return { bytes: body.value, media: body.media }
    case 'json': {
      const json = body.serialize ? body.serialize(body.value) : safeStringify(body.value)
      // `media` is set only when §13.4 negotiated a representation; every other
      // JSON response in every application takes the constant, which is the
      // string it has always taken.
      return { bytes: encoder.encode(json), media: body.media ?? JSON_CONTENT_TYPE }
    }
    default:
      return { bytes: null, media: null }
  }
}

const encoder = new TextEncoder()

/** Interned once — §13.7's "common headers are pre-built" applied to the one
 *  content type the framework writes more than any other. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

function safeStringify(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) {
    throw new ZenError(Codes.SERIALIZATION, 'Response value is not JSON-serialisable', {
      status: 500,
      expose: false,
      meta: { valueType: typeof value },
    })
  }
  return json
}
