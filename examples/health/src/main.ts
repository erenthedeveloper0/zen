import { makeApp } from './app.ts'
import { config } from './config/health.config.ts'

/**
 * `npm run example:health`
 *
 * Then, in another terminal — the sequence is the demonstration:
 *
 *   curl -s  localhost:3000/healthz | jq       # liveness: pass, no dependency touched
 *   curl -s  localhost:3000/readyz  | jq       # readiness: pass, three components
 *
 *   # break the database. Readiness goes 503; liveness stays 200, because
 *   # restarting this pod would not bring the database back.
 *   curl -sX POST localhost:3000/control/db/down
 *   curl -si localhost:3000/readyz  | head -1
 *   curl -si localhost:3000/healthz | head -1
 *
 *   # break the cache instead. It is `critical: false`, so the report says
 *   # `warn` and the status stays 200 — a cold cache is slower, not broken.
 *   curl -sX POST localhost:3000/control/db/ok
 *   curl -sX POST localhost:3000/control/cache/down
 *   curl -s  localhost:3000/readyz | jq '.status, .checks.cache'
 *
 *   # make the payment gateway *hang*. This is the failure that takes down
 *   # health endpoints written by hand: it never answers, so a probe without
 *   # its own budget waits forever and the orchestrator eventually kills a
 *   # process that was perfectly alive. Here the check gives up at 600ms, the
 *   # endpoint answers, and the report names the culprit.
 *   curl -sX POST localhost:3000/control/payments/hang
 *   time curl -s localhost:3000/readyz | jq '.checks.payments'
 *
 * And the part you have to watch rather than read — press Ctrl-C and poll:
 *
 *   while true; do curl -s -o /dev/null -w '%{http_code} ' localhost:3000/readyz; sleep 0.5; done
 *
 * Readiness flips to 503 the instant shutdown begins, and the process keeps
 * answering for the whole drain window. That ordering is §4.5 step 1 and it is
 * the reason this feature exists: a service that stops accepting connections
 * and *then* reports itself unready has already 502'd everything the load
 * balancer sent in between.
 */
const { app } = makeApp()
const handle = await app.listen({ port: config.port })

console.log(`
  listening on ${handle.url}

    GET  /healthz         liveness   — process state only
    GET  /readyz          readiness  — lifecycle + db + cache + payments
    GET  /orders
    GET  /orders/:id
    POST /orders/:id/pay
    POST /control/:component/:fault    component: db | cache | payments
                                       fault:     ok | down | slow | hang

  drain window on shutdown: ${config.drainDelay}ms
`)

// The shutdown itself is `zen()`'s: it installs the process lifecycle when the
// app starts listening, so SIGTERM and SIGINT run §4.5's sequence and exit.
// This only narrates it, because watching /readyz go red while the socket is
// still open is what this example is for.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`\n  ${signal} — /readyz is now 503; draining for ${config.drainDelay}ms before the socket closes\n`)
  })
}
