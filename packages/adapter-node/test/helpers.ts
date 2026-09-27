import { request, type IncomingMessage } from 'node:http'
import { createApp, NoopLogger, type Logger, type ZenApp } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { nodeAdapter, type NodeAdapterOptions } from '../src/index.ts'

/**
 * An app on a real ephemeral port.
 *
 * Everything in this suite goes over a socket on purpose. `inject()` captures
 * the Reply instead of writing it and brings its own `AbortController`, so it
 * could not see a single one of the defects these tests exist for: a request
 * body aborting `ctx.signal`, a disconnect mid-stream crashing the process, a
 * missing file dropping the connection. Only the adapter does any of that.
 */
export async function serve(
  build: (app: ZenApp) => void,
  options: { adapter?: NodeAdapterOptions; logger?: Logger; timeout?: string } = {},
): Promise<{ app: ZenApp; url: string; close: () => Promise<void> }> {
  const app = createApp({
    router: new ZenRouter(),
    pathParser: {
      parse(path: string) {
        const parsed = parsePath(path)
        return { path: parsed.path, segments: parsed.segments }
      },
    },
    adapter: nodeAdapter(options.adapter),
    logger: options.logger ?? new NoopLogger(),
    env: {},
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  }) as unknown as ZenApp
  build(app)
  const handle = await app.listen({ port: 0 })
  return { app, url: handle.url, close: () => app.close() }
}

/** A logger that remembers what was logged at `error`, for asserting on failures. */
export function capturingLogger(): Logger & { readonly errors: string[] } {
  const errors: string[] = []
  const record = (a: unknown, b?: string): void => { errors.push(typeof a === 'string' ? a : b ?? '') }
  const logger = {
    errors,
    level: 'trace' as const,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error: record,
    fatal: record,
    child() { return logger },
  }
  return logger as unknown as Logger & { readonly errors: string[] }
}

/**
 * Open a request, hand the first response chunk to `onData`, and let it decide
 * when to drop the connection. Resolves once the socket is gone.
 */
export function openAndDrop(
  url: string,
  shouldDrop: (text: string, response: IncomingMessage) => boolean,
): Promise<{ status: number | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    let text = ''
    let status: number | undefined
    const req = request(url, (res) => {
      status = res.statusCode
      res.on('data', (chunk) => {
        text += String(chunk)
        if (shouldDrop(text, res)) req.destroy()
      })
      res.on('end', () => resolve({ status, text }))
    })
    req.on('error', () => {})
    req.on('close', () => resolve({ status, text }))
    req.on('timeout', () => reject(new Error('timed out')))
    req.end()
  })
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves when `signal` aborts, or after `ms` with `false`. */
export function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(true) }, { once: true })
  })
}
