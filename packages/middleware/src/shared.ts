import type {
  AnySchema, JsonSchema, JsonSchemaNode, LowercaseName, Reply, ReplyBuilder, StandardIssue,
} from '@erenthedeveloper0/zen-core'

/**
 * What this pack touches on a context, declared structurally — §10.4.
 *
 * `Registrar.hook` takes a `Function` on purpose: a plugin is written before
 * the application's decoration set exists, so pinning its hooks to
 * `Context<never, X>` would reject the pattern for an `X` the author cannot
 * know. The convention the examples already follow is to declare exactly the
 * surface the hook uses (`examples/openapi/src/plugins/request-id.ts` declares
 * `{ id: string }` and nothing else), and the point of doing it is that a
 * middleware cannot quietly start depending on `ctx.user` later.
 *
 * These are split by concern rather than merged into one context type for the
 * same reason: `securityHeaders` may not read the request, and the type says so.
 */

/** Reading the request without materialising the header record. */
export interface RawReading {
  readonly method: string
  readonly raw: { header(name: LowercaseName): string | undefined }
}

/** Staging response metadata (§13.6) — applied at egress on every path. */
export interface Staging {
  readonly res: ReplyBuilder
}

/** Producing a reply from a hook, which is how a phase short-circuits (§9.2). */
export interface Answering {
  empty(status?: 204 | 205 | 304): Reply<null>
  json<T>(body: T, init?: { status?: number }): Reply<T>
}

export type CorsRequest = RawReading & Answering

/**
 * `ctx.raw.header` rather than `ctx.headers[name]`.
 *
 * `ctx.headers` is lazy and memoised, but the first touch walks every header
 * the adapter received and builds a record (`buildHeaders`, §7.2). These hooks
 * run on *every* request in the application, including the ones whose handlers
 * never look at a header, so making them the reason that record exists would be
 * a cost the application did not ask for — §9.4's rule applied to a plugin
 * rather than to the compiler.
 */
export function headerOf(ctx: RawReading, name: LowercaseName): string | undefined {
  return ctx.raw.header(name)
}

/**
 * A CORS preflight — an `OPTIONS` carrying `Access-Control-Request-Method`.
 *
 * Both halves are required by the Fetch standard and both are load-bearing
 * here: an `OPTIONS` without the header is an ordinary request for a resource's
 * options and may well have a route, and answering it with 204 would shadow
 * that route with something the application did not write.
 */
export function isPreflight(ctx: RawReading): boolean {
  return ctx.method === 'OPTIONS' && ctx.raw.header('access-control-request-method') !== undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Options schemas — rfcs/0001 §10.5 step 2
// ─────────────────────────────────────────────────────────────────────────────

/** One option a factory accepts, stated twice: as a check, and as JSON Schema. */
export interface OptionField {
  /** What the option must be, completing "expected …". */
  readonly expected: string
  readonly accepts: (value: unknown) => boolean
  readonly json: JsonSchemaNode
}

/**
 * The options schema of a factory in this pack.
 *
 * §8.6's motivating sentence is "`rateLimit({ limt: 100 })` fails at startup
 * with a spelling suggestion, not at 3 a.m. under load", and the pack is where
 * that sentence is about. A factory hands its options to core as
 * `Plugin.boundOptions`, against this schema as `Plugin.options`, and they are
 * checked at boot before any plugin's `setup` runs.
 *
 * Hand-written Standard Schemas, so the pack keeps its zero dependencies. The
 * work is split with core so nothing is reported twice: `validate` checks the
 * type of each option that is present, and core reads the schema's JSON Schema
 * — a closed object — to name every key it does not declare, with the one it
 * was probably meant to be. A schema that also refused unknown keys would put
 * every typo in the diagnostic twice.
 *
 * It returns the options it was given, unchanged: a factory reads them from
 * its closure, so what it was built with is exactly what boot checked. The
 * checks a value needs beyond its type — a `limit` below one, an origin with a
 * trailing slash — stay in the factory, because configuration supplies the
 * same values and must meet the same rule.
 */
export function optionsSchema(factory: string, fields: Readonly<Record<string, OptionField>>): AnySchema {
  const properties: Record<string, JsonSchemaNode> = {}
  for (const key of Object.keys(fields)) properties[key] = (fields[key] as OptionField).json
  const shape: JsonSchema = { type: 'object', properties, additionalProperties: false }

  return {
    '~standard': {
      version: 1,
      vendor: 'zen-middleware',
      validate(value: unknown) {
        if (value === undefined) return { value: {} }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { issues: [{ message: `${factory}() takes an options object` }] }
        }
        const given = value as Readonly<Record<string, unknown>>
        const issues: StandardIssue[] = []
        for (const key of Object.keys(fields)) {
          const option = given[key]
          const field = fields[key] as OptionField
          if (option !== undefined && !field.accepts(option)) issues.push({ message: `expected ${field.expected}`, path: [key] })
        }
        return issues.length === 0 ? { value } : { issues }
      },
    },
    toJsonSchema: () => shape,
  } as AnySchema
}

const field = (expected: string, accepts: (value: unknown) => boolean, json: JsonSchemaNode = {}): OptionField =>
  ({ expected, accepts, json })

export const BOOLEAN = field('true or false', (v) => typeof v === 'boolean', { type: 'boolean' })
export const STRING = field('a string', (v) => typeof v === 'string', { type: 'string' })
export const NUMBER = field('a number', (v) => typeof v === 'number', { type: 'number' })
export const FUNCTION = field('a function', (v) => typeof v === 'function')
export const REGEXP = field('a RegExp', (v) => v instanceof RegExp)
export const DURATION = field(
  "a duration — milliseconds, or a string such as '10m'",
  (v) => typeof v === 'number' || typeof v === 'string',
  { type: ['number', 'string'] },
)
export const STRINGS = field(
  'a list of strings',
  (v) => Array.isArray(v) && v.every((item) => typeof item === 'string'),
  { type: 'array', items: { type: 'string' } },
)
export const STRING_RECORD = field(
  'an object of string values',
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((item) => typeof item === 'string'),
  { type: 'object', additionalProperties: { type: 'string' } },
)

/** Exactly one of these values. */
export function oneOf(...values: readonly (string | number | boolean)[]): OptionField {
  return field(values.map((value) => JSON.stringify(value)).join(', '), (v) => values.includes(v as never), { enum: [...values] })
}

/** Any one of these fields. */
export function either(...fields: readonly OptionField[]): OptionField {
  return field(
    fields.map((f) => f.expected).join(', or '),
    (v) => fields.some((f) => f.accepts(v)),
    { anyOf: fields.map((f) => f.json) },
  )
}
