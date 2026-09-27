import { jsonSchema } from '@erenthedeveloper0/zen'
import type { Collection } from '@erenthedeveloper0/zen'
import { callProvider } from '../../shared/upstream.ts'

/**
 * The routes that need a *different* budget, in both directions.
 *
 * Every real service has them, and the usual outcome is that one global timeout
 * is set to whatever the slowest endpoint needs — which means the other four
 * hundred routes are effectively unbounded. Declaring the exception on the
 * exception is the entire point of resolving deadlines through the scope chain.
 */

const ReportView = jsonSchema<{ rows: number; tookMs: number }>({
  title: 'Report',
  type: 'object',
  properties: { rows: { type: 'integer' }, tookMs: { type: 'integer' } },
  required: ['rows', 'tookMs'],
})

export function reportRoutes(c: Collection): void {
  // Inherits the collection's generous budget, declared in `app.ts`.
  c.get('/quarterly', {
    name: 'reports.quarterly',
    response: { 200: ReportView },
  }, async function buildQuarterly(ctx) {
    const started = performance.now()
    await callProvider('warehouse', { latencyMs: 120, budgetMs: ctx.timeLeft, signal: ctx.signal })
    return { rows: 4_812, tookMs: Math.round(performance.now() - started) }
  })

  // Tighter than its collection *and* than the app: a health-ish probe that
  // should fail fast rather than queue behind a warehouse query.
  c.get('/status', {
    name: 'reports.status',
    timeout: '250ms',
    response: { 200: ReportView },
  }, async function reportStatus(ctx) {
    const started = performance.now()
    await callProvider('warehouse-ping', { latencyMs: 10, budgetMs: ctx.timeLeft, signal: ctx.signal })
    return { rows: 0, tookMs: Math.round(performance.now() - started) }
  })
}
