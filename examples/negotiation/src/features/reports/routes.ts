import { NotFound, type Collection } from '@erenthedeveloper0/zen'
import { ProblemShape, Regions, SaleV1, SaleV2, SalesCsv, SalesQuery, SalesV1, SalesV2 } from './schemas.ts'
import type { Sale, SalesService } from './service.ts'

/** The media types this API speaks. Named once so nothing can misspell one. */
export const V1 = 'application/vnd.acme.sales.v1+json'
export const V2 = 'application/vnd.acme.sales.v2+json'
export const CSV = 'text/csv'

/**
 * One resource, three representations — rfcs/0001 §13.4.
 *
 * ### What the handler does *not* do
 *
 * There is no `if (accept.includes('csv'))`, no `res.format({...})`, no second
 * route, no `/v2/` prefix, and no `Vary` header written by hand. The handler
 * returns domain objects; the representation is a property of the *route*, and
 * the framework picked it at stage 5 — before this function ran, before the
 * query was validated, before anything was read.
 *
 * ### The one thing the handler does read
 *
 * `ctx.negotiated`, once, and only where the *shape* genuinely differs: v2
 * nests the owner and v1 does not, so one of them has to be built. That is a
 * real branch on a real difference, and it is the only kind this design leaves
 * you: the framework decides *which* representation, and the handler decides
 * what that representation contains.
 *
 * Note what happens if the branch is wrong. Returning a v2 object under the v1
 * media type does not send a v2 body — the compiled serializer for v1 drops
 * `currency` and would refuse the nested `owner`, because §13.3's guarantee
 * applies per representation. The contract is enforced, not documented.
 */
export function reportRoutes(reports: Collection, service: SalesService): void {
  /**
   * The list, in three representations.
   *
   * Declaration order is the server's preference: a client sending
   * `Accept: * / *` — or no `Accept` at all, which is what `curl` does — gets
   * v2. That is the right default for a browser poking at the API and it is
   * the wrong one to leave implicit, which is why the order here is a decision
   * rather than an accident of how the object was typed.
   */
  reports.get('/', {
    name: 'sales.list',
    query: SalesQuery,
    response: {
      200: {
        [V2]: SalesV2,
        [V1]: SalesV1,
        [CSV]: SalesCsv,
      },
    },
  }, function listSales(ctx) {
    // `?limit=10` is a number here because §11.4 read the schema. Nothing in
    // this file calls `Number()`.
    const sales = service.list(ctx.query.region, ctx.query.limit)
    return sales.map((sale) => project(sale, ctx.negotiated)) as never
  })

  /**
   * One sale, and a 404 that is deliberately **not** negotiated.
   *
   * The 200 uses the variant form; the 404 uses the plain form. So a client
   * asking for CSV gets CSV on success and `application/problem+json` on
   * failure — which is §12.1's one envelope, and is what every HTTP client in
   * existence already knows how to read.
   */
  reports.get('/:id<int>', {
    name: 'sales.get',
    response: {
      200: {
        [V2]: SaleV2,
        [V1]: SaleV1,
        [CSV]: SaleV1,
      },
      404: ProblemShape,
    },
  }, function getSale(ctx) {
    const sale = service.find(ctx.params.id)
    if (sale === undefined) throw new NotFound(`No sale ${ctx.params.id}`)
    return project(sale, ctx.negotiated) as never
  })

  /**
   * A route with **one** declared representation, for contrast.
   *
   * It is not negotiated: it reads no `Accept`, stages no `Vary`, and emits no
   * negotiation code — `npm run explain` shows the difference, and
   * `benchmarks/negotiation` gates on the two pipelines being byte-identical
   * to the ones an app with no negotiated route at all compiles.
   *
   * Ask it for CSV and it answers 200 with JSON. RFC 9110 §12.5.1 permits
   * exactly that, and the alternative — every route in every application
   * parsing `Accept` to discover it has nothing to decide — is the per-request
   * cost this framework exists to refuse.
   */
  reports.get('/regions', {
    name: 'sales.regions',
    response: { 200: Regions },
  }, function listRegions() {
    return service.regions as never
  })
}

/**
 * The domain object as one representation sees it.
 *
 * v1 and CSV are the same flat shape; v2 nests the owner and adds `currency`.
 * `internalMargin` is on the input and in none of the outputs — and it would be
 * dropped even if this function forgot, because no response schema declares it.
 * This function exists to get the *shape* right, not to enforce the contract;
 * the serializer does that (§13.3).
 */
function project(sale: Sale, media: string | null): unknown {
  if (media === V2) {
    return {
      id: sale.id,
      region: sale.region,
      owner: { id: sale.ownerId, name: sale.ownerName },
      amount: sale.amount,
      currency: sale.currency,
      closedAt: sale.closedAt,
    }
  }
  return {
    id: sale.id,
    region: sale.region,
    owner: sale.ownerName,
    amount: sale.amount,
    closedAt: sale.closedAt,
  }
}
