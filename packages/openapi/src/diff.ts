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

function diffSchema(
  rawBefore: OpenApiSchema,
  rawAfter: OpenApiSchema,
  direction: Direction,
  where: string,
  ctx: Context,
  seen: Set<string>,
): void {
  const guard = `${rawBefore.$ref ?? ''}|${rawAfter.$ref ?? ''}|${where}`
  if (rawBefore.$ref !== undefined || rawAfter.$ref !== undefined) {
    if (seen.has(guard)) return
    seen.add(guard)
  }

  const before = ctx.before.resolve(rawBefore)
  const after = ctx.after.resolve(rawAfter)

  diffTypes(before, after, direction, where, ctx)
  diffEnum(before, after, direction, where, ctx)

  if (before.format !== after.format) {
    ctx.changes.push(breaking(
      'OAS_FORMAT_CHANGED',
      `Format changed from ${before.format ?? 'none'} to ${after.format ?? 'none'}.`,
      where,
    ))
  }

  diffProperties(before, after, direction, where, ctx, seen)

  const beforeItems = typeof before.items === 'object' ? before.items : undefined
  const afterItems = typeof after.items === 'object' ? after.items : undefined
  if (beforeItems !== undefined && afterItems !== undefined) {
    diffSchema(beforeItems, afterItems, direction, `${where}[]`, ctx, seen)
  }

  if (direction === 'request' && before.additionalProperties !== false && after.additionalProperties === false) {
    ctx.changes.push(breaking(
      'OAS_ADDITIONAL_PROPERTIES_CLOSED',
      'Extra properties are no longer accepted.',
      where,
    ))
  }
}

function diffProperties(
  before: OpenApiSchema,
  after: OpenApiSchema,
  direction: Direction,
  where: string,
  ctx: Context,
  seen: Set<string>,
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

    diffSchema(from, to, direction, at, ctx, seen)
  }
}

function diffTypes(
  before: OpenApiSchema,
  after: OpenApiSchema,
  direction: Direction,
  where: string,
  ctx: Context,
): void {
  const from = typeSet(before)
  const to = typeSet(after)
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
