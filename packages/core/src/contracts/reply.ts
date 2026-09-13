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
  | { readonly kind: 'file'; readonly path: string; readonly media?: string | undefined; readonly range?: ByteRange | undefined }
  | { readonly kind: 'sse'; readonly channel: SseChannel }

export type StreamSource =
  | AsyncIterable<Uint8Array | string>
  | (() => AsyncIterable<Uint8Array | string>)

export interface ByteRange {
  readonly start: number
  readonly end: number
}

export interface SseChannel extends AsyncIterable<Uint8Array> {
  send(event: SseEvent): void
  comment(text: string): void
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
