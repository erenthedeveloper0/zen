import type { ParamType } from '@visionpilot/zen-core'

/**
 * Built-in path parameter types — rfcs/0001 §5.2.
 *
 * A param type contributes three things from one declaration: a matcher
 * predicate compiled into the trie (so `/users/abc` cleanly 404s instead of
 * reaching your handler with garbage), a parse function, and a JSON Schema
 * fragment for OpenAPI. One declaration, three consumers — I4.
 */

const INT = /^-?\d+$/
const FLOAT = /^-?\d+(\.\d+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEX = /^[0-9a-f]+$/i

// Every pattern above is linear-time: no nested quantifiers, no backtracking
// blowup. `eslint-plugin-zen/no-unbounded-regex` enforces that in CI (§19.3).

/**
 * §11.4.1's precision rule, applied to the path: `/orders/9007199254740993` is
 * an ordinary Postgres `bigint`, and `Number()` turns it into `…992` — the
 * request then acts on the wrong row. Sixteen digits used to pass the length
 * check and round silently. A value that does not survive the round trip does
 * not match, so the route 404s instead of answering for a different id; a
 * route that genuinely takes 64-bit ids declares an untyped `:id` and parses
 * it as a `BigInt` itself.
 */
export const intType: ParamType<number> = {
  name: 'int',
  test: (s) => s.length > 0 && s.length <= 17 && INT.test(s) && Number.isSafeInteger(Number(s)),
  parse: (s) => Number(s),
  jsonSchema: { type: 'integer' },
}

export const floatType: ParamType<number> = {
  name: 'float',
  test: (s) => s.length > 0 && s.length <= 32 && FLOAT.test(s),
  parse: (s) => Number(s),
  jsonSchema: { type: 'number' },
}

export const uuidType: ParamType<string> = {
  name: 'uuid',
  test: (s) => s.length === 36 && UUID.test(s),
  parse: (s) => s,
  jsonSchema: { type: 'string', format: 'uuid' },
}

export const ulidType: ParamType<string> = {
  name: 'ulid',
  test: (s) => s.length === 26 && ULID.test(s),
  parse: (s) => s,
  jsonSchema: { type: 'string', pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' },
}

export const dateType: ParamType<Date> = {
  name: 'date',
  test: (s) => s.length >= 10 && s.length <= 30 && !Number.isNaN(Date.parse(s)),
  parse: (s) => new Date(s),
  jsonSchema: { type: 'string', format: 'date-time' },
}

export const slugType: ParamType<string> = {
  name: 'slug',
  test: (s) => s.length > 0 && s.length <= 200 && SLUG.test(s),
  parse: (s) => s,
  jsonSchema: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
}

export const hexType: ParamType<string> = {
  name: 'hex',
  test: (s) => s.length > 0 && s.length <= 256 && HEX.test(s),
  parse: (s) => s,
  jsonSchema: { type: 'string', pattern: '^[0-9a-fA-F]+$' },
}

export const BUILTIN_PARAM_TYPES: ReadonlyMap<string, ParamType> = new Map<string, ParamType>([
  ['int', intType as ParamType],
  ['float', floatType as ParamType],
  ['uuid', uuidType as ParamType],
  ['ulid', ulidType as ParamType],
  ['date', dateType as ParamType],
  ['slug', slugType as ParamType],
  ['hex', hexType as ParamType],
])
