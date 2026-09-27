import type { Reply } from '../contracts/reply.ts'
import type { TimeoutInfo, TimeoutStage } from '../contracts/deadline.ts'
import { CLIENT_CLOSED, TIMEOUT_STATUS } from '../contracts/deadline.ts'
import { MutableReply } from './reply.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * The deadline arm — rfcs/0001 §4.4.
 *
 * §4.4 has promised since the first draft that "every `Ctx` carries a real
 * `AbortSignal`, wired to client disconnect *and to the handler timeout*". Half
 * of that was true. This is the other half, and it closes a hole that once headed the
 * roadmap: without it a handler that never returns holds its connection,
 * its socket and its slot in the event loop until the process restarts, and
 * nothing in the framework notices.
 *
 * Two mechanisms, with two different jobs, because one is not enough:
 *
 *   1. **The arm** — a timer that fires at the deadline, aborts the signal, and
 *      answers the request whether or not the pipeline has finished. This is
 *      what makes the connection bounded. It cannot make the *work* stop: you
 *      cannot interrupt a running `await`, and any framework claiming otherwise
 *      is claiming something JavaScript does not offer.
 *   2. **The stage checks** — emitted by the pipeline compiler at the stage
 *      boundaries of §4.1, so a request whose deadline has already blown, or
 *      whose client has already left, stops at the next boundary instead of
 *      validating a body and querying a database for an answer nobody will
 *      read. This is the part a compiled framework gets nearly free and an
 *      interpreted middleware chain cannot get at all: the boundaries are
 *      known statically, so the checks are three branches on routes that
 *      declared a deadline and *no emitted text at all* on routes that did not.
 *
 * The honest limit, stated because §I9 requires the cost of a feature to be
 * visible and this is the shape of it: between two boundaries, only code that
 * respects `ctx.signal` can be cancelled. `fetch`, `node:fs`, and every driver
 * that accepts a signal will; a synchronous 30-second loop will not. The
 * deadline still answers the client on time. That is the guarantee, and it is
 * the one that matters for the connection pool.
 */

/**
 * Thrown into the dispatcher by the arm.
 *
 * A module-level sentinel rather than an `Error` subclass: nothing about it is
 * ever shown to anybody, it exists only to win a `Promise.race`, and identity
 * comparison against a frozen symbol cannot be spoofed by user code that throws
 * something with a matching `name`.
 */
export const EXPIRED: unique symbol = Symbol('zen.deadline.expired')

/**
 * One deadline, one request.
 *
 * Fixed shape and no methods on the hot fields, because the pipeline reads
 * `stage` and `done` at every stage boundary and those two reads are the entire
 * per-stage cost of the feature.
 */
export class Deadline {
  /** `performance.now()` at which this request expires. */
  readonly at: number
  /** The budget actually granted, after any inbound clamp. */
  readonly budgetMs: number
  /** Aborts on expiry *or* on client disconnect. This becomes `ctx.signal`. */
  readonly signal: AbortSignal
  /** Rejects with `EXPIRED`. Never resolves. */
  readonly expiry: Promise<never>

  /**
   * Where the request is now — written by the compiled pipeline at each stage
   * boundary, read by the arm when it fires.
   *
   * This is the field that turns "the request timed out" into "the handler blew
   * a 2 s budget after 2.04 s", and it costs one store of an interned literal
   * per stage on routes that opted in.
   */
  stage: TimeoutStage = 'pre'

  /**
   * True once this request is over, for either reason.
   *
   * A plain boolean rather than reading `signal.aborted` because the pipeline
   * checks it three times per request and `AbortSignal.prototype.aborted` is a
   * native accessor, not a field. Same answer, one property load.
   */
  done = false

  /** True only when the *timer* fired. Distinguishes 504 from a client leaving. */
  expired = false

  #timer: ReturnType<typeof setTimeout> | null
  #controller: AbortController
  #connSignal: AbortSignal
  #onConnAbort: () => void

