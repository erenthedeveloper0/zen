import { Conflict, token } from '@visionpilot/zen'
import type { CheckoutInput, Order } from './schemas.ts'
import type { CatalogService } from '../catalog/index.ts'

export interface CheckoutService {
  place(input: CheckoutInput): Order
  readonly placed: readonly Order[]
}

export const CheckoutToken = token<CheckoutService>('checkout')

export function makeCheckout(catalog: CatalogService, nextId: () => string): CheckoutService {
  const placed: Order[] = []

  return {
    placed,
    place(input) {
      let totalCents = 0
      for (const line of input.lines) {
        const product = catalog.find(line.productId)
        // A domain failure with a stable code, so the error counter labels on
        // something a dashboard can group by (I7).
        if (product === undefined) throw new Conflict(`Product ${line.productId} is no longer available`)
        totalCents += product.priceCents * line.quantity
      }
      if (input.couponCode !== undefined) totalCents = Math.round(totalCents * 0.9)

      const order: Order = { id: nextId(), totalCents, lineCount: input.lines.length, status: 'accepted' }
      placed.push(order)
      return order
    },
  }
}
