import type { AppGraph } from '../contracts/graph.ts'
import type {
  GraphCheck, GraphCollection, GraphDecoration, GraphDocument, GraphHook, GraphMiddleware, GraphParamType,
  GraphPlugin, GraphRoute, GraphSchema, GraphService, GraphSlot, JsonValue,
} from '../contracts/graph-document.ts'
import type { HookRecord } from '../contracts/hook.ts'
import type { JsonSchema } from '../contracts/json-schema.ts'
import type { RouteRecord } from '../contracts/route.ts'
import type { SourceOrigin } from '../primitives/origin.ts'
import { GRAPH_DOCUMENT_VERSION } from '../contracts/graph-document.ts'
import { APP_PHASES, REQUEST_PHASES } from '../contracts/hook.ts'
import { VALIDATION_SOURCES } from '../contracts/coercion.ts'
import { toJsonSchema } from '../compile/json-schema.ts'
import { isVariantRecord } from '../compile/media-type.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * `serializeGraph` — the `AppGraph` as a `GraphDocument`, rfcs/0001 §2.4.
 *
 * Canonical by construction: every list whose order is not a fact about the
 * application is sorted (routes by path and method, plugins, slots, checks and
 * services by name), every list whose order *is* one is kept (a route's
 * middleware and hooks, in execution order), and `canonicalJson` sorts every
 * object's keys. Registering the same routes in a different order therefore
 * produces the same document, byte for byte, and the same fingerprint.
 *
 * Asynchronous because the fingerprints are SHA-256 through WebCrypto
 * (`crypto.subtle.digest`), the one hash every runtime Zen targets ships —
 * which is also why core needs no `node:crypto` for it (§3.3 B2).
 */
export async function serializeGraph(graph: AppGraph): Promise<GraphDocument> {
  const routes: GraphRoute[] = []
  const ordered = [...graph.routes].sort(byPathThenMethod)
  for (const record of ordered) routes.push(await routeDocument(record))

  const body: Omit<GraphDocument, 'fingerprint'> = {
    zenGraph: GRAPH_DOCUMENT_VERSION,
    routes,
    collections: graph.collections.map((c): GraphCollection => ({
      id: c.id,
      prefix: c.prefix,
      name: c.name ?? null,
      parent: c.parent,
      tags: [...c.tags],
      origin: originOf(c.origin),
      meta: metaOf(c.meta),
    })).sort(byKey('id')),
    plugins: graph.plugins.map((p): GraphPlugin => ({
      name: p.name,
      version: p.version,
      dependsOn: { ...p.dependsOn },
      origin: originOf(p.origin),
    })).sort(byKey('name')),
    hooks: appHooks(graph),
    slots: graph.slots.map((s): GraphSlot => ({
      name: s.name,
      optional: s.optional,
      hasDefault: s.defaultValue !== undefined,
      disposes: s.dispose !== undefined,
    })).sort(byKey('name')),
    decorations: graph.decorations.map((d): GraphDecoration => ({
      name: d.name,
      source: d.source,
      slot: d.slot === null ? null : d.slot.name,
      origin: originOf(d.origin),
    })).sort(byKey('name')),
    checks: graph.checks.map((c): GraphCheck => ({
      name: c.name,
      kind: c.kind,
      timeoutMs: c.timeoutMs,
      ttlMs: c.ttlMs,
      critical: c.critical,
      description: c.description ?? null,
      source: c.source,
      origin: originOf(c.origin),
    })).sort(byKey('name')),
    paramTypes: [...graph.paramTypes.values()].map((t): GraphParamType => ({
      name: t.name,
      jsonSchema: t.jsonSchema === undefined ? null : jsonSafe(t.jsonSchema),
    })).sort(byKey('name')),
    schemas: [...graph.schemas].map(([name, entry]): GraphSchema => ({
      name,
      schema: describe(entry.schema, 'output'),
      source: entry.source,
      origin: originOf(entry.origin),
    })).sort(byKey('name')),
    services: graph.services.map((s): GraphService => ({
      name: s.token.name,
      lifetime: s.lifetime,
      eager: s.eager,
      optional: s.token.optional === true,
      deps: s.deps.map((d) => d.name),
      origin: originOf(s.origin),
    })).sort(byKey('name')),
    meta: metaOf(graph.meta),
    config: jsonSafe(graph.config) as unknown as GraphDocument['config'],
  }

  return { ...body, fingerprint: await graphFingerprint(body) }
}

/**
 * The application fingerprint of a document — the same function `serializeGraph`
 * uses, exported so a reader can check that a document it was handed is the
 * one its fingerprint describes.
 */
