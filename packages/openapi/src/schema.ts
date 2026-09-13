import type { JsonSchema, JsonSchemaNode, JsonType } from '@zenjs/core'
import { resolveRef } from '@zenjs/core'
import type { OpenApiSchema } from './types.ts'

/**
 * JSON Schema → OpenAPI 3.1 Schema Object — rfcs/0001 §29.2, §29.3.
 *
 * Two things happen here, and only one of them is mechanical.
 *
 * The mechanical part is hoisting `$defs` into `components.schemas`, rewriting
 * local `$ref`s, and up-converting the OpenAPI 3.0 spellings (`nullable`) that
 * real converters still emit.
 *
 * The load-bearing part is **closure**. Zen's serializer inverts JSON Schema's
 * default: an object with no `additionalProperties` drops undeclared keys rather
 * than passing them through (§13.3.1). A document generated from the raw schema
 * would therefore describe an endpoint that permits fields the wire will never
 * carry — documentation that is wrong in the one direction that matters, since a
 * client author would write code to read a field that can never arrive. So
 * response schemas are projected *closed*, mirroring `serializer-ir.ts` node for
 * node, and `test/openapi.test.ts` proves the two agree by running values
 * through the real compiled serializer.
 *
 * Request schemas are **not** closed. There the validator is the authority, the
 * validator is the user's Standard Schema library, and its converter's output is
 * the honest description of what it accepts.
 */

export interface DocDiagnostic {
  readonly severity: 'error' | 'warning' | 'info'
  readonly code: string
  readonly message: string
  /** Where the problem is, in human terms: `GET /users/:id → response 200`. */
  readonly where: string
  readonly hint?: string | undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Component registry — §29.3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deduplication runs in three passes, cheapest and most authoritative first:
 * schema *identity* (the same imported object used by four routes is one
 * component), then a *declared* name (`$id` / `title`), then *structural*
 * equality. The third pass is a backstop, not the strategy — two schemas that
 * happen to have the same shape today are not necessarily the same concept, so
 * structural merging only ever fires for schemas that had no name to begin with.
 */
export class Components {
  readonly #byName = new Map<string, OpenApiSchema>()
  readonly #byKey = new Map<string, string>()
  /** `name + shape` → the name that owns it. What makes two arrivals one component. */
  readonly #byIdentity = new Map<string, string>()
  /** A name that turned out to duplicate another, and the name it defers to. */
  readonly #aliases = new Map<string, string>()
  readonly #reserved = new Set<string>()

  /**
   * Claim a name for a shape that is already projected.
   *
   * `key` is the identity the caller wants deduplicated on, and it is a
   * parameter rather than always the shape for a reason: two *named* schemas
   * that happen to look alike today are not the same concept, so the caller
   * folds the name into the key and they stay separate. Anonymous schemas pass
   * the shape and do collapse. Different keys wanting the same name get `Name2`.
   */
  claim(preferred: string, schema: OpenApiSchema, key: string, variant?: string): string {
    const existing = this.#byKey.get(key)
    if (existing !== undefined) return existing

    const identity = identityOf(preferred, schema)
    const owner = this.#byIdentity.get(identity)
    if (owner !== undefined) {
      this.#byKey.set(key, owner)
      return owner
    }

    const name = this.#free(preferred, variant)
    this.#reserved.add(name)
    this.#byName.set(name, schema)
    this.#byKey.set(key, name)
    this.#byIdentity.set(identity, name)
    return name
  }

  /**
   * Reserve a name for a shape that cannot be projected yet — a `$def` whose body
   * may refer back to itself, or refer to a sibling def not yet visited. Keyed on
   * the *raw* schema so recursion terminates.
   *
   * The reservation is provisional: the same concept can arrive twice, once as a
   * converter's `$defs` entry and once as an inline titled object, and which one
   * is seen first depends on route order. `fill` reconciles that.
   */
  reserve(preferred: string, rawKey: string, variant?: string): { readonly name: string; readonly fresh: boolean } {
    const existing = this.#byKey.get(rawKey)
    if (existing !== undefined) return { name: existing, fresh: false }
    const name = this.#free(preferred, variant)
    this.#reserved.add(name)
    this.#byKey.set(rawKey, name)
    return { name, fresh: true }
  }

