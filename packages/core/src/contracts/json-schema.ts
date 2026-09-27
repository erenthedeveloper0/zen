/**
 * JSON Schema — the serializer's input language (rfcs/0001 §13.3).
 *
 * Standard Schema deliberately exposes only `validate`; it says nothing about a
 * schema's *shape*. But a serializer that emits only declared fields — the
 * security property this whole subsystem exists for — needs the shape, not the
 * validator. JSON Schema is the one shape language every relevant library can
 * already produce, and it is what §29's OpenAPI emitter will need anyway, so it
 * earns its place as the IR rather than a bespoke Zen format.
 *
 * Mirrored here rather than depended upon: `@visionpilot/zen-core` stays at zero runtime
 * dependencies, and the subset below is Draft 2020-12 plus the two OpenAPI 3.0
 * spellings (`nullable`, `definitions`) that real toolchains still emit.
 *
 * Keywords that constrain *validity* but not *shape* — `minLength`, `pattern`,
 * `not`, `if`/`then`, `multipleOf` — are intentionally ignored. Serialization is
 * not validation: the response has already been produced by the handler, and
 * re-validating it on the way out would be a second, slower validator with no
 * new authority. Only keywords that change which bytes are emitted are honoured,
 * and any such keyword Zen cannot honour becomes a boot diagnostic rather than a
 * silent difference.
 */

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export interface JsonSchema {
  readonly $ref?: string | undefined
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>> | undefined
  /** Draft-07 / OpenAPI 3.0 spelling of `$defs`. Still emitted by real tools. */
  readonly definitions?: Readonly<Record<string, JsonSchemaNode>> | undefined

  readonly type?: JsonType | readonly JsonType[] | undefined
  readonly enum?: readonly unknown[] | undefined
  readonly const?: unknown

  readonly properties?: Readonly<Record<string, JsonSchemaNode>> | undefined
  readonly required?: readonly string[] | undefined
  readonly additionalProperties?: JsonSchemaNode | undefined
  readonly patternProperties?: Readonly<Record<string, JsonSchemaNode>> | undefined
  readonly unevaluatedProperties?: JsonSchemaNode | undefined

  readonly items?: JsonSchemaNode | undefined
  readonly prefixItems?: readonly JsonSchemaNode[] | undefined

  readonly anyOf?: readonly JsonSchemaNode[] | undefined
  readonly oneOf?: readonly JsonSchemaNode[] | undefined
  readonly allOf?: readonly JsonSchemaNode[] | undefined

  readonly format?: string | undefined
  /** OpenAPI 3.0's nullable. 3.1 uses `type: [..., 'null']`; both are accepted. */
  readonly nullable?: boolean | undefined
  readonly discriminator?: { readonly propertyName: string } | undefined

  readonly title?: string | undefined
  readonly description?: string | undefined

  readonly [keyword: string]: unknown
}

/**
 * `true`/`false` are legal schemas in Draft 2020-12 ("anything" / "nothing"),
 * and libraries do emit them for `z.unknown()` and `z.never()`.
 *
 * This is used *everywhere a subschema appears* — `properties`, `$defs`,
 * `items`, `anyOf` — because that is what the dialect says, and because a
 * narrower type would force every converter a user writes to cast. The runtime
 * already handled booleans in all of these positions; for a while the type did
 * not, which is the sort of gap that only shows up when a real schema library
 * is plugged in.
 */
export type JsonSchemaNode = JsonSchema | boolean

/**
 * How a schema library hands Zen its JSON Schema.
 *
 * Three conventions exist in the wild and core probes all of them rather than
 * picking a winner: ArkType exposes `toJsonSchema()`, some libraries spell it
 * `toJSONSchema()`, and Zod/Valibot expose a *free function* instead — which is
 * what `registerSchemaConverter` is for. Core knows the names, never the
 * libraries.
 */
export interface JsonSchemaBearer {
  toJsonSchema?: ((options?: { io?: SchemaIo }) => JsonSchemaSource) | undefined
  toJSONSchema?: ((options?: { io?: SchemaIo }) => JsonSchemaSource) | undefined
}

/**
 * Which side of the schema is being described.
 *
 * Not a detail. `z.enum([...]).default('member')` is **optional on input** and
 * **guaranteed on output**, so a document generated in the wrong direction tells
 * client authors a field is required when it is not — or that it may be absent
 * when it never is. Requests are described as `input`, responses as `output`.
 */
export type SchemaIo = 'input' | 'output'

/**
 * What a converter is allowed to hand back.
 *
 * Deliberately loose. `JsonSchema` above is Zen's *reading* model of the
 * dialect: the keywords it understands, typed the way it wants to consume them.
 * Every library models JSON Schema slightly differently — Zod's `JSONSchema`,
 * TypeBox's `TSchema` and a hand-written literal all describe the same documents
 * with structurally incompatible types — and demanding that a converter's return
 * type match Zen's exactly would put a cast in every user's four-line
 * integration.
 *
 * So the cast lives in `toJsonSchema` instead, once, and it is safe because of a
 * property that is checked rather than assumed: **every reader of a converted
 * schema probes before it trusts.** `serializer-ir.ts` asks `typeof schema.$ref
 * === 'string'`, `Array.isArray(schema.enum)`, `typeof schema !== 'object'` at
 * each step, so a document with an unexpected keyword or shape produces a boot
 * diagnostic, never a crash.
 */
export type JsonSchemaSource = { readonly [keyword: string]: unknown }

/** Converts a vendor's schema object into JSON Schema. Registered by userland. */
export type SchemaConverter = (schema: object, io: SchemaIo) => JsonSchemaSource | null
