import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  BodySource, Capabilities, Connection, Dispatch, ListenOptions, RawRequest,
  RemoteInfo, Reply, RuntimeAdapter, ServerHandle, LowercaseName, SseChannel,
} from '@erenthedeveloper0/zen-core'
import { Codes, PayloadTooLarge, ZenError, docsUrl } from '@erenthedeveloper0/zen-core'
import { planFile } from './file.ts'

export { mediaTypeFor } from './file.ts'

export interface NodeAdapterOptions {
  /** Slowloris defence — §19.2. */
  readonly headersTimeout?: number | undefined
  readonly requestTimeout?: number | undefined
  readonly keepAliveTimeout?: number | undefined
  readonly maxHeadersCount?: number | undefined
  /**
   * The most bytes the request line and headers may take together — §19.2.
   * 8 KB, where Node's own default is 16 KB. Node counts them while parsing, so
   * a request past it never reaches Zen: Node answers 431 and closes the
   * connection. Raise it for clients that send large cookies.
   */
  readonly maxHeaderSize?: number | undefined
  /**
   * The longest request target accepted — §4.2 stage 2. 8 KB. Past it the
   * adapter answers 414 `ZEN_URI_TOO_LONG` before dispatch and closes the
   * connection: no context is built, no hook runs, nothing is logged.
   *
   * The target is part of what `maxHeaderSize` counts, so with both defaults a
   * target this long is refused as 431 first. This is the limit that still
   * holds when `maxHeaderSize` is raised for cookies, which is no reason to
   * take a longer URL.
   */
  readonly maxUrlLength?: number | undefined
  /**
   * Requests one keep-alive connection may carry. The last one is answered with
   * `Connection: close`, so the client opens a new connection — which a load
   * balancer can send to another instance — and a request pipelined past it is
   * answered 503 by Node. `0`, the default, sets no limit.
   */
  readonly maxRequestsPerSocket?: number | undefined
  /**
   * §4.5 step 1's window, in milliseconds: how long `close()` keeps accepting
   * after readiness has gone red, so the load balancer can stop routing here
   * before anything is refused. Set it longer than your orchestrator's
   * readiness `periodSeconds × failureThreshold`.
   */
  readonly drainDelay?: number | undefined
  /** How long in-flight requests get to finish before their sockets are destroyed. */
  readonly shutdownTimeout?: number | undefined
}

/**
 * What this adapter provides — rfcs/0001 §14.1, read by the app since
 * `0.1.0-alpha.4` (a plugin's `requires` is checked against it).
 *
 * `compression` and `websocket` are `'none'` because this adapter implements
 * neither. They said `'library'` until then, which a plugin requiring either
 * would have believed: a capability descriptor that claims what is not built
 * turns "fails at boot" back into "fails at 3am".
 */