  /**
   * `keepAlive` decides whether the timer holds the event loop open, and the
   * default is that it does not — see the `unref` below.
   *
   * It exists because reusing this arm for health probes (§31.4) found the
   * assumption baked into that default: a *request's* deadline is never the
   * only thing that will produce an answer, because the connection is open and
   * the pipeline is running. A probe's deadline can be. `await app.probe()` in
   * an otherwise idle process, against a dependency that never responds, is a
   * promise only this timer can settle — and with an unref'd timer Node
   * decides there is nothing left to do and exits, so the caller gets no report
   * and no error either. Anything awaiting the expiry rather than merely
   * racing it wants `true`.
   */
  constructor(budgetMs: number, connSignal: AbortSignal, keepAlive = false) {
    const controller = new AbortController()
    this.#controller = controller
    this.#connSignal = connSignal
    this.budgetMs = budgetMs
    this.at = performance.now() + budgetMs
    this.signal = controller.signal

    // Composed by hand rather than with `AbortSignal.any`, for two reasons that
    // are both about the timer and neither about elegance. `AbortSignal.timeout`
    // gives no handle to clear, so at 10k rps with a 30 s budget the process
    // would hold three hundred thousand live timers that all still have to
    // fire; and the reason an abort carries has to be *ours*, because "did the
    // deadline blow or did the client leave" decides between a 504 that pages
    // someone and a 499 that does not.
    this.#onConnAbort = () => {
      if (this.done) return
      this.done = true
      this.#clear()
      controller.abort(connSignal.reason)
    }
    connSignal.addEventListener('abort', this.#onConnAbort, { once: true })

    let reject!: (reason: unknown) => void
    this.expiry = new Promise<never>((_resolve, r) => { reject = r })

    // The dispatcher attaches the real handler by racing this promise, but it
    // does not always get that far: a pipeline on §8.4's sync fast path that
    // *throws* never builds the race at all — the throw propagates straight to
    // the catch — and if the timer then fires while the error path is awaiting
    // a slow `onError` hook, `EXPIRED` rejects a promise nobody is listening
    // to. That is an unhandled rejection, which by default takes the process
    // down: the deadline crashing the process it exists to keep alive.
    //
    // A no-op handler marks it handled without consuming it; the race still
    // sees the rejection, because a promise may have any number of handlers.
    this.expiry.catch(() => {})

    this.#timer = setTimeout(() => {
      this.#timer = null
      if (this.done) return
      this.done = true
      this.expired = true
      // Abort first, then reject. The order is load-bearing: the dispatcher
      // wakes on the rejection and starts building a reply, and by then every
      // `fetch` and driver call holding this signal must already be cancelled,
      // or the request we just answered goes on paying for work.
      controller.abort(new ZenError(Codes.TIMEOUT, 'Request deadline exceeded', { status: 504 }))
      reject(EXPIRED)
    }, budgetMs)

    // A deadline must not keep a process alive on its own. If everything else
    // has finished, an in-flight request's timer is not a reason to stay up —
    // graceful shutdown (§4.5) is, and it has its own accounting.
    if (!keepAlive) this.#timer.unref?.()

    if (connSignal.aborted) this.#onConnAbort()
  }

  /** Remaining budget in ms. Negative once blown, which is worth seeing. */
  get left(): number {
    return this.at - performance.now()
  }

  /**
   * Stop the clock, and only the clock — called as the reply is handed to the
   * adapter.
   *
   * The deadline bounds stages 5–9 and not the write (§4.4), so the timer must
   * not fire once egress starts. The *connection* half must stay wired: a
   * streamed body — `ctx.stream()`, `ctx.sse()` — keeps the exchange open after
   * this point, and `ctx.signal` is the only way the code producing it learns
   * the client left. Removing the listener here, as `disarm` used to be called
   * here, made `ctx.signal` deaf to disconnects on every bounded streaming
   * route: an SSE subscription wired to it leaked for the life of the process.
   */
  settle(): void {
    this.#clear()
  }

  /**
   * Release the timer and the listener.
   *
   * Called from a `finally` on every path. Skipping it leaks one timer per
   * request — the failure mode is invisible under test and fatal at load, which
   * is why it is a `finally` and not a success-path call.
   */
  disarm(): void {
    this.#clear()
    this.#connSignal.removeEventListener('abort', this.#onConnAbort)
  }

  #clear(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * The report `onTimeout` hooks and `ZEN_TIMEOUT` carry — asked for only once
   * the deadline has expired.
   *
   * `elapsedMs` has the budget as its floor because two clocks are involved
   * and they do not agree. The timer runs on the event loop's clock, which
   * libuv caches for a whole iteration and keeps in whole milliseconds;
   * `performance.now()` does neither. So the timer can fire while
   * `performance.now()` still shows a sliver of budget left — Windows CI caught
   * 19.85 ms against a 20 ms budget — and "exceeded its 20 ms budget (19.9 ms
   * elapsed)" breaks `TimeoutInfo`'s "always ≥ `budgetMs`" and reads as
   * nonsense. The shortfall is skew between the clocks, not time the request
   * had left.
   */
  info(startTime: number, route: string | null): TimeoutInfo {
    const elapsed = performance.now() - startTime
    return {
      stage: this.stage,
      budgetMs: this.budgetMs,
      elapsedMs: elapsed < this.budgetMs ? this.budgetMs : elapsed,
      route,
    }
  }
}

