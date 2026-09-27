import type {
  AppGraph, CoercePlan, CollectionId, CollectionRecord, JsonSchema, ParamType, PathSegment,
  RouteRecord,
} from '@erenthedeveloper0/zen-core'
import { toJsonSchema, isVariantRecord, normaliseMediaType, isMediaProblem } from '@erenthedeveloper0/zen-core'
import {
  Components, canonical, declaredName, projectSchema, sanitizeName,
  type DocDiagnostic,
} from './schema.ts'
import type {
  ExternalDocs, HttpOperation, OpenApiDocument, OpenApiSchema, ParameterObject,
  ParameterLocation, PathItemObject, RequestBodyObject, ResponseObject, SecurityRequirement,
  SecurityScheme, ServerObject, TagObject,
} from './types.ts'

/**
 * `AppGraph → OpenAPIDocument` — rfcs/0001 §29.
 *
 * A pure function, and that is the architectural claim. Every other framework
 * treats OpenAPI as an add-on that *re-describes* what the routes already say,
 * which is why the documentation is always slightly wrong. Here the graph
 * already contains every fact the document needs — paths, methods, param types,
 * request and response schemas per status, tags, collections — so there is
 * nothing to keep in sync because there is nothing duplicated.
 *
 * Nothing in this module runs per request. It is called once, from `onBoot`,
 * against the frozen graph.
 */

export interface OpenApiOptions {
  readonly title: string
  readonly version: string
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly servers?: readonly ServerObject[] | undefined
  readonly tags?: readonly TagObject[] | undefined
  readonly externalDocs?: ExternalDocs | undefined
  readonly security?: readonly SecurityRequirement[] | undefined
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>> | undefined
  readonly license?: { readonly name: string; readonly identifier?: string; readonly url?: string } | undefined
  readonly contact?: { readonly name?: string; readonly url?: string; readonly email?: string } | undefined
  /**
   * Document the RFC 9457 envelope Zen actually emits on the error path, as
   * `4XX`/`5XX` responses. On by default: the error shape is a real part of the
   * API contract, and leaving it undocumented is how clients end up parsing it
   * by observation.
   */
  readonly problemDetails?: boolean | undefined
  /** Routes to leave out. The docs endpoints exclude themselves through this. */
  readonly exclude?: ((route: RouteRecord) => boolean) | undefined
}

export interface OpenApiResult {
  readonly document: OpenApiDocument
  /**
   * Everything the generator could not state with confidence — an undeclared
   * response schema, an unconvertible library schema, an anonymous schema shared
   * by four operations. Surfaced rather than silently papered over, because a
   * document that quietly describes less than the API does is worse than one
   * that says so.
   */
  readonly diagnostics: readonly DocDiagnostic[]
}

const METHOD_TO_OPERATION: Readonly<Record<string, HttpOperation>> = {
  GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch',
  DELETE: 'delete', HEAD: 'head', OPTIONS: 'options',
}

const PROBLEM_REF = '#/components/schemas/ProblemDetails'

/**
 * One appearance of a schema in the document.
 *
 * `place` is why this exists: hoisting happens *after* every route is visited,
 * because "is this schema shared?" is not answerable until then. Keeping a
 * setter rather than a copy is what lets the second pass replace an inlined
 * schema with a `$ref` in the document itself.
 */
interface SchemaUse {
  readonly json: JsonSchema
  readonly original: object | null
  /** Response side. Requests and responses of the same named type are two components. */
  readonly closed: boolean
  readonly where: string
  readonly hint: string
  readonly shape: string
  readonly projected: OpenApiSchema
  readonly place: (schema: OpenApiSchema) => void
}

// ─────────────────────────────────────────────────────────────────────────────

export function openapiDocument(graph: AppGraph, options: OpenApiOptions): OpenApiResult {
  return new DocumentBuilder(graph, options).build()
}

