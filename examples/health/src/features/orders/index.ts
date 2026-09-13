import type { Collection, Reply, Token } from 'zen'
import { PaymentsToken } from '../../plugins/payments.ts'
import type { Dependencies } from '../../shared/dependencies.ts'

/**
 * The API the service is ready *for* — rfcs/0001 §23.4.
 *
 * Deliberately ordinary. A health example whose only routes are health
 * endpoints proves nothing about the property that matters, which is that
 * `/readyz` gates traffic to *these*: when `db` is down this is what the load
 * balancer should stop sending you, and `/healthz` is what stops the
 * orchestrator killing you while you wait for it to come back.
 *
 * Note what these handlers do **not** do — check whether their dependencies are
 * healthy first. That is the readiness endpoint's job, one layer out, and a
 * handler that re-asks the question per request is how a service ends up
 * probing its database twice for every order it serves.
 */

interface Ctx {
  resolve<T>(token: Token<T>): T
  json<T>(body: T, init?: { status?: number }): Reply<T>
}

interface CtxWithId extends Ctx {
  readonly params: { readonly id: string }
}

export function orderRoutes(deps: Dependencies) {
  const unbounded = new AbortController().signal

  return (orders: Collection): void => {
    orders.get('/', async function listOrders(ctx: Ctx) {
      await deps.db.query(unbounded)
      return ctx.json({ orders: [{ id: 'ord_1', total: 4200 }, { id: 'ord_2', total: 1750 }] })
    })

    orders.get('/:id', async function getOrder(ctx: CtxWithId) {
      await deps.db.query(unbounded)
      return ctx.json({ id: ctx.params.id, total: 4200, currency: 'EUR' })
    })

    orders.post('/:id/pay', async function payOrder(ctx: CtxWithId) {
      const gateway = ctx.resolve(PaymentsToken)
      const { latencyMs } = await gateway.query(unbounded)
      return ctx.json({ id: ctx.params.id, paid: true, gatewayMs: Math.round(latencyMs) }, { status: 201 })
    })
  }
}
