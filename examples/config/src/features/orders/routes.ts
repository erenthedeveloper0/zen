import type { Collection } from '@erenthedeveloper0/zen'
import { OrderPage, OrderQuery } from './schemas.ts'
import { listOrders } from './service.ts'
import type { AppConfig } from '../../config/types.ts'

/**
 * Orders — the feature that reads configuration, and reads it from `ctx`.
 *
 * `ctx.config` rather than an imported module, and the difference is not
 * stylistic:
 *
 *   - The module form makes the handler depend on a *file*, so testing it with
 *     a different page size means either mutating a module-level object or
 *     re-importing with a different environment. `ctx.config` makes it depend
 *     on the application, and `zen({ overrides: … })` in a test is one line
 *     (§16.1 layer 8, which exists for exactly this).
 *   - It is the same object every request sees, frozen once at boot. There is
 *     no per-request cost: `ctx.config` is a getter over the shared
 *     `ContextEnv`, and `benchmarks/config` asserts that against the generated
 *     bytes rather than against a clock.
 */
export function orderRoutes(orders: Collection): void {
  orders.get('/', {
    name: 'orders.list',
    query: OrderQuery,
    response: { 200: OrderPage },
  }, function listOrdersRoute(ctx) {
    const config = (ctx as unknown as { config: AppConfig }).config

    // The ceiling is the operator's, the request's preference is the client's,
    // and the default is the operator's too. Three sources, one line, and none
    // of them is `process.env`.
    const pageSize = Math.min(
      ctx.query.pageSize ?? config.pagination.pageSize,
      config.pagination.maxPageSize,
    )

    return listOrders(ctx.query.page, pageSize)
  })
}
