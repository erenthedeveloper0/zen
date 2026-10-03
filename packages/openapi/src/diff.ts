import type { JsonSchemaNode, JsonType } from '@erenthedeveloper0/zen-core'
import type {
  HttpOperation, OpenApiDocument, OpenApiSchema, OperationObject, ParameterObject, ResponseObject,
} from './types.ts'

/**
 * API change detection — rfcs/0001 §29.5.
 *
 * A governance feature disguised as tooling. The point is not the diff; it is
 * that an API change stops being "a diff in a routes file" and becomes a
 * reviewable statement about compatibility, on the pull request, before it
 * ships.
 *
 * Two asymmetries drive every rule here, and they are the whole model:
 *
 *   - **Requests are contravariant.** Accepting *less* breaks callers. Removing
 *     a field, adding a required one, or narrowing a type are all breaking.
 *   - **Responses are covariant.** Returning *less* breaks callers. Removing a
 *     field, dropping a status, or widening a type (a value the client's
 *     exhaustive switch has never seen) are all breaking.
 *
 * The classification is deliberately conservative: when a change could break a
 * reasonable consumer, it is reported as breaking. A tool that under-reports is
 * worse than no tool, because it is trusted.
 */

export type ChangeKind = 'breaking' | 'compatible' | 'documentation'

export interface ApiChange {
  readonly kind: ChangeKind
  readonly code: string
  readonly message: string
  /** `GET /users/{id} → response 200 → users[].email` */
  readonly location: string
}

export interface DiffResult {
  readonly changes: readonly ApiChange[]
  readonly breaking: readonly ApiChange[]
  readonly compatible: readonly ApiChange[]
  readonly documentation: readonly ApiChange[]
}