export async function graphFingerprint(document: Omit<GraphDocument, 'fingerprint'> | GraphDocument): Promise<string> {
  const { fingerprint: _f, config: _c, slots: _s, ...rest } = canonicalOrder(document as GraphDocument)
  return sha256(canonicalJson(withoutOrigins(rest)))
}

/**
 * Every list whose order is not a fact about the application, in the order
 * `serializeGraph` writes it — applied again here, so the fingerprint is over
 * the canonical form and not over whatever order a document arrived in. A tool
 * that re-sorts a document's routes still holds the same application. The
 * lists whose order *is* a fact keep it: a route's middleware and hooks, and
 * the hooks within one phase. Phases themselves are put in phase order, which
 * is what they run in.
 */
function canonicalOrder(document: GraphDocument): GraphDocument {
  const phases: readonly string[] = [...REQUEST_PHASES, ...APP_PHASES]
  return {
    ...document,
    routes: [...document.routes].sort((a, b) =>
      a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.method < b.method ? -1 : a.method > b.method ? 1 : 0),
    collections: [...document.collections].sort(byKey('id')),
    plugins: [...document.plugins].sort(byKey('name')),
    // Stable: hooks of one phase keep their order, which is their execution order.
    hooks: [...document.hooks].sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase)),
    slots: [...document.slots].sort(byKey('name')),
    decorations: [...document.decorations].sort(byKey('name')),
    checks: [...document.checks].sort(byKey('name')),
    paramTypes: [...document.paramTypes].sort(byKey('name')),
    schemas: [...document.schemas].sort(byKey('name')),
    services: [...document.services].sort(byKey('name')),
  }
}

/** The contract fingerprint of one route of a document — see `GraphRoute.contract`. */
export async function contractFingerprint(route: Pick<GraphRoute, 'method' | 'path' | 'request' | 'responses'>): Promise<string> {
  return sha256(canonicalJson(contractOf(route)))
}

/**
 * What a route's contract *is*: its method and path, and its schemas with the
 * documentation-only keywords removed and their spelling normalised.
 */
