import { z } from 'zod'
import { registerSchemaConverter, registerIssueMapper, type IssueCode } from '@erenthedeveloper0/zen'

/**
 * Teach Zen how to read Zod's shape — rfcs/0001 §11.1, §13.3, §16.2.
 *
 * The same four lines `examples/openapi` and `examples/coercion` use, and this
 * example is the third consumer of the *same* probe. That is the point worth
 * noticing: §16.2's `expected: integer, between 1 and 100` line, §11.4's
 * coercion plan, §13.3's response filter and §29's OpenAPI document all read
 * one conversion, so none of the four can form a different opinion about what a
 * schema says — and registering a converter once serves all of them.
 *
 * Config adds a fifth reader of the same structure, and a new keyword:
 * `format: 'password'` in the emitted JSON Schema is what marks an environment
 * variable as a secret. A schema library with no converter still validates
 * perfectly here; what it loses is the constraint in the error message and the
 * ability to mark a secret, and Zen says so once at boot rather than silently.
 */
registerSchemaConverter('zod', (schema, io) => z.toJSONSchema(schema as z.ZodType, { io }))

/**
 * Issue codes from Zod's own `code`, not from its message — rfcs/0001 §11.2.
 * The message is in whatever language `z.config()` chose; the code is not. A
 * missing value is `required` before this is asked, because Zen reads that from
 * the request, so this maps the rest — and anything it does not name is
 * `invalid`, never a guess from the text.
 */
const ZOD_CODES = new Map<unknown, IssueCode>([
  ['invalid_type', 'type'], ['too_small', 'min'], ['too_big', 'max'],
  ['invalid_format', 'format'], ['custom', 'custom'],
])
registerIssueMapper('zod', (issue) => ZOD_CODES.get(issue['code']) ?? 'invalid')

export { z }
