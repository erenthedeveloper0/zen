/**
 * A 150-line schema library, written here to prove a point.
 *
 * Zen's core depends on [Standard Schema](https://standardschema.dev) and on
 * nothing else — so "works with Zod, Valibot and ArkType" is not a list of
 * integrations Zen maintains, it is a consequence of those libraries
 * implementing `~standard`. The strongest demonstration of that is a schema
 * library the framework has never heard of. This one.
 *
 * Every schema here also carries `toJsonSchema()`, which is the convention
 * ArkType uses and which Zen probes for. That is what lets **one declaration
 * drive both directions**:
 *
 *     app.post('/users', { body: User, response: { 201: PublicUser } }, …)
 *                                ↑                        ↑
 *                        validate the request      compile the serializer
 *
 * In a real application you would write `import { z } from 'zod'` and one line
 * of `registerSchemaConverter`. Nothing else about this example would change.
 */
import type { JsonSchema } from '@visionpilot/zen'

// ─────────────────────────────────────────────────────────────────────────────

export interface Schema<T> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: 'tiny'
    readonly validate: (value: unknown) => { value: T } | { issues: Issue[] }
  }
  toJsonSchema(): JsonSchema
}

interface Issue {
  readonly message: string
  readonly path?: (string | number)[]
}

export type Infer<S> = S extends Schema<infer T> ? T : never

type Check<T> = (value: unknown, path: (string | number)[]) => { value: T } | { issues: Issue[] }

function schema<T>(check: Check<T>, json: JsonSchema): Schema<T> {
  return {
    '~standard': { version: 1, vendor: 'tiny', validate: (value) => check(value, []) },
    toJsonSchema: () => json,
  }
}

const bad = (path: (string | number)[], message: string): { issues: Issue[] } => ({
  issues: [{ path, message }],
})

// ─── leaves ──────────────────────────────────────────────────────────────────

export const string = (opts: { min?: number; max?: number; format?: string } = {}): Schema<string> =>
  schema<string>(
    (value, path) => {
      if (typeof value !== 'string') return bad(path, 'Expected a string')
      if (opts.min !== undefined && value.length < opts.min) return bad(path, `Expected at least ${opts.min} characters`)
      if (opts.max !== undefined && value.length > opts.max) return bad(path, `Expected at most ${opts.max} characters`)
      return { value }
    },
    { type: 'string', ...(opts.format !== undefined ? { format: opts.format } : {}) },
  )

export const email = (): Schema<string> =>
  schema<string>(
    (value, path) =>
      typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? { value }
        : bad(path, 'Expected a valid email address'),
    { type: 'string', format: 'email' },
  )

export const int = (opts: { min?: number; max?: number } = {}): Schema<number> =>
  schema<number>(
    (value, path) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) return bad(path, 'Expected an integer')
      if (opts.min !== undefined && value < opts.min) return bad(path, `Expected a minimum of ${opts.min}`)
      if (opts.max !== undefined && value > opts.max) return bad(path, `Expected a maximum of ${opts.max}`)
      return { value }
    },
    { type: 'integer' },
  )

export const boolean = (): Schema<boolean> =>
  schema<boolean>(
    (value, path) => (typeof value === 'boolean' ? { value } : bad(path, 'Expected a boolean')),
    { type: 'boolean' },
  )

export const isoDate = (): Schema<string> =>
  schema<string>(
    (value, path) =>
      typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? { value }
        : bad(path, 'Expected an ISO 8601 timestamp'),
    { type: 'string', format: 'date-time' },
  )

export const literal = <const T extends string>(constant: T): Schema<T> =>
  schema<T>(
    (value, path) => (value === constant ? { value: constant } : bad(path, `Expected "${constant}"`)),
    { const: constant },
  )

export const enumOf = <const T extends readonly string[]>(...values: T): Schema<T[number]> =>
  schema<T[number]>(
    (value, path) =>
      typeof value === 'string' && (values as readonly string[]).includes(value)
        ? { value: value as T[number] }
        : bad(path, `Expected one of: ${values.join(', ')}`),
    { enum: [...values] },
  )

// ─── combinators ─────────────────────────────────────────────────────────────

export const array = <T>(items: Schema<T>): Schema<T[]> =>
  schema<T[]>(
    (value, path) => {
      if (!Array.isArray(value)) return bad(path, 'Expected an array')
      const out: T[] = []
      const issues: Issue[] = []
      value.forEach((item, index) => {
        const result = run(items, item, [...path, index])
        if ('issues' in result) issues.push(...result.issues)
        else out.push(result.value)
      })
      return issues.length > 0 ? { issues } : { value: out }
    },
    { type: 'array', items: items.toJsonSchema() },
  )

export const optional = <T>(inner: Schema<T>): Schema<T | undefined> & { readonly $optional: true } =>
  Object.assign(
    schema<T | undefined>(
      (value, path) => (value === undefined ? { value: undefined } : run(inner, value, path)),
      inner.toJsonSchema(),
    ),
    { $optional: true as const },
  )

type Shape = Record<string, Schema<unknown>>
type InferShape<S extends Shape> = { [K in keyof S]: Infer<S[K]> }

export function object<S extends Shape>(shape: S): Schema<InferShape<S>> {
  const entries = Object.entries(shape)
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, child] of entries) {
    properties[key] = child.toJsonSchema()
    if (!('$optional' in child)) required.push(key)
  }

  return schema<InferShape<S>>(
    (value, path) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return bad(path, 'Expected an object')
      }
      const source = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      const issues: Issue[] = []

      for (const [key, child] of entries) {
        const result = run(child, source[key], [...path, key])
        if ('issues' in result) issues.push(...result.issues)
        else if (result.value !== undefined) out[key] = result.value
      }

      return issues.length > 0 ? { issues } : { value: out as InferShape<S> }
    },
    // `additionalProperties: false` is redundant for Zen — an absent
    // `additionalProperties` already means "drop" (§13.3.1) — but it is written
    // out so the emitted JSON Schema is honest to a reader who expects the
    // JSON Schema default of "allow".
    { type: 'object', properties, required, additionalProperties: false },
  )
}

function run<T>(target: Schema<T>, value: unknown, path: (string | number)[]): { value: T } | { issues: Issue[] } {
  const result = (target as unknown as { '~standard': { validate: (v: unknown) => { value: T } | { issues: Issue[] } } })
    ['~standard'].validate(value)
  if ('issues' in result) {
    // Re-root the child's issue paths under this position, so a failure at
    // `users[2].email` reports that and not `email`.
    return { issues: result.issues.map((issue) => ({ ...issue, path: [...path, ...(issue.path ?? [])] })) }
  }
  return result
}
