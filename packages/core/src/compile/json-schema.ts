import type { JsonSchema, JsonSchemaBearer, SchemaConverter, SchemaIo } from '../contracts/json-schema.ts'
import type { AnySchema, StandardResult } from '../contracts/standard-schema.ts'

/**
 * Getting JSON Schema out of a Standard Schema — rfcs/0001 §13.3, §29.1.
 *
 * Standard Schema v1 has no shape channel, so this is necessarily a probe. It is
 * a *closed* set of probes with a documented order, not a heuristic: each step
 * either produces a schema or is skipped, and failure returns `null` so the
 * caller can emit an honest boot diagnostic rather than pretending the response
 * contract is enforced when it is not.
 */

const converters = new Map<string, SchemaConverter>()

/**
 * Teach Zen how to convert one vendor's schemas.
 *
 * This is the seam that keeps `@visionpilot/zen-core` at zero dependencies while still
 * supporting Zod and Valibot, whose converters are free functions in separate
 * packages rather than methods on the schema:
 *
 * ```ts
 * import { z } from 'zod'
 * registerSchemaConverter('zod', (s, io) => z.toJSONSchema(s as never, { io }))
 * ```
 *
 * The `io` argument is why this signature takes two parameters instead of one:
 * a schema with a default is optional on the way in and guaranteed on the way
 * out, and a converter that ignores the distinction produces a document that is
 * wrong about `required` for every such field.
 *
 * The vendor string is `schema['~standard'].vendor`, which the spec requires.
 */
export function registerSchemaConverter(vendor: string, convert: SchemaConverter): void {
  converters.set(vendor, convert)
}

export function schemaConverterFor(vendor: string): SchemaConverter | undefined {
  return converters.get(vendor)
}

/** Test-only. Registrations are process-global, like slots. */
export function __resetSchemaConverters(): void {
  converters.clear()
}

const JSON_SCHEMA_MARK = Symbol.for('zen.jsonSchema')

interface MarkedSchema extends AnySchema {
  readonly [JSON_SCHEMA_MARK]: JsonSchema
}

/**
 * Declare a response shape as raw JSON Schema, with its TypeScript type supplied
 * by the caller.
 *
 * The escape hatch for three real situations: a schema library with no converter
 * yet, a hand-written OpenAPI fragment, and Zen's own tests — which must exercise
 * the serializer without dragging a schema library into a zero-dependency
 * package.
 *
 * It deliberately does **not** validate. `validate` returns an issue instead of
 * passing input through, because a `jsonSchema()` silently accepting any request
 * body would be a security hole wearing a schema's clothes; `ready()` also
 * refuses it on a request source, so the mistake is caught at boot rather than
 * on the first malicious request.
 */
export function jsonSchema<T = unknown>(schema: JsonSchema): AnySchema & { readonly '~standard': { readonly types?: { input: T; output: T } | undefined } } {
  const marked = {
    [JSON_SCHEMA_MARK]: schema,
    '~standard': {
      version: 1 as const,
      vendor: 'zen-json-schema',
      validate: (): StandardResult<never> => ({
        issues: [{
          message:
            'jsonSchema() describes a response shape for serialization and OpenAPI; it cannot validate input. ' +
            'Use a Standard Schema library (Zod, Valibot, ArkType) for params/query/headers/cookies/body.',
        }],
      }),
    },
  }
  return marked as unknown as AnySchema & { readonly '~standard': { readonly types?: { input: T; output: T } | undefined } }
}

/** True for a schema produced by `jsonSchema()` — used by the boot-time check. */
export function isDescribeOnly(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && JSON_SCHEMA_MARK in schema
}

