import { z } from '../../shared/zod.ts'

export const OrderQuery = z.object({
  page: z.number().int().min(1).default(1),
  /**
   * No default, and no upper bound stated here.
   *
   * Both live in configuration: the default is `config.pagination.pageSize` and
   * the ceiling is `config.pagination.maxPageSize`, because "how many rows is
   * too many" is an operational decision and not a property of this endpoint.
   * The schema's job is to say the value is a positive integer; the operator's
   * job is to say how large it may be.
   *
   * Written as `z.number()` rather than `z.coerce.number()` because §11.4 reads
   * the declared type and converts `?page=2` on the way in — the two features
   * compose, and neither is aware of the other.
   */
  pageSize: z.number().int().min(1).optional(),
})

export const Order = z.object({
  id: z.number().int(),
  customer: z.string(),
  total: z.number().int(),
  currency: z.string(),
})

export const OrderPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  items: z.array(Order),
})
