/**
 * `@zenjs/openapi` — `AppGraph → OpenAPI 3.1`, plus breaking-change detection.
 *
 * rfcs/0001 §29. Depends on `@zenjs/core` and nothing else — in particular not
 * on the router, which is why param-type schemas arrive through the frozen
 * graph rather than through a second copy of the built-in table (§24.3).
 */

export { openapiDocument, pathVariants, type OpenApiOptions, type OpenApiResult, type PathVariant } from './document.ts'
export { openapiPlugin, type OpenApiPluginOptions } from './plugin.ts'
export { renderReference } from './ui.ts'
export {
  diffDocuments, type ApiChange, type ChangeKind, type DiffResult,
} from './diff.ts'
export {
  Components, canonical, declaredName, isObjectShape, projectSchema, sanitizeName,
  type DocDiagnostic, type ProjectOptions,
} from './schema.ts'
export type * from './types.ts'
export { DOC_META_KEYS } from './types.ts'
