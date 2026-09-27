import type { Reply, SseChannel, SseEvent, SseInit } from '../contracts/reply.ts'
import { MutableReply } from './reply.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * Server-sent events — rfcs/0001 §13.5, §30.2.
 *
 * `ctx.sse()` was declared on the context contract from the first draft and
 * implemented by neither context class, so it type-checked and then threw
 * `TypeError: ctx.sse is not a function` on the first request (TASKS #7). This
 * is the implementation, and its shape follows from one decision: **the channel
 * is an async iterable of encoded frames**, and that is the whole interface
 * between it and an adapter.
 *
 * Three things fall out of that without any extra machinery:
 *
 *   - **Backpressure.** An adapter pulls the next frame when the socket can take
 *     it (`Readable.from` on Node, a `ReadableStream` pull on the edge), so a
 *     slow client slows the pull, not the process. What piles up in between is
 *     bounded by `maxBuffered` — see {@link DEFAULT_MAX_BUFFERED}.
 *   - **Disconnects.** A client that leaves makes the adapter stop iterating,
 *     which calls `return()` on the iterator, which closes the channel. Nothing
 *     has to poll a socket, and `send` after that point is a no-op rather than
 *     a crash in whatever event bus was holding the reference.
 *   - **Portability.** Nothing here touches a stream class, a timer handle type
 *     or a platform API, so the same channel runs on every adapter core does.
 *
 * Frames follow the WHATWG event-stream grammar: `event:`, `id:`, `retry:` and
 * one `data:` line per line of payload, then a blank line. A payload that is not
 * a string is JSON-encoded, which never produces a raw line break — so a JSON
 * event is always exactly one `data:` line, whatever it contains.
 */

/** Marks a channel so `finalize` can turn a returned channel into its reply. */
export const SSE_CHANNEL: unique symbol = Symbol.for('zen.sse.channel')

/** 15 s — under every common proxy idle timeout (nginx and most load balancers default to 60 s). */
export const DEFAULT_KEEP_ALIVE = 15_000

/**
 * 1 MiB of unsent frames per connection.
 *
 * Generous for any client that is actually reading — a browser drains a local
 * stream in microseconds — and small enough that ten thousand clients who stop
 * reading cost 10 GiB rather than everything. Past it the channel closes: the
 * client reconnects (with `Last-Event-ID`, if the application sends ids) and
 * resumes from a known point, which is a better outcome than a server that
 * dies holding every event it could not deliver.
 */
export const DEFAULT_MAX_BUFFERED = 1024 * 1024

const encoder = new TextEncoder()
/** The first frame when nothing else is queued: flushes the status line and headers. */
const OPEN = encoder.encode(':\n\n')
const HEARTBEAT = encoder.encode(': keep-alive\n\n')
const DONE: IteratorReturnResult<undefined> = Object.freeze({ done: true as const, value: undefined })

export type SseChannelWithReply = SseChannel & { readonly $reply: Reply<SseEvent> }

/**
 * Build a channel and the reply that carries it.
 *
 * Called by `ctx.sse()` in both context classes, which is why it lives here
 * rather than on either of them: the generated class and `PlainContext` must
 * not be able to disagree about what a stream is.
 */
export function createSseChannel(init: SseInit = {}): SseChannelWithReply {
  const keepAlive = init.keepAlive ?? DEFAULT_KEEP_ALIVE
  const maxBuffered = init.maxBuffered ?? DEFAULT_MAX_BUFFERED
  assertNonNegativeInteger('keepAlive', keepAlive)
  assertNonNegativeInteger('maxBuffered', maxBuffered)
  if (init.retry !== undefined) assertNonNegativeInteger('retry', init.retry)

  const queue: Uint8Array[] = []
  let buffered = 0
  let closing = false
  let finished = false
  let started = false
  let iterated = false
  let waiting: ((result: IteratorResult<Uint8Array>) => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  /** Hand a frame to a waiting reader, or queue it within the budget. */
  const push = (frame: Uint8Array): void => {
    if (closing) return
    if (waiting !== null) {
      const resolve = waiting
      waiting = null
      resolve({ done: false, value: frame })
      return
    }
    if (buffered + frame.byteLength > maxBuffered) {
      // A client this far behind is not going to catch up. Dropping it lets it
      // reconnect from a known point; keeping it lets it hold memory forever.
      finish()
      return
    }
    queue.push(frame)
    buffered += frame.byteLength
  }

  /** No more frames, and nobody left to hand the queue to. */
  const finish = (): void => {
    closing = true
    finished = true
    queue.length = 0
    buffered = 0
    stopHeartbeat()
    if (waiting !== null) {
      const resolve = waiting
      waiting = null
      resolve(DONE)
    }
  }

  const stopHeartbeat = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /**
   * Heartbeats start with the first pull, not at construction. A channel that
   * is never consumed — the handler threw after creating it, the request was
   * a `HEAD` — therefore never owns a timer that nothing would clear.
   */
  const startHeartbeat = (): void => {
    if (keepAlive === 0 || timer !== null) return
    timer = setInterval(() => { push(HEARTBEAT) }, keepAlive)
    // A stream is not a reason for the process to stay up; the server is.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const iterator: AsyncIterator<Uint8Array> & AsyncIterable<Uint8Array> = {
    next(): Promise<IteratorResult<Uint8Array>> {
      if (!started) {
        started = true
        startHeartbeat()
        // Nothing queued means nothing would be written — and nothing written
        // means the status line and headers sit in the adapter's buffer while
        // `EventSource` waits for `onopen`. One comment frame sends them.
        if (queue.length === 0 && !finished) return Promise.resolve({ done: false, value: OPEN })
      }
      const frame = queue.shift()
      if (frame !== undefined) {
        buffered -= frame.byteLength
        return Promise.resolve({ done: false, value: frame })
      }
      if (closing) {
        finished = true
        stopHeartbeat()
        return Promise.resolve(DONE)
      }
      return new Promise((resolve) => { waiting = resolve })
    },
    /** The consumer stopped — on Node, the client disconnected mid-stream. */
    return(): Promise<IteratorResult<Uint8Array>> {
      finish()
      return Promise.resolve(DONE)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }

  const channel = {
    [SSE_CHANNEL]: true as const,

    send(event: SseEvent): void {
      if (closing) return
      push(encoder.encode(frameOf(event)))
    },

    comment(text: string): void {
      if (closing) return
      let frame = ''
      for (const line of splitLines(text)) frame += `: ${line}\n`
      push(encoder.encode(`${frame}\n`))
    },

    /**
     * Graceful: frames already sent are still delivered, then the stream ends.
     * `send(x); close()` in a handler therefore means "deliver x, then stop" —
     * which is what anybody writing those two lines expects.
     */
    close(): void {
      if (closing) return
      closing = true
      if (queue.length === 0) finish()
    },

    get closed(): boolean {
      return closing
    },

    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (iterated) {
        throw new ZenError(
          Codes.INTERNAL,
          'An SSE channel can be consumed once. It was handed to a second reader.',
          { status: 500, expose: false },
        )
      }
      iterated = true
      return iterator
    },

    $reply: undefined as unknown as Reply<SseEvent>,
  }

  const reply = new MutableReply<SseEvent>(200, { kind: 'sse', channel })
  reply.headers.set('content-type', 'text/event-stream; charset=utf-8')
  // `no-transform` is the half that matters behind a CDN or a compressing
  // proxy: a transformed event stream is a buffered one, and a buffered event
  // stream is a request that looks hung.
  reply.headers.set('cache-control', 'no-cache, no-transform')
  // nginx buffers proxied responses unless told not to. Everyone discovers this
  // the hard way; the header costs 21 bytes.
  reply.headers.set('x-accel-buffering', 'no')
  channel.$reply = reply

  if (init.retry !== undefined) push(encoder.encode(`retry: ${init.retry}\n\n`))

  return channel as SseChannelWithReply
}

/** True for a channel returned from `ctx.sse()`. */
export function isSseChannel(value: unknown): value is SseChannelWithReply {
  return typeof value === 'object' && value !== null && (value as { [SSE_CHANNEL]?: unknown })[SSE_CHANNEL] === true
}

/**
 * One event, framed. Exported for the adapters and the tests, which assert the
 * wire format rather than trusting it.
 */
export function frameOf(event: SseEvent): string {
  let frame = ''
  if (event.event !== undefined) {
    assertField('event', event.event, false)
    frame += `event: ${event.event}\n`
  }
  if (event.id !== undefined) {
    assertField('id', event.id, true)
    frame += `id: ${event.id}\n`
  }
  if (event.retry !== undefined) {
    assertNonNegativeInteger('retry', event.retry)
    frame += `retry: ${event.retry}\n`
  }
  const data = typeof event.data === 'string' ? event.data : (JSON.stringify(event.data) ?? '')
  for (const line of splitLines(data)) frame += `data: ${line}\n`
  return `${frame}\n`
}

/** The event-stream grammar ends a line at CRLF, CR or LF; so does this. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * A line break inside `event` or `id` ends the field early, and whatever
 * follows becomes a field of its own — `id: 1\ndata: forged` is two lines on
 * the wire. Refused rather than stripped, for the reason `SmallHeaderBag`
 * refuses CR/LF in a header: quietly repairing the value hides the bug that
 * produced it (§19.5).
 */
function assertField(name: 'event' | 'id', value: string, forbidNul: boolean): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 10 || c === 13 || (forbidNul && c === 0)) {
      throw new ZenError(
        Codes.HEADER_INVALID,
        `SSE "${name}" contains an illegal character (${c === 0 ? 'NUL' : c === 10 ? 'LF' : 'CR'}) at index ${i}.`,
        { status: 500, expose: false },
      )
    }
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ZenError(
      Codes.INTERNAL,
      `SSE "${name}" must be a non-negative whole number of ${name === 'maxBuffered' ? 'bytes' : 'milliseconds'}; got ${String(value)}.`,
      { status: 500, expose: false },
    )
  }
}
