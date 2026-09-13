import type { Collection } from 'zen'
import { NotFound } from 'zen'
import { CatalogQuery, CatalogView, LegacyQuery, OrderForm, OrderView, ProductView } from './schemas.ts'
import { byIds, find, search } from './service.ts'

/**
 * The catalogue endpoints — rfcs/0001 §11.4, §6.
 *
 * Read these handlers looking for the code that *is not here*. There is no
 * `Number(ctx.query.page)`, no `ctx.query.tags ?? []` followed by an
 * `Array.isArray` check, no `=== 'true'`. Every value arrives as the type the
 * schema declared, and the handler is the business logic and nothing else.
 */
export function catalogRoutes(c: Collection): void {
  /**
   * The endpoint the whole example exists for.
   *
   * `ctx.query` here is `{ page: number; limit: number; inStock?: boolean;
   * tags: string[]; sku?: string; q?: string | number; sort: 'price' | 'name' |
   * 'rating' }` — and it *was* that type before this feature existed, because
   * `InferQuery` has always read the schema's output. What changed is that the
   * runtime now agrees with it.
   *
   * That gap is the honest description of the papercut §11.4 closes: the types
   * were not wrong, they were unenforced, and TypeScript will not tell you that
   * `ctx.query.page` is a lie. It just is one, until the first `z.coerce`.
   */
  c.get('/', {
    name: 'catalog.search',
    query: CatalogQuery,
    response: { 200: CatalogView },
  }, function searchCatalog(ctx) {
    const { items, total } = search({
      page: ctx.query.page,
      limit: ctx.query.limit,
      ...(ctx.query.inStock === undefined ? {} : { inStock: ctx.query.inStock }),
      tags: ctx.query.tags,
      ...(ctx.query.sku === undefined ? {} : { sku: ctx.query.sku }),
      sort: ctx.query.sort,
    })

    return {
      items: items.map((p) => ({ ...p, tags: [...p.tags] })),
      page: ctx.query.page,
      limit: ctx.query.limit,
      total,
      applied: {
        inStock: ctx.query.inStock ?? null,
        tags: ctx.query.tags,
        sku: ctx.query.sku ?? null,
        sort: ctx.query.sort,
      },
    }
  })

  /**
   * The same list shape, for a client that sends `?ids=0,1,2`.
   *
   * One line of configuration, and it lives on the route rather than in the
   * schema — which is the design decision this endpoint exists to demonstrate.
   * `z.array(z.number())` describes what the *application* wants; `arrays:
   * 'comma'` describes what one *caller* sends. Putting the second inside the
   * first would mean a schema that cannot be shared between two clients that
   * disagree about a convention neither of them chose.
   *
   * It also reaches the generated OpenAPI document as `style: form, explode:
   * false`, from this same declaration — so a client generated against the
   * document sends what the server actually parses (§29.1 applied to
   * parameters). Nobody wrote that mapping twice.
   */
  c.get('/by-ids', {
    name: 'catalog.byIds',
    query: LegacyQuery,
    coercion: { query: { arrays: 'comma' } },
    response: { 200: ProductView.array() },
  }, function listByIds(ctx) {
    return byIds(ctx.query.ids).map((p) => ({ ...p, tags: [...p.tags] }))
  })

  /**
   * A form post — the one body that is coerced, and only because it is a query
   * string wearing a different content type.
   *
   * The profile is on the route rather than the app because the distinction
   * §11.4 draws is per-media-type and the profile is per-source: an app-wide
   * `body` profile would also coerce this service's JSON endpoints, which is
   * the thing the RFC's default is specifically protecting. Scoping it to the
   * one form route keeps the guarantee everywhere else.
   */
  c.post('/:sku/order', {
    name: 'catalog.order',
    body: OrderForm,
    coercion: { body: { numbers: true, booleans: true, emptyStringAsUndefined: true } },
    response: { 200: OrderView },
  }, function placeOrder(ctx) {
    const product = find(ctx.params.sku)
    if (product === undefined) throw new NotFound(`No product with SKU ${ctx.params.sku}`)

    return {
      sku: product.sku,
      quantity: ctx.body.quantity,
      giftWrap: ctx.body.giftWrap,
      note: ctx.body.note ?? null,
      total: product.price * ctx.body.quantity + (ctx.body.giftWrap ? 5 : 0),
    }
  })
}