/**
 * Probe order, most authoritative first:
 *
 *   1. `jsonSchema()` marker           — the user handed us JSON Schema outright
 *   2. a bare JSON Schema object       — no `~standard`, but recognisably a schema
 *   3. a registered converter for `~standard.vendor` — Zod, Valibot
 *   4. `toJsonSchema()` / `toJSONSchema()` — ArkType and friends
 *
 * Step 3 sits above step 4 because a registration is an *explicit act* and a
 * method merely exists. That ordering was originally the other way round, and it
 * was wrong in a way that only showed up against a real library: Zod schemas
 * carry a `toJSONSchema()` method, so the converter a user had registered was
 * never called, and the method's default direction (`output`) was used to
 * describe request bodies — marking every field with a default as *required* in
 * a POST body that does not require it. Step 4 now passes `{ io }` as well, for
 * the libraries reached that way.
 *
 * Returns `null` when none apply. `null` is not an error here: the caller decides
 * whether an unconvertible schema is a warning (response — the type-level
 * contract still holds, the runtime one does not) or fatal.
 *
 * `io` defaults to `'output'` because the serializer — the only caller in core —
 * is describing what leaves the process. `@visionpilot/zen-openapi` passes `'input'` for
 * request sources.
 */
export function toJsonSchema(schema: unknown, io: SchemaIo = 'output'): JsonSchema | null {
  if (typeof schema !== 'object' || schema === null) return null

  const marked = (schema as Partial<MarkedSchema>)[JSON_SCHEMA_MARK]
  if (marked !== undefined) return marked

  if (!('~standard' in schema)) {
    return looksLikeJsonSchema(schema) ? (schema as JsonSchema) : null
  }

  const standard = (schema as AnySchema)['~standard']
  const convert = typeof standard === 'object' && standard !== null ? converters.get(standard.vendor) : undefined
  // The one cast at the converter boundary — see `JsonSchemaSource` for why it
  // is here rather than in every userland converter, and why it is safe.
  if (convert !== undefined) return callProbe(() => convert(schema, io) as JsonSchema | null)

  // `{ io }` is passed positionally-compatibly: libraries that take an options
  // object and do not know the key ignore it, and the ones that do (Zod) stop
  // describing a request body as though it were a response.
  const bearer = schema as JsonSchemaBearer
  if (typeof bearer.toJsonSchema === 'function') return callProbe(() => bearer.toJsonSchema!({ io }))
  if (typeof bearer.toJSONSchema === 'function') return callProbe(() => bearer.toJSONSchema!({ io }))

  return null
}

/**
 * A converter that throws is treated as "cannot convert", not as a crash.
 *
 * Zod's converter genuinely throws on constructs with no JSON Schema equivalent
 * (`z.transform`, `z.custom`), and that is a legitimate answer to "what shape is
 * this?" — it should produce the same honest boot warning as having no converter
 * at all, not take the application down.
 */
function callProbe(fn: () => JsonSchema | null): JsonSchema | null {
  try {
    const result = fn()
    return typeof result === 'object' && result !== null ? result : null
  } catch {
    return null
  }
}

const SHAPE_KEYWORDS = [
  'type', 'properties', 'items', 'prefixItems', 'enum', 'const',
  'anyOf', 'oneOf', 'allOf', '$ref', 'additionalProperties',
] as const

function looksLikeJsonSchema(value: object): boolean {
  for (const keyword of SHAPE_KEYWORDS) {
    if (keyword in value) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// $ref resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a local JSON Pointer against the root document.
 *
 * Only same-document refs are supported, and deliberately so: following a remote
 * `$ref` at boot would mean network I/O inside `ready()`, which is a hard no. The
 * two shapes real converters emit are `#/$defs/Name` and `#/definitions/Name`,
 * plus bare `#` for a self-recursive root.
 */
export function resolveRef(root: JsonSchema, ref: string): JsonSchema | null {
  if (ref === '#' || ref === '') return root
  if (!ref.startsWith('#/')) return null

  let node: unknown = root
  for (const rawSegment of ref.slice(2).split('/')) {
    if (typeof node !== 'object' || node === null) return null
    const segment = decodePointerSegment(rawSegment)
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === 'object' && node !== null ? (node as JsonSchema) : null
}

function decodePointerSegment(segment: string): string {
  // RFC 6901: ~1 is "/", ~0 is "~", and the order matters.
  return segment.includes('~') ? segment.replace(/~1/g, '/').replace(/~0/g, '~') : segment
}