class DocumentBuilder {
  readonly #graph: AppGraph
  readonly #opts: OpenApiOptions
  readonly #diagnostics: DocDiagnostic[] = []
  readonly #components = new Components()
  readonly #uses: SchemaUse[] = []
  readonly #operationIds = new Set<string>()
  readonly #collections = new Map<CollectionId, CollectionRecord>()
  readonly #tagsUsed = new Set<string>()

  constructor(graph: AppGraph, options: OpenApiOptions) {
    this.#graph = graph
    this.#opts = options
    for (const collection of graph.collections) this.#collections.set(collection.id, collection)
  }

  build(): OpenApiResult {
    const routes = this.#graph.routes.filter((route) => !this.#hidden(route))
    const problems = this.#opts.problemDetails !== false && routes.length > 0

    // Claimed before any user schema so the `$ref` above can be a constant. A
    // user schema also titled ProblemDetails becomes ProblemDetails2, which is
    // visible in the document rather than silently shadowing the error contract.
    if (problems) this.#components.claim('ProblemDetails', PROBLEM_DETAILS as OpenApiSchema, 'zen:problem-details')

    const paths = new Map<string, Record<string, unknown>>()

    for (const route of routes) {
      const method = METHOD_TO_OPERATION[route.method]
      if (method === undefined) {
        this.#warn('ZEN_OAS_METHOD_UNMAPPED', `${route.method} has no OpenAPI equivalent and was omitted.`, `${route.method} ${route.path}`)
        continue
      }
      for (const variant of pathVariants(route.segments)) {
        const item = paths.get(variant.template) ?? {}
        paths.set(variant.template, item)
        const operation = this.#operation(route, variant, problems)
        if (item[method] !== undefined) {
          this.#diagnostics.push({
            severity: 'error',
            code: 'ZEN_OAS_OPERATION_COLLISION',
            message: `Two routes produce ${route.method} ${variant.template}; the second was dropped from the document.`,
            where: `${route.method} ${variant.template}`,
            hint: 'This normally means an optional parameter expanded onto a path another route already owns.',
          })
          continue
        }
        item[method] = operation
      }
    }

    this.#hoistSharedSchemas()

    const document: Record<string, unknown> = {
      openapi: '3.1.0',
      info: buildInfo(this.#opts),
      paths: sortRecord(paths),
    }
    if (this.#opts.servers !== undefined) document['servers'] = this.#opts.servers
    if (this.#opts.security !== undefined) document['security'] = this.#opts.security
    if (this.#opts.externalDocs !== undefined) document['externalDocs'] = this.#opts.externalDocs

    const tags = buildTags(this.#opts.tags, this.#tagsUsed, this.#graph.collections)
    if (tags.length > 0) document['tags'] = tags

    const schemas = this.#components.toRecord()
    const hasSchemas = Object.keys(schemas).length > 0
    if (hasSchemas || this.#opts.securitySchemes !== undefined) {
      const components: Record<string, unknown> = {}
      if (hasSchemas) components['schemas'] = schemas
      if (this.#opts.securitySchemes !== undefined) components['securitySchemes'] = this.#opts.securitySchemes
      document['components'] = components
    }

    // A component can be reserved under a provisional name and only later turn
    // out to duplicate one already published — see `Components#fill`. Refs to
    // the provisional name were already emitted, so they are rewritten here.
    const aliases = this.#components.aliases()
    const final = aliases.size === 0 ? document : (rewriteRefs(document, aliases) as Record<string, unknown>)

    return { document: final as unknown as OpenApiDocument, diagnostics: this.#diagnostics }
  }

  // ── operations ───────────────────────────────────────────────────────────

  #operation(route: RouteRecord, variant: PathVariant, problems: boolean): Record<string, unknown> {
    const where = `${route.method} ${variant.template}`
    const meta = readMeta(route)
    const tags = this.#tags(route, meta.tags)
    for (const tag of tags) this.#tagsUsed.add(tag)

    const baseId = meta.operationId ?? route.name ?? defaultOperationId(route)
    const operationId = this.#operationId(
      variant.suffix === null ? baseId : `${baseId}By${pascal(variant.suffix)}`,
      where,
    )

    const parameters: ParameterObject[] = [
      ...this.#pathParameters(variant.segments, where),
      ...this.#schemaParameters(route.schema.query, 'query', where, route.coercion?.get('query')),
      ...this.#schemaParameters(route.schema.headers, 'header', where, route.coercion?.get('headers')),
      ...this.#schemaParameters(route.schema.cookies, 'cookie', where, route.coercion?.get('cookies')),
    ]

    const operation: Record<string, unknown> = {
      operationId,
      responses: this.#responses(route, where, problems),
    }
    if (meta.summary !== undefined) operation['summary'] = meta.summary
    if (meta.description !== undefined) operation['description'] = meta.description
    if (tags.length > 0) operation['tags'] = tags
    if (meta.deprecated) operation['deprecated'] = true
    if (parameters.length > 0) operation['parameters'] = parameters

    const body = this.#requestBody(route, where)
    if (body !== null) operation['requestBody'] = body
    if (meta.security !== undefined) operation['security'] = meta.security
    if (meta.externalDocs !== undefined) operation['externalDocs'] = meta.externalDocs

    // §4.4 — the budget, as a vendor extension.
    //
    // A generated client needs it: an SDK that waits thirty seconds for an
    // endpoint the server abandons after two spends twenty-eight seconds
    // holding a socket for an answer that is never coming. Today that number
    // lives in a runbook, if anywhere.
    //
    // It is the *same field* the dispatcher arms from and `explainRoute`
    // prints, so it cannot describe a budget the service does not use — the
    // same property that makes §29.1's documented-fields guarantee worth
    // having, applied to a second fact about the route.
    if (route.timeout !== null) operation['x-zen-timeout-ms'] = route.timeout.ms

    return operation
  }

  #requestBody(route: RouteRecord, where: string): RequestBodyObject | null {
    const body = route.schema.body
    if (body === undefined || body === null) return null

    // `'input'`: a request body is described as the validator *receives* it.
    const json = toJsonSchema(body, 'input')
    if (json === null) {
      this.#warn(
        'ZEN_OAS_SCHEMA_UNCONVERTIBLE',
        'The request body schema could not be converted to JSON Schema; the document describes it as unconstrained.',
        `${where} → body`,
        'Register a converter with registerSchemaConverter(vendor, fn), or use a library exposing toJsonSchema().',
      )
      return { required: true, content: { 'application/json': { schema: {} } } }
    }

    // Requests are projected *open*. The validator is the authority there and it
    // is the user's schema library, so its converter's output is the honest
    // description of what it accepts — unlike responses, where Zen's own
    // serializer decides what leaves the process (§13.3.1).
    const media: Record<string, unknown> = {}
    const use = this.#record(json, body, false, `${where} → body`, `${route.name ?? defaultOperationId(route)}Body`, (schema) => {
      media['schema'] = schema
    })
    media['schema'] = use.projected
    return { required: true, content: { 'application/json': media as { schema: OpenApiSchema } } }
  }

  #responses(route: RouteRecord, where: string, problems: boolean): Record<string, ResponseObject> {
    const responses: Record<string, ResponseObject> = {}
    const declared = route.schema.response as unknown as Record<string, unknown> | undefined

    if (declared === undefined) {
      this.#warn(
        'ZEN_OAS_RESPONSE_UNDECLARED',
        "No response schema is declared, so this operation's payload is undocumented.",
        where,
        'Add `response: { 200: Schema }`. It also compiles a serializer that cannot emit undeclared fields (§13.3).',
      )
      responses['default'] = { description: 'Undocumented. This route declares no response schema.' }
    } else {
      for (const status of Object.keys(declared).sort((a, b) => Number(a) - Number(b))) {
        const schema = declared[status]
        if (schema === null || schema === undefined) {
          responses[status] = { description: statusText(Number(status)) }
          continue
        }

        // §13.4 — the variant form. `content` is a map of media type to schema
        // in OpenAPI already, so a negotiated response needs no new vocabulary
        // here: it is the same object with more than one key, and the reason
        // this generator can write it at all is that the graph carries the
        // media types rather than the document re-describing them (§29.1).
        //
        // The offer *order* is preserved, because `RouteRecord.negotiation`
        // preserved it and it is a real fact about the API: it is what a client
        // sending `Accept: * / *` receives. OpenAPI does not give that order a
        // meaning, but dropping it would throw away something true.
        if (isVariantRecord(schema)) {
          const content: Record<string, { schema: OpenApiSchema }> = {}
          const ordered = route.negotiation?.offers ?? Object.keys(schema)
          for (const media of ordered) {
            const variant = variantSchema(schema as Record<string, unknown>, media)
            if (variant === null || variant === undefined) continue
            const described = this.#describeResponse(
              variant, route, `${where} → response ${status} (${media})`,
            )
            if (described !== null) content[media] = described
          }
          responses[status] = {
            description: statusText(Number(status)),
            content,
          }
          continue
        }

        const described = this.#describeResponse(schema, route, `${where} → response ${status}`)
        responses[status] = described === null
          ? { description: statusText(Number(status)), content: { 'application/json': { schema: {} } } }
          : {
              description: descriptionOf(toJsonSchema(schema, 'output') ?? {}) ?? statusText(Number(status)),
              content: { 'application/json': described },
            }
      }
    }

    if (problems) {
      const problem: ResponseObject = {
        description: 'RFC 9457 problem document.',
        content: { 'application/problem+json': { schema: { $ref: PROBLEM_REF } } },
      }
      if (responses['4XX'] === undefined) responses['4XX'] = problem
      if (responses['5XX'] === undefined) responses['5XX'] = problem
    }
    return responses
  }

  /**
   * One response schema → one `content` entry, or `null` when it will not
   * convert.
   *
   * Extracted when §13.4 arrived, because the negotiated form needs this once
   * per media type and the plain form needs it once. Sharing it is what keeps
   * `200: Schema` and `200: { 'application/json': Schema }` producing the same
   * `$ref` to the same component — which is the property the dedup pass
   * (§29.5) and the drift suite both depend on, and which two copies of this
   * body would have broken the first time one of them was edited.
   */
  #describeResponse(
    schema: unknown,
    route: RouteRecord,
    where: string,
  ): { schema: OpenApiSchema } | null {
    // `'output'`: a response is described as it leaves the serializer.
    const json = toJsonSchema(schema, 'output')
    if (json === null) {
      this.#warn(
        'ZEN_OAS_SCHEMA_UNCONVERTIBLE',
        'This response schema could not be converted to JSON Schema; the document describes it as unconstrained.',
        where,
        'The serializer reports the same schema at boot: the type-level contract holds, the runtime one does not.',
      )
      return null
    }

    const media: Record<string, unknown> = {}
    const use = this.#record(
      json, schema as object, true, where,
      declaredName(json) ?? `${route.name ?? defaultOperationId(route)}Response`,
      (projected) => { media['schema'] = projected },
    )
    media['schema'] = use.projected
    return media as { schema: OpenApiSchema }
  }

  // ── parameters ───────────────────────────────────────────────────────────

  #pathParameters(segments: readonly PathSegment[], where: string): ParameterObject[] {
    const out: ParameterObject[] = []
    for (const segment of segments) {
      if (segment.kind === 'static') continue

      if (segment.kind === 'wildcard') {
        // OpenAPI has no tail-match notion. Documenting it as a string path
        // parameter is the standard approximation; the extension says so out
        // loud rather than letting a client author assume a single segment.
        out.push({
          name: segment.value,
          in: 'path',
          required: true,
          description: 'Matches the remainder of the path, including "/".',
          schema: { type: 'string' },
          'x-zen-wildcard': true,
        })
        continue
      }

      // §5.2's promise, cashed: one `paramType` declaration produced the trie
      // matcher, the parse function, and this schema.
      let schema: OpenApiSchema = { type: 'string' }
      if (segment.type !== undefined) {
        const paramType: ParamType | undefined = this.#graph.paramTypes.get(segment.type)
        if (paramType?.jsonSchema !== undefined) schema = paramType.jsonSchema as OpenApiSchema
        else {
          this.#warn(
            'ZEN_OAS_PARAM_TYPE_UNDOCUMENTED',
            `Parameter type "<${segment.type}>" contributes no jsonSchema, so ":${segment.value}" is documented as a plain string.`,
            where,
            'Add a `jsonSchema` fragment to the param type — one declaration, three consumers (§5.2).',
          )
        }
      }
      out.push({ name: segment.value, in: 'path', required: true, schema })
    }
    return out
  }

  /**
   * Query, header and cookie schemas are objects; OpenAPI wants one parameter
   * per property. The whole schema is projected first so that any `$defs` it
   * carries are hoisted once, then its properties are split apart.
   */
  #schemaParameters(
    source: unknown,
    location: ParameterLocation,
    where: string,
    coercion: CoercePlan | undefined,
  ): ParameterObject[] {
    if (source === undefined || source === null) return []

    const json = toJsonSchema(source, 'input')
    if (json === null) {
      this.#warn(
        'ZEN_OAS_SCHEMA_UNCONVERTIBLE',
        `The ${location} schema could not be converted to JSON Schema, so its parameters are undocumented.`,
        where,
        'Register a converter with registerSchemaConverter(vendor, fn), or use a library exposing toJsonSchema().',
      )
      return []
    }

    const projected = projectSchema(json, {
      components: this.#components, closed: false, diagnostics: this.#diagnostics, where,
    }) as Record<string, unknown>

    const properties = projected['properties'] as Record<string, OpenApiSchema> | undefined
    if (properties === undefined) {
      this.#diagnostics.push({
        severity: 'info',
        code: 'ZEN_OAS_PARAMS_NOT_OBJECT',
        message: `The ${location} schema declares no properties at its top level, so no parameters were documented.`,
        where,
        hint: 'Parameters must come from a plain object schema; a $ref or union at the root cannot be split into parameters.',
      })
      return []
    }

    const required = new Set((projected['required'] as string[] | undefined) ?? [])
    const out: ParameterObject[] = []
    for (const name of Object.keys(properties)) {
      const schema = properties[name]
      if (schema === undefined) continue
      const parameter: Record<string, unknown> = { name, in: location, schema }
      if (required.has(name)) parameter['required'] = true
      if (typeof schema.description === 'string') parameter['description'] = schema.description
      if (schema['deprecated'] === true) parameter['deprecated'] = true
      Object.assign(parameter, listStyle(location, coercion, name))
      out.push(parameter as unknown as ParameterObject)
    }
    return out
  }

  // ── schema identity — §29.3 ──────────────────────────────────────────────

  #record(
    json: JsonSchema,
    original: object | null,
    closed: boolean,
    where: string,
    hint: string,
    place: (schema: OpenApiSchema) => void,
  ): SchemaUse {
    const projected = projectSchema(json, {
      components: this.#components, closed, diagnostics: this.#diagnostics, where,
    })
    const use: SchemaUse = { json, original, closed, where, hint, projected, shape: canonical(projected), place }
    this.#uses.push(use)
    return use
  }

  /**
   * Three passes, in order of authority (§29.3).
   *
   *   1. **Identity** — the same imported schema object used by four routes is
   *      one concept, whatever it looks like.
   *   2. **Declared name** — `$id` or `title`. A named schema is always hoisted,
   *      even when used once, because the name is the author telling a client
   *      generator what to call the type.
   *   3. **Structure** — a backstop for anonymous schemas, and only for those.
   *      Two differently-named schemas that happen to have the same shape today
   *      are not necessarily the same concept, so this never merges named ones.
   *
   * Single-use anonymous schemas stay inline. Hoisting them would fill
   * `components` with `Schema1..Schema40` and make the document harder to read
   * for no gain.
   */
  #hoistSharedSchemas(): void {
    const byIdentity = new Map<object, SchemaUse[]>()
    const byShape = new Map<string, SchemaUse[]>()

    for (const use of this.#uses) {
      if (use.original !== null) push(byIdentity, use.original, use)
      push(byShape, use.shape, use)
    }

    const done = new Set<SchemaUse>()

    for (const use of this.#uses) {
      if (done.has(use)) continue
      // Already a component: either a `$defs` entry the projector hoisted, or a
      // titled schema it recognised. Claiming a second component *for a `$ref`*
      // would publish a pointer to a pointer.
      if (use.projected.$ref !== undefined) continue

      const name = declaredName(use.json)
      // Identity only merges uses that also project identically: the same object
      // used once as a request body and once as a response is two shapes,
      // because only one of them is closed.
      const identical = (use.original === null ? [use] : byIdentity.get(use.original) ?? [use])
        .filter((other) => other.shape === use.shape)
      const structural = byShape.get(use.shape) ?? [use]
      const shared = identical.length > 1 || structural.length > 1

      if (name === null && !shared) continue

      if (name === null) {
        this.#diagnostics.push({
          severity: 'info',
          code: 'ZEN_OAS_ANONYMOUS_SHARED',
          message: `An anonymous schema is used by ${structural.length} operations and was named automatically.`,
          where: use.where,
          hint: 'Give the schema a title (or $id) so generated clients get a stable type name across releases.',
        })
      }

      const key = name === null ? `shape:${use.shape}` : `named:${name}:${use.shape}`
      const preferred = pascal(sanitizeName(name ?? use.hint))
      const variant = use.closed ? undefined : 'Input'
      const component = this.#components.claim(preferred, use.projected, key, variant)
      if (name !== null && component !== preferred && component !== `${preferred}${variant ?? ''}`) {
        this.#warn(
          'ZEN_OAS_TITLE_COLLISION',
          `Two different schemas are both titled "${name}"; this one was published as "${component}".`,
          use.where,
          'Give them distinct titles — a generated client names its types from these.',
        )
      }

      const ref: OpenApiSchema = { $ref: `#/components/schemas/${component}` }
      for (const member of structural) {
        member.place(ref)
        done.add(member)
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  #hidden(route: RouteRecord): boolean {
    if (route.meta.get('hidden') === true) return true
    return this.#opts.exclude?.(route) === true
  }

  /** Tags come from the collection chain, outermost first, then route metadata. */
  #tags(route: RouteRecord, extra: readonly string[] | undefined): string[] {
    const chain: string[][] = []
    let current = route.collection === null ? undefined : this.#collections.get(route.collection)
    while (current !== undefined) {
      chain.unshift([...current.tags])
      current = current.parent === null ? undefined : this.#collections.get(current.parent)
    }
    const out: string[] = []
    for (const tags of chain) for (const tag of tags) if (!out.includes(tag)) out.push(tag)
    for (const tag of extra ?? []) if (!out.includes(tag)) out.push(tag)
    return out
  }

  #operationId(base: string, where: string): string {
    if (!this.#operationIds.has(base)) {
      this.#operationIds.add(base)
      return base
    }
    this.#warn(
      'ZEN_OAS_OPERATION_ID_COLLISION',
      `operationId "${base}" is already taken; this operation was renamed.`,
      where,
      'Give the route an explicit `name`. operationId is what generated clients call the method.',
    )
    for (let n = 2; ; n++) {
      const candidate = `${base}_${n}`
      if (!this.#operationIds.has(candidate)) {
        this.#operationIds.add(candidate)
        return candidate
      }
    }
  }

  #warn(code: string, message: string, where: string, hint?: string): void {
    this.#diagnostics.push({ severity: 'warning', code, message, where, hint })
  }
}

