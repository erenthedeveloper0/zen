/**
 * A minimal OpenMetrics-compatible registry — rfcs/0001 §31.2.
 *
 * Deliberately hand-written and dependency-free: the point of this example is
 * the hook system, and a `prom-client` import would put the interesting part
 * behind someone else's abstraction. It is small enough to read in one sitting
 * and correct enough to scrape.
 *
 * The one design decision that matters is that a metric's label *names* are
 * fixed at construction. Cardinality is the thing that kills a metrics backend,
 * and it is almost never killed by a metric that was declared wrong — it is
 * killed by a label value that turned out to be unbounded. Fixing the names
 * here means the only remaining question is where the values come from, which
 * §31.2 answers: the route template, from the AppGraph.
 */

export type LabelValues = Readonly<Record<string, string>>

/**
 * The label separator, written as an escape rather than as the byte itself.
 *
 * NUL is the right separator here — no label value can contain one, so a
 * composite key cannot be forged by a value with a comma in it. What it must not
 * be is a *literal* NUL in the source, which is what this file contained until
 * now: `file` reported the module as `data` rather than text, `grep` reported
 * "Binary file matches", and `tsc` accepted it silently. HANDOFF §8 has the same
 * mistake happening twice more since, in `config-store.ts` and `store.ts`.
 *
 * Same bytes at runtime; one of them is reviewable.
 */
const SEP = '\u0000'

abstract class Metric {
  readonly name: string
  readonly help: string
  readonly labelNames: readonly string[]

  constructor(name: string, help: string, labelNames: readonly string[] = []) {
    this.name = name
    this.help = help
    this.labelNames = labelNames
  }

  abstract readonly type: string
  abstract expose(): string[]

  protected key(labels: LabelValues): string {
    return this.labelNames.map((n) => labels[n] ?? '').join(SEP)
  }

  protected values(key: string): LabelValues {
    const parts = key === '' ? [] : key.split(SEP)
    const out: Record<string, string> = {}
    this.labelNames.forEach((name, i) => { out[name] = parts[i] ?? '' })
    return out
  }
}

export class Counter extends Metric {
  readonly type = 'counter'
  readonly #cells = new Map<string, number>()

  inc(labels: LabelValues = {}, by = 1): void {
    const key = this.key(labels)
    this.#cells.set(key, (this.#cells.get(key) ?? 0) + by)
  }

  get(labels: LabelValues = {}): number {
    return this.#cells.get(this.key(labels)) ?? 0
  }

  expose(): string[] {
    return [...this.#cells].map(([key, value]) => `${this.name}${render(this.values(key))} ${format(value)}`)
  }
}

export class Gauge extends Metric {
  readonly type = 'gauge'
  #value = 0

  inc(by = 1): void { this.#value += by }
  dec(by = 1): void { this.#value -= by }
  get(): number { return this.#value }

  expose(): string[] {
    return [`${this.name} ${format(this.#value)}`]
  }
}

/** Fixed buckets, in seconds. Web-request shaped: 1 ms to 5 s. */
export const DEFAULT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const

interface Bucketed {
  counts: number[]
  sum: number
  count: number
}

export class Histogram extends Metric {
  readonly type = 'histogram'
  readonly #cells = new Map<string, Bucketed>()
  readonly #buckets: readonly number[]

  constructor(name: string, help: string, labelNames: readonly string[] = [], buckets = DEFAULT_BUCKETS) {
    super(name, help, labelNames)
    this.#buckets = buckets
  }

  observe(labels: LabelValues, value: number): void {
    const key = this.key(labels)
    let cell = this.#cells.get(key)
    if (cell === undefined) {
      cell = { counts: new Array<number>(this.#buckets.length).fill(0), sum: 0, count: 0 }
      this.#cells.set(key, cell)
    }
    cell.sum += value
    cell.count++
    for (let i = 0; i < this.#buckets.length; i++) {
      if (value <= (this.#buckets[i] as number)) cell.counts[i] = (cell.counts[i] as number) + 1
    }
  }

  count(labels: LabelValues): number {
    return this.#cells.get(this.key(labels))?.count ?? 0
  }

  expose(): string[] {
    const lines: string[] = []
    for (const [key, cell] of this.#cells) {
      const labels = this.values(key)
      // Already cumulative: `observe` increments every bucket the value fits
      // in, which is what `le` ("less than or equal") means.
      for (let i = 0; i < this.#buckets.length; i++) {
        lines.push(`${this.name}_bucket${render({ ...labels, le: String(this.#buckets[i]) })} ${cell.counts[i] as number}`)
      }
      lines.push(`${this.name}_bucket${render({ ...labels, le: '+Inf' })} ${cell.count}`)
      lines.push(`${this.name}_sum${render(labels)} ${format(cell.sum)}`)
      lines.push(`${this.name}_count${render(labels)} ${cell.count}`)
    }
    return lines
  }
}

export class Registry {
  readonly #metrics: Metric[] = []

  register<M extends Metric>(metric: M): M {
    this.#metrics.push(metric)
    return metric
  }

  /** The scrape body. Sorted, so a diff between two scrapes is readable. */
  expose(): string {
    const out: string[] = []
    for (const metric of this.#metrics) {
      const lines = metric.expose()
      if (lines.length === 0) continue
      out.push(`# HELP ${metric.name} ${metric.help}`)
      out.push(`# TYPE ${metric.name} ${metric.type}`)
      out.push(...lines.sort())
    }
    return out.join('\n') + '\n'
  }
}

function render(labels: LabelValues): string {
  const pairs = Object.entries(labels).filter(([, v]) => v !== '')
  if (pairs.length === 0) return ''
  return `{${pairs.map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}`
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Prometheus wants a plain decimal, not `1e-7`. */
function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6)
}
