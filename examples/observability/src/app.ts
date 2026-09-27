import { zen, Forbidden } from '@erenthedeveloper0/zen'
import type { Reply, ZenApp } from '@erenthedeveloper0/zen'
import { observability, type RequestLine } from './plugins/observability.ts'
import { CatalogToken, catalogRoutes, makeCatalog } from './features/catalog/index.ts'
import { CheckoutToken, checkoutRoutes, makeCheckout } from './features/checkout/index.ts'
import { config } from './config/observability.config.ts'

/**
 * The composition root — rfcs/0001 §23.4.
 *
 * Everything that decides *how the application is assembled* lives here, and
 * nothing that decides what it does. Reading this file top to bottom should
 * tell you the whole shape of the process: which plugins are on, what runs on
 * every request, and where the features are mounted.
 *
 * The three hook scopes of §9.3 are all visible in this one file, which is the
 * point of the design: whether a registration applies to everything, to a
 * subtree, or to one route is determined by the indentation of the line you are
 * reading, not by whether something was wrapped in a helper elsewhere (§10.3).
 */
export interface AppOptions {
  /** Injected so tests can assert on the log line instead of scraping stdout. */
  readonly onRequestLine?: (line: RequestLine) => void
  /** Simulated per-query cost, so the `handler` stage is not always 0.000 ms. */
  readonly workUnits?: number
  readonly quiet?: boolean
}

export function makeApp(options: AppOptions = {}): ZenApp {
  const app = zen(options.quiet === true ? { logger: quiet() } : {})

  // ── global scope: everything, including 404s ───────────────────────────
  app.use(observability, {
    path: config.metricsPath,
    serverTiming: config.serverTiming,
    log: options.onRequestLine ?? defaultLog,
  })

  // A global transform hook. It runs on every JSON response, and it is the
  // clearest demonstration of §13.3 holding regardless: a route with a
  // response schema still emits exactly its declared fields afterwards,
  // because the serializer is bound after the transform hooks, not before.
  app.hook('onSerialize', function stampGeneration(_ctx: unknown, payload: unknown) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return
    return { ...payload, generatedBy: config.release }
  })

  let counter = 0
  const catalog = makeCatalog(options.workUnits ?? 0)
  app.provide(CatalogToken, () => catalog)
  app.provide(CheckoutToken, () => makeCheckout(catalog, () => `ord_${++counter}`))

  // ── collection scope: a subtree, and only that subtree ─────────────────
  app.collection('/products', { name: 'catalog', tags: ['catalog'] }, catalogRoutes)
  app.collection('/checkout', { name: 'checkout', tags: ['checkout'] }, checkoutRoutes)

  app.collection('/admin', {
    name: 'admin',
    tags: ['admin'],
    // Declared with the collection rather than added inside it, because "every
    // route under /admin is audited" is a property of the subtree and should
    // read as one. Express cannot express this: its response middleware is
    // global-by-position, so the equivalent is a path check inside a global
    // handler that every other route also pays for.
    hooks: {
      onRequest: function requireAdminKey(ctx) {
        if ((ctx as unknown as { headers: Record<string, string | undefined> }).headers['x-admin-key'] !== config.adminKey) {
          throw new Forbidden('This endpoint requires an admin key')
        }
      },
      onResponse: function auditLog(ctx, reply) {
        audit.push({
          route: (ctx as unknown as { route: { path: string } | null }).route?.path ?? '?',
          status: reply.status,
        })
      },
    },
  }, (admin) => {
    admin.get('/orders', { name: 'admin.orders' }, function listOrders(ctx) {
      return { orders: ctx.resolve(CheckoutToken).placed }
    })

    admin.get('/audit', { name: 'admin.audit' }, function readAudit() {
      return { entries: audit }
    })
  })

  return app
}

/** Where the collection-scoped audit hook writes. Module state, on purpose:
 *  the example is a single process and a store would obscure the hook. */
export const audit: Array<{ route: string; status: number }> = []

function defaultLog(line: RequestLine): void {
  const stages = Object.entries(line.stages)
    .filter(([, ms]) => ms > 0)
    .map(([name, ms]) => `${name}=${ms.toFixed(2)}`)
    .join(' ')
  console.log(
    `${line.method} ${line.route} ${line.status} ${line.durationMs.toFixed(2)}ms ` +
    `${stages} id=${line.requestId}`,
  )
}

function quiet() {
  const noop = () => {}
  return { level: 'fatal' as const, child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
}

export type { Reply }
