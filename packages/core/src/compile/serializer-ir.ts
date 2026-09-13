import type { JsonSchema, JsonSchemaNode, JsonType } from '../contracts/json-schema.ts'
import { resolveRef } from './json-schema.ts'

/**
 * The serializer IR — rfcs/0001 §13.3.
 *
 * JSON Schema is normalised once, at boot, into a small closed union. Both
 * engines then consume *this*, never the raw schema. That is the single most
 * important structural decision in this subsystem: the compiled serializer and
 * the walking serializer cannot disagree about what `type: ['string','null']`
 * means, or about whether an absent `additionalProperties` drops or passes
 * through, because neither of them ever sees those keywords. Everything the
 * differential suite has to prove is reduced to "the same tree, two traversal
 * strategies".
 *
 * It is also where the security decision lives. In JSON Schema, an absent
 * `additionalProperties` means *allow*. Here it means **drop** — see
 * `normaliseObject`.
 */

export type SerNode =
  /** `{}` / `true` / `z.unknown()` — the declared-anything opt-out. */
  | { readonly kind: 'any'; readonly path: string }
  /** `false` — nothing may be emitted. */
  | { readonly kind: 'none'; readonly path: string }
  | { readonly kind: 'string'; readonly path: string; readonly format: 'plain' | 'date-time' | 'date' }
  | { readonly kind: 'number'; readonly path: string }
  | { readonly kind: 'integer'; readonly path: string }
  | { readonly kind: 'boolean'; readonly path: string }
  | { readonly kind: 'null'; readonly path: string }
  | { readonly kind: 'const'; readonly path: string; readonly value: unknown; readonly encoded: string }
  | { readonly kind: 'enum'; readonly path: string; readonly values: readonly unknown[]; readonly encoded: readonly string[] }
  | { readonly kind: 'nullable'; readonly path: string; readonly inner: SerNode }
  | {
      readonly kind: 'object'
      readonly path: string
      readonly props: readonly SerProp[]
      /** Declared keys, precomputed so neither engine scans `props` per request. */
      readonly declared: ReadonlySet<string>
      /** `'drop'` is the default and the security property. */
      readonly additional: SerNode | 'drop' | 'passthrough'
    }
  | { readonly kind: 'array'; readonly path: string; readonly items: SerNode }
  | { readonly kind: 'tuple'; readonly path: string; readonly items: readonly SerNode[]; readonly rest: SerNode | null }
  | { readonly kind: 'union'; readonly path: string; readonly branches: readonly SerBranch[] }
  | { readonly kind: 'ref'; readonly path: string; readonly name: string }

export interface SerProp {
  readonly key: string
  /** The key already encoded as a JSON fragment, e.g. `"email":`. */
  readonly encodedKey: string
  readonly required: boolean
  readonly node: SerNode
}

export interface SerBranch {
  readonly test: SerTest
  readonly node: SerNode
}

/**
 * How a union branch is chosen at runtime.
 *
 * Deliberately a closed set of *cheap* tests. Zen will not try every branch's
 * full validator to see which one fits — that would make serialization
 * O(branches × size) and would smuggle a validator into the response path. If
 * the branches cannot be told apart by one of these, that is a boot diagnostic
 * telling the author to add a discriminant, not a silent slow path.
 */
export type SerTest =
  | { readonly kind: 'typeof'; readonly type: 'string' | 'number' | 'boolean' | 'bigint' }
  | { readonly kind: 'null' }
  | { readonly kind: 'array' }
  | { readonly kind: 'object' }
  | { readonly kind: 'discriminant'; readonly prop: string; readonly value: unknown }
  | { readonly kind: 'present'; readonly prop: string }
  | { readonly kind: 'const'; readonly value: unknown }
  | { readonly kind: 'enum'; readonly values: readonly unknown[] }
  | { readonly kind: 'always' }

export interface SerProgram {
  readonly root: SerNode
  readonly defs: ReadonlyMap<string, SerNode>
  readonly strict: boolean
}

export interface IrDiagnostic {
  readonly path: string
  readonly message: string
  readonly hint: string
}

