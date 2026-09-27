import type { JsonSchema } from '@erenthedeveloper0/zen-core'

/**
 * OpenAPI 3.1 document types — rfcs/0001 §29.
 *
 * 3.1 rather than 3.0 for one reason that matters here: 3.1's Schema Object *is*
 * JSON Schema 2020-12, the same dialect the validation layer produces and the
 * serializer IR consumes. Under 3.0 every schema would need lossy
 * down-conversion (`nullable`, `exclusiveMinimum`, tuples, `const`) — which is
 * precisely the silent drift this subsystem exists to prevent.
 *
 * Only the parts Zen emits are typed. A partial-but-honest type is more useful
 * than a complete one nobody reads, and `[extension: string]` keeps `x-` fields
 * legal without pretending to enumerate them.
 */

/** OAS 3.1 Schema Objects are JSON Schema 2020-12, so this is not an alias of convenience. */
export type OpenApiSchema = JsonSchema

export interface OpenApiDocument {
  readonly openapi: string
  readonly info: InfoObject
  readonly servers?: readonly ServerObject[] | undefined
  readonly paths: Readonly<Record<string, PathItemObject>>
  readonly components?: ComponentsObject | undefined
  readonly tags?: readonly TagObject[] | undefined
  readonly security?: readonly SecurityRequirement[] | undefined
  readonly externalDocs?: ExternalDocs | undefined
  readonly [extension: string]: unknown
}

export interface InfoObject {
  readonly title: string
  readonly version: string
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly license?: { readonly name: string; readonly identifier?: string; readonly url?: string } | undefined
  readonly contact?: { readonly name?: string; readonly url?: string; readonly email?: string } | undefined
}

export interface ServerObject {
  readonly url: string
  readonly description?: string | undefined
  readonly variables?: Readonly<Record<string, { readonly default: string; readonly enum?: readonly string[]; readonly description?: string }>> | undefined
}

export interface TagObject {
  readonly name: string
  readonly description?: string | undefined
  readonly externalDocs?: ExternalDocs | undefined
}

export interface ExternalDocs {
  readonly url: string
  readonly description?: string | undefined
}

export type HttpOperation = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'

export type PathItemObject = {
  readonly [M in HttpOperation]?: OperationObject
} & {
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly parameters?: readonly ParameterObject[] | undefined
}

export interface OperationObject {
  readonly operationId: string
  readonly summary?: string | undefined
  readonly description?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly deprecated?: boolean | undefined
  readonly parameters?: readonly ParameterObject[] | undefined
  readonly requestBody?: RequestBodyObject | undefined
  readonly responses: Readonly<Record<string, ResponseObject>>
  readonly security?: readonly SecurityRequirement[] | undefined
  readonly externalDocs?: ExternalDocs | undefined
  readonly [extension: string]: unknown
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie'

export interface ParameterObject {
  readonly name: string
  readonly in: ParameterLocation
  readonly required?: boolean | undefined
  readonly description?: string | undefined
  readonly deprecated?: boolean | undefined
  readonly schema: OpenApiSchema
  readonly [extension: string]: unknown
}

export interface RequestBodyObject {
  readonly required?: boolean | undefined
  readonly description?: string | undefined
  readonly content: Readonly<Record<string, MediaTypeObject>>
}

export interface ResponseObject {
  readonly description: string
  readonly content?: Readonly<Record<string, MediaTypeObject>> | undefined
  readonly headers?: Readonly<Record<string, HeaderObject>> | undefined
}

export interface HeaderObject {
  readonly description?: string | undefined
  readonly required?: boolean | undefined
  readonly schema: OpenApiSchema
}

export interface MediaTypeObject {
  readonly schema: OpenApiSchema
  readonly example?: unknown
}

export interface ComponentsObject {
  readonly schemas?: Readonly<Record<string, OpenApiSchema>> | undefined
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>> | undefined
}

export type SecurityRequirement = Readonly<Record<string, readonly string[]>>

export interface SecurityScheme {
  readonly type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS'
  readonly description?: string | undefined
  readonly name?: string | undefined
  readonly in?: 'query' | 'header' | 'cookie' | undefined
  readonly scheme?: string | undefined
  readonly bearerFormat?: string | undefined
  readonly openIdConnectUrl?: string | undefined
  readonly flows?: Readonly<Record<string, unknown>> | undefined
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route metadata this generator reads — rfcs/0001 §5.1.
 *
 * `meta` is a free-form map on purpose, but a generator that reads undocumented
 * keys is a generator nobody can predict. These are the keys, and they are the
 * whole list:
 *
 * ```ts
 * app.get('/users/:id<int>', {
 *   name: 'users.show',
 *   meta: { summary: 'Fetch one user', tags: ['users'], deprecated: true },
 *   response: { 200: PublicUser },
 * }, handler)
 * ```
 */
export interface RouteDocMeta {
  readonly summary?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly operationId?: string
  readonly deprecated?: boolean
  /** Excluded from the document entirely. The docs endpoints set this on themselves. */
  readonly hidden?: boolean
  readonly security?: readonly SecurityRequirement[]
  readonly externalDocs?: ExternalDocs
}

export const DOC_META_KEYS = [
  'summary', 'description', 'tags', 'operationId', 'deprecated', 'hidden', 'security', 'externalDocs',
] as const satisfies readonly (keyof RouteDocMeta)[]
