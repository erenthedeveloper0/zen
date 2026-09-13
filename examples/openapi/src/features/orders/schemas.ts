import { z } from '../../shared/zod.ts'
import { PublicUser } from '../users/schemas.ts'

/**
 * A second feature, so the document has something to compose.
 *
 * `Order.customer` reuses `PublicUser` — the *same object*, imported. The
 * generator's identity pass recognises that and emits one `$ref`, so the
 * generated client gets `Order.customer: PublicUser` rather than a structurally
 * identical `OrderCustomer` type that drifts the first time someone edits one
 * of them (§29.3).
 */

export const OrderStatus = z.enum(['pending', 'paid', 'shipped', 'cancelled'])

export const OrderLine = z.object({
  sku: z.string().meta({ description: 'Stock-keeping unit.' }),
  quantity: z.int().min(1),
  unitPriceCents: z.int().min(0),
}).meta({ id: 'OrderLine', title: 'OrderLine' })

export const Order = z.object({
  id: z.int(),
  status: OrderStatus,
  customer: PublicUser,
  lines: z.array(OrderLine),
  totalCents: z.int(),
  placedAt: z.iso.datetime(),
}).meta({ id: 'Order', title: 'Order' })

export const NewOrder = z.object({
  customerId: z.int(),
  lines: z.array(OrderLine).min(1),
}).meta({ id: 'NewOrder', title: 'NewOrder' })

export type OrderOut = z.infer<typeof Order>
export type NewOrderIn = z.input<typeof NewOrder>
