import type { Reply } from '../contracts/reply.ts'
import type { Logger } from '../contracts/logger.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes, docsUrl } from '../errors/codes.ts'
import { devErrorPage } from './dev-error-page.ts'
import { ServiceUnavailable } from '../errors/http-errors.ts'
import { MutableReply } from './reply.ts'

export type ErrorMapper = (error: unknown, ctx: unknown) => unknown

export interface ErrorEngineOptions {
  readonly dev: boolean
  readonly logger: Logger
  /** §12.8's circuit breaker; see {@link BREAKER_DEFAULTS}. */
  readonly breaker?: Partial<BreakerOptions> | undefined
  /** Milliseconds on a monotonic clock. `performance.now()`; a test passes its own. */
  readonly now?: (() => number) | undefined
  /**
   * §12.6 — what only the application knows about an error, in development:
   * where its route was registered, where the error was raised and the code
   * around that line, the route's resolved chain. Called on the error path of
   * a development build and never otherwise.
   */
  readonly explain?: ((error: ZenError, info: ErrorContextInfo) => DevFacts) | undefined
  /** §12.6 — where a development build sends each 5xx it answered, rendered for a reader. */
  readonly report?: ((problem: Readonly<Record<string, unknown>>) => void) | undefined
}

/**
 * The development facts about one error — §12.6. Structured, so a
 * terminal renderer, the development HTML page and a test all read the same
 * thing; rendered by whoever has somewhere to render it.
 */
export interface DevFacts {
  /** `src/routes/users.ts:31:3` — where the failing route was registered. */
  readonly origin?: string | undefined
  /** `src/services/users.ts:88:11` — the first frame of the application's own code. */
  readonly thrown?: string | undefined
  /** The lines around `thrown`, when the host can read the file. */
  readonly frame?: { readonly file: string; readonly line: number; readonly lines: ReadonlyArray<{ readonly line: number; readonly text: string }> } | undefined
  /** The route's resolved chain, as `explainRoute` prints it. */
  readonly chain?: readonly string[] | undefined
}

export interface BreakerOptions {
  /** Formatter failures, inside `windowMs`, that open the circuit. */
  readonly threshold: number
  readonly windowMs: number
  /** How long an open circuit answers without calling the formatter before trying it again. */
  readonly cooldownMs: number
}

/**
 * Five failures in ten seconds, then thirty seconds of the minimal responder.
 *
 * A formatter that throws once is a bug worth a `fatal` line. A formatter that
 * throws on every error is a broken process, and a `fatal` per request turns
 * its log into the incident: thousands of identical stack traces burying the
 * one line that says what broke. The numbers are generous on both sides — a
 * transient failure does not trip it, and a broken formatter is retried twice
 * a minute rather than abandoned for the life of the process.
 */
