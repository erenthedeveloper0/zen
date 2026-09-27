import { zen } from '@erenthedeveloper0/zen'
import type { ZenApp } from '@erenthedeveloper0/zen'
import { z } from './shared/zod.ts'
import { config } from './config/coercion.config.ts'
import { catalogRoutes } from './features/catalog/index.ts'

/**
 * The composition root — rfcs/0001 §23.4, §11.4.
 *
 * Two apps are built here, and the second one is the argument.
 *
 * `makeApp()` is the service as you would write it today: schemas that declare
 * the types the handlers want, and nothing else. `makeLegacyApp()` is the same
 * service with coercion switched off and `z.coerce` written back into every
 * field — which is what every Zod-on-Express codebase looks like, and what this
 * one looked like before §11.4.
 *
 * They answer identically. `test/coercion.test.ts` asserts that on the same
 * requests, which is a stronger claim than "the feature works": it says the
 * feature is a *refactor* of something people already do by hand, and therefore
 * that adopting it cannot change behaviour. That is the bar a convenience has
 * to clear before it earns a default.
 */

export interface AppOptions {
  readonly quiet?: boolean
}

export function makeApp(options: AppOptions = {}): ZenApp {
  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    // Explicit, and identical to the defaults — see the note in the config.
    coercion: config.coercion as never,
  })

  app.collection('/catalog', { name: 'catalog', tags: ['catalog'] }, catalogRoutes)

  /**
   * A header list, which is where `arrays: 'comma'` earns its default.
   *
   * RFC 9110 says a list header is comma-separated, and Node folds repeated
   * headers into one comma-joined value before any framework sees them — so
   * `X-Feature: a` twice and `X-Feature: a,b` once are indistinguishable by the
   * time a handler runs. Splitting on commas is not a convenience here; it is
   * the only reading under which both spellings mean the same thing.
   */
  app.get('/features', {
    name: 'features',
    headers: z.object({ 'x-feature': z.array(z.string()).default([]) }),
  }, function readFeatures(ctx) {
    return { enabled: ctx.headers['x-feature'] }
  })

  return app
}

/**
 * The same service, written the way it had to be written before §11.4.
 *
 * Three differences, and only three:
 *
 *   1. `coercion: false` — the whole subsystem off, so this app compiles the
 *      pipelines it would have compiled in 0.1.
 *   2. every numeric and boolean field is `z.coerce.*`.
 *   3. `tags` needs `z.preprocess`, because `z.coerce` has no answer for the
 *      single-value-is-not-an-array problem at all. This is the part people
 *      write once per project, get subtly wrong, and copy forever — note that
 *      it has to handle `undefined`, a bare string and an existing array, and
 *      that nothing checks it does.
 *
 * The third one is the honest reason this feature was ranked above "config" and
 * below "middleware": `z.coerce.number()` is a papercut, and `?tags=sale`
 * arriving as a string when `?tags=sale&tags=new` arrives as an array is a bug.
 */
export function makeLegacyApp(options: AppOptions = {}): ZenApp {
  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    coercion: false,
  })

  const asArray = (value: unknown): unknown =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]

  const LegacyCatalogQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    inStock: z.preprocess(
      (v) => (v === undefined ? undefined : v === 'true' || v === '1' || v === 'yes' || v === 'on'),
      z.boolean().optional(),
    ),
    tags: z.preprocess(asArray, z.array(z.string()).default([])),
    sku: z.string().optional(),
    q: z.union([z.string(), z.number()]).optional(),
    sort: z.enum(['price', 'name', 'rating']).default('name'),
  })

  app.get('/catalog', { name: 'catalog.search', query: LegacyCatalogQuery }, function searchCatalog(ctx) {
    return {
      page: ctx.query.page,
      limit: ctx.query.limit,
      applied: {
        inStock: ctx.query.inStock ?? null,
        tags: ctx.query.tags,
        sku: ctx.query.sku ?? null,
        sort: ctx.query.sort,
      },
    }
  })

  return app
}

function quiet() {
  const noop = () => {}
  return {
    level: 'fatal' as const, child() { return this },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
}