export const NODE_CAPABILITIES: Capabilities = {
  eval: true,
  webStreams: true,
  nodeStreams: true,
  fs: true,
  compression: 'none',
  http2: false,
  websocket: 'none',
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
  readonly #clientGone: () => unknown

  constructor(message: IncomingMessage, clientGone: () => unknown) {
    this.native = message
    this.#clientGone = clientGone
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
    return (this.#body ??= new NodeBodySource(this.native, this.#clientGone))
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
  readonly #clientGone: () => unknown

  constructor(message: IncomingMessage, clientGone: () => unknown) {
    this.#message = message
    this.#clientGone = clientGone
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

    try {
      for await (const chunk of this.#message) {
        if (signal?.aborted) {
          this.#message.destroy()
          // The signal's own reason: a `ZEN_TIMEOUT` when the deadline fired, an
          // `AbortError` when the client left. Either classifies as what happened,
          // where a bare `Error('aborted')` became an unexplained 500 in the logs.
          throw signal.reason
        }
        const buffer = chunk as Buffer
        total += buffer.length
        if (total > limit) {
          this.#message.destroy()
          throw new PayloadTooLarge(`Body exceeds the ${limit} byte limit`)
        }
        chunks.push(buffer)
      }
    } catch (error) {
      // A client that hangs up mid-upload ends the read with Node's own
      // `aborted` / `ECONNRESET` error rather than at a chunk boundary, and that
      // was logged as an application 500. The connection signal normally says
      // so first; report that instead. The response's `close` and the request's
      // error arrive in whichever order the socket delivers them, so Node's
      // error is recognised on its own as well — and answered with the
      // connection's own abort, raised here rather than waited for, because the
      // error engine reads an abort as the request's only when it *is*
      // `ctx.signal.reason` (§12.4). A fresh `AbortError` would be one the
      // application caused: an application 500 for a client that left.
      if (signal?.aborted === true && error !== signal.reason) throw signal.reason
      if (isClientAbort(error)) throw this.#clientGone()
      throw error
    }

    return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
  }

  async *stream(): AsyncIterable<Uint8Array> {
    for await (const chunk of this.#message) yield chunk as Buffer
  }
}

/** Node's error for a request whose client went away mid-body: `aborted`, `ECONNRESET`. */
function isClientAbort(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  return e !== null && typeof e === 'object' && e.code === 'ECONNRESET' && e.message === 'aborted'
}

/** What every connection on one server shares with that server's `close()`. */
interface ServerState {
  /** Set once shutdown has passed the drain window and stopped accepting. */
  closing: boolean
  /** Open event streams, ended with a `shutdown` event by `close()` (§30.2). */
  readonly streams: Set<SseChannel>
}

class NodeConnection implements Connection {
  readonly signal: AbortSignal
  readonly native: ServerResponse
  readonly #request: IncomingMessage
  readonly #state: ServerState
  readonly #controller: AbortController

  constructor(response: ServerResponse, request: IncomingMessage, state: ServerState) {
    this.native = response
    this.#request = request
    this.#state = state
    this.#controller = new AbortController()
    this.signal = this.#controller.signal

    // §4.5 step 2 — a keep-alive connection that finishes a response after
    // shutdown began must not go back to idling. `server.close()` only closes
    // connections that are idle *at the moment it is called*; one that finishes
    // a millisecond later waits for the client to hang up, and a load balancer's
    // upstream pool never does, so `close()` sat out the whole
    // `shutdownTimeout` on every rolling deploy. Responses whose headers are
    // still to be written get `Connection: close` in `send()`; this covers the
    // ones already on the wire.
    const socket = request.socket
    response.once('finish', () => {
      if (state.closing && !socket.destroyed) socket.end()
    })

    // §4.4 — a real AbortSignal wired to client disconnect closes the "client
    // hung up but we kept querying Postgres for 30s" hole.
    //
    // The *response's* `close`, not the request's. Since Node 16 an
    // `IncomingMessage` emits `close` as soon as its body has been consumed —
    // which is what body intake does — so listening there aborted `ctx.signal`
    // on every request with a body, and on a route with a deadline the stage
    // check after intake then abandoned it: **every POST answered 499**. Only
    // `inject()` had ever sent a body, and it has its own AbortController.
    //
    // The response emits `close` exactly once, when the exchange is over for
    // either reason; `writableFinished` says which. Finished means we answered.
    // Not finished means the connection went away first — the client left.
    response.once('close', () => {
      if (!response.writableFinished) this.#controller.abort()
    })
  }

  /**
   * The client went away mid-body: abort this connection now — the response's
   * `close` may not have arrived yet — and hand back the reason, which every
   * `ctx.signal` composed from this one now carries (§4.4).
   */
  clientGone(): unknown {
    if (!this.signal.aborted) this.#controller.abort()
    return this.signal.reason
  }

  async send(reply: Reply): Promise<void> {
    const response = this.native

    // The exchange is already over: the client left, a streamed body failed
    // part way (`#pipe` destroys the response before it rethrows), or an
    // earlier reply finished it. There is nothing to say and nobody to say it
    // to. This is the check that closed the crash: a second reply for an
    // exchange whose status line had gone out used to reach `setHeader`, throw
    // `ERR_HTTP_HEADERS_SENT` from a `.catch` nobody was listening to, and
    // **take the process down** whenever a client disconnected mid-stream.
    if (response.writableEnded || response.destroyed) return

    // Defence in depth: headers flushed on a response that is neither ended
    // nor destroyed. No path in this adapter produces that state today — the
    // negative-control script established as much — but a header cannot be
    // taken back, so if one ever does, ending the connection is the only
    // honest signal left.
    if (response.headersSent) {
      response.destroy()
      return
    }

    // An earlier attempt at this exchange may have staged headers before it
    // failed — a file that turned out not to exist. Start clean, or the error
    // reply inherits the first reply's headers.
    for (const name of response.getHeaderNames()) response.removeHeader(name)

    const body = reply.body

    // Everything that can fail before a byte is written happens first, so that
    // failing is still an ordinary error reply rather than a truncated one.
    const file = body.kind === 'file'
      ? await planFile(body, this.#fileRequest(), reply.status, reply.headers.has('content-type'))
      : null

    response.statusCode = file === null ? reply.status : file.status
    // `appendHeader` for **every** name, not only `set-cookie`.
    //
    // `SmallHeaderBag.entries()` is documented as flattened: a multi-value
    // header appears once per value, and repeating a name there is how the bag
    // says "this header has several values". `setHeader` discards all but the
    // last, so a `Vary` from CORS and one from content negotiation — two
    // subsystems that know nothing about each other — would lose one of them.
    // On a name that appears once, `appendHeader` is `setHeader`.
    for (const [name, value] of reply.headers.entries()) {
      response.appendHeader(name, value)
    }
    // §4.5 step 2: shutting down, so this is the connection's last response.
    // Node honours the header by closing the socket once the body is written.
    if (this.#state.closing) response.setHeader('connection', 'close')

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
        await this.#pipe(typeof body.value === 'function' ? body.value() : body.value)
        return
      }
      case 'file': {
        const plan = file as NonNullable<typeof file>
        // `onResponse` hooks read the reply that went out; a 304 or a 206 is
        // decided here, after the `stat`, so the reply is told what it became.
        if (plan.status !== reply.status) (reply as { status: number }).status = plan.status
        for (const [name, value] of plan.headers) {
          if (!response.hasHeader(name)) response.setHeader(name, value)
        }
        if (!plan.body) {
          response.end()
          return
        }
        await this.#pipe(createReadStream(plan.path, plan.range ?? undefined))
        return
      }
      case 'sse': {
        const channel = body.channel
        // Tracked so `close()` can end it with a final `event: shutdown` rather
        // than holding the drain open until `shutdownTimeout` severs it (§30.2).
        this.#state.streams.add(channel)
        try {
          await this.#pipe(channel)
        } finally {
          this.#state.streams.delete(channel)
          channel.close()
        }
        return
      }
      default:
        response.end()
    }
  }

  /**
   * Stream a body into the response.
   *
   * The status line is already out by the time this can fail, so no failure
   * here can become an error reply. There are two ways it fails, and they must
   * not be confused:
   *
   *   - **The client went away.** The ordinary end of a stream nobody is
   *     reading. Not an error; nothing is logged.
   *   - **The source threw** — a cursor died, a generator had a bug. That is a
   *     failure of the application and is rethrown, so the error engine logs it
   *     and `onResponse` observes a failed exchange. The connection is destroyed
   *     first, so the client sees a truncated transfer rather than a body that
   *     looks complete.
   *
   * Telling them apart from the outside does not work: `pipeline` destroys the
   * response on *either* failure, which aborts the connection signal and makes
   * a crashed source look exactly like a departed client. So the source is read
   * through {@link guarded}, which records an error only when it comes out of
   * the source's own `next()`.
   */
  async #pipe(source: AsyncIterable<Uint8Array | string>): Promise<void> {
    const failure: { error?: unknown; failed: boolean } = { failed: false }
    try {
      await pipeline(Readable.from(guarded(source, failure)), this.native)
    } catch {
      if (!this.native.destroyed) this.native.destroy()
      if (failure.failed) throw failure.error
    }
  }

  #fileRequest(): { method: string; header(name: string): string | undefined } {
    const request = this.#request
    return {
      method: request.method ?? 'GET',
      header(name) {
        const value = request.headers[name]
        return Array.isArray(value) ? value.join(', ') : value
      },
    }
  }
}

/**
 * Read a body source, recording an error only when the *source* produced it.
 *
 * When the destination fails, `Readable.from` tells the source by calling
 * `throw()` on it with the destination's error. That error is not the
 * source's, so it must not be recorded as one — and it is not, because it
 * arrives through `throw()`, while a genuine failure comes out of `next()`.
 *
 * Deliberately an iterator object and not an `async function*`. A generator
 * that is suspended inside `await next()` queues `return()` and `throw()` until
 * it next yields, and a quiet event stream may never yield again — so the
 * channel never heard that its client had gone. For the same reason `return()`
 * is forwarded without waiting on it: a source stuck on an await that will
 * never settle must not hold the exchange, and its `onResponse` hooks, open.
 */
function guarded<T>(
  source: AsyncIterable<T>,
  failure: { error?: unknown; failed: boolean },
): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let done = false

  /** Stopped early — the client left, or the response failed. Tell the source. */
  const release = (): void => {
    if (done) return
    done = true
    try {
      const settled = iterator.return?.()
      if (settled !== undefined) void Promise.resolve(settled).catch(() => {})
    } catch {
      // A source whose `return` throws has nothing left to release.
    }
  }

  return {
    async next(): Promise<IteratorResult<T>> {
      if (done) return { done: true, value: undefined }
      try {
        const step = await iterator.next()
        if (step.done === true) done = true
        return step
      } catch (error) {
        done = true
        failure.failed = true
        failure.error = error
        throw error
      }
    },
    async return(): Promise<IteratorResult<T>> {
      release()
      return { done: true, value: undefined }
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      release()
      throw error
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

/**
 * The answer to a request target longer than `maxUrlLength` — §4.2 stage 2.
 *
 * Written by the adapter, before dispatch, because an ingress guard exists to
 * refuse a request before anything is allocated in proportion to it. So it is
 * the part of the error contract that needs no request: the code and its link
 * (I7). No `instance`, which would echo the target being refused, and no
 * `requestId`, because no request was made of it.
 */
const URI_TOO_LONG = JSON.stringify({
  type: docsUrl(Codes.URI_TOO_LONG),
  title: 'URI Too Long',
  status: 414,
  code: Codes.URI_TOO_LONG,
})

/**
 * A size option, checked when the adapter is made rather than discovered under
 * load: `url.length > NaN` is never true, so a limit that is not a number would
 * be no limit, silently.
 */
function sizeOption(name: string, value: number | undefined, fallback: number, least: number): number {
  if (value === undefined) return fallback
  if (Number.isInteger(value) && value >= least) return value
  throw new ZenError(
    Codes.CONFIG_INVALID,
    `nodeAdapter: ${name} must be a whole number of at least ${least}; got ${JSON.stringify(value)}.`,
    {
      status: 500,
      expose: false,
      hint: `Pass nodeAdapter({ ${name}: ${fallback === 0 ? 100 : fallback} }), or leave it out for the default (${fallback}).`,
    },
  )
}

export function nodeAdapter(options: NodeAdapterOptions = {}): RuntimeAdapter {
  const maxHeaderSize = sizeOption('maxHeaderSize', options.maxHeaderSize, 8192, 1)
  const maxUrlLength = sizeOption('maxUrlLength', options.maxUrlLength, 8192, 1)
  const maxRequestsPerSocket = sizeOption('maxRequestsPerSocket', options.maxRequestsPerSocket, 0, 0)

  return {
    name: 'node',
    caps: NODE_CAPABILITIES,

    async listen(dispatch: Dispatch, listenOptions: ListenOptions): Promise<ServerHandle> {
      const state: ServerState = { closing: false, streams: new Set() }

      const server: Server = createServer({ maxHeaderSize }, (request, response) => {
        // One length compare, then nothing: no context, no hooks, no log line.
        // `request.url` is the target as sent, one character per byte.
        if ((request.url ?? '/').length > maxUrlLength) {
          response.writeHead(414, {
            'content-type': 'application/problem+json',
            'content-length': URI_TOO_LONG.length,
            connection: 'close',
          })
          response.end(URI_TOO_LONG)
          return
        }
        const conn = new NodeConnection(response, request, state)
        const raw = new NodeRawRequest(request, () => conn.clientGone())
        void Promise.resolve(dispatch(raw, conn)).catch((error: unknown) => {
          // Last resort: the dispatcher owns error handling, so reaching here
          // means the error engine itself failed. Never leave a socket hanging —
          // and never throw from here, because nothing is listening: a throw in
          // this callback is an unhandled rejection, and by default that ends
          // the process.
          try {
            if (!response.headersSent && !response.destroyed) {
              response.statusCode = 500
              response.setHeader('content-type', 'application/problem+json')
              response.end('{"status":500,"code":"ZEN_INTERNAL"}')
            } else if (!response.destroyed) {
              response.destroy()
            }
          } catch {
            // The socket is already gone; there is nobody left to tell.
          }
          console.error('[zen] dispatch failed', error)
        })
      })

      server.headersTimeout = options.headersTimeout ?? 20_000
      server.requestTimeout = options.requestTimeout ?? 30_000
      server.keepAliveTimeout = options.keepAliveTimeout ?? 65_000
      server.maxHeadersCount = options.maxHeadersCount ?? 64
      server.maxRequestsPerSocket = maxRequestsPerSocket

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
        url: `http://${urlHost(host)}:${actualPort}`,
        async close() {
          // §4.5 — drain before refusing. Skipping this delay is the number-one
          // cause of 502s during rolling deploys, and most frameworks skip it.
          const drain = options.drainDelay ?? 0
          if (drain > 0) await new Promise((r) => setTimeout(r, drain))

          // §4.5 step 2 — from here every response is its connection's last.
          state.closing = true

          // §30.2 — event streams are in-flight requests that never finish on
          // their own, so without this `server.close()` waits the whole
          // `shutdownTimeout` and then severs them. Now, after the drain window
          // (so the load balancer has stopped sending reconnects here), each
          // gets a final `shutdown` event and a clean end; `EventSource`
          // reconnects to an instance that is staying up.
          for (const channel of state.streams) {
            channel.send({ event: 'shutdown', data: '' })
            channel.close()
          }

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

/**
 * The host part of `ServerHandle.url`: a wildcard address becomes the loopback
 * address that reaches it, and an IPv6 literal is bracketed. `http://::1:3000`
 * is not a URL — `fetch(handle.url)` threw for any server bound to IPv6.
 */
function urlHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '[::1]'
  return host.includes(':') ? `[${host}]` : host
}

export default nodeAdapter
