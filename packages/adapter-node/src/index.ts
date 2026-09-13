import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  BodySource, Capabilities, Connection, Dispatch, ListenOptions, RawRequest,
  RemoteInfo, Reply, RuntimeAdapter, ServerHandle, LowercaseName,
} from '@zenjs/core'
import { PayloadTooLarge } from '@zenjs/core'

export interface NodeAdapterOptions {
  /** Slowloris defence — §19.2. */
  readonly headersTimeout?: number | undefined
  readonly requestTimeout?: number | undefined
  readonly keepAliveTimeout?: number | undefined
  readonly maxHeadersCount?: number | undefined
  readonly drainDelay?: number | undefined
  readonly shutdownTimeout?: number | undefined
}

export const NODE_CAPABILITIES: Capabilities = {
  eval: true,
  webStreams: true,
  nodeStreams: true,
  fs: true,
  compression: 'library',
  http2: false,
  websocket: 'library',
  timers: 'full',
  asyncLocalStorage: true,
  cpuTimeLimited: false,
}

/**
 * The Node fast path — rfcs/0001 §14.3.
 *
 * `NodeRawRequest` wraps `IncomingMessage` directly rather than constructing a
 * WHATWG `Request`. That construction costs ~3-6µs and several allocations (URL
 * parsing, `Headers` with lowercasing and validation, a `ReadableStream` body
 * wrapper) on the platform carrying most production traffic.
 *
 * Because Zen's abstraction is `RawRequest` — a lazy accessor interface — and
 * not `Request`, none of that is paid here, while an edge adapter backs the same
 * interface with a `Request` at genuinely zero cost.
 */
class NodeRawRequest implements RawRequest {
  readonly native: IncomingMessage
  #body: BodySource | null = null

  constructor(message: IncomingMessage) {
    this.native = message
  }

  get method(): string {
    return this.native.method ?? 'GET'
  }

  get url(): string {
    return this.native.url ?? '/'
  }

  /** Node has already lowercased header names; no per-access work is needed. */
  header(name: LowercaseName): string | undefined {
    const value = this.native.headers[name as string]
    return Array.isArray(value) ? value.join(', ') : value
  }

  headerNames(): Iterable<string> {
    return Object.keys(this.native.headers)
  }

  /** Not constructed until a route actually declares a body. */
  get body(): BodySource {
    return (this.#body ??= new NodeBodySource(this.native))
  }

  get remote(): RemoteInfo {
    const socket = this.native.socket
    return {
      address: socket.remoteAddress,
      port: socket.remotePort,
      family: socket.remoteFamily === 'IPv6' ? 'IPv6' : 'IPv4',
    }
  }
}

class NodeBodySource implements BodySource {
  #message: IncomingMessage

  constructor(message: IncomingMessage) {
    this.#message = message
  }

  get kind(): 'none' | 'stream' {
    const method = this.#message.method
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      if (this.#message.headers['content-length'] === undefined &&
          this.#message.headers['transfer-encoding'] === undefined) {
        return 'none'
      }
    }
    return 'stream'
  }

