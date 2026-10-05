import type { Capabilities } from '../contracts/capabilities.ts'
import type { Plugin } from '../contracts/plugin.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

export interface PendingPlugin {
  readonly plugin: Plugin<never, object>
  readonly options: unknown
  readonly order: number
}

/**
 * Plugin resolution — rfcs/0001 §10.5.
 *
 * Steps 1-6 are pure analysis over data; nothing is executed. That is what makes
 * `zen plugin graph` able to render a plugin tree that fails to boot, and it is
 * why every failure below names the plugin, its version, and its dependents
 * rather than surfacing as a TypeError inside someone's `setup`.
 */
export function resolvePlugins(
  pending: readonly PendingPlugin[],
  caps: Capabilities,
): { order: PendingPlugin[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []

  // Nodes are keyed by *instance*, not by name: a plugin declaring
  // `multiple: true` legitimately appears more than once, and keying the graph
  // by name made the completeness check compare 2 nodes against 1 name and
  // report a phantom cycle.
  const keyOf = (entry: PendingPlugin) => `${entry.plugin.name}#${entry.order}`

  const participants: PendingPlugin[] = []
  const byName = new Map<string, PendingPlugin>()

  // 2 — duplicates & conflicts
  for (const entry of pending) {
    const { name, multiple } = entry.plugin
    const existing = byName.get(name)
    if (existing !== undefined && multiple !== true) {
      diagnostics.push({
        severity: 'error',
        code: Codes.PLUGIN_DUPLICATE,
        message: `Plugin "${name}" is registered twice.`,
        hint: 'Remove the duplicate registration, or declare `multiple: true` if the plugin supports it.',
      })
      continue
    }
    participants.push(entry)
    // Dependency lookups resolve to the first registration of a name.
    if (existing === undefined) byName.set(name, entry)
  }

  for (const entry of pending) {
    for (const conflict of entry.plugin.conflictsWith ?? []) {
      if (byName.has(conflict)) {
        diagnostics.push({
          severity: 'error',
          code: Codes.PLUGIN_CONFLICT,
          message: `Plugin "${entry.plugin.name}" conflicts with "${conflict}", which is also registered.`,
        })
      }
    }

    // Capability requirements: fail at boot with a clear message rather than at
    // runtime with `fs is not defined`. `true` asks for a capability; a string
    // asks for that exact one — `websocket: 'native'` — and used to be read by
    // nothing, which made `requires` true for exactly half its vocabulary.
    for (const [key, required] of Object.entries(entry.plugin.requires ?? {})) {
      const actual = (caps as unknown as Record<string, unknown>)[key]
      if ((required === true || typeof required === 'string') && actual !== required) {
        diagnostics.push({
          severity: 'error',
          code: Codes.CAPABILITY_UNAVAILABLE,
          message:
            `Plugin "${entry.plugin.name}" requires capability "${key}", ` +
            `which this runtime does not provide (got ${JSON.stringify(actual)}).`,
          hint: 'Remove the plugin for this target, or choose an adapter that supports it.',
        })
      }
    }
  }

  // 3 — dependency edges
  const edges = new Map<string, Set<string>>()
  for (const entry of participants) {
    edges.set(keyOf(entry), new Set())
  }

  for (const entry of participants) {
    for (const [depName, range] of Object.entries(entry.plugin.dependsOn ?? {})) {
      const dep = byName.get(depName)
      if (dep === undefined) {
        diagnostics.push({
          severity: 'error',
          code: Codes.PLUGIN_MISSING,
          message: `Plugin "${entry.plugin.name}" requires "${depName}" (${range}), which is not registered.`,
          hint: `Register it first: app.use(${depName}Plugin)`,
        })
        continue
      }
      if (!satisfies(dep.plugin.version, range)) {
        diagnostics.push({
          severity: 'error',
          code: Codes.PLUGIN_VERSION,
          message:
            `Plugin "${entry.plugin.name}" requires "${depName}@${range}", ` +
            `but ${depName}@${dep.plugin.version} is registered.`,
        })
        continue
      }
      edges.get(keyOf(entry))?.add(keyOf(dep))
    }

    // 4 — ordering hints
    for (const afterName of entry.plugin.after ?? []) {
      const target = byName.get(afterName)
      if (target !== undefined) edges.get(keyOf(entry))?.add(keyOf(target))
    }
    for (const beforeName of entry.plugin.before ?? []) {
      const target = byName.get(beforeName)
      if (target !== undefined) edges.get(keyOf(target))?.add(keyOf(entry))
    }
  }

  if (diagnostics.length > 0) return { order: [], diagnostics }

  // 5-6 — Kahn's algorithm, tie-broken by registration order so boot is
  // deterministic across runs.
  const byKey = new Map(participants.map((p) => [keyOf(p), p]))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const key of edges.keys()) {
    indegree.set(key, 0)
    dependents.set(key, [])
  }
  for (const [key, deps] of edges) {
    indegree.set(key, deps.size)
    for (const dep of deps) dependents.get(dep)?.push(key)
  }

  const ready = participants
    .filter((p) => (indegree.get(keyOf(p)) ?? 0) === 0)
    .sort((a, b) => a.order - b.order)

  const order: PendingPlugin[] = []
  while (ready.length > 0) {
    const next = ready.shift() as PendingPlugin
    order.push(next)
    for (const dependentKey of dependents.get(keyOf(next)) ?? []) {
      const remaining = (indegree.get(dependentKey) ?? 0) - 1
      indegree.set(dependentKey, remaining)
      if (remaining === 0) {
        const entry = byKey.get(dependentKey)
        if (entry !== undefined) {
          ready.push(entry)
          ready.sort((a, b) => a.order - b.order)
        }
      }
    }
  }

  if (order.length !== participants.length) {
    const placed = new Set(order.map(keyOf))
    const stuck = participants.filter((p) => !placed.has(keyOf(p))).map((p) => p.plugin.name)
    diagnostics.push({
      severity: 'error',
      code: Codes.PLUGIN_CYCLE,
      message: `Circular plugin dependency involving: ${stuck.join(' → ')}`,
      hint: 'Break the cycle, or use `before`/`after` ordering hints instead of a hard dependency.',
    })
  }

  return { order, diagnostics }
}

