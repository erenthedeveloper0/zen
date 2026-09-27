import type { StatusCode } from '../contracts/http.ts'
import type { AnySchema } from '../contracts/standard-schema.ts'
import type { CodeGen } from './codegen.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { toJsonSchema } from './json-schema.ts'
import { buildProgram, type SerProgram } from './serializer-ir.ts'
import { compileSerializer, type Serializer } from './serializer-compiler.ts'
import { walkSerializer } from './serializer-walk.ts'
import { isVariantRecord } from './media-type.ts'

/**
 * Route response schemas → the per-status serializer table — rfcs/0001 §13.3.
 *
 * The status is only known at runtime (a handler may return 200 or 201 from the
 * same route), so the table is a `Map` built at boot and consulted once per
 * response. A miss means "no declared contract for this status" and falls back
 * to `JSON.stringify` — the honest behaviour, since inventing a contract the
 * author did not write would be worse than not having one.
 */
export type SerializerTable = ReadonlyMap<number, Serializer>

export type SerializerMode = 'compiled' | 'walk' | 'off'

export interface SerializerBuildOptions {
  readonly routeId: string
  readonly strict: boolean
  readonly mode: SerializerMode
  readonly codegen: CodeGen
}

export interface SerializerBuildResult {
  readonly table: SerializerTable | null
  readonly diagnostics: readonly Diagnostic[]
}

export function buildSerializerTable(
  response: Readonly<Record<StatusCode, unknown>> | undefined,
  options: SerializerBuildOptions,
): SerializerBuildResult {
  if (response === undefined || options.mode === 'off') return EMPTY

  const table = new Map<number, Serializer>()
  const diagnostics: Diagnostic[] = []

  for (const key of Object.keys(response)) {
    const status = Number(key)
    if (!Number.isInteger(status)) {
      diagnostics.push({
        severity: 'error',
        code: Codes.SCHEMA_UNCONVERTIBLE,
        message: `Response schema key "${key}" on ${options.routeId} is not a status code.`,
        hint:
          'Response schemas are keyed by numeric status. There is no "2XX" or "default" key: the serializer binds one ' +
          'contract to one status, and error responses come from the error engine, which @erenthedeveloper0/zen-openapi documents as 4XX/5XX.',
      })
      continue
    }

    const schema = (response as Record<string, unknown>)[key]
    if (schema === null || schema === undefined) continue

    // §13.4 — a status declared in the *variant* form belongs to the negotiation
    // plan, which builds one serializer per media type. Skipping it here rather
    // than teaching this table about media types keeps the plain path exactly
    // what it was: one status, one contract, no dimension it does not use.
    if (isVariantRecord(schema)) continue

    const built = compileStatusSerializer(schema as AnySchema, status, options)
    diagnostics.push(...built.diagnostics)
    if (built.serializer !== null) table.set(status, built.serializer)
  }

  return { table: table.size > 0 ? table : null, diagnostics }
}

export interface StatusSerializerResult {
  readonly serializer: Serializer | null
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * One schema, one status → one serializer, or an honest reason there is none.
 *
 * Extracted so the plain form (`buildSerializerTable`) and the negotiated form
 * (`buildNegotiation`, §13.4) share it. That sharing is the point rather than
 * tidiness: it is what makes `200: UserSchema` and
 * `200: { 'application/json': UserSchema }` produce the *same* serializer, with
 * the same diagnostics and the same guarantee about undeclared fields. Two code
 * paths would eventually be two behaviours, and the one that got less use would
 * be the one that quietly stopped filtering.
 */
export function compileStatusSerializer(
  schema: AnySchema,
  status: number,
  options: SerializerBuildOptions,
): StatusSerializerResult {
  const jsonSchema = toJsonSchema(schema)
  if (jsonSchema === null) {
    // A *warning*, not an error, and the distinction matters. The route still
    // has a type-level contract — `HandlerResult` is narrowed either way — but
    // the runtime guarantee is absent, and silently having half the promise is
    // exactly what §13.3 is a reaction to. So: boot, loudly, and say which
    // half is missing.
    return {
      serializer: null,
      diagnostics: [{
        severity: 'warning',
        code: Codes.SCHEMA_UNCONVERTIBLE,
        message:
          `${options.routeId} declares a response schema for ${status}, but it could not be converted to JSON Schema. ` +
          'Responses for this status will be serialized with JSON.stringify and undeclared fields will NOT be filtered.',
        hint:
          'Register a converter for this schema library — `registerSchemaConverter("zod", s => z.toJSONSchema(s, { io: "output" }))` — ' +
          'or declare the shape directly with `jsonSchema<T>({ ... })`.',
        locations: [options.routeId],
      }],
    }
  }

  const { program, diagnostics: irDiagnostics } = buildProgram(jsonSchema, options.strict)
  if (program === null) {
    return {
      serializer: null,
      diagnostics: irDiagnostics.map((problem) => ({
        severity: 'error' as const,
        code: Codes.SCHEMA_UNCONVERTIBLE,
        message: `${options.routeId} response ${status}: ${problem.message}`,
        hint: problem.hint,
        locations: [`${options.routeId} → ${problem.path}`],
      })),
    }
  }

  return {
    serializer: buildSerializer(program, `${options.routeId}#${status}`, options),
    diagnostics: [],
  }
}

export function buildSerializer(program: SerProgram, name: string, options: { mode: SerializerMode; codegen: CodeGen }): Serializer {
  return options.mode === 'walk' ? walkSerializer(program) : compileSerializer(program, name, options.codegen)
}

const EMPTY: SerializerBuildResult = { table: null, diagnostics: [] }