export const BREAKER_DEFAULTS: BreakerOptions = Object.freeze({ threshold: 5, windowMs: 10_000, cooldownMs: 30_000 })

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
  readonly #breaker: BreakerOptions
  readonly #now: () => number
  readonly #explain: ((error: ZenError, info: ErrorContextInfo) => DevFacts) | undefined
  readonly #report: ((problem: Readonly<Record<string, unknown>>) => void) | undefined
  /** When recent formatter failures happened, oldest first, at most `threshold` of them. */
  readonly #failures: number[] = []
  /** The circuit is open until this instant; `0` when it is closed. */
  #openUntil = 0
  /** True from the moment the circuit opens until the formatter works again. */
  #tripped = false
  /** Errors answered by the minimal responder, without the formatter, since it tripped. */
  #shed = 0

  constructor(opts: ErrorEngineOptions) {
    this.#dev = opts.dev
    this.#logger = opts.logger
    this.#breaker = { ...BREAKER_DEFAULTS, ...opts.breaker }
    this.#now = opts.now ?? (() => performance.now())
    this.#explain = opts.explain
    this.#report = opts.report
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

    const zen = classify(resolved, ctx.signal)
    this.#log(zen, ctx)

    // §12.8 — while the circuit is open the formatter is not called at all.
    if (this.#openUntil !== 0) {
      if (this.#now() < this.#openUntil) {
        this.#shed++
        return minimalFailure(ctx.requestId)
      }
      this.#openUntil = 0 // half-open: the next error tries the formatter once
    }

    try {
      const reply = this.#format(zen, ctx)
      if (this.#tripped) {
        this.#logger.warn(
          { answeredMinimal: this.#shed },
          `error formatter works again; ${this.#shed} error(s) were answered by the minimal 500 while it was skipped`,
        )
        this.#tripped = false
        this.#shed = 0
      }
      return reply
    } catch (formatError) {
      this.#formatterFailed(formatError)
      return minimalFailure(ctx.requestId)
    }
  }

  /**
   * One failure is logged as an `error`; the one that makes `threshold`
   * inside `windowMs` opens the circuit and is the single `fatal` (§12.8).
   * A failure while half-open re-opens it at once — the formatter just
   * proved it is still broken — without another `fatal`.
   */
  #formatterFailed(error: unknown): void {
    const now = this.#now()
    const { threshold, windowMs, cooldownMs } = this.#breaker
    if (this.#tripped) {
      this.#openUntil = now + cooldownMs
      this.#logger.error({ err: error }, 'error formatter still throws; skipping it again')
      return
    }
    const failures = this.#failures
    failures.push(now)
    while (failures.length > 0 && now - (failures[0] as number) > windowMs) failures.shift()
    if (failures.length < threshold) {
      this.#logger.error({ err: error }, 'error formatter threw; emitting minimal 500')
      return
    }
    failures.length = 0
    this.#openUntil = now + cooldownMs
    this.#tripped = true
    this.#logger.fatal(
      { err: error, failures: threshold, windowMs, cooldownMs },
      `error formatter threw ${threshold} times in ${windowMs} ms; answering errors with the minimal 500 ` +
        `for ${cooldownMs} ms without calling it`,
    )
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
    // `meta` first, so an application's metadata can add fields to the line
    // but never replace the ones every dashboard filters on — a `meta.status`
    // used to overwrite the real one.
    const payload = {
      ...(error.meta ?? {}),
      err: error,
      code: error.code,
      status: error.status,
      requestId: ctx.requestId,
      route: ctx.route,
      method: ctx.method,
      path: ctx.path,
    }
    if (error.status >= 500) this.#logger.error(payload, error.message)
    else if (error.status === 429 || error.status === 408) this.#logger.warn(payload, error.message)
    else this.#logger.debug(payload, error.message)
  }

  /** The application's facts, which must never be the reason an error goes unanswered. */
  #facts(error: ZenError, ctx: ErrorContextInfo): DevFacts {
    if (this.#explain === undefined) return {}
    try {
      return this.#explain(error, ctx)
    } catch {
      return {}
    }
  }

  #reportDev(problem: Readonly<Record<string, unknown>>): void {
    if (this.#report === undefined) return
    try {
      this.#report(problem)
    } catch {
      // A reporter that fails reports nothing; the response is still owed.
    }
  }

  #format(error: ZenError, ctx: ErrorContextInfo): Reply {
    const problem = error.toProblem(ctx.path, ctx.requestId)

    if (this.#dev) {
      problem['debug'] = {
        // The message even when `expose` withholds it from `title`: this is
        // the development document, and the developer is the reader.
        message: error.message,
        stack: splitStack(error.stack),
        cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message } : undefined,
        route: ctx.route,
        meta: error.meta,
        // §12.6 — what to do, what else broke, and where it is documented.
        hint: error.hint,
        consequence: error.consequence,
        docs: docsUrl(error.code),
        ...this.#facts(error, ctx),
      }
      if (error.status >= 500) this.#reportDev(problem)
    }

    // §12.6 — in development a browser gets a page; an API client keeps its
    // document. Either carries the error's own headers: a 401's challenge or
    // a 405's `Allow` is no less owed to a browser.
    const reply = this.#dev && ctx.html === true
      ? devErrorPage(problem)
      : new MutableReply(error.status, { kind: 'json', value: problem })
    if (reply.body.kind === 'json') reply.headers.set('content-type', 'application/problem+json; charset=utf-8')
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
  /** The failing route's id, so a development build can describe it (§12.6). */
  readonly routeId?: string | null | undefined
  /** Development only: the request's `Accept` prefers HTML — it gets the error page. */
  readonly html?: boolean | undefined
  /**
   * The request's own signal — `ctx.signal` — so an abort can be told apart
   * from one the application caused (`classify`). Absent outside a request.
   */
  readonly signal?: AbortSignal | undefined
}

