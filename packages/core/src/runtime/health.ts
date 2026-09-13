import type { Logger } from '../contracts/logger.ts'
import type { Duration } from '../primitives/time.ts'
import type {
  CheckOptions, CheckRecord, ComponentReport, HealthProbe, HealthReport,
  HealthStatus, ProbeKind, ProbeResult, ServiceState,
} from '../contracts/health.ts'
import { HEALTH_DEFAULTS } from '../contracts/health.ts'
import { parseDuration } from '../primitives/time.ts'
import { Deadline, EXPIRED } from './deadline.ts'
import { Codes } from '../errors/codes.ts'
import type { Diagnostic } from '../errors/zen-error.ts'

/**
 * The health registry — rfcs/0001 §31.4.
 *
 * Three jobs, and the second and third are what make this more than a
 * `Promise.all` over some closures:
 *
 *   1. **Own the lifecycle state**, so readiness can fail at the *top* of
 *      shutdown while the process is still answering (§4.5 step 1). That
 *      ordering is the entire feature: a service that stops accepting
 *      connections and *then* reports itself unready has already 502'd
 *      everything the load balancer sent in between.
 *   2. **Bound each probe separately**, with the same arm the request path uses
 *      (§4.4). One budget over the whole endpoint produces the least useful
 *      sentence in an incident channel — "the health check timed out" — when
 *      what an operator needs is "redis: fail after 1s, postgres: pass in 3ms".
 *      A per-check budget is also the only way a slow dependency cannot hide a
 *      fast one's answer.
 *   3. **Collapse concurrent probes**, because a health endpoint is polled by
 *      the orchestrator, the load balancer, the service mesh and the metrics
 *      scraper at once, and the naive implementation opens a database
 *      connection for each of them. The moment that matters is the moment the
 *      dependency is already struggling, which is exactly when the naive
 *      implementation adds load to it.
 *
 * Nothing here is compiled, and that is worth stating rather than leaving as an
 * absence: there is no generated twin to differentially test (§20.5) because
 * there is no generated form. The endpoints are ordinary routes through the
 * ordinary compiler, which is why registering this costs an application route
 * exactly nothing — checked in `benchmarks/health/run.ts` against the emitted
 * bytes, the same way §9.4 and §4.4 are.
 */

/** A signal that never aborts — probes are bounded by their own budget alone. */
const NEVER: AbortSignal = new AbortController().signal

/** Monotonic: a process never un-drains. Index order *is* the transition order. */
const STATE_ORDER: readonly ServiceState[] = ['starting', 'live', 'draining', 'stopped']

const MAX_MESSAGE = 200

interface CacheEntry {
  /** Already stamped `cached: true`, so a hit allocates nothing. */
  readonly report: ComponentReport
  readonly expiresAt: number
}

export interface HealthRegistryOptions {
  readonly timeout?: Duration | undefined
  readonly ttl?: Duration | undefined
  /**
   * Include the text of a *thrown* error in the report. Off by default.
   *
   * A `CheckOutcome.message` the probe returned is always reported: its author
   * chose to publish it. A driver's exception is a different thing — `pg` says
   * `getaddrinfo ENOTFOUND db-primary.internal`, which names internal topology
   * to whoever can reach the endpoint. It is logged either way; this only
   * decides whether it goes on the wire. Same rule as §13.3: what you declared
   * may ship, what you did not may not.
   */
  readonly details?: boolean | undefined
  readonly logger?: Logger | undefined
}

export class HealthRegistry {
  readonly #byName = new Map<string, CheckRecord>()
  readonly #readiness: CheckRecord[] = []
  readonly #liveness: CheckRecord[] = []
  readonly #cache = new Map<string, CacheEntry>()
  readonly #inflight = new Map<string, Promise<ComponentReport>>()
  readonly #defaultTimeoutMs: number
  readonly #defaultTtlMs: number
  readonly #details: boolean
  readonly #log: Logger | undefined
  #state: ServiceState = 'starting'

  constructor(options: HealthRegistryOptions = {}) {
    this.#defaultTimeoutMs = parseDuration(options.timeout ?? HEALTH_DEFAULTS.timeout)
    this.#defaultTtlMs = parseDuration(options.ttl ?? HEALTH_DEFAULTS.ttl)
    this.#details = options.details ?? false
    this.#log = options.logger
  }

  get state(): ServiceState {
    return this.#state
  }

