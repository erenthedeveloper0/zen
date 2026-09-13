import type { Capabilities } from './capabilities.ts'
import type { LowercaseName, RemoteInfo } from './http.ts'
import type { Reply } from './reply.ts'

/**
 * The runtime ⇄ adapter boundary — rfcs/0001 §3.3 (B2) and §14.
 *
 * `@zenjs/core` never sees `http.IncomingMessage`, `Request`, or a Lambda event.
 * It sees `RawRequest`: a narrow, *lazy* accessor interface. This is what lets
 * the Node adapter skip constructing a WHATWG `Request` (~3-6µs and several
 * allocations) on the platform that carries most production traffic, while an
 * edge adapter backs the same interface with a `Request` at zero cost.
 */
export interface BodySource {
  readonly kind: 'none' | 'buffer' | 'stream'
  readonly length: number | undefined
  /** Reads up to `limit` bytes; rejects with ZEN_BODY_TOO_LARGE past it. */
  read(limit: number, signal?: AbortSignal): Promise<Uint8Array>
  stream(): AsyncIterable<Uint8Array>
}

export interface RawRequest {
  readonly method: string
  /** Raw request-target, undecoded, including any query string. */
  readonly url: string
  header(name: LowercaseName): string | undefined
  headerNames(): Iterable<string>
  readonly body: BodySource
  readonly remote: RemoteInfo
  /** Adapter escape hatch. Typed per adapter by declaration merging. */
  readonly native: unknown
}

export interface Connection {
  readonly signal: AbortSignal
  send(reply: Reply): Promise<void> | void
  readonly native: unknown
}

export type Dispatch = (raw: RawRequest, conn: Connection) => Promise<void> | void

export interface ListenOptions {
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface ServerHandle {
  readonly address: { readonly host: string; readonly port: number } | null
  readonly url: string
  close(): Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  readonly caps: Capabilities
  listen(dispatch: Dispatch, opts: ListenOptions): Promise<ServerHandle>
}