export interface IrResult {
  readonly program: SerProgram | null
  readonly diagnostics: readonly IrDiagnostic[]
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildProgram(schema: JsonSchema, strict: boolean): IrResult {
  const diagnostics: IrDiagnostic[] = []
  const defs = new Map<string, SerNode>()
  const refNames = new Map<string, string>()
  const builder = new Builder(schema, defs, refNames, diagnostics)

  const root = builder.node(schema, '$')
  builder.drain()

  if (diagnostics.length > 0) return { program: null, diagnostics }
  return { program: { root, defs, strict }, diagnostics }
}

class Builder {
  readonly #root: JsonSchema
  readonly #defs: Map<string, SerNode>
  readonly #names: Map<string, string>
  readonly #diagnostics: IrDiagnostic[]
  readonly #queue: Array<{ ref: string; name: string; schema: JsonSchema }> = []
  #counter = 0

  constructor(
    root: JsonSchema,
    defs: Map<string, SerNode>,
    names: Map<string, string>,
    diagnostics: IrDiagnostic[],
  ) {
    this.#root = root
    this.#defs = defs
    this.#names = names
    this.#diagnostics = diagnostics
  }

  /** Definitions are compiled after the root so recursion terminates. */
  drain(): void {
    while (this.#queue.length > 0) {
      const job = this.#queue.shift() as { ref: string; name: string; schema: JsonSchema }
      this.#defs.set(job.name, this.node(job.schema, `$(${job.name})`))
    }
  }

  fail(path: string, message: string, hint: string): void {
    this.#diagnostics.push({ path, message, hint })
  }

  node(schema: JsonSchema | boolean | undefined, path: string): SerNode {
    if (schema === undefined || schema === true) return { kind: 'any', path }
    if (schema === false) return { kind: 'none', path }
    if (typeof schema !== 'object') return { kind: 'any', path }

    if (typeof schema.$ref === 'string') return this.#ref(schema.$ref, path)

    for (const keyword of SHAPE_CHANGING_UNSUPPORTED) {
      if (schema[keyword] !== undefined) {
        this.fail(
          path,
          `Response schema uses "${keyword}", which changes which properties are emitted and which the serializer cannot honour.`,
          'Declare the properties explicitly, or opt this position out with `additionalProperties: true` if unfiltered output is genuinely intended.',
        )
        return { kind: 'any', path }
      }
    }

    if (schema.const !== undefined) {
      return { kind: 'const', path, value: schema.const, encoded: encodeLiteral(schema.const) }
    }

    if (Array.isArray(schema.enum)) return this.#enum(schema.enum, path)

    const allOf = schema.allOf
    if (Array.isArray(allOf) && allOf.length > 0) return this.#allOf(schema, allOf, path)

    const union = schema.oneOf ?? schema.anyOf
    if (Array.isArray(union) && union.length > 0) return this.#union(schema, union, path)

    return this.#byType(schema, path)
  }

  #byType(schema: JsonSchema, path: string): SerNode {
    const declared = schema.type
    const types: readonly JsonType[] =
      declared === undefined ? [] : Array.isArray(declared) ? declared : [declared as JsonType]

    // OpenAPI 3.0's `nullable: true` and 3.1's `type: [..., 'null']` mean the
    // same thing and are folded into one IR node so the engines see one shape.
    const nullable = schema.nullable === true || types.includes('null')
    const concrete = types.filter((t) => t !== 'null')

    if (concrete.length === 0) {
      // `type: 'null'`, or no type at all but object-ish keywords present.
      if (nullable && types.length > 0) return { kind: 'null', path }
      const inferred = this.#inferShape(schema, path)
      return nullable ? { kind: 'nullable', path, inner: inferred } : inferred
    }

    if (concrete.length === 1) {
      const inner = this.#single(schema, concrete[0] as JsonType, path)
      return nullable ? { kind: 'nullable', path, inner } : inner
    }

    // `type: ['string','number']` — a union in disguise. Same machinery.
    const branches: SerBranch[] = []
    for (const type of concrete) {
      const node = this.#single(schema, type, path)
      const test = testForType(type)
      if (test === null) {
        this.fail(path, `Cannot discriminate the multi-type schema at ${path}.`, 'Use `oneOf` with a discriminant property instead of a `type` array.')
        return { kind: 'any', path }
      }
      branches.push({ test, node })
    }
    if (nullable) branches.unshift({ test: { kind: 'null' }, node: { kind: 'null', path } })
    return { kind: 'union', path, branches }
  }

