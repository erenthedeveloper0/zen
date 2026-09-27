import type { HeaderValue, LowercaseName, StatusCode } from './http.ts'

/**
 * The Reply IR — rfcs/0001 §13.2.
 *
 * A Reply is a *value describing a response*, not a sink. Nothing is written
 * until the Response Engine runs at lifecycle stage 9. This is what makes
 * double-send structurally impossible and lets `around` middleware inspect and
 * replace a downstream response with no monkey-patching.
 *
 * The body is a tagged union rather than a WHATWG `Response` so that `file` and
 * `stream` survive to the adapter un-materialised: the Node adapter can use
 * `fs.createReadStream` + `pipeline`, while an edge adapter turns the same IR
 * into a `Response` with zero loss.
 */
export type BodyPayload =
  | { readonly kind: 'empty' }
  | { readonly kind: 'text'; readonly value: string; readonly media: string }
  /**
   * `media` carries the negotiated `Content-Type` when §13.4 chose one, and is
   * absent otherwise — in which case egress writes `application/json;
   * charset=utf-8`, exactly as it always has.
   *
   * Absent rather than always-present on purpose. `jsonReply` runs on every JSON
   * response in every application, and the overwhelming majority of them serve
   * one representation; making them all store a field for a dimension they do
   * not have would be the zero-cost rule (§9.4) paid in the other direction.
   * The two writers that *do* set it — `attachSerializer` and its negotiated
   * sibling — both emit the same four fields, so the shape a serializer-bound
   * body has is still exactly one shape.
   */
  | {
      readonly kind: 'json'
      readonly value: unknown
      readonly serialize?: ((v: unknown) => string) | undefined
      readonly media?: string | undefined
    }
  | { readonly kind: 'bytes'; readonly value: Uint8Array; readonly media: string }
  | { readonly kind: 'stream'; readonly value: StreamSource; readonly media: string; readonly length?: number | undefined }
  /**
   * A file on disk, left un-materialised so the adapter can stream it — and
   * `stat` it *before* the status line goes out, which is what lets a missing
   * file be an ordinary 404 rather than a dropped connection (§13.5).
   *
   * `root` confines `path`: the adapter resolves the path against it and
   * answers 404 for anything that escapes, including through `..` segments a
   * wildcard param decoded. Without a root the path is used as given, which is
   * right for a path the application chose and wrong for one a client chose.
   */
  | {
      readonly kind: 'file'
      readonly path: string
      readonly media?: string | undefined
      readonly range?: ByteRange | undefined
      readonly root?: string | undefined
    }
  | { readonly kind: 'sse'; readonly channel: SseChannel }

export type StreamSource =
  | AsyncIterable<Uint8Array | string>
  | (() => AsyncIterable<Uint8Array | string>)

export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * A server-sent event stream — rfcs/0001 §13.5, §30.2.
 *
 * The handler returns the channel and keeps a reference to it; everything sent
 * afterwards is framed and written to the connection. The adapter consumes it
 * as an async iterable of encoded frames, which is also what makes backpressure
 * and disconnect detection work without a callback: a client that leaves stops
 * the iteration, and a stopped iteration closes the channel.
 */
export interface SseChannel extends AsyncIterable<Uint8Array> {
  /**
   * Queue one event. `data` that is not a string is JSON-encoded. Silently
   * ignored once the channel is closed, because "the client left" is not an
   * error in the code that was talking to it.
   *
   * Throws `ZEN_HEADER_INVALID` when `event` or `id` contains a line break (or
   * `id` a NUL): either would end the field early and let the rest of the value
   * forge a second event.
   */
  send(event: SseEvent): void
  /** A comment line — ignored by `EventSource`, useful as a manual heartbeat. */
  comment(text: string): void
  /** End the stream. Idempotent. */
  close(): void
  readonly closed: boolean
}

export interface SseEvent {
  readonly data: unknown
  readonly event?: string | undefined
  readonly id?: string | undefined
  readonly retry?: number | undefined
}

export interface SetCookie {
  readonly name: string
  readonly value: string
  readonly path?: string | undefined
  readonly domain?: string | undefined
  readonly expires?: Date | undefined
  readonly maxAge?: number | undefined
  readonly httpOnly?: boolean | undefined
  readonly secure?: boolean | undefined
  readonly sameSite?: 'strict' | 'lax' | 'none' | undefined
  readonly partitioned?: boolean | undefined
}

/** Insertion-ordered, multi-value aware, small-array backed (§13.6). */
export interface HeaderBag {
  get(name: LowercaseName): string | undefined
  getAll(name: LowercaseName): readonly string[]
  set(name: string, value: HeaderValue): void
  append(name: string, value: string): void
  has(name: LowercaseName): boolean
  delete(name: LowercaseName): void
  entries(): Array<[string, string]>
  readonly size: number
}

export interface Reply<T = unknown> {
  readonly status: StatusCode
  readonly headers: HeaderBag
  readonly cookies: readonly SetCookie[]
  readonly body: BodyPayload
  /** Phantom carrier for end-to-end client typing. Never present at runtime. */
  readonly $type?: T
}

export interface ReplyInit {
  readonly status?: StatusCode | undefined
  readonly headers?: Readonly<Record<string, HeaderValue>> | undefined
  readonly media?: string | undefined
}

/** `ctx.file(path, init)` — §13.5. */
export interface FileReplyInit extends ReplyInit {
  /**
   * The directory `path` must stay inside. Set it whenever any part of `path`
   * came from the request: `ctx.file(ctx.params.path, { root: PUBLIC_DIR })`.
   * A path that resolves outside it is answered 404 — not 403, which would
   * confirm the file exists.
   */
  readonly root?: string | undefined
}

/** `ctx.sse(init)` — §13.5, §30.2. */
export interface SseInit {
  /**
   * Reconnection delay sent to the client as the stream's first frame, in
   * milliseconds. `EventSource` waits this long before reconnecting after the
   * connection drops. Omitted when unset, so the browser's default applies.
   */
  readonly retry?: number | undefined
  /**
   * Heartbeat interval in milliseconds, or `0` to disable. A comment frame
   * keeps proxies with idle timeouts (nginx 60 s, most load balancers 60 s)
   * from cutting a quiet stream. Defaults to 15 s.
   */
  readonly keepAlive?: number | undefined
  /**
   * The most unsent bytes the channel will hold for a slow client before it
   * gives up and closes the stream. Defaults to 1 MiB. A producer that outpaces
   * its reader otherwise grows memory without bound — one connection at a time,
   * and the attacker chooses how slowly to read.
   */
  readonly maxBuffered?: number | undefined
}