  /** Every registered check, in registration order — for the AppGraph (§2.4). */
  get checks(): readonly CheckRecord[] {
    return [...this.#byName.values()]
  }

  has(name: string): boolean {
    return this.#byName.has(name)
  }

  /**
   * Returns a `Diagnostic` instead of throwing, so a bad check is reported with
   * every other registration problem rather than costing a restart (§12.7).
   */
  register(
    name: string,
    probe: HealthProbe,
    options: CheckOptions = {},
    source = 'app',
  ): Diagnostic | null {
    if (typeof name !== 'string' || name.trim() === '' || /\s/.test(name)) {
      return {
        severity: 'error',
        code: Codes.HEALTH_CHECK_INVALID,
        message: `Health check name ${JSON.stringify(name)} is not usable.`,
        hint: 'Use a short identifier with no whitespace — it becomes a key in the health document and a metric label.',
      }
    }
    if (typeof probe !== 'function') {
      return {
        severity: 'error',
        code: Codes.HEALTH_CHECK_INVALID,
        message: `Health check "${name}" was registered with a ${typeof probe} instead of a function.`,
        hint: 'A probe is `(signal) => void | boolean | HealthStatus | CheckOutcome`, and may be async.',
      }
    }

    const existing = this.#byName.get(name)
    if (existing !== undefined) {
      return {
        severity: 'error',
        code: Codes.HEALTH_CHECK_DUPLICATE,
        message: `Health check "${name}" is registered twice — by ${existing.source} and by ${source}.`,
        // Last-write-wins would be worse than a boot error in the one way that
        // matters here: the check that vanished is the one nobody notices is
        // gone, because the endpoint still returns 200.
        hint: 'Rename one of them, or namespace it by its owner (e.g. "billing.db").',
      }
    }

    let timeoutMs: number
    let ttlMs: number
    try {
      timeoutMs = options.timeout === undefined ? this.#defaultTimeoutMs : parseDuration(options.timeout)
      ttlMs = options.ttl === undefined ? this.#defaultTtlMs : parseDuration(options.ttl)
    } catch (error) {
      return {
        severity: 'error',
        code: Codes.HEALTH_CHECK_INVALID,
        message: `Health check "${name}": ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Durations are numbers of milliseconds, or strings like "250ms" and "2s".',
      }
    }
    if (timeoutMs <= 0) {
      return {
        severity: 'error',
        code: Codes.HEALTH_CHECK_INVALID,
        message: `Health check "${name}" has a timeout of ${timeoutMs}ms, which expires before the probe can run.`,
        hint: 'Give it a positive budget. There is deliberately no "unbounded" — an unbounded probe is how an endpoint hangs.',
      }
    }

    const record: CheckRecord = {
      name,
      probe,
      kind: options.kind ?? 'readiness',
      timeoutMs,
      ttlMs,
      critical: options.critical ?? true,
      description: options.description,
      source,
    }
    this.#byName.set(name, record)
    ;(record.kind === 'liveness' ? this.#liveness : this.#readiness).push(record)
    return null
  }

  // ── lifecycle (§4.5) ──────────────────────────────────────────────────────

  /** Boot finished: readiness may now pass. Called at the end of `ready()`. */
  live(): void {
    this.#advance('live')
  }

  /**
   * Shutdown has begun — readiness fails from here, liveness does not.
   *
   * That split is the point. Reporting `fail` on liveness during a drain asks
   * the orchestrator to `SIGKILL` a process that is deliberately and correctly
   * finishing its in-flight requests.
   */
  drain(): void {
    this.#advance('draining')
  }

  stop(): void {
    this.#advance('stopped')
  }

  #advance(to: ServiceState): void {
    if (STATE_ORDER.indexOf(to) > STATE_ORDER.indexOf(this.#state)) this.#state = to
  }

  // ── probing ───────────────────────────────────────────────────────────────

  async run(kind: ProbeKind): Promise<HealthReport> {
    const started = performance.now()
    const state = this.#state
    const checks = kind === 'liveness' ? this.#liveness : this.#readiness

    // Parallel, because these are independent I/O waits and running them in
    // series makes the endpoint's latency the *sum* of every dependency's — at
    // which point the endpoint is the slowest thing in the deployment.
    const reports = checks.length === 0
      ? []
      : await Promise.all(checks.map((check) => this.#one(check)))

    return {
      status: aggregate(state, kind, reports),
      state,
      kind,
      durationMs: performance.now() - started,
      checks: reports,
    }
  }

  /** Drop every cached result. For tests, and for a deliberate re-probe. */
  invalidate(): void {
    this.#cache.clear()
  }

  #one(check: CheckRecord): Promise<ComponentReport> {
    const now = Date.now()
    const cached = this.#cache.get(check.name)
    if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.report)

    // Single flight. Every caller that arrives while a probe is in the air gets
    // that probe's promise, so N simultaneous scrapes cost one round trip.
    const inflight = this.#inflight.get(check.name)
    if (inflight !== undefined) return inflight

    const run = this.#probe(check, now).finally(() => {
      this.#inflight.delete(check.name)
    })
    this.#inflight.set(check.name, run)
    return run
  }

  async #probe(check: CheckRecord, observedAt: number): Promise<ComponentReport> {
    const started = performance.now()
    // The same arm the request path uses (§4.4) rather than a second timer
    // implementation: an unref'd timer, an `AbortSignal` the probe actually
    // receives, and a promise that rejects with `EXPIRED`. Reusing it is why a
    // probe's `fetch` is genuinely cancelled when its budget blows, instead of
    // being abandoned and left to run against a dependency already in trouble.
    //
    // `keepAlive: true` is the one place this differs from a request. A request
    // has an open socket holding the loop; a probe has nothing but this timer,
    // and unref'ing it means a wedged dependency in an otherwise idle process
    // exits before the report can be written.
    const deadline = new Deadline(check.timeoutMs, NEVER, true)
    let report: ComponentReport

    try {
      const outcome = await Promise.race<ProbeResult>([
        Promise.resolve(check.probe(deadline.signal)),
        deadline.expiry,
      ])
      report = finish(check, normalise(outcome), started, observedAt)
    } catch (error) {
      report = error === EXPIRED
        ? finish(
            check,
            { status: 'fail', message: `probe exceeded its ${check.timeoutMs}ms budget` },
            started,
            observedAt,
          )
        : finish(check, this.#fromThrow(check, error), started, observedAt)
    } finally {
      deadline.disarm()
    }

    // A failure is cached for the same TTL as a success, and the trade is
    // explicit: a recovery becomes visible up to one TTL late. The alternative —
    // re-probing on every request while a dependency is down — aims the full
    // scrape rate at the component least able to absorb it, at the exact moment
    // it is least able to. With a one-second TTL the lag is a second and the
    // protection is unconditional, which is the right way round.
    this.#cache.set(check.name, {
      report: { ...report, cached: true },
      expiresAt: observedAt + check.ttlMs,
    })
    return report
  }

  #fromThrow(check: CheckRecord, error: unknown): { status: HealthStatus; message: string } {
    const text = error instanceof Error ? error.message : String(error)
    this.#log?.warn({ check: check.name, err: error }, 'health check threw')
    return this.#details
      ? { status: 'fail', message: text.slice(0, MAX_MESSAGE) }
      : { status: 'fail', message: 'check failed' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function normalise(
  outcome: ProbeResult,
): { status: HealthStatus; message?: string; data?: Readonly<Record<string, unknown>> } {
  if (outcome === undefined || outcome === null || outcome === true) return { status: 'pass' }
  if (outcome === false) return { status: 'fail' }
  if (typeof outcome === 'string') return { status: outcome }
  return {
    status: outcome.status,
    ...(outcome.message === undefined ? {} : { message: outcome.message.slice(0, MAX_MESSAGE) }),
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
  }
}

function finish(
  check: CheckRecord,
  outcome: {
    status: HealthStatus
    message?: string | undefined
    data?: Readonly<Record<string, unknown>> | undefined
  },
  started: number,
  observedAt: number,
): ComponentReport {
  return {
    name: check.name,
    // A non-critical failure is *reported* as a failure of that component and
    // downgraded only where it is aggregated, so the report never lies about
    // what it saw in order to make the summary come out green.
    status: outcome.status,
    durationMs: performance.now() - started,
    critical: check.critical,
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
    observedAt,
    cached: false,
  }
}

/**
 * State first, checks second — and the two kinds read state differently.
 *
 * Readiness passes only while `live`: a process still booting, or already
 * draining, must not receive traffic however healthy its dependencies are.
 * Liveness passes in every state but `stopped`, including `starting`, because a
 * liveness probe that fails during a slow boot is how a service that takes 40
 * seconds to warm a cache never finishes booting at all.
 *
 * There is also nothing to check for liveness by construction, which is worth
 * saying plainly: the process answered this HTTP request, so its event loop is
 * turning. The response *is* the liveness check.
 */
function aggregate(
  state: ServiceState,
  kind: ProbeKind,
  reports: readonly ComponentReport[],
): HealthStatus {
  if (kind === 'readiness' && state !== 'live') return 'fail'
  if (kind === 'liveness' && state === 'stopped') return 'fail'

  let status: HealthStatus = 'pass'
  for (const report of reports) {
    const effective: HealthStatus =
      report.status === 'fail' && !report.critical ? 'warn' : report.status
    if (effective === 'fail') return 'fail'
    if (effective === 'warn') status = 'warn'
  }
  return status
}