/**
 * A deliberately small semver range check: `*`, `1.2.3`, `^1.2.3`, `~1.2.3`,
 * `>=1.2.3`. Enough for plugin dependency declarations, and small enough to
 * keep `@erenthedeveloper0/zen-core` at zero runtime dependencies (§19.8).
 */
export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim()
  if (trimmed === '*' || trimmed === '') return true

  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim())
    if (m === null) return null
    return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
  }

  const actual = parse(version)
  if (actual === null) return false

  const operator = /^(\^|~|>=|>|<=|<|=)?/.exec(trimmed)?.[1] ?? '='
  const wanted = parse(trimmed.slice(operator === '=' && !trimmed.startsWith('=') ? 0 : operator.length))
  if (wanted === null) return false

  const cmp = compare(actual, wanted)

  switch (operator) {
    case '^':
      // Caret: same left-most non-zero component.
      if (wanted[0] > 0) return actual[0] === wanted[0] && cmp >= 0
      if (wanted[1] > 0) return actual[0] === 0 && actual[1] === wanted[1] && cmp >= 0
      return actual[0] === 0 && actual[1] === 0 && actual[2] === wanted[2]
    case '~':
      return actual[0] === wanted[0] && actual[1] === wanted[1] && cmp >= 0
    case '>=': return cmp >= 0
    case '>': return cmp > 0
    case '<=': return cmp <= 0
    case '<': return cmp < 0
    default: return cmp === 0
  }
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const left = a[i] as number
    const right = b[i] as number
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}
