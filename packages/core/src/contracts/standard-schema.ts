/**
 * The Standard Schema v1 interface — rfcs/0001 §11.1.
 *
 * Zen's core depends on this and on nothing else for validation. Zod (>=3.24),
 * Valibot (>=1), ArkType (>=2) and Effect Schema implement it natively, so the
 * user's schema library never enters Zen's dependency tree and adding a new one
 * is a userland act rather than a framework release.
 *
 * Mirrored here (rather than depended upon) so that `@zenjs/core` keeps its
 * zero-runtime-dependency guarantee. The shape is spec-defined and stable.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaProps<Input, Output>
}

export interface StandardSchemaProps<Input, Output> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
  readonly types?: StandardTypes<Input, Output> | undefined
}

export interface StandardTypes<Input, Output> {
  readonly input: Input
  readonly output: Output
}

export type StandardResult<Output> = StandardSuccess<Output> | StandardFailure

export interface StandardSuccess<Output> {
  readonly value: Output
  readonly issues?: undefined
}

export interface StandardFailure {
  readonly issues: ReadonlyArray<StandardIssue>
}

export interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined
}

export interface StandardPathSegment {
  readonly key: PropertyKey
}

/** Any schema Zen can consume. */
export type AnySchema = StandardSchemaV1<unknown, unknown>

export type InferOutput<S> =
  S extends StandardSchemaV1<unknown, infer O> ? O : unknown

export type InferInput<S> =
  S extends StandardSchemaV1<infer I, unknown> ? I : unknown

/** Narrow a value to a Standard Schema at runtime without importing any library. */
export function isStandardSchema(value: unknown): value is AnySchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~standard' in value &&
    typeof (value as AnySchema)['~standard'] === 'object'
  )
}
