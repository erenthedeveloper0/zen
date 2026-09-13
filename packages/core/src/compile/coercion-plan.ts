import type { JsonSchema, JsonSchemaNode, JsonType } from '../contracts/json-schema.ts'
import type { AnySchema } from '../contracts/standard-schema.ts'
import type {
  BooleanWords, CoerceField, CoerceOp, CoercePlan, CoercionOptions, CoercionProfile,
  CoercionRecord, CoercionSpec, ValidationSource,
} from '../contracts/coercion.ts'
import { BOOLEAN_WORDS, COERCION_DEFAULTS, COERCION_OFF, VALIDATION_SOURCES } from '../contracts/coercion.ts'
import { resolveRef, toJsonSchema } from './json-schema.ts'

/**
 * Deriving a coercion plan from a schema — rfcs/0001 §11.4.
 *
 * The whole subsystem rests on one observation: **the schema already knows.**
 * A framework that coerces without reading the schema has to guess, and every
 * guess is wrong somewhere — `?zip=01234` becomes `1234`, `?id=1e5` becomes
 * `100000`, and a version string `?v=1.10` becomes `1.1`. A framework that
 * refuses to coerce at all makes the developer write `z.coerce.number()` on
 * every numeric field of every query schema they will ever write.
 *
 * So the plan is computed at boot from the *declared* type of each position,
 * obtained through the same `toJsonSchema` probe the response serializer and
 * the OpenAPI generator already use (§13.3, §29.1). Three consequences that are
 * worth stating because each one is load-bearing:
 *
 *   - **A position that accepts a string is never coerced.** That is checked
 *     before anything else, and it is what makes the zip-code case impossible
 *     rather than merely unlikely. It holds through unions: `z.union([z.string(),
 *     z.number()])` is left alone, because the value it arrived as is already
 *     one the schema accepts.
 *   - **An ambiguous position is never coerced.** A schema accepting both a
 *     number and a boolean cannot say which `'1'` meant, so the string is passed
 *     through and the schema decides. Silence is the only honest answer and it
 *     is cheaper than the wrong one.
 *   - **An unreadable schema coerces nothing, loudly.** `toJsonSchema` returning
 *     `null` produces a boot *warning* naming the routes, not a silent absence
 *     — the same call §13.3 makes about an unconvertible response schema, and
 *     for the same reason: half a promise kept silently is worse than no
 *     promise.
 *
 * Only **top-level properties** are planned. That is not a shortcut: the four
 * sources this applies to are flat by construction — a query string, a header
 * bag, a cookie jar and a form body have no nesting to descend into, and the
 * `qs`-style deep parsing that would create some is off by design (§19.5).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Profile resolution — the scope chain
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedProfiles = Readonly<Record<ValidationSource, CoercionProfile>>

/**
 * Fold app → collection → … → route into one profile per source.
 *
 * Merging field by field rather than "innermost wins outright" is the one place
 * this deliberately diverges from `resolveTimeout`, and §11.4's contract
 * explains why: a deadline is a single value, so two of them in scope is a
 * question of *which*; a profile is six independent switches, so an app saying
 * "no numeric coercion anywhere" and a route saying "but split my arrays on
 * commas" are not in conflict and both should hold.
 */
export function resolveCoercion(chain: readonly (CoercionSpec | undefined)[]): ResolvedProfiles {
  const out: Record<ValidationSource, CoercionProfile> = {
    params: COERCION_DEFAULTS.params,
    query: COERCION_DEFAULTS.query,
    headers: COERCION_DEFAULTS.headers,
    cookies: COERCION_DEFAULTS.cookies,
    body: COERCION_DEFAULTS.body,
  }

  for (const spec of chain) {
    if (spec === undefined) continue
    if (spec === false) {
      for (const source of VALIDATION_SOURCES) out[source] = COERCION_OFF
      continue
    }
    for (const source of VALIDATION_SOURCES) {
      const declared = (spec as CoercionOptions)[source]
      if (declared === undefined) continue
      out[source] = declared === false ? COERCION_OFF : { ...out[source], ...stripUndefined(declared) }
    }
  }

  return out
}

/**
 * `exactOptionalPropertyTypes` makes `{ numbers: undefined }` a different thing
 * from `{}`, and a spread would otherwise let an explicit `undefined` — which
 * is what an unset config key destructures to — erase a default.
 */
