import { config } from '../config/health.config.ts'

/**
 * Three fake dependencies with one honest property each.
 *
 * A health example whose dependencies always work demonstrates nothing, so
 * every one of these can be broken at runtime through `/control` and each fails
 * in a *different* way, because those failures are the whole subject:
 *
 *   - `db` refuses — the ordinary case, an error thrown by a driver.
 *   - `cache` degrades — still answers, but slowly enough to matter.
 *   - `payments` **hangs** — the failure everybody forgets, and the only one
 *     that can take a health endpoint down with it. A dependency that returns
 *     an error is easy; a dependency that returns nothing is how a probe
 *     without a budget becomes an outage of its own.
 */

export type Fault = 'ok' | 'down' | 'slow' | 'hang'

export type ComponentName = 'db' | 'cache' | 'payments'

export interface Dependency {
  readonly name: ComponentName
  fault: Fault
  /** Nothing here is real; the point is the shape of the failures. */
  query(signal: AbortSignal): Promise<{ latencyMs: number }>
}

class FakeDependency implements Dependency {
  readonly name: ComponentName
  fault: Fault = 'ok'
  readonly #baseLatency: number

  constructor(name: ComponentName, baseLatency: number) {
    this.name = name
    this.#baseLatency = baseLatency
  }

  async query(signal: AbortSignal): Promise<{ latencyMs: number }> {
    if (this.fault === 'down') {
      throw new Error(`connect ECONNREFUSED ${this.name}-primary.internal:5432`)
    }

    // `slow` means *degraded*, not dead: slower than the threshold a check
    // warns at, still inside the budget it fails at. That window is the whole
    // reason `warn` exists, and a fixture that overshot it into `fail` would
    // quietly stop testing the interesting case — which is exactly what the
    // first draft of this file did.
    const latency = this.fault === 'slow' ? this.#baseLatency * config.slowFactor : this.#baseLatency
    const started = performance.now()

    await new Promise<void>((resolve, reject) => {
      // `hang` never resolves on its own. What ends it is the signal — which is
      // the entire argument for handing probes a real `AbortSignal` rather than
      // just racing them against a timer and walking away. A probe that is
      // abandoned instead of cancelled leaves a connection open against a
      // dependency that is, by definition, already having a bad day.
      const timer = this.fault === 'hang' ? null : setTimeout(resolve, latency)
      signal.addEventListener('abort', () => {
        if (timer !== null) clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    })

    return { latencyMs: performance.now() - started }
  }
}

export interface Dependencies {
  readonly db: Dependency
  readonly cache: Dependency
  readonly payments: Dependency
  set(name: ComponentName, fault: Fault): void
  readonly faults: Readonly<Record<ComponentName, Fault>>
}

export function makeDependencies(): Dependencies {
  const db = new FakeDependency('db', config.latency.db)
  const cache = new FakeDependency('cache', config.latency.cache)
  const payments = new FakeDependency('payments', config.latency.payments)
  const all: Record<ComponentName, FakeDependency> = { db, cache, payments }

  return {
    db,
    cache,
    payments,
    set(name, fault) { all[name].fault = fault },
    get faults() {
      return { db: db.fault, cache: cache.fault, payments: payments.fault }
    },
  }
}
