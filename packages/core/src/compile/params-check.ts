import type { PathSegment } from '../contracts/route.ts'
import type { AnySchema } from '../contracts/standard-schema.ts'
import type { JsonSchemaNode } from '../contracts/json-schema.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { closest } from '../primitives/nearest.ts'
import { toJsonSchema } from './json-schema.ts'

/**
 * A `params` schema, checked against the path it validates — rfcs/0001 §5.2.
 *
 * `params: z.object({ userId })` on `/users/:id` booted until
 * `0.1.0-alpha.4` and answered **every** request 400, because the schema
 * required a key the router never supplies. §5.2 described the check in the
 * present tense for two releases; `app.url()` gave `ZEN_PARAM_MISMATCH` its
 * first producer from the other direction, and this is the boot-time half.
 *
 * The schema is read through the same JSON Schema probe the serializer, the
 * coercion planner and the OpenAPI generator use, in the `input` direction —
 * a key with a default is not required on the way in. Four cases, by how sure
 * the verdict is:
 *
 * | Case | Severity |
 * | --- | --- |
 * | A required key the path does not supply — or supplies only from an optional segment | **error** |
 * | A path parameter the schema does not declare, under `additionalProperties: false` | **error**: every request is refused |
 * | A path parameter the schema does not declare, otherwise | warning: the schema drops `ctx.params.<name>` |
 * | An `integer` schema reading an untyped segment | reported once, for every route, as information |
 *
 * The last is not a mistake — coercion turns `'7'` into `7` (§11.4) — only a
 * choice with a cost: `:id<int>` makes `/users/abc` a 404 at the matcher,
 * before anything runs, where the schema makes it a 400 after validation.
 *
 * A schema that cannot be converted is checked by nothing here, for §11.4.3's
 * reason: `@erenthedeveloper0/zen-openapi` already reports it, and two warnings
 * about one schema train people to ignore both.
 */
export interface ParamsCheck {
  readonly errors: readonly Diagnostic[]
  readonly warnings: readonly Diagnostic[]
  /** Untyped path parameters an `integer` schema reads — the information row. */
  readonly untypedIntegers: readonly string[]
}

const CLEAN: ParamsCheck = { errors: [], warnings: [], untypedIntegers: [] }

export function checkParamsSchema(
  route: string,
  segments: readonly PathSegment[],
  schema: AnySchema | undefined,
): ParamsCheck {
  if (schema === undefined) return CLEAN
  const shape = toJsonSchema(schema, 'input')
  const properties = shape?.properties
  if (shape === null || properties === undefined) return CLEAN

  const supplied = new Map<string, PathSegment>()
  for (const segment of segments) {
    if (segment.kind === 'param' || segment.kind === 'wildcard') supplied.set(segment.value, segment)
  }
  const names = [...supplied.keys()]
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  const untypedIntegers: string[] = []

  for (const key of shape.required ?? []) {
    const segment = supplied.get(key)
    if (segment !== undefined && segment.optional !== true) continue
    if (segment !== undefined) {
      errors.push({
        severity: 'error',
        code: Codes.PARAM_MISMATCH,
        message:
          `${route}: the params schema requires "${key}", which the path supplies only when its optional ` +
          `segment is present.`,
        hint: `Make "${key}" optional in the schema, or the segment required in the path.`,
        consequence: `Every request that omits the segment would be refused with a 400.`,
        locations: [route],
      })
      continue
    }
    const meant = closest(key, names)
    errors.push({
      severity: 'error',
      code: Codes.PARAM_MISMATCH,
      message:
        `${route}: the params schema requires "${key}", and the path supplies ` +
        (names.length === 0 ? 'no parameters.' : `${names.map((n) => `"${n}"`).join(', ')}.`),
      hint: meant === null
        ? `Name the schema's keys after the path's parameters${names.length === 0 ? '' : ` (${names.join(', ')})`}, or add :${key} to the path.`
        : `Did you mean to name it "${meant}"? Rename the schema key, or the path parameter.`,
      consequence: `Every request to ${route} would be refused with a 400: the router never supplies "${key}".`,
      locations: [route],
    })
  }

  const closed = shape.additionalProperties === false
  for (const [name, segment] of supplied) {
    if (Object.hasOwn(properties, name)) {
      if (segment.kind === 'param' && segment.type === undefined && isInteger(properties[name])) {
        untypedIntegers.push(`${route} (:${name})`)
      }
      continue
    }
    const declared = Object.keys(properties)
    if (closed) {
      errors.push({
        severity: 'error',
        code: Codes.PARAM_MISMATCH,
        message: `${route}: the path supplies "${name}", and the params schema refuses any key it does not declare.`,
        hint: `Declare "${name}" in the schema${declared.length === 0 ? '' : ` (it declares ${declared.join(', ')})`}.`,
        consequence: `Every request to ${route} would be refused with a 400.`,
        locations: [route],
      })
    } else {
      warnings.push({
        severity: 'warning',
        code: Codes.PARAM_MISMATCH,
        message:
          `${route}: the path supplies "${name}", which the params schema does not declare, so ` +
          `ctx.params.${name} is whatever the schema does with an unknown key — usually, dropped.`,
        hint: `Declare "${name}" in the schema.`,
        locations: [route],
      })
    }
  }

  return errors.length === 0 && warnings.length === 0 && untypedIntegers.length === 0
    ? CLEAN
    : { errors, warnings, untypedIntegers }
}

function isInteger(node: JsonSchemaNode | undefined): boolean {
  if (typeof node !== 'object' || node === null) return false
  const type = node.type
  return type === 'integer' || (Array.isArray(type) && type.includes('integer'))
}