function stripUndefined(partial: Partial<CoercionProfile>): Partial<CoercionProfile> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(partial)) {
    const value = (partial as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = value
  }
  return out as Partial<CoercionProfile>
}

/**
 * True when a profile can never produce a plan, whatever the schema says.
 *
 * Checked *before* the schema is converted, which is the difference between a
 * feature that costs nothing when unused and one that merely runs quickly: an
 * app whose cookies profile is off never converts a cookie schema, so it never
 * pays the conversion and never gets a warning about a schema whose shape
 * nothing was going to read.
 */
export function isInert(profile: CoercionProfile): boolean {
  return (
    !profile.numbers &&
    profile.booleans === false &&
    profile.arrays === 'none' &&
    !profile.emptyStringAsUndefined
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan derivation
// ─────────────────────────────────────────────────────────────────────────────

export type PlanOutcome =
  /** A plan, or `null` when the schema declares nothing this profile can act on. */
  | { readonly kind: 'ok'; readonly plan: CoercePlan | null }
  /** `toJsonSchema` could not read the schema — the caller warns. */
  | { readonly kind: 'unconvertible' }
  /** Readable, but not a plain object at the root — a `$ref`, a union, a tuple. */
  | { readonly kind: 'not-object' }

export function buildCoercePlan(
  schema: AnySchema | undefined,
  source: ValidationSource,
  profile: CoercionProfile,
): PlanOutcome {
  if (schema === undefined || isInert(profile)) return OK_NONE

  const json = toJsonSchema(schema, 'input')
  if (json === null) return UNCONVERTIBLE

  const root = json
  const node = typeof root.$ref === 'string' ? resolveRef(root, root.$ref) : root
  if (node === null) return NOT_OBJECT

  const properties = node.properties
  if (properties === undefined) return NOT_OBJECT

  const words = wordsOf(profile.booleans)
  const fields: CoerceField[] = []

  for (const key of Object.keys(properties)) {
    const op = opFor(properties[key], root, profile, words, new Set())
    const emptyToUndefined = profile.emptyStringAsUndefined
    if (op === null && !emptyToUndefined) continue
    fields.push({
      key,
      altKey: profile.arrays === 'bracket' && op?.kind === 'array' ? `${key}[]` : null,
      emptyToUndefined,
      op,
    })
  }

  return fields.length === 0 ? OK_NONE : { kind: 'ok', plan: { source, fields } }
}

/**
 * Every source of one route, planned together.
 *
 * Returns `null` rather than an empty map when nothing is coerced, so that
 * "this route coerces nothing" has exactly one representation and the zero-cost
 * check downstream is `record.coercion === null` rather than a size test that
 * an empty map would quietly pass while still having been allocated.
 */
export function planRoute(
  schema: { readonly [K in ValidationSource]?: AnySchema | undefined },
  profiles: ResolvedProfiles,
): { readonly record: CoercionRecord | null; readonly unreadable: readonly ValidationSource[] } {
  let plans: Map<ValidationSource, CoercePlan> | null = null
  let unreadable: ValidationSource[] | null = null

  for (const source of VALIDATION_SOURCES) {
    const outcome = buildCoercePlan(schema[source], source, profiles[source])
    if (outcome.kind === 'ok') {
      if (outcome.plan !== null) (plans ??= new Map()).set(source, outcome.plan)
      continue
    }
    // `not-object` is deliberately silent. A `$ref` or a union at the root of a
    // query schema is already reported by the OpenAPI generator as
    // `ZEN_OAS_PARAMS_NOT_OBJECT` (§28.8), and a second warning about the same
    // schema, from a second subsystem, at every boot, would train people to
    // ignore both.
    if (outcome.kind === 'unconvertible') (unreadable ??= []).push(source)
  }

  return { record: plans, unreadable: unreadable ?? EMPTY_SOURCES }
}

const EMPTY_SOURCES: readonly ValidationSource[] = Object.freeze([])

const OK_NONE: PlanOutcome = { kind: 'ok', plan: null }
const UNCONVERTIBLE: PlanOutcome = { kind: 'unconvertible' }
const NOT_OBJECT: PlanOutcome = { kind: 'not-object' }

function wordsOf(booleans: boolean | BooleanWords): BooleanWords | null {
  if (booleans === false) return null
  if (booleans === true) return BOOLEAN_WORDS
  return { true: booleans.true.map(lower), false: booleans.false.map(lower) }
}

const lower = (word: string): string => word.toLowerCase()

/**
 * The decision, for one position.
 *
 * Reads as a sequence of refusals on purpose. Everything before the last two
 * lines is a reason *not* to convert, because the failure mode this subsystem
 * has to avoid is converting something it should have left alone — a request
 * that arrives as the wrong type produces a 400 the client can read, and a
 * request that arrives silently mangled produces a support ticket six weeks
 * later.
 */
function opFor(
  node: JsonSchemaNode | undefined,
  root: JsonSchema,
  profile: CoercionProfile,
  words: BooleanWords | null,
  seen: Set<string>,
): CoerceOp | null {
  const types = accepted(node, root, seen)

  // Unconstrained. `z.unknown()`, `z.any()`, an empty schema — the position
  // will take whatever arrives, so there is nothing to convert *to*.
  if (types === null) return null

  // Rule 1. The value is already a type the schema accepts.
  if (types.has('string')) return null

  const wantsArray = types.has('array')
  const wantsNumeric = types.has('number') || types.has('integer')
  const wantsBoolean = types.has('boolean')

  // Rule 2. Two different target classes and one string: the wire cannot say
  // which was meant, so neither can this.
  const classes = (wantsArray ? 1 : 0) + (wantsNumeric ? 1 : 0) + (wantsBoolean ? 1 : 0)
  if (classes !== 1) return null

  if (wantsArray) {
    // `arrays: 'none'` still permits *element* coercion. The style governs how
    // a scalar becomes a list, not what the list contains — so an app that has
    // turned array shaping off still gets `?ids=1&ids=2` as numbers.
    const items = opFor(itemsOf(node, root, new Set()), root, profile, words, seen)
    const wrap = profile.arrays === 'repeat' || profile.arrays === 'bracket'
    const split = profile.arrays === 'comma' ? ',' : null
    if (items === null && !wrap && split === null) return null
    return { kind: 'array', wrap, split, items }
  }

  if (wantsNumeric && profile.numbers) {
    return types.has('number') ? NUMBER : INTEGER
  }

  if (wantsBoolean && words !== null) {
    return { kind: 'boolean', words }
  }

  return null
}

const NUMBER: CoerceOp = Object.freeze({ kind: 'number' })
const INTEGER: CoerceOp = Object.freeze({ kind: 'integer' })

/**
 * The set of JSON types a position will accept, or `null` for "no constraint".
 *
 * `null` and "the empty set" are genuinely different answers and both are
 * reachable — `z.unknown()` constrains nothing, `z.never()` accepts nothing —
 * so they must not be conflated into a falsy check. Both end in no coercion,
 * by different routes.
 */
function accepted(
  node: JsonSchemaNode | undefined,
  root: JsonSchema,
  seen: Set<string>,
): Set<JsonType> | null {
  if (node === undefined || node === true) return null
  if (node === false) return EMPTY_TYPES
  if (typeof node !== 'object') return null

  if (typeof node.$ref === 'string') {
    // A recursive schema in a query string is not a shape anyone should be
    // coercing into, and following the cycle would not terminate.
    if (seen.has(node.$ref)) return null
    seen.add(node.$ref)
    const target = resolveRef(root, node.$ref)
    return target === null ? null : accepted(target, root, seen)
  }

  // Intersected, because every constraint present on one node must hold at once
  // — `allOf` and a sibling `type` are both binding, and JSON Schema says so.
  const constraints: Array<Set<JsonType> | null> = []

  if ('const' in node) constraints.push(new Set([jsonTypeOf(node.const)]))

  if (Array.isArray(node.enum)) {
    const fromEnum = new Set<JsonType>()
    for (const value of node.enum) fromEnum.add(jsonTypeOf(value))
    constraints.push(fromEnum)
  }

  const branches = node.oneOf ?? node.anyOf
  if (Array.isArray(branches) && branches.length > 0) constraints.push(unionOf(branches, root, seen))

  if (Array.isArray(node.allOf)) {
    for (const member of node.allOf) constraints.push(accepted(member, root, seen))
  }

  if (node.type !== undefined) {
    constraints.push(new Set(Array.isArray(node.type) ? node.type : [node.type]))
  }

  let out: Set<JsonType> | null = null
  for (const constraint of constraints) {
    if (constraint === null) continue
    out = out === null ? new Set(constraint) : intersect(out, constraint)
  }

  // OpenAPI 3.0's spelling of `type: [..., 'null']`. Widening rather than
  // narrowing, and harmless either way: a query string cannot deliver `null`,
  // so its presence never changes which conversion is chosen.
  if (node.nullable === true && out !== null) out.add('null')

  return out
}

const EMPTY_TYPES: Set<JsonType> = new Set()

function unionOf(
  branches: readonly JsonSchemaNode[],
  root: JsonSchema,
  seen: Set<string>,
): Set<JsonType> | null {
  const out = new Set<JsonType>()
  for (const branch of branches) {
    // One unconstrained branch makes the union unconstrained: the position
    // accepts anything, including the string it already is.
    const types = accepted(branch, root, new Set(seen))
    if (types === null) return null
    for (const type of types) out.add(type)
  }
  return out
}

/**
 * Set intersection, with the one subtype relation JSON Schema actually has.
 *
 * `integer` is a *subtype* of `number`, so a position constrained to `number`
 * by its `type` and to `integer` by a sibling keyword accepts integers rather
 * than nothing. A plain set intersection says otherwise, and the case is not
 * exotic: `z.literal(7)` converts to `{ type: 'number', const: 7 }`, whose
 * const is an integer — so a naive intersection makes every numeric literal in
 * a query string uncoercible, which is precisely the sort of quiet
 * almost-working this subsystem exists to avoid.
 */
function intersect(a: Set<JsonType>, b: Set<JsonType>): Set<JsonType> {
  const out = new Set<JsonType>()
  for (const type of a) if (b.has(type)) out.add(type)
  if (!out.has('integer') && ((a.has('integer') && b.has('number')) || (a.has('number') && b.has('integer')))) {
    out.add('integer')
  }
  return out
}

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string': return 'string'
    case 'boolean': return 'boolean'
    case 'number': return Number.isInteger(value) ? 'integer' : 'number'
    default: return 'object'
  }
}

