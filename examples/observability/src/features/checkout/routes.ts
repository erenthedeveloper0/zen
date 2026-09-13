import type { Collection } from 'zen'
import { CheckoutToken } from './service.ts'
import { CheckoutBody, OrderView } from './schemas.ts'

/**
 * One POST, with a body and a real validator — so the `parse` and `validate`
 * stages of the `Server-Timing` header have something to report.
 *
 * The `onParse` hook in the observability plugin only exists on this route:
 * intake is emitted into the pipeline solely because the route declares a body
 * (§4.2 stage 6), and a parse hook cannot resurrect a stage that is not there.
 * The catalog routes pay nothing for it.
 */
export function checkoutRoutes(c: Collection): void {
  c.post('/', {
    name: 'checkout.place',
    body: CheckoutBody,
    response: { 201: OrderView },
  }, function placeOrder(ctx) {
    const order = ctx.resolve(CheckoutToken).place(ctx.body)
    // Staged, not sent: egress applies it later, and the response contract
    // reads the staged status so the 201 gets the 201 serializer (§13.6).
    ctx.res.status(201).header('location', `/checkout/${order.id}`)
    return order
  })
}