const REF_PREFIX = '#/components/schemas/'

/** Rewrites every `$ref` through the alias map, wherever it appears. */
function rewriteRefs(node: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, aliases))
  if (typeof node !== 'object' || node === null) return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
      const target = aliases.get(value.slice(REF_PREFIX.length))
      out[key] = target === undefined ? value : `${REF_PREFIX}${target}`
      continue
    }
    out[key] = rewriteRefs(value, aliases)
  }
  return out
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

export interface PathVariant {
  readonly template: string
  readonly segments: readonly PathSegment[]
  /** The optional parameter this variant adds, used to keep operationIds unique. */
  readonly suffix: string | null
}

/**
 * `/posts/:slug?` becomes two paths, not one path with `required: false`.
 *
 * OpenAPI has no optional path parameter — the spec requires `required: true`
 * for `in: 'path'` — so the only correct representation is two concrete paths,
 * which is also exactly what the router does at build time (`expandOptional`,
 * §5.2). A generated client therefore gets both call shapes instead of one that
 * cannot be expressed.
 */
export function pathVariants(segments: readonly PathSegment[]): PathVariant[] {
  let trailingOptional = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i] as PathSegment
    if (segment.kind === 'param' && segment.optional === true) trailingOptional++
    else break
  }

  if (trailingOptional === 0) return [{ template: templateOf(segments), segments, suffix: null }]

  const variants: PathVariant[] = []
  const base = segments.length - trailingOptional
  for (let extra = 0; extra <= trailingOptional; extra++) {
    const slice = segments.slice(0, base + extra)
    const added = extra === 0 ? null : (segments[base + extra - 1] as PathSegment).value
    variants.push({ template: templateOf(slice), segments: slice, suffix: added })
  }
  return variants
}

