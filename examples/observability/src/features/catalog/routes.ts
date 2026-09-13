import { NotFound } from 'zen'
import type { Collection } from 'zen'
import { CatalogToken } from './service.ts'
import { ListQuery, ProductList, ProductView } from './schemas.ts'

/**
 * The catalog routes.
 *
 * Nothing here knows the observability plugin exists — which is the test of
 * whether cross-cutting concerns were actually kept cross-cutting. There is no
 * `withMetrics(handler)` wrapper, no `logger.info` at the top of each handler,
 * and no timing middleware to remember to register.
 */
export function catalogRoutes(c: Collection): void {
  // Named function expressions, not arrows: `explainRoute` prints the handler
  // name, and "anonymous" in the one line a reader was looking for defeats the
  // point of printing the chain at all.
  c.get('/', {
    name: 'catalog.list',
    query: ListQuery,
    response: { 200: ProductList },
  }, function listProducts(ctx) {
    return ctx.resolve(CatalogToken).list(ctx.query.limit, ctx.query.tag)
  })

  c.get('/:id<int>', {
    name: 'catalog.show',
    response: { 200: ProductView },
    // A route-scoped hook — the innermost of the three scopes (§9.3). It runs
    // after every global and collection hook on the way in, and before them on
    // the way out.
    hooks: {
      onSend: function cacheForAMinute(_ctx, reply) {
        reply.headers.set('cache-control', 'public, max-age=60')
      },
    },
  }, function showProduct(ctx) {
    const row = ctx.resolve(CatalogToken).find(ctx.params.id)
    if (row === undefined) throw new NotFound(`No product with id ${ctx.params.id}`)
    // `costCents` and `supplier` are on the row and are not in ProductView, so
    // the compiled serializer drops them (§13.3). The `onSerialize` hook in
    // app.ts cannot put them back either — the contract is bound after it.
    return row
  })
}
