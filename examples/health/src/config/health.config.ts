import type { Duration } from '@visionpilot/zen'

/**
 * Configuration — a plain module until §16 lands.
 *
 * Same convention as `examples/openapi` and `examples/deadlines`: putting it in
 * `src/config/` now means that when `defineConfig` and env validation arrive,
 * this file gains a schema and none of its importers move.
 */
export const config = {
  port: Number(process.env['PORT'] ?? 3000),

  /**
   * How long the load balancer is given to notice `/readyz` has gone red before
   * the process stops accepting connections (§4.5 step 1).
   *
   * This is the number that decides whether a rolling deploy 502s. It has to be
   * longer than the *product* of the probe interval and the failure threshold
   * in your orchestrator: with `periodSeconds: 2, failureThreshold: 2` a pod is
   * only removed from the endpoints list four seconds after it first fails, so
   * a drain shorter than that stops accepting while traffic is still arriving.
   *
   * Five seconds against the 4 s worst case in the README's probe config, which
   * is thin on purpose — it should look thin, because in most deployments this
   * value is zero and nobody has done the arithmetic at all.
   */
  drainDelay: 5_000,

  /** How long in-flight requests get to finish once the socket stops accepting. */
  shutdownTimeout: 15_000,

  /**
   * An app-wide request budget (§4.4).
   *
   * Set here mostly to prove a composition: it does *not* apply to the health
   * endpoints, which refuse it, because a readiness probe bounded by the
   * service's own request timeout fails during exactly the incident it exists
   * to describe — and a 504 with an empty body names no dependency at all.
   */
  requestTimeout: '2s' as Duration,

  /**
   * Per-check budgets. Deliberately much shorter than the request budget: a
   * probe is not the work, it is the question "is the work possible", and a
   * dependency that needs longer than this to answer that has already answered.
   */
  checks: {
    db: '400ms' as Duration,
    cache: '200ms' as Duration,
    payments: '600ms' as Duration,
  },

  /**
   * How long a probe result is reused.
   *
   * One second, so the orchestrator, the load balancer and the metrics scraper
   * all polling at once cost one round trip — and a recovery is still visible
   * inside a single probe interval.
   */
  ttl: '1s' as Duration,

  /**
   * Whether a thrown probe error's text reaches the wire.
   *
   * `true` here because in this deployment the endpoints are cluster-internal.
   * The default is `false`, and the reason is that a driver's exception says
   * things like `getaddrinfo ENOTFOUND db-primary.internal` — which is topology,
   * published to whoever can reach the endpoint. Flip this off the moment
   * `/readyz` becomes routable from anywhere you do not control.
   */
  details: true,

  /** Simulated dependency latencies, in ms. */
  latency: {
    db: 4,
    cache: 1,
    payments: 40,
  },

  /**
   * What `fault: 'slow'` multiplies a dependency's latency by.
   *
   * Eight, so payments lands at 320 ms: above the 200 ms at which its check
   * warns, below the 600 ms at which it fails. That window is the whole point
   * of `warn` existing, and a fixture that overshot it would test the failure
   * case twice and the degraded case never.
   */
  slowFactor: 8,
} as const
