import { NotFound, token } from '@erenthedeveloper0/zen'
import type { Clock } from '../../shared/clock.ts'
import type { UserRepo, UserRow } from '../users/service.ts'
import type { NewOrderIn } from './schemas.ts'

export interface OrderRow {
  readonly id: number
  readonly status: 'pending' | 'paid' | 'shipped' | 'cancelled'
  readonly customer: UserRow
  readonly lines: readonly { sku: string; quantity: number; unitPriceCents: number }[]
  readonly totalCents: number
  readonly placedAt: string
  /** Internal. Never declared in a response schema, therefore never emitted. */
  readonly marginCents: number
  readonly fraudScore: number
}

export interface OrderRepo {
  list(): OrderRow[]
  find(id: number): OrderRow | undefined
  create(input: NewOrderIn): OrderRow
}

export const OrderRepoToken = token<OrderRepo>('orders.repo')

/**
 * `deps: [ClockToken, UserRepoToken]` is declared in `app.ts`, not reflected
 * from this signature — which is what lets `ready()` detect a cycle or a captive
 * dependency before the first request (§15.4).
 */
export function inMemoryOrderRepo(clock: Clock, users: UserRepo): OrderRepo {
  let nextId = 1
  const rows = new Map<number, OrderRow>()

  const build = (customer: UserRow, lines: NewOrderIn['lines']): OrderRow => {
    const totalCents = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0)
    return {
      id: nextId++,
      status: 'pending',
      customer,
      lines,
      totalCents,
      placedAt: clock.now().toISOString(),
      marginCents: Math.round(totalCents * 0.31),
      fraudScore: 0.02,
    }
  }

  const seedCustomer = users.find(1)
  if (seedCustomer !== undefined) {
    const seeded = build(seedCustomer, [{ sku: 'ZEN-001', quantity: 2, unitPriceCents: 1500 }])
    rows.set(seeded.id, seeded)
  }

  return {
    list: () => [...rows.values()],
    find: (id) => rows.get(id),
    create(input) {
      const customer = users.find(input.customerId)
      if (customer === undefined) throw new NotFound(`User ${input.customerId} not found`)
      const created = build(customer, input.lines)
      rows.set(created.id, created)
      return created
    },
  }
}
