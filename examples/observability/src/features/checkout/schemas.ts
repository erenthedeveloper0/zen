import { z } from 'zod'
import { jsonSchema } from 'zen'

/**
 * A body big enough for the `validate` stage to register on the clock.
 *
 * That is not padding: an example where every stage measures 0.000 ms proves
 * nothing about per-stage attribution. Twenty lines with per-item refinements
 * is also roughly what a real checkout payload looks like.
 */
export const CheckoutBody = z.object({
  customer: z.object({
    email: z.email(),
    name: z.string().min(1).max(120),
    country: z.string().length(2),
  }),
  lines: z.array(z.object({
    productId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(99),
  })).min(1).max(20),
  couponCode: z.string().regex(/^[A-Z0-9-]{4,16}$/).optional(),
  note: z.string().max(500).optional(),
})

export type CheckoutInput = z.infer<typeof CheckoutBody>

export interface Order {
  readonly id: string
  readonly totalCents: number
  readonly lineCount: number
  readonly status: 'accepted'
}

export const OrderView = jsonSchema<Order>({
  title: 'Order',
  type: 'object',
  properties: {
    id: { type: 'string' },
    totalCents: { type: 'integer' },
    lineCount: { type: 'integer' },
    status: { const: 'accepted' },
  },
  required: ['id', 'totalCents', 'lineCount', 'status'],
})
