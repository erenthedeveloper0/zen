import { definePlugin, token } from '@erenthedeveloper0/zen'
import type { Dependency } from '../shared/dependencies.ts'
import { config } from '../config/health.config.ts'

/**
 * A plugin that owns a connection, and therefore owns its check — §31.4, §10.2.
 *
 * This is the half of the design that decides whether health checks actually
 * get written. The application does not know how to probe someone else's
 * connection pool: it does not know what a cheap query looks like, what counts
 * as degraded, or what budget is reasonable. If the check has to be written by
 * the application, it either gets written badly or does not get written — and a
 * dependency nobody probes is one that takes the service down silently.
 *
 * So `Registrar.health` exists, the plugin publishes the answer, and the
 * service's only decision is whether to *require* it (`checks: ['payments']` at
 * the composition root).
 */

export const PaymentsToken = token<Dependency>('payments')

export interface PaymentsOptions {
  readonly client: Dependency
}

export const payments = definePlugin<PaymentsOptions, {}>({
  name: 'payments',
  version: '1.0.0',

  setup(app, options) {
    const client = options.client
    app.provide(PaymentsToken, { factory: () => client })

    app.health('payments', async (signal) => {
      const { latencyMs } = await client.query(signal)
      // A slow payment gateway is a real condition with a real consequence, and
      // it is not the same condition as an unreachable one. `warn` says so:
      // reported on the endpoint and on the dashboard, and still routed to,
      // because refusing all traffic because checkout is slow is worse than
      // being slow at checkout.
      return latencyMs > 200
        ? { status: 'warn' as const, message: `degraded: ${latencyMs.toFixed(0)}ms`, data: { latencyMs } }
        : { status: 'pass' as const, message: `${latencyMs.toFixed(0)}ms`, data: { latencyMs } }
    }, {
      // Shorter than the request budget, and shorter than the caller would
      // ever wait. A probe is the question "is this possible", not the work.
      timeout: config.checks.payments,
      description: 'third-party payment gateway',
    })
  },
})