  /**
   * Attach a body to a reserved name — and collapse it onto an existing
   * component if it turns out to be the same concept under the same name.
   *
   * This is the fix for a bug the first real application found: Zod hoists a
   * schema carrying an `id` into `$defs` when it is nested, and emits it inline
   * when it is not, so `PublicUser` arrived by both routes and the document
   * published `PublicUser` *and* `PublicUser2`. Two names for one type in a
   * generated client is exactly the drift this subsystem exists to prevent.
   */
  fill(name: string, schema: OpenApiSchema): void {
    const identity = identityOf(name, schema)
    const owner = this.#byIdentity.get(identity)
    if (owner !== undefined && owner !== name) {
      this.#aliases.set(name, owner)
      this.#reserved.delete(name)
      return
    }
    this.#byIdentity.set(identity, name)
    this.#byName.set(name, schema)
  }

  /** `duplicate → canonical`, for the final `$ref` rewrite. Empty in the common case. */
  aliases(): ReadonlyMap<string, string> {
    return this.#aliases
  }

  has(name: string): boolean {
    return this.#byName.has(name)
  }

  get size(): number {
    return this.#byName.size
  }

  /** Sorted, because a document that reorders itself between runs cannot be diffed. */
  toRecord(): Record<string, OpenApiSchema> {
    const out: Record<string, OpenApiSchema> = {}
    for (const name of [...this.#byName.keys()].sort()) {
      if (this.#aliases.has(name)) continue
      out[name] = this.#byName.get(name) as OpenApiSchema
    }
    return out
  }

  /**
   * `variant` is tried before the numeric fallback, and it exists for one very
   * common case: the same named schema appears on both sides of the API, and the
   * two are not identical — a converter describes a request body as it is
   * *received* (extra keys tolerated) and a response as it is *emitted* (extra
   * keys impossible, §13.3.1).
   *
   * They are genuinely two schemas, so they must be two components. But
   * `OrderLine` and `OrderLineInput` tell a client author which is which, and
   * `OrderLine` and `OrderLine2` do not.
   */
  #free(preferred: string, variant?: string): string {
    const base = sanitizeName(preferred)
    if (!this.#reserved.has(base)) return base
    if (variant !== undefined) {
      const varied = `${base}${variant}`
      if (!this.#reserved.has(varied)) return varied
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}${n}`
      if (!this.#reserved.has(candidate)) return candidate
    }
  }
}

/**
 * A component's identity: its name plus its *shape*, with the top-level
 * annotations removed.
 *
 * `title` and `description` are stripped because converters do not emit them
 * consistently between an inline occurrence and a `$defs` entry for the very
 * same schema — and two schemas with the same name and the same structure are
 * one type whichever prose happens to be attached. Nested annotations are left
 * alone; they are part of the shape as far as a client generator is concerned.
 */
function identityOf(name: string, schema: OpenApiSchema): string {
  const { title: _title, description: _description, ...rest } = schema as Record<string, unknown>
  return `${sanitizeName(name)}::${canonical(rest)}`
}

const NAME_ILLEGAL = /[^A-Za-z0-9_.-]/g

export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(NAME_ILLEGAL, '_').replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'Schema'
}

/**
 * Key-sorted JSON. Used for structural identity, so it must be stable across
 * runs and across property insertion order — `{a,b}` and `{b,a}` are one shape.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectOptions {
  readonly components: Components
  /** True for responses: apply Zen's drop-by-default (§13.3.1). */
  readonly closed: boolean
  readonly diagnostics: DocDiagnostic[]
  readonly where: string
}

/** Keywords handled structurally; everything else is copied through verbatim. */
const STRUCTURAL = new Set([
  '$ref', '$defs', 'definitions', '$schema', '$id',
  'type', 'nullable', 'properties', 'required', 'additionalProperties',
  'items', 'prefixItems', 'anyOf', 'oneOf', 'allOf',
])

export function projectSchema(raw: JsonSchema, options: ProjectOptions): OpenApiSchema {
  return new Projector(raw, options).walk(raw, new Set(), 0)
}

class Projector {
  readonly #root: JsonSchema
  readonly #opts: ProjectOptions
  /** `#/$defs/User` → component name. Populated before the body is walked. */
  readonly #refs = new Map<string, string>()
  /** Name suffix for the open (request) side, so both sides can coexist. */
  readonly #variant: string | undefined

  constructor(root: JsonSchema, options: ProjectOptions) {
    this.#root = root
    this.#opts = options
    this.#variant = options.closed ? undefined : 'Input'
    this.#hoistDefs(root.$defs, '#/$defs/')
    this.#hoistDefs(root.definitions, '#/definitions/')
  }

  #hoistDefs(defs: Readonly<Record<string, JsonSchemaNode>> | undefined, prefix: string): void {
    if (defs === undefined) return
    // Names are reserved for every def first, then bodies are projected. A
    // recursive `$def` refers to itself through a name that must already exist.
    const pending: Array<{ name: string; schema: JsonSchemaNode }> = []
    for (const key of Object.keys(defs)) {
      const schema = defs[key]
      if (schema === undefined) continue
      // The closure flag is part of the identity: the same raw schema projected
      // open (a request) and closed (a response) is two different documents.
      const rawKey = `def:${this.#opts.closed ? 'closed' : 'open'}:${canonical(schema)}`
      const claimed = this.#opts.components.reserve(key, rawKey, this.#variant)
      this.#refs.set(`${prefix}${key}`, claimed.name)
      if (claimed.fresh) pending.push({ name: claimed.name, schema })
    }
    for (const job of pending) {
      this.#opts.components.fill(job.name, this.walk(job.schema, new Set(), 0))
    }
  }

  /**
   * `depth` exists for one rule: **a titled subschema becomes a component
   * wherever it appears.**
   *
   * A response of `{ users: PublicUser[] }` should say `$ref: PublicUser`, not
   * inline a second copy of the same object — otherwise a generated client
   * grows `UserListUsersItem` alongside `PublicUser` and the two drift the first
   * time someone edits one. A `title` is the author naming a type, so it is
   * honoured at every level. Anonymous subschemas stay inline, because hoisting
   * those would fill `components` with `Schema1..Schema40`.
   *
   * Depth 0 is exempt: the caller decides whether the *root* is hoisted, since
   * only it knows how many operations share it (§29.3).
   */
  walk(node: JsonSchema | boolean | undefined, seen: ReadonlySet<string>, depth: number): OpenApiSchema {
    if (node === undefined || node === true) return {}
    if (node === false) return { not: {} }
    if (typeof node !== 'object') return {}

    if (typeof node.$ref === 'string') return this.#ref(node.$ref, seen, depth)

    const title = depth > 0 ? declaredName(node) : null
    if (title !== null) {
      const body = this.#body(node, seen, depth)
      const name = this.#opts.components.claim(title, body, `named:${title}:${canonical(body)}`, this.#variant)
      if (name !== title && name !== `${title}${this.#variant ?? ''}`) {
        this.#opts.diagnostics.push({
          severity: 'warning',
          code: 'ZEN_OAS_TITLE_COLLISION',
          message: `Two different schemas are both named "${title}"; this one was published as "${name}".`,
          where: this.#opts.where,
          hint: 'Give them distinct titles — a generated client names its types from these.',
        })
      }
      return { $ref: `#/components/schemas/${name}` }
    }

    return this.#body(node, seen, depth)
  }

  #body(node: JsonSchema, seen: ReadonlySet<string>, depth: number): OpenApiSchema {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(node)) {
      if (STRUCTURAL.has(key)) continue
      const value = node[key]
      if (value !== undefined) out[key] = value
    }

