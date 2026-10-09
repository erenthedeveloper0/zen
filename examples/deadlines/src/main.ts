import { makeApp } from './app.ts'
import { config } from './config/deadlines.config.ts'

/**
 * `npm run example:deadlines`
 *
 * Then, in another terminal:
 *
 *   curl -i  localhost:3000/quotes                       # 200, partial, slow provider dropped
 *   curl -i  localhost:3000/quotes?providers=fast,steady # 200, complete
 *   curl -i  localhost:3000/quotes/best-effort           # 200 from onTimeout, x-degraded
 *   curl -i  localhost:3000/reports/quarterly            # inherits the 10s collection budget
 *   curl -i  localhost:3000/reports/status               # its own 250ms
 *   curl -N  localhost:3000/feed/live                    # timeout: false — streams to the end
 *   curl -sS localhost:3000/deadlines                    # which routes are bounded, and headroom
 *
 * And the propagation, which is the part a plain timeout cannot do:
 *
 *   curl -i localhost:3000/quotes -H 'x-request-timeout: 120'
 *
 * 120 ms is shorter than our 2 s, so it wins: after the 60 ms reserve the
 * providers get 60 ms, and `steady`'s 90 ms misses too. Try 60000
 * — it is longer, so it is ignored: a caller may hurry us, never delay us.
 *
 *   curl -i localhost:3000/quotes -H 'x-request-timeout: 60000'
 *
 * Watch `x-deadline-left-ms` on every response. That number, not a latency
 * chart, is what tells you a route is one bad Tuesday from timing out.
 */
const app = makeApp()
const handle = await app.listen({ port: config.port })

console.log(`
  listening on ${handle.url}

    default budget   ${config.requestTimeout}   (header: ${config.timeoutHeader}, shortens only)

    GET  /quotes?providers=fast,steady,slow
    GET  /quotes/best-effort
    GET  /reports/quarterly        10s   (collection)
    GET  /reports/status          250ms  (route)
    GET  /feed/live               none   (timeout: false)
    GET  /deadlines
`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
