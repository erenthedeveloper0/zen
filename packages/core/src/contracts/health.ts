import type { Duration } from '../primitives/time.ts'
import type { MaybePromise } from './route.ts'

/**
 * Health and readiness — rfcs/0001 §31.4.
 *
 * Two endpoints that look identical and answer different questions:
 *
 *   - **Liveness** — "should the orchestrator restart me?"
 *   - **Readiness** — "should the load balancer send me traffic?"
 *
 * Conflating them is why deployments 502, and it fails in both directions.
 * A readiness probe that ignores dependencies routes traffic to a pod whose
 * database connection has not opened yet. A liveness probe that *checks* them
 * restarts every pod in the fleet the moment the database blips, converting a
 * partial outage into a total one — and then the restarts prevent the pool from
 * ever reconnecting. The second failure is rarer, worse, and much harder to
 * diagnose, which is why the default here is that a check is readiness-only and
 * putting one in liveness takes an explicit `kind: 'liveness'`.
 *
 * The wire format is `application/health+json`
 * (draft-inadarei-api-health-check), for the same reason errors are RFC 9457
 * (§12.6): an existing format everything already understands beats a
 * hand-rolled `{ ok: true }` that every consumer has to be taught.
 */

/**
 * `pass` · `warn` · `fail`, from the health-check draft.
 *
 * `warn` exists so a non-critical dependency can be *reported* as down without
 * taking the service out of the load balancer. Without it every check is
 * load-bearing, so people stop adding checks, and the endpoint stops describing
 * the service.
 */
export type HealthStatus = 'pass' | 'warn' | 'fail'

/**
 * Where the process is in its own lifecycle — §4.5.
 *
 * `draining` is the state the whole feature exists for: flipped at the *top* of
 * shutdown, before the server stops accepting, so the load balancer has a
 * window to notice and stop routing while the process is still able to answer.
 */
export type ServiceState = 'starting' | 'live' | 'draining' | 'stopped'

export type ProbeKind = 'readiness' | 'liveness'

export interface CheckOutcome {
  readonly status: HealthStatus
  /**
   * Written by the check's author, and therefore always reported.
   *
   * The distinction from a *thrown* error's message is deliberate and is the
   * same one §13.3 makes about response fields: what you declared may ship,
   * what you did not may not. `new Error(...)` out of a driver says
   * `getaddrinfo ENOTFOUND db-primary.internal`, which is a topology leak; this
   * string is one somebody chose to publish.
   */
  readonly message?: string | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
}

/**
 * What a probe may return.
 *
 * `void` counts as `pass`, so the common probe is `async () => { await
 * db.query('select 1') }` — throwing is the failure channel, which is how the
 * driver already reports it.
 */
export type ProbeResult = CheckOutcome | HealthStatus | boolean | void

/**
 * A probe is handed an `AbortSignal` bound to its **own** budget (§4.4).
 *
 * Not decorative: pass it to `fetch`, or to any driver that accepts one, and a
 * probe that blows its budget actually stops working. A health check that keeps
 * a connection open after the report was written is a health check that makes
 * the outage worse.
 */
export type HealthProbe = (signal: AbortSignal) => MaybePromise<ProbeResult>

export interface CheckOptions {
  /** Defaults to `'readiness'`. See the note at the top on why. */
  readonly kind?: ProbeKind | undefined
  /** This check's own budget. Defaults to the registry's (1s). */
  readonly timeout?: Duration | undefined
  /** How long a result is reused. Defaults to the registry's (1s). */
  readonly ttl?: Duration | undefined
  /**
   * `false` degrades this check's failure to `warn` — reported, not fatal.
   *
   * The recommendation engine being unreachable should not take the checkout
   * API out of the load balancer, and a service where it does is one where
   * nobody adds checks.
   */
  readonly critical?: boolean | undefined
  /** Shown in the report; the place to say what "db" actually is. */
  readonly description?: string | undefined
}

/** A registered check, with every default resolved — the record tools read. */
export interface CheckRecord {
  readonly name: string
  readonly probe: HealthProbe
  readonly kind: ProbeKind
  readonly timeoutMs: number
  readonly ttlMs: number
  readonly critical: boolean
  readonly description: string | undefined
  /** Who registered it — a plugin name, or `'app'`. */
  readonly source: string
}

export interface ComponentReport {
  readonly name: string
  readonly status: HealthStatus
  /** How long the probe took. The number that finds the slow dependency. */
  readonly durationMs: number
  readonly critical: boolean
  readonly message?: string | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
  /** Epoch ms at which this result was *produced* — not at which it was served. */
  readonly observedAt: number
  /**
   * True when this result came from the TTL cache rather than a fresh probe.
   *
   * Reported rather than hidden, because a cached `pass` and a fresh `pass` are
   * different claims and an operator staring at a dashboard during an incident
   * is entitled to know which one they are reading.
   */
  readonly cached: boolean
}

export interface HealthReport {
  readonly status: HealthStatus
  readonly state: ServiceState
  readonly kind: ProbeKind
  /** Wall time for the whole report, including the parallel probe fan-out. */
  readonly durationMs: number
  readonly checks: readonly ComponentReport[]
}

/** draft-inadarei-api-health-check. Not `application/json`, on purpose. */
export const HEALTH_MEDIA_TYPE = 'application/health+json'

/**
 * `warn` is 200 because a warning is not a reason to stop routing traffic —
 * that is the whole difference between `warn` and `fail`, and giving them the
 * same status code would erase it.
 */
export const HEALTH_STATUS: Readonly<Record<HealthStatus, 200 | 503>> = Object.freeze({
  pass: 200,
  warn: 200,
  fail: 503,
})

/** Registry defaults, exported so the docs and the tests cannot drift. */
export const HEALTH_DEFAULTS: {
  readonly timeout: Duration
  readonly ttl: Duration
} = Object.freeze({
  // Short on purpose. A probe is not the work; it is the question "is the work
  // possible", and a dependency that needs more than a second to answer that
  // has already answered it.
  timeout: '1s',
  // Long enough that Kubernetes, the load balancer and Prometheus all probing
  // at once cost one round trip; short enough that a recovery is visible inside
  // one probe interval.
  ttl: '1s',
})
