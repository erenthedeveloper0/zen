import { z } from '../../shared/zod.ts'

/**
 * The schemas, written the way you would write them if the wire had types —
 * rfcs/0001 §11.4.
 *
 * **There is not one `z.coerce` in this file.** That is the entire point of the
 * feature, and it is worth looking at the diff it represents rather than the
 * code that is here. Every one of these declarations used to have to be written
 * twice: once as the type the handler wants, and once as the instruction to get
 * there from a string.
 *
 *     page:  z.coerce.number().int().min(1).default(1)      // before
 *     page:  z.number().int().min(1).default(1)             // now
 *
 * The saving is three tokens per field, which is not interesting. What is
 * interesting is what the first line *does* when somebody forgets it: nothing
 * visible. `?page=2` arrives as `'2'`, `'2' > 1` is true, the validator passes,
 * and the string reaches the database driver — which either coerces it back
 * (fine, until the day it doesn't) or builds `LIMIT '2'`. The failure of the
 * old form is silent, and the failure of this one is a boot-time plan you can
 * print (`npm run explain -w @visionpilot/zen-example-coercion`).
 */

/** Shared by both list endpoints, and the reason they behave identically. */
export const Pagination = z.object({
  page: z.number().int().min(1).default(1).meta({ description: 'One-based page number.' }),
  limit: z.number().int().min(1).max(100).default(20).meta({ description: 'Page size, 1–100.' }),
})

export const CatalogQuery = Pagination.extend({
  /**
   * `?inStock=true`, `?inStock=1`, `?inStock=on` — all three, because all three
   * are what real clients send. A checkbox posts `on`, a shell script writes
   * `1`, and a JSON-minded client writes `true`.
   */
  inStock: z.boolean().optional(),

  /**
   * `?tags=sale` and `?tags=sale&tags=new` both arrive as an array.
   *
   * The single-value case is the one worth pointing at. Every query parser in
   * every language produces a *string* for `?tags=sale` and an *array* for two
   * of them, so the handler that works in testing crashes in production the
   * first time a user filters on one tag. Here the schema says `array`, so it
   * is an array both times.
   */
  tags: z.array(z.string()).default([]),

  /**
   * Declared as a string, and therefore never touched.
   *
   * `?sku=00713` is the case that makes blanket coercion unacceptable. It looks
   * exactly like a number, it is not one, and a framework that guesses from the
   * *value* rather than the schema turns it into 713 and returns the wrong
   * product. Nothing here is clever enough to do that, because the plan is
   * built from the declared type and the declared type is `string`.
   */
  sku: z.string().optional(),

  /**
   * A union that includes a string, which is also never coerced — for the same
   * reason, one level less obviously. `?q=2024` may be a search for the text
   * "2024"; the schema accepts the string it arrived as, so there is nothing to
   * convert *to*.
   */
  q: z.union([z.string(), z.number()]).optional(),

  sort: z.enum(['price', 'name', 'rating']).default('name'),
})

/**
 * The legacy list endpoint's query — same shape, different wire convention.
 *
 * The schema is deliberately identical to `CatalogQuery`'s list field. What
 * differs is one line on the route, and that is the argument for making the
 * array style a *profile* rather than something you spell in the schema: how a
 * list is encoded is a property of the client, and the same `z.array(z.string())`
 * should not have to be rewritten because one caller uses commas.
 */
export const LegacyQuery = z.object({
  ids: z.array(z.number().int()).default([]),
})

/**
 * A form body — the one body shape that has the query string's problem.
 *
 * JSON bodies are never coerced (§11.4): `{"quantity": "2"}` against
 * `z.number()` is a client bug and reporting it is more useful than papering
 * over it. `application/x-www-form-urlencoded` *is* a query string, so this
 * route turns body coercion on, and turns on `emptyStringAsUndefined` with it —
 * an HTML form submits every untouched input as `''`, and without that switch
 * an optional note the user left blank arrives as an empty string rather than
 * as absent.
 */
export const OrderForm = z.object({
  quantity: z.number().int().min(1),
  giftWrap: z.boolean().default(false),
  note: z.string().max(200).optional(),
})

export const ProductView = z.object({
  sku: z.string(),
  name: z.string(),
  price: z.number(),
  rating: z.number(),
  inStock: z.boolean(),
  tags: z.array(z.string()),
})

export const CatalogView = z.object({
  items: z.array(ProductView),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  /** Echoed back so the example can show what the handler actually received. */
  applied: z.object({
    inStock: z.boolean().nullable(),
    tags: z.array(z.string()),
    sku: z.string().nullable(),
    sort: z.string(),
  }),
})

export const OrderView = z.object({
  sku: z.string(),
  quantity: z.number().int(),
  giftWrap: z.boolean(),
  note: z.string().nullable(),
  total: z.number(),
})

export type CatalogResult = z.infer<typeof CatalogView>
export type OrderResult = z.infer<typeof OrderView>
