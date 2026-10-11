import type { StatusCode } from '../contracts/http.ts'
import type { AnySchema } from '../contracts/standard-schema.ts'
import type { CodeGen } from './codegen.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { toJsonSchema } from './json-schema.ts'
import { exposureDiagnostics } from './exposure.ts'
import { buildProgram, type IrResult, type SerProgram } from './serializer-ir.ts'
import type { JsonSchema } from '../contracts/json-schema.ts'
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
  /**
   * One application's shared serializers — §11.6. Absent, every call compiles
   * its own, which is what a caller outside an application gets.
   */
  readonly memo?: SerializerMemo | undefined
}

/**
 * Serializers shared across an application's routes — rfcs/0001 §11.6.
 *
 * §11.6 promised that `Paginated(UserSchema)` used by ten routes is "one
 * compiled serializer shared by ten routes", and until `0.2.0-alpha` each
 * route compiled its own: ten units of identical source, ten functions the
 * JIT warmed separately, ten times the boot work. Two levels, as §11.6 says:
 *
 *   - **identity** — the same schema object converts and lowers to the IR
 *     once (`WeakMap`, so an application's schemas are not kept alive by it);
 *   - **structure** — two schemas whose IR is the same compile to one
 *     serializer, keyed by a canonical encoding of the IR. The IR, not the
 *     JSON Schema: two schemas differing only in a `description` or a
 *     `minLength` write the same bytes, so they are the same serializer.
 *
 * Diagnostics stay per route. What a schema is about — a `writeOnly` field, a
 * union the serializer cannot discriminate — is reported for every route that
 * uses it, naming that route, exactly as before; only the compiled function is
 * shared.
 */
export interface SerializerMemo {
  readonly identity: WeakMap<object, { readonly json: JsonSchema | null; readonly ir: Map<boolean, IrResult> }>
  readonly compiled: Map<string, Serializer>
}

export function createSerializerMemo(): SerializerMemo {
  return { identity: new WeakMap(), compiled: new Map() }
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
  media = 'application/json',
): StatusSerializerResult {
  const memo = options.memo
  const known = memo?.identity.get(schema as object)
  const jsonSchema = known !== undefined ? known.json : toJsonSchema(schema)
  const shared = known ?? (memo === undefined ? undefined : { json: jsonSchema, ir: new Map<boolean, IrResult>() })
  if (memo !== undefined && known === undefined && shared !== undefined) memo.identity.set(schema as object, shared)
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

  // A field the schema itself marks "never returned" — refused before a
  // serializer that would return it exists (§13.3, `compile/exposure.ts`).
  const exposed = exposureDiagnostics(jsonSchema, { routeId: options.routeId, status, media })
  if (exposed.some((d) => d.severity === 'error')) return { serializer: null, diagnostics: exposed }

  let lowered = shared?.ir.get(options.strict)
  if (lowered === undefined) {
    lowered = buildProgram(jsonSchema, options.strict)
    shared?.ir.set(options.strict, lowered)
  }
  const { program, diagnostics: irDiagnostics } = lowered
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

  if (memo === undefined) {
    return { serializer: buildSerializer(program, `${options.routeId}#${status}`, options), diagnostics: exposed }
  }
  const key = `${options.mode}:${programKey(program)}`
  let serializer = memo.compiled.get(key)
  if (serializer === undefined) {
    // Named after the first route to need it; the others reuse it by structure.
    serializer = buildSerializer(program, `${options.routeId}#${status}`, options)
    memo.compiled.set(key, serializer)
  }
  return { serializer, diagnostics: exposed }
}

/**
 * The IR in one canonical string — the structural key of §11.6's sharing.
 *
 * Every field the two engines read is in it, in a fixed order: `Map`s as
 * sorted entries, `Set`s as sorted lists, object keys sorted. Two programs
 * with the same key emit the same bytes for every value, which is the only
 * sense of "the same serializer" that matters.
 */
export function programKey(program: SerProgram): string {
  return stable(program)
}

function stable(value: unknown): string {
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => [String(k), v] as const)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `M{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  if (value instanceof Set) return `S[${[...value].map((v) => stable(v)).sort().join(',')}]`
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined) return 'u'
  return JSON.stringify(value) ?? String(value)
}

export function buildSerializer(program: SerProgram, name: string, options: { mode: SerializerMode; codegen: CodeGen }): Serializer {
  return options.mode === 'walk' ? walkSerializer(program) : compileSerializer(program, name, options.codegen)
}

const EMPTY: SerializerBuildResult = { table: null, diagnostics: [] }