const METHODS: readonly HttpOperation[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

export function diffDocuments(before: OpenApiDocument, after: OpenApiDocument): DiffResult {
  const changes: ApiChange[] = []
  const context = { before: new Resolver(before), after: new Resolver(after), changes }

  const paths = new Set([...Object.keys(before.paths), ...Object.keys(after.paths)])
  for (const path of [...paths].sort()) {
    const beforeItem = before.paths[path]
    const afterItem = after.paths[path]

    if (beforeItem !== undefined && afterItem === undefined) {
      changes.push(breaking('OAS_PATH_REMOVED', `Path ${path} was removed.`, path))
      continue
    }
    if (beforeItem === undefined && afterItem !== undefined) {
      changes.push(compatible('OAS_PATH_ADDED', `Path ${path} was added.`, path))
      continue
    }
    if (beforeItem === undefined || afterItem === undefined) continue

    for (const method of METHODS) {
      const from = beforeItem[method]
      const to = afterItem[method]
      const location = `${method.toUpperCase()} ${path}`
      if (from !== undefined && to === undefined) {
        changes.push(breaking('OAS_OPERATION_REMOVED', `${location} was removed.`, location))
      } else if (from === undefined && to !== undefined) {
        changes.push(compatible('OAS_OPERATION_ADDED', `${location} was added.`, location))
      } else if (from !== undefined && to !== undefined) {
        diffOperation(from, to, location, context)
      }
    }
  }

  return {
    changes,
    breaking: changes.filter((c) => c.kind === 'breaking'),
    compatible: changes.filter((c) => c.kind === 'compatible'),
    documentation: changes.filter((c) => c.kind === 'documentation'),
  }
}

interface Context {
  readonly before: Resolver
  readonly after: Resolver
  readonly changes: ApiChange[]
}

function diffOperation(from: OperationObject, to: OperationObject, where: string, ctx: Context): void {
  if (from.operationId !== to.operationId) {
    // Generated clients name their methods from this. Renaming it is a source
    // break in every SDK even when the wire format is untouched.
    ctx.changes.push(breaking(
      'OAS_OPERATION_ID_CHANGED',
      `operationId changed from "${from.operationId}" to "${to.operationId}".`,
      where,
    ))
  }
  if (from.summary !== to.summary || from.description !== to.description) {
    ctx.changes.push(documentation('OAS_DESCRIPTION_CHANGED', 'Summary or description changed.', where))
  }
  if (from.deprecated !== true && to.deprecated === true) {
    ctx.changes.push(documentation('OAS_OPERATION_DEPRECATED', 'Operation was marked deprecated.', where))
  }
  if ((from.security?.length ?? 0) === 0 && (to.security?.length ?? 0) > 0) {
    ctx.changes.push(breaking('OAS_SECURITY_ADDED', 'Operation now requires authentication.', where))
  }

  diffParameters(from.parameters ?? [], to.parameters ?? [], where, ctx)
  diffRequestBody(from, to, where, ctx)
  diffResponses(from.responses, to.responses, where, ctx)
}

function diffParameters(
  from: readonly ParameterObject[],
  to: readonly ParameterObject[],
  where: string,
  ctx: Context,
): void {
  const key = (p: ParameterObject): string => `${p.in}:${p.name}`
  const beforeMap = new Map(from.map((p) => [key(p), p]))
  const afterMap = new Map(to.map((p) => [key(p), p]))

  for (const [id, parameter] of beforeMap) {
    const next = afterMap.get(id)
    const at = `${where} → ${id}`
    if (next === undefined) {
      ctx.changes.push(breaking('OAS_PARAM_REMOVED', `Parameter ${id} was removed.`, at))
      continue
    }
    if (parameter.required !== true && next.required === true) {
      ctx.changes.push(breaking('OAS_PARAM_NOW_REQUIRED', `Parameter ${id} became required.`, at))
    } else if (parameter.required === true && next.required !== true) {
      ctx.changes.push(compatible('OAS_PARAM_NOW_OPTIONAL', `Parameter ${id} became optional.`, at))
    }
    diffSchema(parameter.schema, next.schema, 'request', at, ctx, new Set())
  }
  for (const [id, parameter] of afterMap) {
    if (beforeMap.has(id)) continue
    const at = `${where} → ${id}`
    ctx.changes.push(parameter.required === true
      ? breaking('OAS_PARAM_ADDED_REQUIRED', `Required parameter ${id} was added.`, at)
      : compatible('OAS_PARAM_ADDED', `Optional parameter ${id} was added.`, at))
  }
}

function diffRequestBody(from: OperationObject, to: OperationObject, where: string, ctx: Context): void {
  const beforeBody = from.requestBody
  const afterBody = to.requestBody
  if (beforeBody === undefined && afterBody === undefined) return
  if (beforeBody === undefined && afterBody !== undefined) {
    ctx.changes.push(afterBody.required === false
      ? compatible('OAS_BODY_ADDED', 'An optional request body was added.', where)
      : breaking('OAS_BODY_ADDED_REQUIRED', 'A required request body was added.', where))
    return
  }
  if (beforeBody !== undefined && afterBody === undefined) {
    ctx.changes.push(compatible('OAS_BODY_REMOVED', 'The request body is no longer read.', where))
    return
  }
  if (beforeBody === undefined || afterBody === undefined) return

  const media = new Set([...Object.keys(beforeBody.content), ...Object.keys(afterBody.content)])
  for (const type of [...media].sort()) {
    const beforeMedia = beforeBody.content[type]
    const afterMedia = afterBody.content[type]
    const at = `${where} → body (${type})`
    if (beforeMedia === undefined) {
      ctx.changes.push(compatible('OAS_BODY_MEDIA_ADDED', `Media type ${type} is now accepted.`, at))
      continue
    }
    if (afterMedia === undefined) {
      ctx.changes.push(breaking('OAS_BODY_MEDIA_REMOVED', `Media type ${type} is no longer accepted.`, at))
      continue
    }
    diffSchema(beforeMedia.schema, afterMedia.schema, 'request', at, ctx, new Set())
  }
}

function diffResponses(
  from: Readonly<Record<string, ResponseObject>>,
  to: Readonly<Record<string, ResponseObject>>,
  where: string,
  ctx: Context,
): void {
  const statuses = new Set([...Object.keys(from), ...Object.keys(to)])
  for (const status of [...statuses].sort()) {
    const beforeResponse = from[status]
    const afterResponse = to[status]
    const at = `${where} → response ${status}`

    if (beforeResponse !== undefined && afterResponse === undefined) {
      ctx.changes.push(breaking('OAS_STATUS_REMOVED', `Status ${status} is no longer returned.`, at))
      continue
    }
    if (beforeResponse === undefined && afterResponse !== undefined) {
      ctx.changes.push(compatible('OAS_STATUS_ADDED', `Status ${status} was added.`, at))
      continue
    }
    if (beforeResponse === undefined || afterResponse === undefined) continue

    const beforeContent = beforeResponse.content ?? {}
    const afterContent = afterResponse.content ?? {}
    const media = new Set([...Object.keys(beforeContent), ...Object.keys(afterContent)])
    for (const type of [...media].sort()) {
      const beforeMedia = beforeContent[type]
      const afterMedia = afterContent[type]
      const mediaAt = `${at} (${type})`
      if (beforeMedia === undefined) {
        ctx.changes.push(compatible('OAS_RESPONSE_MEDIA_ADDED', `Media type ${type} was added.`, mediaAt))
        continue
      }
      if (afterMedia === undefined) {
        ctx.changes.push(breaking('OAS_RESPONSE_MEDIA_REMOVED', `Media type ${type} is no longer returned.`, mediaAt))
        continue
      }
      diffSchema(beforeMedia.schema, afterMedia.schema, 'response', mediaAt, ctx, new Set())
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

type Direction = 'request' | 'response'

/**
 * Compare two schemas, as what they say rather than as how they are spelled.
 *
 * `active` holds the components being compared further up *this* descent, and
 * nothing else. A component that contains itself — a tree, a comment thread —
 * is compared once per path into it, and the recursion stops where it would
 * start repeating. The guard used to be a set of `ref|ref|location` keys, and a
 * location grows by a segment at every level, so it never repeated: any
 * recursive schema overflowed the stack, which is how `openapi:check` died on an
 * API whose response was a tree. Keyed on the pair alone, across the whole
 * operation, it would also have stopped at a component's *second use*, and a
 * change is reported once per use (§29.7) — `billing` and `shipping` are two
 * places a client reads an `Address`.
 */
function diffSchema(
  rawBefore: OpenApiSchema | undefined,
  rawAfter: OpenApiSchema | undefined,
  direction: Direction,
  where: string,
  ctx: Context,
  active: Set<string>,
): void {
  const before = viewOf(ctx.before, rawBefore)
  const after = viewOf(ctx.after, rawAfter)

  const key = before.ref === undefined && after.ref === undefined ? null : `${before.ref ?? ''}|${after.ref ?? ''}`
  if (key !== null) {
    if (active.has(key)) return
    active.add(key)
  }

  try {
    diffTypes(before.types, after.types, direction, where, ctx)
    // Several branches left after a union is read: their types were compared
    // above, and nothing else can be — which branch of one document is which of
    // the other is not knowable in general (§28.8).
    if (before.union || after.union) return

    diffEnum(before.node, after.node, direction, where, ctx)

    if (before.node.format !== after.node.format) {
      ctx.changes.push(breaking(
        'OAS_FORMAT_CHANGED',
        `Format changed from ${before.node.format ?? 'none'} to ${after.node.format ?? 'none'}.`,
        where,
      ))
    }

    diffProperties(before.node, after.node, direction, where, ctx, active)

    const beforeItems = typeof before.node.items === 'object' ? before.node.items : undefined
    const afterItems = typeof after.node.items === 'object' ? after.node.items : undefined
    if (beforeItems !== undefined && afterItems !== undefined) {
      diffSchema(beforeItems, afterItems, direction, `${where}[]`, ctx, active)
    }

    if (
      direction === 'request' &&
      before.node.additionalProperties !== false &&
      after.node.additionalProperties === false
    ) {
      ctx.changes.push(breaking(
        'OAS_ADDITIONAL_PROPERTIES_CLOSED',
        'Extra properties are no longer accepted.',
        where,
      ))
    }
  } finally {
    if (key !== null) active.delete(key)
  }
}

/**
 * What a schema says — the only thing a comparison should read.
 *
 * A converter is free to spell one schema several ways, and two of them used
 * to diff as a change. zod 4.4 wrote a nullable string as
 * `anyOf: [{ type: 'string' }, { type: 'null' }]` and zod 4.6 writes
 * `type: ['string', 'null']`; the type set was read off `type` alone, so the
 * first looked like a schema with no type and the second like one that had
 * gained two, and a dependency bump that changed no byte on the wire failed the
 * gate with two breaking changes. The other half was quieter and worse: nothing
 * looked inside `anyOf` at all, so a field removed from
 * `z.object({…}).nullable()` — the most common union there is — passed.
 *
 * So a union is read before it is compared:
 *
 *   - `$ref`s are followed, in the schema and in each branch, and nested unions
 *     are flattened;
 *   - `null` branches are set aside, and if **one** branch is left, the view is
 *     that branch, nullable — its fields, items, enum and format compared exactly
 *     as a plain schema's are, with `null` in its type set and, if it has one, in
 *     its enum, which is what `enum: […, null]` would have said;
 *   - if **several** are left, the view is the union of the types they admit,
 *     and only that is compared (`union: true`).
 *
 * And `const: v` is `enum: [v]`, which is what it means.
 *
 * A union is only read this way when it is the whole schema. `type` or
 * `properties` beside an `anyOf` is an intersection, and reading that as a
 * union would be a guess; it is compared as it was, keyword by keyword.
 */
interface SchemaView {
  /** The schema whose keywords are compared: a branch, for a nullable union. */
  readonly node: OpenApiSchema
  /** The types it admits; empty when it states none. */
  readonly types: ReadonlySet<JsonType>
  /** Several non-null branches: their types are compared, nothing else is. */
  readonly union: boolean
  /** The component this view was reached through — for the cycle guard. */
  readonly ref: string | undefined
}

function viewOf(resolver: Resolver, raw: OpenApiSchema | undefined): SchemaView {
  if (raw === undefined) return { node: {}, types: new Set(), union: false, ref: undefined }
  const node = resolver.resolve(raw)
  const branches = branchesOf(resolver, node, 0)
  if (branches === null) return plainView(node, raw.$ref)

  const others = branches.filter((b) => !isNullSchema(b.node))
  const nullable = others.length < branches.length

  if (others.length === 1) {
    const only = others[0] as Branch
    const inner = plainView(only.node, raw.$ref ?? only.ref)
    if (!nullable) return inner
    const enumWithNull = inner.node.enum === undefined || inner.node.enum.includes(null)
      ? inner.node
      : { ...inner.node, enum: [...inner.node.enum, null] }
    return {
      node: enumWithNull,
      types: inner.types.size === 0 ? inner.types : new Set([...inner.types, 'null' as const]),
      union: false,
      ref: inner.ref,
    }
  }

  // Every branch has to state its types for the union of them to mean anything:
  // one unconstrained branch admits every type, and an empty set is how "not
  // stated" is spelled everywhere else in this file.
  const types = new Set<JsonType>()
  let stated = branches.length > 0
  for (const branch of branches) {
    const own = typeSet(branch.node)
    if (own.size === 0) stated = false
    for (const type of own) types.add(type)
  }
  return { node: {}, types: stated ? types : new Set(), union: others.length > 1, ref: raw.$ref }
}

function plainView(node: OpenApiSchema, ref: string | undefined): SchemaView {
  const spelled = node.const !== undefined && node.enum === undefined ? { ...node, enum: [node.const] } : node
  return { node: spelled, types: typeSet(node), union: false, ref }
}

interface Branch {
  readonly node: OpenApiSchema
  readonly ref: string | undefined
}

/**
 * A union's branches, resolved and flattened — or `null` when `node` is not a
 * union standing alone. Depth-bounded, because two components can be unions of
 * each other, and a schema that never bottoms out is compared as written.
 */
function branchesOf(resolver: Resolver, node: OpenApiSchema, depth: number): Branch[] | null {
  const listed = node.anyOf ?? node.oneOf
  if (!Array.isArray(listed) || listed.length === 0 || depth > 8) return null
  if (
    node.type !== undefined || node.properties !== undefined || node.items !== undefined ||
    node.enum !== undefined || node.const !== undefined
  ) {
    return null
  }

  const out: Branch[] = []
  for (const entry of listed) {
    const schema = asSchema(entry) as OpenApiSchema
    const resolved = resolver.resolve(schema)
    const nested = branchesOf(resolver, resolved, depth + 1)
    if (nested === null) out.push({ node: resolved, ref: schema.$ref })
    else out.push(...nested)
  }
  return out
}

/** `{ type: 'null' }`, and its other spellings — `const: null`, `enum: [null]`. */
function isNullSchema(node: OpenApiSchema): boolean {
  const type = node.type
  if (type === 'null') return true
  if (Array.isArray(type) && type.length === 1 && type[0] === 'null') return true
  if (type === undefined && node.const === null) return true
  return type === undefined && node.enum !== undefined && node.enum.length === 1 && node.enum[0] === null
}

function diffProperties(
  before: OpenApiSchema,
  after: OpenApiSchema,
  direction: Direction,
  where: string,
  ctx: Context,
  active: Set<string>,
): void {
  const beforeProps = before.properties
  const afterProps = after.properties
  if (beforeProps === undefined && afterProps === undefined) return

  const beforeRequired = new Set(before.required ?? [])
  const afterRequired = new Set(after.required ?? [])
  const names = new Set([...Object.keys(beforeProps ?? {}), ...Object.keys(afterProps ?? {})])

  for (const name of [...names].sort()) {
    const from = asSchema(beforeProps?.[name])
    const to = asSchema(afterProps?.[name])
    const at = `${where}.${name}`

    if (from !== undefined && to === undefined) {
      ctx.changes.push(direction === 'response'
        ? breaking('OAS_RESPONSE_FIELD_REMOVED', `Response field "${name}" was removed.`, at)
        : breaking('OAS_REQUEST_FIELD_REMOVED', `Request field "${name}" is no longer accepted.`, at))
      continue
    }
    if (from === undefined && to !== undefined) {
      if (direction === 'response') {
        ctx.changes.push(compatible('OAS_RESPONSE_FIELD_ADDED', `Response field "${name}" was added.`, at))
      } else {
        ctx.changes.push(afterRequired.has(name)
          ? breaking('OAS_REQUEST_FIELD_ADDED_REQUIRED', `Required request field "${name}" was added.`, at)
          : compatible('OAS_REQUEST_FIELD_ADDED', `Optional request field "${name}" was added.`, at))
      }
      continue
    }
    if (from === undefined || to === undefined) continue

    const wasRequired = beforeRequired.has(name)
    const isRequired = afterRequired.has(name)
    if (!wasRequired && isRequired) {
      ctx.changes.push(direction === 'request'
        ? breaking('OAS_REQUEST_FIELD_NOW_REQUIRED', `Request field "${name}" became required.`, at)
        : compatible('OAS_RESPONSE_FIELD_NOW_GUARANTEED', `Response field "${name}" is now always present.`, at))
    } else if (wasRequired && !isRequired) {
      ctx.changes.push(direction === 'response'
        ? breaking('OAS_RESPONSE_FIELD_NOW_OPTIONAL', `Response field "${name}" may now be absent.`, at)
        : compatible('OAS_REQUEST_FIELD_NOW_OPTIONAL', `Request field "${name}" became optional.`, at))
    }

    diffSchema(from, to, direction, at, ctx, active)
  }
}

function diffTypes(
  from: ReadonlySet<JsonType>,
  to: ReadonlySet<JsonType>,
  direction: Direction,
  where: string,
  ctx: Context,
): void {
  if (from.size === 0 && to.size === 0) return

  const added = [...to].filter((t) => !from.has(t))
  const removed = [...from].filter((t) => !to.has(t))

  // Widening a response is breaking (a client that exhaustively handles the old
  // types meets one it has never seen); widening a request is a relaxation.
  for (const type of added) {
    ctx.changes.push(direction === 'response'
      ? breaking('OAS_TYPE_WIDENED', `Response may now be "${type}".`, where)
      : compatible('OAS_TYPE_WIDENED', `Request now also accepts "${type}".`, where))
  }
  for (const type of removed) {
    ctx.changes.push(direction === 'request'
      ? breaking('OAS_TYPE_NARROWED', `Request no longer accepts "${type}".`, where)
      : compatible('OAS_TYPE_NARROWED', `Response is no longer "${type}".`, where))
  }
}

function diffEnum(
  before: OpenApiSchema,
  after: OpenApiSchema,
  direction: Direction,
  where: string,
  ctx: Context,
): void {
  const from = before.enum
  const to = after.enum
  if (from === undefined && to === undefined) return
  if (from === undefined || to === undefined) {
    ctx.changes.push(from === undefined
      ? (direction === 'request'
        ? breaking('OAS_ENUM_INTRODUCED', 'The accepted values are now restricted to an enum.', where)
        : compatible('OAS_ENUM_INTRODUCED', 'The returned values are now restricted to an enum.', where))
      : (direction === 'response'
        ? breaking('OAS_ENUM_REMOVED', 'The value is no longer restricted to a known set.', where)
        : compatible('OAS_ENUM_REMOVED', 'Any value is now accepted.', where)))
    return
  }

  const beforeValues = new Set(from.map((v) => JSON.stringify(v)))
  const afterValues = new Set(to.map((v) => JSON.stringify(v)))
  for (const value of afterValues) {
    if (beforeValues.has(value)) continue
    ctx.changes.push(direction === 'response'
      ? breaking('OAS_ENUM_VALUE_ADDED', `Response may now be ${value}.`, where)
      : compatible('OAS_ENUM_VALUE_ADDED', `Request now also accepts ${value}.`, where))
  }
  for (const value of beforeValues) {
    if (afterValues.has(value)) continue
    ctx.changes.push(direction === 'request'
      ? breaking('OAS_ENUM_VALUE_REMOVED', `Request no longer accepts ${value}.`, where)
      : compatible('OAS_ENUM_VALUE_REMOVED', `Response is no longer ${value}.`, where))
  }
}

/** `true`/`false` are legal schemas; treat them as "no constraints stated". */
function asSchema(node: JsonSchemaNode | undefined): OpenApiSchema | undefined {
  if (node === undefined) return undefined
  return typeof node === 'boolean' ? (node ? {} : { not: {} }) : node
}

function typeSet(schema: OpenApiSchema): Set<JsonType> {
  const declared = schema.type
  if (declared === undefined) return new Set()
  return new Set(Array.isArray(declared) ? declared : [declared])
}

/** Follows `#/components/schemas/*` so the diff compares shapes, not pointers. */
class Resolver {
  readonly #schemas: Readonly<Record<string, OpenApiSchema>>

  constructor(document: OpenApiDocument) {
    this.#schemas = document.components?.schemas ?? {}
  }

  resolve(schema: OpenApiSchema): OpenApiSchema {
    let current = schema
    for (let hops = 0; hops < 16; hops++) {
      const ref = current.$ref
      if (typeof ref !== 'string') return current
      const name = ref.startsWith('#/components/schemas/') ? ref.slice('#/components/schemas/'.length) : null
      const target = name === null ? undefined : this.#schemas[name]
      if (target === undefined) return {}
      current = target
    }
    return {}
  }
}

function breaking(code: string, message: string, location: string): ApiChange {
  return { kind: 'breaking', code, message, location }
}

function compatible(code: string, message: string, location: string): ApiChange {
  return { kind: 'compatible', code, message, location }
}

function documentation(code: string, message: string, location: string): ApiChange {
  return { kind: 'documentation', code, message, location }
}
