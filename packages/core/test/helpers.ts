import { BootError, createApp, ZenApp, type Logger, type ZenOptions } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { fileURLToPath } from 'node:url'

export const pathParser = {
  parse(path: string) {
    const parsed = parsePath(path)
    return { path: parsed.path, segments: parsed.segments }
  },
}

export function silentLogger(): Logger {
  const noop = () => {}
  const logger = {
    level: 'fatal' as const,
    child() { return logger },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
  return logger
}

/**
 * `inspect: true` because so many suites read `generatedSource()` — the gates
 * that a stage emits nothing, or a route compiles byte-identically. What an
 * app keeps without it is asserted in `generated-source.test.ts`.
 */
export function makeApp<X = {}>(opts: Partial<ZenOptions> = {}): ZenApp<X> {
  return placedBoot(createApp<X>({
    router: new ZenRouter(),
    pathParser,
    logger: silentLogger(),
    inspect: true,
    ...opts,
  }))
}

/**
 * A gate `0.2.0-alpha` set itself, held where every core suite builds its
 * apps: **every boot diagnostic carries `file:line`** (§5.1). A
 * diagnostic added without an origin fails whichever test first provokes it,
 * with the code and message that has none, instead of waiting for a reader to
 * notice a line that points nowhere.
 */
export function placedBoot<A extends { ready(): Promise<unknown> }>(app: A): A {
  const ready = app.ready.bind(app)
  Object.defineProperty(app, 'ready', {
    value: () => ready().catch((error: unknown) => {
      assertPlaced(error)
      throw error
    }),
  })
  return app
}

export function assertPlaced(error: unknown): void {
  if (!(error instanceof BootError)) return
  for (const diagnostic of error.diagnostics) {
    const origins = diagnostic.origins ?? []
    const usable = origins.length > 0 &&
      origins.every((o) => typeof o.file === 'string' && o.file !== '' && Number.isInteger(o.line) && o.line > 0)
    if (!usable) {
      throw new Error(
        `Boot diagnostic ${diagnostic.code} has no file:line — "${diagnostic.message}". ` +
          'Every boot diagnostic names the line that registered what it is about (§5.1).',
      )
    }
  }
}

/**
 * Slot and token names are process-global (§7.4), so suites that run in one
 * process must not reuse them. A counter is simpler and more honest than
 * resetting the registry, which would invalidate slots already captured by a
 * compiled context class.
 */
let unique = 0
export function uniqueName(prefix: string): string {
  return `${prefix}.${process.pid}.${unique++}`
}

/**
 * A Standard Schema that also *exposes its shape* — what §11.4 needs.
 *
 * `jsonSchema()` describes without validating and `schema()` validates without
 * describing; coercion is the first subsystem that needs both at once, because
 * the plan comes from the shape and the verdict comes from the validator. Zod
 * gives you both from one declaration, and `examples/coercion` proves the
 * feature against the real thing — but `@erenthedeveloper0/zen-core` has no runtime
 * dependencies and its tests keep that honest (§19.8), so here the two halves
 * are supplied side by side.
 *
 * The validator is a deliberately literal reading of the shape: it checks
 * `type`, `items` and `required` and nothing else. That is enough to
 * demonstrate the property the whole design turns on — **coercion proposes and
 * the schema disposes** — because a value coercion declined to convert arrives
 * as a string and fails this check with this validator's message.
 */
export function shaped(json: Record<string, unknown>) {
  const check = (value: unknown, node: Record<string, unknown> | undefined, path: PropertyKey[]): Array<{ message: string; path: PropertyKey[] }> => {
    if (node === undefined) return []
    const type = node['type'] as string | undefined
    const types = Array.isArray(type) ? (type as string[]) : type === undefined ? null : [type]

    if (types !== null && !types.some((t) => isType(value, t))) {
      return [{ message: `expected ${types.join(' | ')}, received ${describe(value)}`, path }]
    }

    if (types?.includes('object') === true || node['properties'] !== undefined) {
      const properties = (node['properties'] ?? {}) as Record<string, Record<string, unknown>>
      const required = (node['required'] ?? []) as string[]
      const record = value as Record<string, unknown>
      const issues: Array<{ message: string; path: PropertyKey[] }> = []
      for (const key of required) {
        if (record[key] === undefined) issues.push({ message: 'required', path: [...path, key] })
      }
      for (const key of Object.keys(properties)) {
        if (record[key] === undefined) continue
        issues.push(...check(record[key], properties[key], [...path, key]))
      }
      return issues
    }

    if (Array.isArray(value) && node['items'] !== undefined) {
      const issues: Array<{ message: string; path: PropertyKey[] }> = []
      value.forEach((item, index) => {
        issues.push(...check(item, node['items'] as Record<string, unknown>, [...path, index]))
      })
      return issues
    }

    return []
  }

  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-test-shaped',
      validate(value: unknown) {
        const issues = check(value, json, [])
        return issues.length > 0 ? { issues } : { value }
      },
    },
    toJSONSchema() {
      return json
    },
  } as never
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number'
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    default: return true
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** A minimal hand-written Standard Schema — core needs no schema library. */
export function schema<T>(validate: (value: unknown) => { value: T } | { issues: Array<{ message: string; path?: PropertyKey[] }> }) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-test',
      validate,
    },
  } as unknown as { '~standard': { version: 1; vendor: string; validate: (v: unknown) => { value: T } } }
}

/**
 * The file and line this is called from — what a registration's origin should
 * say (§5.1). Write it on the same line as the registration it is compared
 * with: `app.get('/a', h); const at = here()`.
 *
 * Read from the stack *text*, by its own parsing, rather than through the
 * framework's capture: an assertion that used the code under test to compute
 * its expected value would agree with any bug in it.
 */
export function here(): { file: string; line: number } {
  const frame = (new Error().stack ?? '').split('\n')[2]?.trim() ?? ''
  const location = frame.endsWith(')') ? frame.slice(frame.lastIndexOf('(') + 1, -1) : frame.replace(/^at /, '')
  const parts = location.split(':')
  const line = Number(parts[parts.length - 2])
  const file = parts.slice(0, -2).join(':')
  return { file: file.startsWith('file:') ? fileURLToPath(file) : file, line }
}
