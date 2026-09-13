import type { Reply } from '../contracts/reply.ts'
import type { Logger } from '../contracts/logger.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { MutableReply } from './reply.ts'

export type ErrorMapper = (error: unknown, ctx: unknown) => unknown

export interface ErrorEngineOptions {
  readonly dev: boolean
  readonly logger: Logger
}

/**
 * The error pipeline — rfcs/0001 §12.4.
 *
 * Mappers are keyed by constructor and resolved at boot, so request-time lookup
 * is one `Map.get` on `err.constructor` plus a short subclass walk — not the
 * linear `if (err instanceof X)` chain that Express error middleware degrades
 * into as an app grows.
 */
export class ErrorEngine {
  #exact = new Map<Function, ErrorMapper[]>()
  #ordered: Array<{ ctor: Function; map: ErrorMapper }> = []
  #dev: boolean
  #logger: Logger

  constructor(opts: ErrorEngineOptions) {
    this.#dev = opts.dev
    this.#logger = opts.logger
  }

  register(ctor: Function, mapper: ErrorMapper): void {
    const list = this.#exact.get(ctor)
    if (list) list.push(mapper)
    else this.#exact.set(ctor, [mapper])
    this.#ordered.push({ ctor, map: mapper })
  }

  /** Classify → map → format. Never throws; a broken formatter degrades to 500. */
  handle(error: unknown, ctx: ErrorContextInfo): Reply {
    let resolved = error

    try {
      resolved = this.#applyMappers(error, ctx)
    } catch (mapperError) {
      this.#logger.error({ err: mapperError }, 'error mapper threw; falling back')
      resolved = error
    }

    const zen = classify(resolved)
    this.#log(zen, ctx)

    try {
      return this.#format(zen, ctx)
    } catch (formatError) {
      this.#logger.fatal({ err: formatError }, 'error formatter threw; emitting minimal 500')
      return minimalFailure(ctx.requestId)
    }
  }

  #applyMappers(error: unknown, ctx: unknown): unknown {
    if (this.#ordered.length === 0) return error
    if (typeof error !== 'object' || error === null) return error

    const direct = this.#exact.get((error as object).constructor)
    if (direct) {
      for (const mapper of direct) {
        const mapped = mapper(error, ctx)
        if (mapped !== undefined) return mapped
      }
    }

    for (const entry of this.#ordered) {
      if (error instanceof (entry.ctor as new (...args: never[]) => object)) {
        const mapped = entry.map(error, ctx)
        if (mapped !== undefined) return mapped
      }
    }
    return error
  }

  #log(error: ZenError, ctx: ErrorContextInfo): void {
    const payload = {
      err: error,
      code: error.code,
      status: error.status,
      requestId: ctx.requestId,
      route: ctx.route,
      method: ctx.method,
      path: ctx.path,
      ...(error.meta ?? {}),
    }
    if (error.status >= 500) this.#logger.error(payload, error.message)
    else if (error.status === 429 || error.status === 408) this.#logger.warn(payload, error.message)
    else this.#logger.debug(payload, error.message)
  }

  #format(error: ZenError, ctx: ErrorContextInfo): Reply {
    const problem = error.toProblem(ctx.path, ctx.requestId)

    if (this.#dev) {
      problem['debug'] = {
        stack: splitStack(error.stack),
        cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message } : undefined,
        route: ctx.route,
        meta: error.meta,
      }
    }

    const reply = new MutableReply(error.status, { kind: 'json', value: problem })
    reply.headers.set('content-type', 'application/problem+json; charset=utf-8')
    if (error.headers) {
      for (const [name, value] of Object.entries(error.headers)) reply.headers.set(name, value)
    }
    if (error.retryable && !reply.headers.has('retry-after')) reply.headers.set('retry-after', '1')
    return reply
  }
}

export interface ErrorContextInfo {
  readonly requestId: string
  readonly method: string
  readonly path: string
  readonly route: string | null
}

/** Unknown throwables become an internal error that never exposes its message. */
export function classify(error: unknown): ZenError {
  if (error instanceof ZenError) return error

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new ZenError(Codes.TIMEOUT, 'Request aborted', { status: 408, expose: true, cause: error })
    }
    return new ZenError(Codes.INTERNAL, error.message, { status: 500, expose: false, cause: error })
  }

  return new ZenError(Codes.INTERNAL, 'Unknown error', {
    status: 500,
    expose: false,
    meta: { thrown: typeof error, value: safeInspect(error) },
  })
}

function safeInspect(value: unknown): string {
  try {
    return String(value).slice(0, 200)
  } catch {
    return '<unrepresentable>'
  }
}

/** Framework frames are elided by default — 40 lines of node_modules is how a
 *  stack trace becomes unreadable (§12.6). */
function splitStack(stack: string | undefined): string[] {
  if (!stack) return []
  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => !line.includes('/zen/packages/core/src/runtime/'))
    .slice(0, 12)
}

function minimalFailure(requestId: string): Reply {
  const reply = new MutableReply(500, {
    kind: 'text',
    value: `{"status":500,"code":"ZEN_INTERNAL","requestId":"${requestId}"}`,
    media: 'application/problem+json; charset=utf-8',
  })
  return reply
}