    // `const` and `enum` short-circuit shape in the IR, so they do here too:
    // closing an object that can only ever be one literal adds nothing.
    if (node.const !== undefined || Array.isArray(node.enum)) {
      this.#applyType(node, out)
      return out as OpenApiSchema
    }

    const allOf = node.allOf
    if (Array.isArray(allOf) && allOf.length > 0) return this.#allOf(node, allOf, out, seen, depth)

    const union = node.oneOf ?? node.anyOf
    if (Array.isArray(union) && union.length > 0) {
      const keyword = node.oneOf !== undefined ? 'oneOf' : 'anyOf'
      out[keyword] = union.map((member) => this.walk(member, seen, depth + 1))
      this.#applyType(node, out)
      return out as OpenApiSchema
    }

    this.#applyType(node, out)

    if (isObjectShape(node)) this.#object(node, out, seen, depth)
    else if (node.items !== undefined || node.prefixItems !== undefined) this.#array(node, out, seen, depth)

    return out as OpenApiSchema
  }

  /** OAS 3.1 has no `nullable`; `type: [T, 'null']` is the same statement. */
  #applyType(node: JsonSchema, out: Record<string, unknown>): void {
    const declared = node.type
    if (declared === undefined) {
      if (node.nullable === true) out['type'] = 'null'
      return
    }
    const types: readonly JsonType[] = Array.isArray(declared) ? declared : [declared]
    const withNull = node.nullable === true && !types.includes('null') ? [...types, 'null' as JsonType] : types
    out['type'] = withNull.length === 1 ? withNull[0] : withNull
  }

  #object(node: JsonSchema, out: Record<string, unknown>, seen: ReadonlySet<string>, depth: number): void {
    const properties = node.properties
    if (properties !== undefined) {
      const projected: Record<string, OpenApiSchema> = {}
      for (const key of Object.keys(properties)) projected[key] = this.walk(properties[key], seen, depth + 1)
      out['properties'] = projected
    }
    if (node.required !== undefined && node.required.length > 0) out['required'] = [...node.required]

    const additional = node.additionalProperties
    if (additional === undefined) {
      // §13.3.1 — the one deliberate deviation, written down in the document
      // rather than left as folklore. Absent means *drop*, so the document says
      // `false` and a generated client will not offer a field that cannot arrive.
      if (this.#opts.closed) out['additionalProperties'] = false
    } else if (typeof additional === 'boolean') {
      out['additionalProperties'] = additional
    } else {
      out['additionalProperties'] = this.walk(additional, seen, depth + 1)
    }
  }

  #array(node: JsonSchema, out: Record<string, unknown>, seen: ReadonlySet<string>, depth: number): void {
    if (Array.isArray(node.prefixItems)) {
      out['prefixItems'] = node.prefixItems.map((item) => this.walk(item, seen, depth + 1))
      // Draft 2020-12: with `prefixItems`, `items` constrains the tail. `false`
      // is how a fixed-length tuple is spelled, and the IR reads it the same way.
      out['items'] = node.items === undefined || node.items === false ? false : this.walk(node.items, seen, depth + 1)
      return
    }
    if (node.items !== undefined) out['items'] = this.walk(node.items, seen, depth + 1)
  }

  /**
   * `allOf` is an intersection, and the serializer resolves it by *merging* the
   * members into one object (§13.3, `Builder#allOf`). The document must say the
   * same thing — and there is a second reason beyond fidelity: an `allOf` of two
   * closed objects is unsatisfiable, because every property of one member is
   * "additional" to the other. Emitting the merge avoids publishing a schema
   * that nothing can validate against.
   */
  #allOf(
    node: JsonSchema,
    members: readonly JsonSchema[],
    out: Record<string, unknown>,
    seen: ReadonlySet<string>,
    depth: number,
  ): OpenApiSchema {
    if (!this.#opts.closed) {
      out['allOf'] = members.map((member) => this.walk(member, seen, depth + 1))
      this.#applyType(node, out)
      return out as OpenApiSchema
    }

    const resolved: JsonSchema[] = []
    for (const member of members) {
      const target = typeof member.$ref === 'string' ? resolveRef(this.#root, member.$ref) : member
      if (target === null || !isObjectShape(target)) {
        this.#opts.diagnostics.push({
          severity: 'info',
          code: 'ZEN_OAS_ALLOF_UNMERGED',
          message: 'allOf member is not an object schema, so the document keeps allOf rather than merging it.',
          where: this.#opts.where,
          hint: 'The serializer reports the same case as a boot diagnostic; see rfcs/0001 §13.3.',
        })
        out['allOf'] = members.map((m) => this.walk(m, seen, depth + 1))
        this.#applyType(node, out)
        return out as OpenApiSchema
      }
      resolved.push(target)
    }

    const properties: Record<string, JsonSchemaNode> = {}
    const required = new Set<string>()
    let additional: JsonSchemaNode | undefined
    for (const member of [...resolved, node]) {
      for (const [key, value] of Object.entries(member.properties ?? {})) properties[key] = value
      for (const key of member.required ?? []) required.add(key)
      if (member.additionalProperties !== undefined) additional = member.additionalProperties
    }

    const merged: JsonSchema = {
      type: 'object',
      properties,
      ...(required.size > 0 ? { required: [...required] } : {}),
      ...(additional !== undefined ? { additionalProperties: additional } : {}),
    }
    const projected = this.#body(merged, seen, depth) as Record<string, unknown>
    return { ...out, ...projected } as OpenApiSchema
  }

  #ref(ref: string, seen: ReadonlySet<string>, depth: number): OpenApiSchema {
    const hoisted = this.#refs.get(ref)
    if (hoisted !== undefined) return { $ref: `#/components/schemas/${hoisted}` }

    // Not a `$defs` entry: resolve and inline. A pointer into `properties` is
    // legal JSON Schema and rare, but inlining beats emitting a `$ref` that
    // points nowhere in the published document.
    if (seen.has(ref)) {
      this.#opts.diagnostics.push({
        severity: 'warning',
        code: 'ZEN_OAS_REF_CYCLE',
        message: `Circular $ref "${ref}" outside $defs; the document inlines it as an unconstrained schema.`,
        where: this.#opts.where,
        hint: 'Move the recursive schema into $defs so it can be hoisted into components.schemas.',
      })
      return {}
    }
    const target = resolveRef(this.#root, ref)
    if (target === null) {
      this.#opts.diagnostics.push({
        severity: 'warning',
        code: 'ZEN_OAS_REF_UNRESOLVED',
        message: `Unresolvable $ref "${ref}"; the document describes this position as unconstrained.`,
        where: this.#opts.where,
        hint: 'Only same-document refs are supported (#/$defs/Name, #/definitions/Name).',
      })
      return {}
    }
    return this.walk(target, new Set([...seen, ref]), depth)
  }
}

/** Mirrors `Builder#byType`/`#inferShape`: when does the IR build an object node? */
export function isObjectShape(node: JsonSchema): boolean {
  const declared = node.type
  const types: readonly JsonType[] =
    declared === undefined ? [] : Array.isArray(declared) ? declared : [declared]
  if (types.includes('object')) return true
  if (types.filter((t) => t !== 'null').length > 0) return false
  return node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined
}

/** A component name to suggest for a schema that carries one. */
export function declaredName(schema: JsonSchema): string | null {
  const id = schema['$id']
  if (typeof id === 'string' && id.length > 0) {
    const tail = id.split('/').pop()
    if (tail !== undefined && tail.length > 0) return tail.replace(/\.json$/, '')
  }
  const title = schema.title
  return typeof title === 'string' && title.length > 0 ? title : null
}
