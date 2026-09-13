/**
 * A stand-in for something over the network — an HTTP call, a database query,
 * a gRPC round trip.
 *
 * It exists to make one property observable that a `setTimeout` in a test never
 * shows: **the call is actually cancelled.** Every real client that matters
 * takes an `AbortSignal` — `fetch`, `undici`, `pg`, `mongodb`, `ioredis`
 * (via its own mechanism) — and the whole point of `ctx.signal` being wired to
 * the deadline is that they all stop when it fires. `settled` below records
 * how each call ended, so a test can assert "the slow provider was aborted"
 * rather than "the response came back quickly", which is also what you observe
 * when the framework simply stopped waiting and left the work running.
 */

export interface UpstreamCall {
  readonly provider: string
  readonly outcome: 'ok' | 'aborted' | 'budget'
  readonly grantedMs: number
  readonly elapsedMs: number
}

export interface Quote {
  readonly provider: string
  readonly priceCents: number
  readonly latencyMs: number
}

export class UpstreamError extends Error {
  readonly provider: string
  readonly reason: 'aborted' | 'budget'

  constructor(provider: string, reason: 'aborted' | 'budget') {
    super(reason === 'aborted' ? `${provider}: request cancelled` : `${provider}: exceeded its slice of the budget`)
    this.provider = provider
    this.reason = reason
  }
}

/** Every call this process has made, for the tests and for `/upstreams`. */
export const settled: UpstreamCall[] = []

export interface CallOptions {
  readonly latencyMs: number
  /** The caller's remaining budget, already reduced to this call's slice. */
  readonly budgetMs: number
  /** `ctx.signal` — client disconnect *or* the request deadline. */
  readonly signal: AbortSignal
}

/**
 * Call a provider, giving it a slice of the request's remaining budget.
 *
 * Two independent ways to lose, and they are genuinely different events:
 *
 *   - `budget` — this call ran out of *its* slice. The request may still have
 *     time left, and the right move is usually to carry on without this one.
 *   - `aborted` — the *request* is over. Nothing further is worth doing.
 *
 * Collapsing them into one "timeout" is how a service ends up retrying a
 * provider on behalf of a client that hung up ninety seconds ago.
 */
export function callProvider(provider: string, opts: CallOptions): Promise<Quote> {
  const started = performance.now()

  return new Promise<Quote>((resolve, reject) => {
    const finish = (outcome: UpstreamCall['outcome'], settle: () => void): void => {
      clearTimeout(work)
      if (budget !== null) clearTimeout(budget)
      opts.signal.removeEventListener('abort', onAbort)
      settled.push({
        provider,
        outcome,
        grantedMs: Number.isFinite(opts.budgetMs) ? Math.round(opts.budgetMs) : -1,
        elapsedMs: Math.round(performance.now() - started),
      })
      settle()
    }

    const onAbort = (): void => {
      finish('aborted', () => { reject(new UpstreamError(provider, 'aborted')) })
    }

    const work = setTimeout(() => {
      finish('ok', () => {
        resolve({ provider, priceCents: 1000 + provider.length * 37, latencyMs: opts.latencyMs })
      })
    }, opts.latencyMs)

    // `ctx.timeLeft` is `Infinity` on a route that declared no deadline, and a
    // slice of infinity is still infinity. Arming a timer for it is not merely
    // pointless — `setTimeout(fn, Infinity)` is *clamped to 1 ms* by Node with
    // only a warning, so the unbounded case would become the fastest possible
    // failure. Guarding it is what makes "no deadline" mean no deadline.
    const budget = Number.isFinite(opts.budgetMs)
      ? setTimeout(() => {
          finish('budget', () => { reject(new UpstreamError(provider, 'budget')) })
        }, Math.max(0, opts.budgetMs))
      : null

    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function resetUpstreams(): void {
  settled.length = 0
}
