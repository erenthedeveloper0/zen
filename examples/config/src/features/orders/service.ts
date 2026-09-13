export interface Order {
  readonly id: number
  readonly customer: string
  readonly total: number
  readonly currency: string
}

/**
 * The feature, and the thing worth noticing about it: **it reads no
 * configuration and no environment.**
 *
 * §23.4's fourth lesson, from `examples/deadlines`: operational policy belongs
 * in the composition root, not in the feature that happens to need a number.
 * The page size arrives as an argument, so this function is correct whether the
 * operator configures twenty-five or one hundred, and it is testable without
 * standing up an application.
 *
 * The test of whether a concern is *configuration* is whether changing it means
 * editing a feature file. Nothing in this directory would change if `PAGE_SIZE`
 * did.
 */
const ORDERS: readonly Order[] = Array.from({ length: 87 }, (_, i) => ({
  id: i + 1,
  customer: `customer-${(i % 12) + 1}`,
  total: 1000 + i * 137,
  currency: 'EUR',
}))

export function listOrders(page: number, pageSize: number): {
  page: number
  pageSize: number
  total: number
  items: Order[]
} {
  const start = (page - 1) * pageSize
  return {
    page,
    pageSize,
    total: ORDERS.length,
    items: ORDERS.slice(start, start + pageSize) as Order[],
  }
}
