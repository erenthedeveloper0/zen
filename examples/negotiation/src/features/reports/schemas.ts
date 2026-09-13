import { z } from '../../shared/zod.ts'

/**
 * One resource, three representations — rfcs/0001 §13.4.
 *
 * Two of them are the same JSON with different fields, which is the case that
 * needs no encoder at all: a `+json` vendor type is written by the compiled
 * serializer of §13.3 exactly like `application/json`, so **API versioning by
 * media type costs nothing this framework did not already own.** That is the
 * most common real reason to negotiate and it is the cheapest.
 *
 * The third is `text/csv`, which needs `src/media/csv.ts`.
 */

/** v1 — what shipped. `owner` is a bare string. */
export const SaleV1 = z.object({
  id: z.number().int(),
  region: z.string(),
  owner: z.string(),
  amount: z.number(),
  closedAt: z.string(),
})

/**
 * v2 — `owner` became an object, which is a breaking change.
 *
 * The reason this is worth showing: a client pinned to
 * `application/vnd.acme.sales.v1+json` keeps getting v1 from the same URL,
 * forever, with no `/v2/` prefix, no router entry and no branch in the handler.
 * The route declares both and the *negotiation* picks.
 */
export const SaleV2 = z.object({
  id: z.number().int(),
  region: z.string(),
  owner: z.object({ id: z.number().int(), name: z.string() }),
  amount: z.number(),
  currency: z.string(),
  closedAt: z.string(),
})

/** The flat shape the CSV columns come from — see `src/media/csv.ts`. */
export const SaleRow = z.object({
  id: z.number().int(),
  region: z.string(),
  owner: z.string(),
  amount: z.number(),
  closedAt: z.string(),
})

export const SalesV1 = z.array(SaleV1)
export const SalesV2 = z.array(SaleV2)
export const SalesCsv = z.array(SaleRow)

/** The one-representation route's contract — see `routes.ts`. */
export const Regions = z.array(z.string())

export const SalesQuery = z.object({
  region: z.string().optional(),
  /** A number on the wire only because §11.4 read the schema, not the value. */
  limit: z.number().int().min(1).max(500).default(50),
})

/**
 * The error envelope, declared in the **plain** form on purpose.
 *
 * A 404 is not one of the representations this resource has; it is RFC 9457's
 * problem document, and §12.1 says there is one envelope. Declaring it plainly
 * is how the route says "this status is not negotiated" — and the consequence
 * is visible on the wire: ask for CSV, get a 404, and the `Content-Type` is
 * `application/json`, not `text/csv`. A CSV parser handed a JSON problem
 * document reports a parse error at line 1, which is a much worse bug report
 * than a 404.
 */
export const ProblemShape = z.object({
  code: z.string(),
  detail: z.string(),
})
