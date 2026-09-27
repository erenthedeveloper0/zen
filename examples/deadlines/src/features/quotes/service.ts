import { token } from '@erenthedeveloper0/zen'
import { callProvider, UpstreamError, type Quote } from '../../shared/upstream.ts'
import { config, type ProviderName } from '../../config/deadlines.config.ts'

/**
 * A fan-out under a shared budget.
 *
 * This is the shape deadlines exist for, and the shape a *timeout* cannot
 * express. A timeout is a duration — "thirty seconds" — and a service that
 * forwards its own timeout to each of three sequential calls has silently
 * promised ninety. A deadline is an instant, so `ctx.timeLeft` shrinks as the
 * request proceeds and every downstream call is told the truth.
 *
 * Two things are being demonstrated:
 *
 *   1. **Slicing.** Each provider gets the remaining budget minus a reserve for
 *      our own epilogue. Handing every provider the *whole* remaining budget is
 *      the classic bug: the slowest one consumes it all, and the request times
 *      out after having done every bit of the work.
 *   2. **Partial results.** A provider that misses its slice is dropped, not
 *      waited for. Three quotes is better than three quotes and a 504.
 */

export interface QuoteResult {
  readonly quotes: readonly Quote[]
  readonly missed: readonly string[]
  readonly budgetMs: number
}

export interface QuoteService {
  gather(timeLeft: number, signal: AbortSignal, providers: readonly ProviderName[]): Promise<QuoteResult>
}

export const QuoteToken = token<QuoteService>('quotes.service')

export function makeQuotes(): QuoteService {
  return {
    async gather(timeLeft, signal, providers) {
      // `timeLeft` is `Infinity` on a route with no deadline, and the arithmetic
      // still works — which is why it is `Infinity` and not `null`. A route that
      // opted out gives every provider an unbounded slice, which is exactly what
      // opting out means.
      const slice = timeLeft - config.egressReserveMs

      const results = await Promise.allSettled(providers.map((name) =>
        callProvider(name, {
          latencyMs: config.providers[name],
          budgetMs: slice,
          signal,
        })))

      const quotes: Quote[] = []
      const missed: string[] = []
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') quotes.push(result.value)
        else missed.push(nameOf(result.reason, providers[i] as string))
      })

      return { quotes, missed, budgetMs: Math.round(Number.isFinite(slice) ? slice : -1) }
    },
  }
}

function nameOf(reason: unknown, fallback: string): string {
  return reason instanceof UpstreamError ? reason.provider : fallback
}
