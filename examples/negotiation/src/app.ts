import { zen } from '@erenthedeveloper0/zen'
import './shared/zod.ts'
import './media/csv.ts'
import { SalesService, reportRoutes } from './features/reports/index.ts'

/**
 * The composition root — rfcs/0001 §23.4, §13.4.
 *
 * Two import lines carry the whole feature, and neither is a middleware.
 *
 * `./shared/zod.ts` registers the schema converter, so Zen can read a shape.
 * `./media/csv.ts` registers the `text/csv` encoder, so Zen can write one it
 * does not ship. Both are side-effecting imports and both must run **before
 * `ready()`**, because that is when the route's representations are compiled —
 * a media type with no encoder at that moment is a boot error naming the fix,
 * not a runtime surprise on the first export somebody tries.
 *
 * That ordering is the only sharp edge in this example, and it is sharp in the
 * safe direction: forget the import and the app refuses to start, with a
 * message naming the route, the status, the media type and the call to make.
 * The alternative — a lazy encoder registry — would boot fine and send a JSON
 * body under `Content-Type: text/csv`, which is discovered by whoever opens the
 * file, not by whoever deployed it.
 *
 * There is nothing else. No `app.use(negotiate())`, no `Vary` middleware, no
 * `format()` helper. Negotiation is a property of a route's response
 * declaration; a route that declares one representation is not negotiated and
 * pays nothing, and there is no app-level switch to get that wrong with.
 */

export interface AppOptions {
  readonly quiet?: boolean
  /** Keep the compiled source after boot, for `generatedSource()` — `inspect.ts` and the tests read it. */
  readonly inspect?: boolean
}

export function makeApp(options: AppOptions = {}) {
  const service = new SalesService()

  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    inspect: options.inspect === true,
    // §19.2 — a public service should bound its requests. Unrelated to
    // negotiation, and here because an example that would be unsafe to copy is
    // worse than no example.
    timeout: '10s',
  })

  app.collection('/api/sales', { name: 'sales', tags: ['sales'] }, (sales) => {
    reportRoutes(sales, service)
  })

  return { app, service }
}

function quiet() {
  const noop = () => {}
  return {
    level: 'fatal' as const, child() { return this },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
}