/**
 * Unknown throwables become an internal error that never exposes its message.
 *
 * `signal` is the request's own: an abort is only the *request's* when the
 * error is that signal's reason (or carries it as its `cause`).
 */
export function classify(error: unknown, signal?: AbortSignal): ZenError {
  if (error instanceof ZenError) return error

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return classifyAbort(error, signal)
    return new ZenError(Codes.INTERNAL, error.message, { status: 500, expose: false, cause: error })
  }

  return new ZenError(Codes.INTERNAL, 'Unknown error', {
    status: 500,
    expose: false,
    meta: { thrown: typeof error, value: safeInspect(error) },
  })
}

/**
 * Whose abort was it — rfcs/0001 §12.4.
 *
 * Every `AbortError` used to become `ZEN_TIMEOUT`, a 408 that tells the client
 * *it* was slow to send its request (RFC 9110 §15.5.9). The request's own
 * aborts — its deadline, its client leaving — mostly never get here: the
 * dispatcher answers a blown deadline through `EXPIRED`, and a deadline's
 * signal aborts with a `ZEN_TIMEOUT` that is already a `ZenError`. What does
 * get here is an abort the *application* caused, such as its own
 * `AbortController` around an upstream call, and that was nobody's slowness
 * but ours. So:
 *
 *   - the request's own signal, reached through `fetch(url, { signal:
 *     ctx.signal })` and the like — the error *is* `ctx.signal.reason`, or
 *     carries it as its `cause` — keeps the old mapping;
 *   - a `TimeoutError`, `AbortSignal.timeout`'s, or an `AbortError` caused by
 *     one, is an upstream that did not answer: `ZEN_SERVICE_UNAVAILABLE`, 503;
 *   - any other abort is the application's, and unclassified: `ZEN_INTERNAL`.
 */
function classifyAbort(error: Error, signal: AbortSignal | undefined): ZenError {
  if (signal !== undefined && signal.aborted && (error === signal.reason || error.cause === signal.reason)) {
    return new ZenError(Codes.TIMEOUT, 'Request aborted', { status: 408, expose: true, cause: error })
  }
  if (error.name === 'TimeoutError' || (error.cause instanceof Error && error.cause.name === 'TimeoutError')) {
    return new ServiceUnavailable('An upstream call did not answer in time.', { cause: error, retryable: true })
  }
  return new ZenError(Codes.INTERNAL, error.message, { status: 500, expose: false, cause: error })
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
    .filter((line) => !FRAMEWORK_FRAME.test(line))
    .slice(0, 12)
}

/**
 * A frame inside core's runtime, wherever core is installed: this repository's
 * `packages/core/{src,dist}`, or `node_modules/@erenthedeveloper0/zen-core/dist`. The
 * filter this replaced matched one checkout's absolute path and nothing a user
 * would ever have on disk.
 */
const FRAMEWORK_FRAME = /[\\/](?:zen-)?core[\\/](?:src|dist)[\\/]runtime[\\/]/

function minimalFailure(requestId: string): Reply {
  const reply = new MutableReply(500, {
    kind: 'text',
    // Encoded, not interpolated: `ctx.id` is writable, and a request id holding
    // a quote would otherwise make the one response that exists to be safe
    // into malformed JSON.
    value: `{"status":500,"code":"ZEN_INTERNAL","requestId":${JSON.stringify(requestId)}}`,
    media: 'application/problem+json; charset=utf-8',
  })
  return reply
}