/**
 * The effective budget for one request.
 *
 * The clamp is the only interesting line: an inbound header may **shorten** the
 * deadline and can never extend it. A caller with 400 ms left telling us so is
 * useful — we stop work that was going to be discarded, and we can pass a
 * truthful budget further down. A caller asking for an hour is either confused
 * or hostile, and in both cases the answer is the route's own number.
 */
export function budgetFor(
  routeMs: number,
  header: string | undefined,
  read: (name: string) => string | undefined,
): number {
  if (header === undefined) return routeMs
  const raw = read(header)
  if (raw === undefined) return routeMs
  const supplied = Number(raw)
  if (!Number.isFinite(supplied) || supplied <= 0) return routeMs
  return supplied < routeMs ? supplied : routeMs
}

/**
 * The reply for a request whose client is gone, or whose deadline already blew.
 *
 * Deliberately does **not** run the epilogue. `after` middleware is application
 * logic and §4.6 keeps application middleware off the failure path; the
 * transform hooks have nothing to transform. `onResponse` still fires, from the
 * dispatcher, because that is the phase whose entire contract is that it sees
 * everything — including the requests that ended badly, which are the ones
 * worth counting.
 *
 * Fresh each time rather than a frozen singleton: egress writes `content-length`
 * onto the reply it is given, and a shared reply would be a cross-request write.
 */
export function abandoned(): Reply {
  return new MutableReply(CLIENT_CLOSED, { kind: 'empty' })
}

/**
 * A blown deadline as an ordinary error.
 *
 * Reached only when no `onTimeout` hook answered. Going through `ZenError`
 * rather than writing a `Reply` directly is what puts a timeout on the same
 * footing as every other failure: error mappers apply, the RFC 9457 problem
 * document is the same shape, `onError` hooks see it, `onSend` stamps it, and a
 * client switching on `code` gets `ZEN_TIMEOUT` from a deadline exactly as it
 * gets `ZEN_VALIDATION` from a bad body (§I7).
 */
export function timeoutError(info: TimeoutInfo): ZenError {
  const status = TIMEOUT_STATUS[info.stage]
  const where = info.route ?? 'this request'
  return new ZenError(
    Codes.TIMEOUT,
    `${where} exceeded its ${format(info.budgetMs)} budget during the ${info.stage} stage ` +
      `(${format(info.elapsedMs)} elapsed).`,
    {
      status,
      expose: true,
      retryable: status === 504,
      // The stage goes to logs and metrics, never to the client: "which of our
      // stages was slow" is our operational detail, not the caller's business.
      meta: { stage: info.stage, budgetMs: info.budgetMs, elapsedMs: info.elapsedMs },
    },
  )
}

function format(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s` : `${ms.toFixed(0)}ms`
}