  #single(schema: JsonSchema, type: JsonType, path: string): SerNode {
    switch (type) {
      case 'string': {
        const format = schema.format === 'date-time' ? 'date-time' : schema.format === 'date' ? 'date' : 'plain'
        return { kind: 'string', path, format }
      }
      case 'number': return { kind: 'number', path }
      case 'integer': return { kind: 'integer', path }
      case 'boolean': return { kind: 'boolean', path }
      case 'null': return { kind: 'null', path }
      case 'object': return this.#object(schema, path)
      case 'array': return this.#array(schema, path)
    }
  }

  /** No `type`, but the keywords give the shape away. */
  #inferShape(schema: JsonSchema, path: string): SerNode {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      return this.#object(schema, path)
    }
    if (schema.items !== undefined || schema.prefixItems !== undefined) return this.#array(schema, path)
    return { kind: 'any', path }
  }

  #object(schema: JsonSchema, path: string): SerNode {
    const properties = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const props: SerProp[] = []

    for (const key of Object.keys(properties)) {
      const child = properties[key]
      props.push({
        key,
        encodedKey: `${encodeLiteral(key)}:`,
        required: required.has(key),
        node: this.node(child, `${path}.${key}`),
      })
    }

    // ── The security decision, in one expression ─────────────────────────────
    // JSON Schema says an absent `additionalProperties` permits extra keys. Zen
    // inverts that default: absent means **drop**. §13.3.1 is the whole reason
    // this subsystem exists, and a serializer whose default is "emit whatever
    // the object happens to carry" would not prevent a single `passwordHash`
    // from shipping. Passing keys through remains available — it just has to be
    // written down.
    const additionalSchema = schema.additionalProperties
    const additional: SerNode | 'drop' | 'passthrough' =
      additionalSchema === undefined || additionalSchema === false ? 'drop'
      : additionalSchema === true ? 'passthrough'
      : this.node(additionalSchema, `${path}[*]`)

    return { kind: 'object', path, props, declared: new Set(props.map((p) => p.key)), additional }
  }

  #array(schema: JsonSchema, path: string): SerNode {
    const prefix = schema.prefixItems
    if (Array.isArray(prefix)) {
      const items = prefix.map((item, index) => this.node(item, `${path}[${index}]`))
      const rest = schema.items === undefined || schema.items === false ? null : this.node(schema.items, `${path}[]`)
      return { kind: 'tuple', path, items, rest }
    }
    return { kind: 'array', path, items: this.node(schema.items, `${path}[]`) }
  }

  #enum(values: readonly unknown[], path: string): SerNode {
    if (values.length === 0) return { kind: 'none', path }
    if (values.length === 1) {
      return { kind: 'const', path, value: values[0], encoded: encodeLiteral(values[0]) }
    }
    return { kind: 'enum', path, values, encoded: values.map(encodeLiteral) }
  }

  /**
   * `allOf` is an intersection. Only the case that actually describes a shape —
   * a merge of object schemas — is supported; anything else is a diagnostic
   * rather than a guess, because guessing wrong here means either dropping a
   * declared field or emitting an undeclared one.
   */
  #allOf(parent: JsonSchema, members: readonly JsonSchema[], path: string): SerNode {
    if (members.length === 1 && !hasOwnShape(parent)) return this.node(members[0], path)

    const parts: JsonSchema[] = []
    for (const member of members) {
      const resolved = typeof member.$ref === 'string' ? resolveRef(this.#root, member.$ref) : member
      if (resolved === null) {
        this.fail(path, `Unresolvable $ref "${String(member.$ref)}" inside allOf.`, 'Only same-document refs (#/$defs/Name) are supported.')
        return { kind: 'any', path }
      }
      parts.push(resolved)
    }
    if (hasOwnShape(parent)) parts.push(parent)

    const mergeable = parts.every((p) => isObjectLike(p) && p.allOf === undefined && p.anyOf === undefined && p.oneOf === undefined)
    if (!mergeable) {
      this.fail(
        path,
        'Only an allOf of object schemas can be merged into a response serializer.',
        'Flatten the intersection into one object schema, or declare the response with a single schema.',
      )
      return { kind: 'any', path }
    }

    const properties: Record<string, JsonSchemaNode> = {}
    const required: string[] = []
    let additional: JsonSchemaNode | undefined
    for (const part of parts) {
      for (const [key, value] of Object.entries(part.properties ?? {})) properties[key] = value
      for (const key of part.required ?? []) if (!required.includes(key)) required.push(key)
      if (part.additionalProperties !== undefined) additional = part.additionalProperties
    }

    const merged: JsonSchema = additional === undefined
      ? { type: 'object', properties, required }
      : { type: 'object', properties, required, additionalProperties: additional }
    return this.#object(merged, path)
  }

  #union(parent: JsonSchema, members: readonly JsonSchema[], path: string): SerNode {
    const resolved = members.map((member) => ({
      schema: typeof member.$ref === 'string' ? (resolveRef(this.#root, member.$ref) ?? member) : member,
      original: member,
    }))

    // `T | null` is by far the most common union and deserves the cheapest
    // possible shape rather than a two-branch dispatch. Null branches are
    // collapsed first, and *then* counted: converters emit `anyOf: [X, null]`,
    // `anyOf: [null]` and even `anyOf: [null, null]`, and a union of
    // indistinguishable nulls is not an ambiguity worth a diagnostic — every
    // branch produces the same bytes.
    const nonNull = resolved.filter((m) => !isNullSchema(m.schema))
    if (nonNull.length === 0) return { kind: 'null', path }
    if (nonNull.length === 1) {
      const only = nonNull[0] as { schema: JsonSchema; original: JsonSchema }
      const inner = this.node(only.original, path)
      return resolved.length === nonNull.length ? inner : { kind: 'nullable', path, inner }
    }

    const tests = this.#discriminate(parent, resolved.map((m) => m.schema), path)
    if (tests === null) return { kind: 'any', path }

    const branches: SerBranch[] = resolved.map((member, index) => ({
      test: tests[index] as SerTest,
      node: this.node(member.original, `${path}|${index}`),
    }))
    return { kind: 'union', path, branches }
  }

  /**
   * Pick one cheap runtime test per branch, in this order:
   *
   *   1. distinct primitive `type`s        → `typeof`
   *   2. a shared const-valued property    → discriminated union (the good case)
   *   3. a required property unique to one branch → presence test
   *
   * Anything else is refused with a diagnostic that says what to add. Refusing
   * is the honest answer: a union Zen cannot tell apart would otherwise be
   * serialized by whichever branch happened to be first, which is a silent
   * wrong-fields bug — the exact failure mode §13.3 exists to eliminate.
   */
  #discriminate(parent: JsonSchema, members: readonly JsonSchema[], path: string): SerTest[] | null {
    const byType: SerTest[] = []
    let distinctTypes = true
    const seen = new Set<string>()
    for (const member of members) {
      const test = simpleTestFor(member)
      if (test === null || seen.has(JSON.stringify(test))) { distinctTypes = false; break }
      seen.add(JSON.stringify(test))
      byType.push(test)
    }
    if (distinctTypes && byType.length === members.length) return byType

    const declared = parent.discriminator?.propertyName
    const candidates = declared !== undefined ? [declared] : sharedPropertyNames(members)

    for (const prop of candidates) {
      const values: unknown[] = []
      let usable = true
      for (const member of members) {
        const literal = literalOf(member.properties?.[prop])
        if (literal === NO_LITERAL || values.some((v) => Object.is(v, literal))) { usable = false; break }
        values.push(literal)
      }
      if (usable) {
        return members.map((_, index) => ({ kind: 'discriminant', prop, value: values[index] } as const))
      }
    }

    const presence = uniqueRequiredProps(members)
    if (presence !== null) return presence.map((prop) => ({ kind: 'present', prop } as const))

    this.fail(
      path,
      `Cannot tell the ${members.length} branches of this union apart at serialization time.`,
      declared !== undefined
        ? `The declared discriminator "${declared}" is not a literal in every branch.`
        : 'Give every branch a literal discriminant property (e.g. `kind: "user"` / `kind: "admin"`), or declare one response schema per status code.',
    )
    return null
  }

  #ref(ref: string, path: string): SerNode {
    const existing = this.#names.get(ref)
    if (existing !== undefined) return { kind: 'ref', path, name: existing }

    // Follow `$ref` → `$ref` chains here rather than letting them into the IR.
    // A ref node whose target is another ref would make both engines recurse
    // without ever reaching a value, and a *cyclic* chain would hang the
    // compiler at boot — a hang being the one failure mode a boot diagnostic
    // cannot report.
    const seen = new Set<string>([ref])
    let pointer = ref
    let target = resolveRef(this.#root, pointer)
    while (target !== null && typeof target.$ref === 'string') {
      pointer = target.$ref
      if (seen.has(pointer)) {
        this.fail(path, `Circular $ref chain starting at "${ref}".`, 'A $ref must eventually resolve to a schema with a type or properties.')
        return { kind: 'any', path }
      }
      seen.add(pointer)
      target = resolveRef(this.#root, pointer)
    }

    if (target === null) {
      this.fail(path, `Unresolvable $ref "${ref}".`, 'Only same-document refs are supported (#/$defs/Name, #/definitions/Name, or #).')
      return { kind: 'any', path }
    }

    const name = `d${this.#counter++}`
    for (const alias of seen) this.#names.set(alias, name)
    this.#queue.push({ ref, name, schema: target })
    return { kind: 'ref', path, name }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keywords that would change which properties are emitted. Validation-only
 * keywords (`pattern`, `minimum`, `not`, `if`) are ignored on purpose: the
 * response has already been produced, and re-checking it on the way out would
 * be a second validator with no new authority (§13.3).
 */
const SHAPE_CHANGING_UNSUPPORTED = ['patternProperties', 'unevaluatedProperties'] as const

const NO_LITERAL = Symbol('no-literal')

function literalOf(schema: JsonSchemaNode | undefined): unknown {
  if (schema === undefined || typeof schema !== 'object') return NO_LITERAL
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return schema.enum[0]
  return NO_LITERAL
}

function sharedPropertyNames(members: readonly JsonSchema[]): string[] {
  const first = members[0]
  if (first === undefined || first.properties === undefined) return []
  return Object.keys(first.properties).filter((key) =>
    members.every((member) => member.properties?.[key] !== undefined),
  )
}

function uniqueRequiredProps(members: readonly JsonSchema[]): string[] | null {
  const picks: string[] = []
  for (const member of members) {
    const own = (member.required ?? []).find((key) =>
      members.every((other) => other === member || (other.properties?.[key] === undefined && !(other.required ?? []).includes(key))),
    )
    if (own === undefined) return null
    picks.push(own)
  }
  return picks
}

function simpleTestFor(schema: JsonSchema): SerTest | null {
  if (isNullSchema(schema)) return { kind: 'null' }
  const type = schema.type
  if (typeof type !== 'string') return null
  return testForType(type)
}

function testForType(type: JsonType): SerTest | null {
  switch (type) {
    case 'string': return { kind: 'typeof', type: 'string' }
    case 'number':
    case 'integer': return { kind: 'typeof', type: 'number' }
    case 'boolean': return { kind: 'typeof', type: 'boolean' }
    case 'array': return { kind: 'array' }
    case 'object': return { kind: 'object' }
    case 'null': return { kind: 'null' }
  }
}

function isNullSchema(schema: JsonSchema): boolean {
  return schema.type === 'null' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null')
}

function isObjectLike(schema: JsonSchema): boolean {
  return schema.type === 'object' || schema.properties !== undefined || schema.type === undefined
}

function hasOwnShape(schema: JsonSchema): boolean {
  return schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined
}

/**
 * A JSON literal, pre-encoded at boot.
 *
 * `undefined` cannot be represented, so it becomes `null` — the same choice
 * `JSON.stringify` makes at an array position, and the only one that keeps the
 * emitted document well-formed.
 */
export function encodeLiteral(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}