function templateOf(segments: readonly PathSegment[]): string {
  if (segments.length === 0) return '/'
  let out = ''
  for (const segment of segments) {
    out += segment.kind === 'static' ? `/${segment.value}` : `/{${segment.value}}`
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedMeta {
  readonly summary: string | undefined
  readonly description: string | undefined
  readonly tags: readonly string[] | undefined
  readonly operationId: string | undefined
  readonly deprecated: boolean
  readonly security: readonly SecurityRequirement[] | undefined
  readonly externalDocs: ExternalDocs | undefined
}

function readMeta(route: RouteRecord): ResolvedMeta {
  const meta = route.meta
  const text = (key: string): string | undefined => {
    const value = meta.get(key)
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const tags = meta.get('tags')
  const security = meta.get('security')
  const externalDocs = meta.get('externalDocs')
  return {
    summary: text('summary'),
    description: text('description'),
    operationId: text('operationId'),
    tags: Array.isArray(tags) ? (tags.filter((tag) => typeof tag === 'string') as string[]) : undefined,
    deprecated: meta.get('deprecated') === true,
    security: Array.isArray(security) ? (security as readonly SecurityRequirement[]) : undefined,
    externalDocs:
      typeof externalDocs === 'object' && externalDocs !== null ? (externalDocs as ExternalDocs) : undefined,
  }
}

function buildTags(
  declared: readonly TagObject[] | undefined,
  used: ReadonlySet<string>,
  collections: readonly CollectionRecord[],
): TagObject[] {
  const out: TagObject[] = []
  const seen = new Set<string>()
  for (const tag of declared ?? []) {
    out.push(tag)
    seen.add(tag.name)
  }
  const describedBy = new Map<string, string>()
  for (const collection of collections) {
    const description = collection.meta.get('description')
    if (typeof description !== 'string') continue
    for (const tag of collection.tags) describedBy.set(tag, description)
  }
  for (const name of [...used].sort()) {
    if (seen.has(name)) continue
    const description = describedBy.get(name)
    out.push(description === undefined ? { name } : { name, description })
  }
  return out
}

function defaultOperationId(route: RouteRecord): string {
  let out = route.method.toLowerCase()
  for (const segment of route.segments) {
    out += segment.kind === 'static' ? pascal(segment.value) : `By${pascal(segment.value)}`
  }
  return out
}

function pascal(raw: string): string {
  return raw
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * The schema a variant record declares for one media type.
 *
 * Keys are matched through `normaliseMediaType` rather than compared directly,
 * for the same reason the planner does it: `RouteRecord.negotiation.offers`
 * holds the normalised names, and a route that wrote `Application/JSON` would
 * otherwise be documented as having no schema at all — a silent hole in the
 * document produced by a difference in capitalisation.
 */
function variantSchema(variants: Record<string, unknown>, media: string): unknown {
  for (const raw of Object.keys(variants)) {
    const parsed = normaliseMediaType(raw)
    if (!isMediaProblem(parsed) && parsed.media === media) return variants[raw]
  }
  return undefined
}

function descriptionOf(json: JsonSchema): string | undefined {
  return typeof json.description === 'string' && json.description.length > 0 ? json.description : undefined
}

/** Sorted, because a document that reorders itself between runs cannot be diffed. */
function sortRecord(map: ReadonlyMap<string, Record<string, unknown>>): Record<string, PathItemObject> {
  const out: Record<string, PathItemObject> = {}
  for (const key of [...map.keys()].sort()) out[key] = map.get(key) as unknown as PathItemObject
  return out
}

function buildInfo(options: OpenApiOptions): Record<string, unknown> {
  const info: Record<string, unknown> = { title: options.title, version: options.version }
  if (options.summary !== undefined) info['summary'] = options.summary
  if (options.description !== undefined) info['description'] = options.description
  if (options.license !== undefined) info['license'] = options.license
  if (options.contact !== undefined) info['contact'] = options.contact
  return info
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 409: 'Conflict',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? `Status ${status}`
}

/**
 * The error envelope Zen actually produces — `ZenError#toProblem`, served as
 * `application/problem+json`. `debug` appears only when `dev` is on, which is
 * why it is optional and why `additionalProperties` is still `false`.
 */
const PROBLEM_DETAILS: JsonSchema = {
  type: 'object',
  title: 'ProblemDetails',
  description: 'RFC 9457 problem document. Every Zen error response has this shape.',
  properties: {
    type: { type: 'string', format: 'uri', description: 'Stable documentation URL for the error code.' },
    title: { type: 'string', description: 'Human-readable summary. Never leaks internals for non-exposed errors.' },
    status: { type: 'integer' },
    instance: { type: 'string', description: 'The request path this occurred on.' },
    code: { type: 'string', description: 'Stable Zen error code — rfcs/0001 Annex B.' },
    requestId: { type: 'string' },
    errors: {
      type: 'array',
      description: 'Present on validation failures: one entry per failing field, across every source that failed.',
      items: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['params', 'query', 'headers', 'cookies', 'body'],
            description: 'Which part of the request the issue is in.',
          },
          path: { type: 'array', items: { type: ['string', 'integer'] } },
          code: { type: 'string' },
          message: { type: 'string' },
          expected: { type: 'string' },
          received: { type: 'string' },
        },
        required: ['path', 'code', 'message'],
        additionalProperties: false,
      },
    },
    debug: { type: 'object', description: 'Development mode only — stack and cause.', additionalProperties: true },
  },
  required: ['type', 'title', 'status', 'instance', 'code', 'requestId'],
  additionalProperties: false,
}


/**
 * How a list parameter is spelled on the wire — §11.4 projected into §29.
 *
 * OpenAPI's default for a `query` parameter is `style: form, explode: true`,
 * which is the `repeat` spelling: `?tags=a&tags=b`. An application that has
 * asked for `comma` parses `?tags=a,b` instead, and a generated client working
 * from the default would send a request the server reads as one element named
 * `a,b`. So the one case that differs from the default is written down, and the
 * cases that agree with it are not — a document that restates every default is
 * a document nobody diffs.
 *
 * The value comes from `route.coercion`, which is the *same plan the coercer
 * was generated from*. That is the point rather than a convenience: this is the
 * §29.1 property applied to request parameters — the document cannot describe a
 * serialization the service does not parse, because there is one structure and
 * both read it.
 *
 * `header` needs nothing: `style: simple` is the OpenAPI default there and it
 * already means comma-separated, which is what §11.4 defaults headers to.
 */
function listStyle(
  location: ParameterLocation,
  plan: CoercePlan | undefined,
  name: string,
): Record<string, unknown> {
  if (plan === undefined || location !== 'query') return {}
  const field = plan.fields.find((f) => f.key === name)
  const op = field?.op
  if (op === undefined || op === null || op.kind !== 'array') return {}
  if (op.split !== ',') return {}
  return { style: 'form', explode: false }
}