/**
 * The element schema of whichever branch of `node` is the array one.
 *
 * `z.array(z.number()).nullable()` converts to `anyOf: [{ type: 'array', items:
 * … }, { type: 'null' }]`, so the items are one level below where a naive read
 * looks for them. Tuples (`prefixItems`) return `undefined`: a positional tuple
 * in a query string has per-position types and one list of strings to apply
 * them to, and getting that wrong silently is worse than not doing it.
 */
function itemsOf(
  node: JsonSchemaNode | undefined,
  root: JsonSchema,
  seen: Set<string>,
): JsonSchemaNode | undefined {
  if (typeof node !== 'object' || node === null) return undefined

  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) return undefined
    seen.add(node.$ref)
    const target = resolveRef(root, node.$ref)
    return target === null ? undefined : itemsOf(target, root, seen)
  }

  if (node.prefixItems !== undefined) return undefined
  if (node.items !== undefined) return node.items

  for (const list of [node.oneOf, node.anyOf, node.allOf]) {
    if (!Array.isArray(list)) continue
    for (const branch of list) {
      const found = itemsOf(branch, root, seen)
      if (found !== undefined) return found
    }
  }

  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — for `explainRoute`, `zen routes`, and the OpenAPI generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `page → integer`, `tags → array of string (split on ",")`.
 *
 * The blank-handling is parenthesised rather than listed as a second item,
 * because these strings are themselves joined with commas one level up and a
 * flat `page → integer, blank → absent` reads as two fields.
 */
export function describeField(field: CoerceField): string {
  const from = field.altKey === null ? field.key : `${field.key} | ${field.altKey}`
  const blank = field.emptyToUndefined ? 'blank → absent' : null

  if (field.op === null) return `${from} → ${blank ?? 'nothing'}`
  return `${from} → ${describeOp(field.op)}${blank === null ? '' : ` (${blank})`}`
}

function describeOp(op: CoerceOp): string {
  switch (op.kind) {
    case 'number': return 'number'
    case 'integer': return 'integer'
    case 'boolean': return 'boolean'
    case 'array': {
      const inner = op.items === null ? 'string' : describeOp(op.items)
      const how = op.split !== null ? ` (split on "${op.split}")` : op.wrap ? ' (repeat)' : ''
      return `array of ${inner}${how}`
    }
  }
}
