import { zen, healthPlugin, nodeAdapter } from '@erenthedeveloper0/zen'
import type { CheckOutcome, Reply, ZenApp } from '@erenthedeveloper0/zen'
import { config } from './config/health.config.ts'
import { makeDependencies, type ComponentName, type Dependencies, type Fault } from './shared/dependencies.ts'
import { payments } from './plugins/payments.ts'
import { orderRoutes } from './features/orders/index.ts'

/**
 * The composition root — rfcs/0001 §23.4, §31.4, §4.5.
 *
 * Read top to bottom, this file is the service's entire answer to two
 * questions an orchestrator asks it several times a second:
 *
 *   - **"Should I restart you?"** — `/healthz`. Answered from process state
 *     alone. Nothing below adds a dependency to it, and that is deliberate
 *     rather than an omission: a liveness probe that watches the database says
 *     "restart me" when the database is down, every pod says it at once, and
 *     the fleet spends the outage crash-looping instead of waiting. Restarting
 *     also guarantees the connection pools never get to reconnect.
 *   - **"Should I send you traffic?"** — `/readyz`. Answered from the lifecycle
 *     state *and* the dependencies, because both can make this instance the
 *     wrong one to route to.
 *
 * Getting those two the wrong way round is the most expensive configuration
 * mistake in a Kubernetes deployment, and it is one word apart in YAML. The
 * framework's contribution is that the safe assignment is the default: a check
 * is readiness unless it says `kind: 'liveness'`, so the dangerous version is
 * the one that has to be written on purpose.
 */

export interface AppOptions {
  readonly quiet?: boolean
  /** Keep the compiled source after boot, for `generatedSource()` — `inspect.ts` and the tests read it. */
  readonly inspect?: boolean
  /** Tests set this to 0 so a suite does not sit through a real drain. */
  readonly drainDelay?: number
  readonly ttl?: string
}

export interface HealthApp {
  readonly app: ZenApp
  readonly deps: Dependencies
}

export function makeApp(options: AppOptions = {}): HealthApp {
  const deps = makeDependencies()

  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    inspect: options.inspect === true,
    // §4.5 — the drain delay is the load balancer's window to notice `/readyz`
    // has gone red. `app.close()` flips readiness *before* handing control to
    // the adapter, so this whole delay is spent unready and still answering,
    // which is the point.
    adapter: nodeAdapter({
      drainDelay: options.drainDelay ?? config.drainDelay,
      shutdownTimeout: config.shutdownTimeout,
    }),
    timeout: config.requestTimeout,
    health: {
      ttl: (options.ttl ?? config.ttl) as never,
      details: config.details,
    },
  })

  // `checks` is an assertion, not a filter: if the `payments` plugin were
  // removed, or renamed its check, this app would refuse to boot rather than
  // quietly serving 200s for a dependency nothing probes (§9.7's principle,
  // applied to dependencies instead of hook phases).
  app.use(healthPlugin, {
    path: '/healthz',
    readiness: '/readyz',
    checks: ['db', 'payments'],
    info: { service: 'orders', version: process.env['GIT_SHA'] ?? 'dev' },
  })

  app.use(payments, { client: deps.payments })

  // ── readiness: the things that make serving a request possible ──────────

  app.health('db', async (signal) => {
    const { latencyMs } = await deps.db.query(signal)
    return { status: 'pass', message: `${latencyMs.toFixed(1)}ms`, data: { latencyMs } }
  }, {
    timeout: config.checks.db,
    description: 'primary postgres',
  })

  // Non-critical, and that is the whole reason `critical` exists. A cold cache
  // is slower, not broken. Taking this instance out of the load balancer
  // because Redis is down converts a latency problem into an availability
  // problem — and a service where every check is load-bearing is a service
  // where people stop adding checks.
  app.health('cache', async (signal) => {
    await deps.cache.query(signal)
  }, {
    timeout: config.checks.cache,
    critical: false,
    description: 'redis, read-through cache',
  })

  // ── liveness: the one check that is allowed here, and it can only warn ────

  app.health('event-loop', eventLoopLag, {
    kind: 'liveness',
    description: 'scheduler delay — never touches a dependency',
  })

  // ── the API, and the switchboard that makes the example demonstrable ─────

  app.collection('/orders', { name: 'orders', tags: ['orders'] }, orderRoutes(deps))

  app.post('/control/:component/:fault', {
    name: 'control',
    meta: { hidden: true },
  }, function breakThings(ctx: ControlContext) {
    const component = ctx.params.component as ComponentName
    const fault = ctx.params.fault as Fault
    deps.set(component, fault)
    return ctx.json({ faults: deps.faults })
  })

  return { app, deps }
}

/**
 * The only honest liveness check, and it can only ever warn.
 *
 * It measures scheduler delay: how long a zero-delay timer actually took. That
 * is a real signal — a saturated event loop is the shape of a wedged Node
 * process — but notice what it cannot do. If the loop were genuinely blocked,
 * this handler would not run, the HTTP response would not be written, and the
 * orchestrator's own probe would time out and restart the pod. The failure this
 * check is looking for makes the response *impossible*, not negative.
 *
 * So returning `fail` here would be theatre. What it can do is warn early,
 * while the loop is merely struggling, which is when the information is still
 * worth something.
 */
async function eventLoopLag(): Promise<CheckOutcome> {
  const started = performance.now()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const lagMs = performance.now() - started

  return lagMs > 250
    ? { status: 'warn', message: `scheduler delay ${lagMs.toFixed(0)}ms`, data: { lagMs } }
    : { status: 'pass', message: `${lagMs.toFixed(1)}ms`, data: { lagMs } }
}

interface ControlContext {
  readonly params: { readonly component: string; readonly fault: string }
  json<T>(body: T): Reply<T>
}

function quiet() {
  const noop = () => {}
  return {
    level: 'fatal' as const, child() { return this },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
}
