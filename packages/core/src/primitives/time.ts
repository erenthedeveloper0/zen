/** Stratum 0 — no framework imports. */

export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * `'5m'` → 300000. Parsed once at boot, never per request — durations appear in
 * config and middleware options, both of which are validated at registration.
 */
export function parseDuration(value: Duration): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`Invalid duration: ${value}`)
    return value
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value)
  if (!match) throw new TypeError(`Invalid duration: "${value}" (expected e.g. 500ms, 30s, 5m, 2h, 1d)`)
  const amount = Number(match[1])
  const unit = UNITS[match[2] as string]
  if (unit === undefined) throw new TypeError(`Invalid duration unit in "${value}"`)
  return amount * unit
}

export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}
