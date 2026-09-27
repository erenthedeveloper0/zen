import { makeApp } from './app.ts'
import { config } from './config/observability.config.ts'

/**
 * `npm run example:observability`
 *
 * Then, in another terminal:
 *
 *   curl -i localhost:3000/products/1          # look at Server-Timing
 *   curl -sS localhost:3000/products/999       # a 404, still counted
 *   curl -sS localhost:3000/metrics            # the scrape
 *   curl -sS localhost:3000/products/1 -o /dev/null -w '%{time_total}\n'
 *
 * The thing to notice on `/metrics` is that `/products/1` and `/products/999`
 * are one series labelled `route="/products/:id<int>"`. The label comes from
 * the AppGraph via the `onRoute` hook, so the unbounded-cardinality mistake is
 * not something you have to remember not to make.
 */
const app = makeApp({ workUnits: 40 })
const handle = await app.listen({ port: config.port })

console.log(`
  listening on ${handle.url}

    GET  /products?limit=2&tag=desk
    GET  /products/:id
    POST /checkout
    GET  /admin/orders          (x-admin-key: ${config.adminKey})
    GET  ${config.metricsPath}
`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
