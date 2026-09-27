import { slot } from '@visionpilot/zen'
import type { Collection, Reply, TimeoutInfo } from '@visionpilot/zen'
import { QuoteToken } from './service.ts'
import { QuoteEnvelopeView, QuoteQuery } from './schemas.ts'
import type { Quote } from '../../shared/upstream.ts'

/**
 * Whatever arrived by the time the deadline blew.
 *
 * A slot rather than a mutated context (§7.4): declared once, typed at both
 * ends, an integer index into the context's slot array. This is what an
 * `onTimeout` hook has to read from, because by the time it runs the handler's
 * stack is gone — the request was abandoned mid-`await`, and the only state
 * that survives is state that was written somewhere the context can see.
 */
export const Gathered = slot<Quote[]>('quotes.gathered', { default: () => [] })

export function quoteRoutes(c: Collection): void {
  /**
   * The fan-out. Each provider gets a slice of `ctx.timeLeft`, the slow one
   * misses it, and the answer goes out with the two that arrived.
   *
   * Nothing here mentions a timeout. The budget arrived as a value on the
   * context, from a `timeout` declared on the collection in `app.ts` — which
   * means the same handler is correct whether the operator configures two
   * seconds or twenty.
   */
  c.get('/', {
    name: 'quotes.gather',
    query: QuoteQuery,
    response: { 200: QuoteEnvelopeView },
  }, async function gatherQuotes(ctx) {
    const result = await ctx.resolve(QuoteToken).gather(ctx.timeLeft, ctx.signal, ctx.query.providers)
    return {
      quotes: result.quotes,
      missed: result.missed,
      partial: result.missed.length > 0,
      budgetMs: result.budgetMs,
    }
  })

  /**
   * The same fan-out with no slicing — every provider gets the whole request,
   * so the slow one takes the whole request down with it.
   *
   * Then `onTimeout` serves what did arrive. This is the phase earning its
   * place in the lifecycle: a 200 with two of three quotes and `partial: true`
   * is a better answer than a 504, and there is no other point in the request
   * where it can be produced — the handler is suspended on an `await` that will
   * not return, and middleware has already been left behind.
   */
  c.get('/best-effort', {
    name: 'quotes.bestEffort',
    query: QuoteQuery,
    response: { 200: QuoteEnvelopeView },
    hooks: {
      onTimeout: function serveWhatArrived(ctx, info: TimeoutInfo): Reply {
        const gathered = ctx.get(Gathered)
        return ctx.json({
          quotes: gathered,
          missed: [`deadline blown during ${info.stage} after ${Math.round(info.elapsedMs)}ms`],
          partial: true,
          budgetMs: Math.round(info.budgetMs),
        }, { status: 200, headers: { 'x-degraded': 'deadline' } })
      },
    },
  }, async function gatherBestEffort(ctx) {
    // Deliberately no reserve and no slice: the providers are given the whole
    // request and the slow one will outlive it.
    const service = ctx.resolve(QuoteToken)
    const gathered = ctx.get(Gathered)

    await Promise.all(ctx.query.providers.map(async (name) => {
      const one = await service.gather(Infinity, ctx.signal, [name])
      // Written to the slot as each one lands, so the timeout hook can find
      // them. A handler that only returns at the end has nothing to hand over.
      gathered.push(...one.quotes)
    }))

    return { quotes: gathered, missed: [], partial: false, budgetMs: -1 }
  })
}