  get length(): number | undefined {
    const raw = this.#message.headers['content-length']
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  /**
   * §19.3 — the limit is enforced *during* the read. A 5GB body is aborted at
   * byte limit+1; it is never buffered and then rejected.
   */
  async read(limit: number, signal?: AbortSignal): Promise<Uint8Array> {
    const chunks: Buffer[] = []
    let total = 0

    for await (const chunk of this.#message) {
      if (signal?.aborted) {
        this.#message.destroy()
        throw new Error('aborted')
      }
      const buffer = chunk as Buffer
      total += buffer.length
      if (total > limit) {
        this.#message.destroy()
        throw new PayloadTooLarge(`Body exceeds the ${limit} byte limit`)
      }
      chunks.push(buffer)
    }

    return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
  }

  async *stream(): AsyncIterable<Uint8Array> {
    for await (const chunk of this.#message) yield chunk as Buffer
  }
}

class NodeConnection implements Connection {
  readonly signal: AbortSignal
  readonly native: ServerResponse
  #controller: AbortController

  constructor(response: ServerResponse, request: IncomingMessage) {
    this.native = response
    this.#controller = new AbortController()
    this.signal = this.#controller.signal
    // §4.4 — a real AbortSignal wired to client disconnect closes the "client
    // hung up but we kept querying Postgres for 30s" hole.
    request.on('aborted', () => this.#controller.abort())
    request.on('close', () => {
      if (!response.writableEnded) this.#controller.abort()
    })
  }

  async send(reply: Reply): Promise<void> {
    const response = this.native
    if (response.writableEnded) return

    response.statusCode = reply.status
    // `appendHeader` for **every** name, not only `set-cookie`.
    //
    // `SmallHeaderBag.entries()` is documented as flattened: a multi-value
    // header appears once per value, and repeating a name there is how the bag
    // says "this header has several values". `setHeader` discards all but the
    // last, so until now that contract held for exactly one header — the one
    // that had been noticed.
    //
    // Nothing else produced a repeated header, which is why the special case
    // looked complete: `ctx.res.vary()` has always been `appendHeader('vary',
    // …)` and nothing called it. The first thing that did was CORS, whose
    // preflight varies on three request headers — and over a real socket only
    // the third arrived. `inject()` could not see it, because
    // `InjectedResponse.headers` is `Object.fromEntries` and keeps the last
    // value too; the smoke suite found it on the first run.
    //
    // On a name that appears once, `appendHeader` is `setHeader`, so removing
    // the branch costs nothing and closes the class rather than one instance.
    for (const [name, value] of reply.headers.entries()) {
      response.appendHeader(name, value)
    }

    const body = reply.body
    switch (body.kind) {
      case 'empty':
        response.end()
        return
      case 'bytes':
        response.end(Buffer.from(body.value.buffer, body.value.byteOffset, body.value.byteLength))
        return
      case 'text':
        response.end(body.value)
        return
      case 'json':
        response.end(JSON.stringify(body.value))
        return
      case 'stream': {
        const source = typeof body.value === 'function' ? body.value() : body.value
        await pipeline(Readable.from(source), response)
        return
      }
      case 'file': {
        const { createReadStream } = await import('node:fs')
        await pipeline(createReadStream(body.path), response)
        return
      }
      case 'sse': {
        await pipeline(Readable.from(body.channel), response)
        return
      }
      default:
        response.end()
    }
  }
}

export function nodeAdapter(options: NodeAdapterOptions = {}): RuntimeAdapter {
  return {
    name: 'node',
    caps: NODE_CAPABILITIES,

    async listen(dispatch: Dispatch, listenOptions: ListenOptions): Promise<ServerHandle> {
      const server: Server = createServer((request, response) => {
        const raw = new NodeRawRequest(request)
        const conn = new NodeConnection(response, request)
        void Promise.resolve(dispatch(raw, conn)).catch((error: unknown) => {
          // Last resort: the dispatcher owns error handling, so reaching here
          // means the error engine itself failed. Never leave a socket hanging.
          if (!response.writableEnded) {
            response.statusCode = 500
            response.setHeader('content-type', 'application/problem+json')
            response.end('{"status":500,"code":"ZEN_INTERNAL"}')
          }
          console.error('[zen] dispatch failed catastrophically', error)
        })
      })

      server.headersTimeout = options.headersTimeout ?? 20_000
      server.requestTimeout = options.requestTimeout ?? 30_000
      server.keepAliveTimeout = options.keepAliveTimeout ?? 65_000
      server.maxHeadersCount = options.maxHeadersCount ?? 64

      const port = listenOptions.port ?? 3000
      const host = listenOptions.host ?? '127.0.0.1'

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })

      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port

      return {
        address: { host, port: actualPort },
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
        async close() {
          // §4.5 — drain before refusing. Skipping this delay is the number-one
          // cause of 502s during rolling deploys, and most frameworks skip it.
          const drain = options.drainDelay ?? 0
          if (drain > 0) await new Promise((r) => setTimeout(r, drain))
          await new Promise<void>((resolve) => {
            // The force-close timer must be cleared on the normal path: letting
            // it fire against an already-closed server trips a libuv assertion
            // and takes the process down during an otherwise clean shutdown.
            const force = setTimeout(() => {
              server.closeAllConnections()
            }, options.shutdownTimeout ?? 30_000)
            force.unref()

            server.close(() => {
              clearTimeout(force)
              resolve()
            })
            server.closeIdleConnections()
          })
        },
      }
    },
  }
}

export default nodeAdapter