export function contractOf(route: Pick<GraphRoute, 'method' | 'path' | 'request' | 'responses'>): JsonValue {
  const request: Record<string, JsonValue> = {}
  for (const source of Object.keys(route.request)) {
    request[source] = contractSchema(route.request[source] as JsonValue, 'request')
  }
  const responses: Record<string, JsonValue> = {}
  for (const status of Object.keys(route.responses)) {
    const media = route.responses[status]
    if (media === null || media === undefined) {
      responses[status] = null
      continue
    }
    const out: Record<string, JsonValue> = {}
    for (const type of Object.keys(media)) out[type] = contractSchema(media[type] as JsonValue, 'response')
    responses[status] = out
  }
  return { method: route.method, path: route.path, request, responses }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

async function routeDocument(record: RouteRecord): Promise<GraphRoute> {
  const request: Record<string, JsonValue> = {}
  for (const source of VALIDATION_SOURCES) {
    const schema = record.schema[source]
    if (schema !== undefined) request[source] = describe(schema, 'input')
  }

  const responses: Record<string, Record<string, JsonValue> | null> = {}
  const declared = record.schema.response as Readonly<Record<string, unknown>> | undefined
  for (const status of Object.keys(declared ?? {})) {
    const schema = (declared as Record<string, unknown>)[status]
    if (schema === null || schema === undefined) {
      responses[status] = null
      continue
    }
    if (isVariantRecord(schema)) {
      const content: Record<string, JsonValue> = {}
      for (const media of Object.keys(schema as object)) {
        const variant = (schema as Record<string, unknown>)[media]
        content[media] = variant === null || variant === undefined ? null : describe(variant, 'output')
      }
      responses[status] = content
      continue
    }
    responses[status] = { 'application/json': describe(schema, 'output') }
  }

  const route = {
    id: record.id,
    name: record.name ?? null,
    method: record.method,
    path: record.path,
    origin: originOf(record.origin),
    collection: record.collection,
    timeout: record.timeout === null ? null : { ms: record.timeout.ms, from: record.timeout.from },
    coercion: record.coercion === null ? null : coercionOf(record),
    negotiation: record.negotiation === null
      ? null
      : { offers: [...record.negotiation.offers], statuses: [...record.negotiation.statuses] },
    hooks: routeHooks(record),
    middleware: record.middleware.map((m): GraphMiddleware => ({
      kind: m.kind,
      scope: m.scope,
      name: m.name,
      origin: originOf(m.origin),
      when: m.omitted === true ? 'omitted' : m.when?.request !== undefined ? 'guarded' : null,
    })),
    handler: { name: functionName(record.handler), origin: originOf(record.origin) },
    request,
    responses,
    meta: metaOf(record.meta),
    check: typeof record.schema.check === 'function'
      ? { name: functionName(record.schema.check), origin: originOf(record.origin) }
      : null,
    inject: injectOf(record),
    dependencies: [...record.dependencies],
    intake: record.schema.intake === undefined ? null : jsonSafe(record.schema.intake) as { readonly [key: string]: JsonValue },
  }
  return { ...route, contract: await contractFingerprint(route) }
}

function injectOf(record: RouteRecord): { readonly [as: string]: string } | null {
  const inject = record.schema.inject
  if (inject === undefined || typeof inject !== 'object' || inject === null) return null
  const out: Record<string, string> = {}
  for (const [as, token] of Object.entries(inject)) out[as] = (token as { name?: unknown }).name as string
  return out
}

function coercionOf(record: RouteRecord): { readonly [source: string]: JsonValue } {
  const out: Record<string, JsonValue> = {}
  for (const [source, plan] of record.coercion ?? []) out[source] = jsonSafe(plan.fields)
  return out
}

function routeHooks(record: RouteRecord): GraphHook[] {
  const out: GraphHook[] = []
  for (const phase of REQUEST_PHASES) {
    for (const hook of record.hooks.get(phase) ?? []) out.push(hookOf(hook, record.origin))
  }
  return out
}

/**
 * The hooks that are not a route's own: global and collection scopes, and the
 * application phases. In phase order, then registration order — both facts
 * about the application, so neither is sorted away.
 */
function appHooks(graph: AppGraph): GraphHook[] {
  const out: GraphHook[] = []
  for (const phase of [...REQUEST_PHASES, ...APP_PHASES]) {
    for (const hook of graph.hooks.get(phase) ?? []) {
      if (hook.scope === 'route') continue
      out.push(hookOf(hook, undefined))
    }
  }
  return out
}

function hookOf(hook: HookRecord, fallback: SourceOrigin | undefined): GraphHook {
  return {
    phase: hook.phase,
    scope: hook.scope,
    name: hook.name ?? null,
    origin: originOf(hook.origin ?? fallback),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** A schema as JSON Schema, or a marker that says it could not be described. */
function describe(schema: unknown, io: 'input' | 'output'): JsonValue {
  const json = toJsonSchema(schema, io)
  return json === null ? { 'x-zen-unconvertible': true } : jsonSafe(json)
}

/**
 * Keywords that describe a schema to a reader without constraining a value.
 * `default` is one on the response side only: the serializer never fills a
 * default in, while a request validator does, and a different default is a
 * different request.
 */
const DOC_KEYWORDS = new Set([
  'title', 'description', 'examples', 'example', '$comment', 'deprecated', '$schema', '$id', '$anchor',
  'readOnly', 'writeOnly',
])
const RESPONSE_DOC_KEYWORDS = new Set([...DOC_KEYWORDS, 'default'])

/** Keywords whose value is one subschema. */
const SCHEMA_KEYWORDS = new Set([
  'items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'unevaluatedProperties',
  'unevaluatedItems', 'if', 'then', 'else', 'additionalItems',
])
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
/** Keywords whose value maps a name to a subschema. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions'])

/**
 * A schema reduced to what it constrains, spelled one way — what the contract
 * fingerprint hashes.
 *
 *   - documentation keywords go (`title`, `description`, `examples`, …);
 *   - `$defs` are renamed by the order they are first referenced, so a
 *     definition named after a `title` does not make a rename a contract change;
 *   - `nullable: true` and a two-branch `anyOf` with `null` become `type: [T,
 *     'null']`, `const: v` becomes `enum: [v]`, and `type`, `enum` and
 *     `required` are sorted — the spellings `diffDocuments` already reads as one;
 *   - on the response side an object with no `additionalProperties` is closed,
 *     because the serializer drops undeclared fields (§13.3.1) and the document
 *     says so.
 */
export function contractSchema(schema: JsonValue, direction: 'request' | 'response'): JsonValue {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema
  const names = defNames(schema as Record<string, JsonValue>)
  return normalise(schema as Record<string, JsonValue>, direction, names, true)
}

/** `#/$defs/User` → `#/$defs/d0`, by first reference in a depth-first walk. */
function defNames(root: Record<string, JsonValue>): Map<string, string> {
  const names = new Map<string, string>()
  const defs = new Map<string, JsonValue>()
  for (const key of ['$defs', 'definitions'] as const) {
    const table = root[key]
    if (typeof table !== 'object' || table === null || Array.isArray(table)) continue
    for (const name of Object.keys(table)) defs.set(`#/${key}/${name}`, (table as Record<string, JsonValue>)[name] as JsonValue)
  }
  if (defs.size === 0) return names

  const visit = (node: JsonValue): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const ref = (node as Record<string, JsonValue>)['$ref']
    if (typeof ref === 'string' && defs.has(ref) && !names.has(ref)) {
      names.set(ref, `#/$defs/d${names.size}`)
      visit(defs.get(ref) as JsonValue)
    }
    for (const key of Object.keys(node).sort()) {
      if (key === '$defs' || key === 'definitions') continue
      visit((node as Record<string, JsonValue>)[key] as JsonValue)
    }
  }
  visit(root)
  return names
}

function normalise(
  node: Record<string, JsonValue>,
  direction: 'request' | 'response',
  names: ReadonlyMap<string, string>,
  root: boolean,
): JsonValue {
  const drop = direction === 'response' ? RESPONSE_DOC_KEYWORDS : DOC_KEYWORDS
  const out: Record<string, JsonValue> = {}

  for (const key of Object.keys(node)) {
    // Documentation, and vendor extensions — an `x-…` keyword constrains no value.
    if (drop.has(key) || key.startsWith('x-')) continue
    const value = node[key] as JsonValue
    if (key === '$ref' && typeof value === 'string') {
      out[key] = names.get(value) ?? value
    } else if (key === '$defs' || key === 'definitions') {
      if (!root || typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const defs = (out['$defs'] ?? {}) as Record<string, JsonValue>
      for (const name of Object.keys(value)) {
        const renamed = names.get(`#/${key}/${name}`)
        // A definition nothing references is not part of what the schema says.
        if (renamed === undefined) continue
        defs[renamed.slice('#/$defs/'.length)] = sub((value as Record<string, JsonValue>)[name] as JsonValue, direction, names)
      }
      if (Object.keys(defs).length > 0) out['$defs'] = defs
    } else if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = sub(value, direction, names)
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map((member) => sub(member, direction, names))
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const map: Record<string, JsonValue> = {}
      for (const name of Object.keys(value)) map[name] = sub((value as Record<string, JsonValue>)[name] as JsonValue, direction, names)
      out[key] = map
    } else {
      out[key] = value
    }
  }

  // A keyword at its own default says nothing: `uniqueItems: false` is its absence.
  if (out['uniqueItems'] === false) delete out['uniqueItems']

  // `nullable` is OpenAPI 3.0's way of saying `type: [T, 'null']`.
  if (out['nullable'] === true) {
    delete out['nullable']
    const types = typeList(out['type'])
    if (types.length > 0 && !types.includes('null')) out['type'] = [...types, 'null']
  } else if (out['nullable'] === false) {
    delete out['nullable']
  }

  // A two-branch union with `null` is a nullable schema, however it is spelled.
  const union = (out['anyOf'] ?? out['oneOf']) as JsonValue
  if (Array.isArray(union) && union.length === 2 && onlyKey(out, out['anyOf'] !== undefined ? 'anyOf' : 'oneOf')) {
    const [a, b] = union as [JsonValue, JsonValue]
    const other = isNull(a) ? b : isNull(b) ? a : null
    if (other !== null && typeof other === 'object' && !Array.isArray(other)) {
      const types = typeList((other as Record<string, JsonValue>)['type'])
      if (types.length > 0 && (other as Record<string, JsonValue>)['anyOf'] === undefined) {
        const merged: Record<string, JsonValue> = { ...(other as Record<string, JsonValue>) }
        merged['type'] = types.includes('null') ? types : [...types, 'null']
        const values = merged['enum']
        if (Array.isArray(values) && !values.includes(null)) merged['enum'] = [...values, null]
        return finish(merged)
      }
    }
  }

  // `additionalProperties` absent means "allowed" to a validator and "dropped"
  // to the serializer (§13.3.1), so each side is normalised to what it means:
  // a request's `true` is its absence, a response's absence is `false`.
  if (direction === 'request' && out['additionalProperties'] === true) delete out['additionalProperties']
  if (direction === 'response' && isObjectShape(out) && out['additionalProperties'] === undefined) {
    out['additionalProperties'] = false
  }
  return finish(out)
}

function finish(out: Record<string, JsonValue>): JsonValue {
  if (out['const'] !== undefined && out['enum'] === undefined) {
    out['enum'] = [out['const']]
    delete out['const']
  }
  const types = typeList(out['type'])
  if (types.length > 0) out['type'] = types.length === 1 ? (types[0] as string) : [...types].sort()
  if (Array.isArray(out['enum'])) out['enum'] = [...out['enum']].sort(byCanonical)
  if (Array.isArray(out['required'])) out['required'] = [...new Set(out['required'] as string[])].sort()
  return out
}

function sub(node: JsonValue, direction: 'request' | 'response', names: ReadonlyMap<string, string>): JsonValue {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return node
  return normalise(node as Record<string, JsonValue>, direction, names, false)
}

function typeList(type: JsonValue | undefined): string[] {
  if (typeof type === 'string') return [type]
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string')
  return []
}

function isNull(node: JsonValue): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
  const record = node as Record<string, JsonValue>
  const types = typeList(record['type'])
  return types.length === 1 && types[0] === 'null'
}

function onlyKey(node: Record<string, JsonValue>, key: string): boolean {
  for (const other of Object.keys(node)) if (other !== key) return false
  return true
}

/** Mirrors the serializer IR and the OpenAPI projector: when is a schema an object? */
function isObjectShape(node: Record<string, JsonValue>): boolean {
  const types = typeList(node['type'])
  if (types.includes('object')) return true
  if (types.filter((t) => t !== 'null').length > 0) return false
  if (node['enum'] !== undefined || node['const'] !== undefined) return false
  return node['properties'] !== undefined || node['required'] !== undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical JSON, and the hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key-sorted JSON — the one spelling of a value a fingerprint is taken over.
 *
 * A key whose value is `undefined` is left out, as `JSON.stringify` leaves it
 * out, so the canonical form of a document and of the same document after a
 * trip through `JSON.stringify` and `JSON.parse` are one string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value)
    return json === undefined ? 'null' : json
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** `sha256-<hex>` of a string's UTF-8 bytes, through WebCrypto. */
export async function sha256(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle
  if (subtle === undefined) {
    throw new ZenError(
      Codes.CAPABILITY_UNAVAILABLE,
      'Fingerprinting the application graph needs WebCrypto (globalThis.crypto.subtle), which this runtime does not provide.',
      { status: 500, expose: false },
    )
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, '0')
  return `sha256-${hex}`
}

interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON safety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Any value, as JSON — the conversion every free-form field of the graph goes
 * through (route `meta`, plugin metadata, a converter's JSON Schema).
 *
 * A function becomes `{ "function": name }`, a `Map` an object of its entries,
 * a `bigint` its digits, a non-finite number `null`, a cycle `"[Circular]"`,
 * and any other object that is not a plain one or an array
 * `{ "object": constructorName }`: its type is a fact worth keeping, and its
 * contents are not something the graph can promise to serialise faithfully.
 */
export function jsonSafe(value: unknown, seen: Set<object> = new Set()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined' || typeof value === 'symbol') return null
  if (typeof value === 'function') return { function: value.name === '' ? 'anonymous' : value.name }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen))
    if (value instanceof Map) {
      const out: Record<string, JsonValue> = {}
      for (const [key, item] of value) out[String(key)] = jsonSafe(item, seen)
      return out
    }
    if (value instanceof Set) return [...value].map((item) => jsonSafe(item, seen))
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: unknown } }).constructor?.name
      return { object: typeof name === 'string' && name !== '' ? name : 'Object' }
    }
    const out: Record<string, JsonValue> = {}
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) continue
      out[key] = jsonSafe(item, seen)
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function metaOf(meta: ReadonlyMap<string, unknown>): { readonly [key: string]: JsonValue } {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of meta) out[key] = jsonSafe(value)
  return out
}

function originOf(origin: SourceOrigin | undefined | null): SourceOrigin | null {
  return origin === undefined || origin === null ? null : { file: origin.file, line: origin.line, column: origin.column }
}

/** The document with every `origin` removed, for the application fingerprint. */
function withoutOrigins(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOrigins)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (key === 'origin') continue
    out[key] = withoutOrigins((value as Record<string, unknown>)[key])
  }
  return out
}

function functionName(fn: unknown): string | null {
  const name = (fn as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : null
}

function byPathThenMethod(a: RouteRecord, b: RouteRecord): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return a.method < b.method ? -1 : a.method > b.method ? 1 : 0
}

function byKey<K extends string>(key: K) {
  return (a: { readonly [P in K]: string }, b: { readonly [P in K]: string }): number =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0
}

function byCanonical(a: JsonValue, b: JsonValue): number {
  const x = canonicalJson(a)
  const y = canonicalJson(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export type { JsonSchema }
