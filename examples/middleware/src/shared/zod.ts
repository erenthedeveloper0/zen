import { z } from 'zod'
import { registerSchemaConverter, registerIssueMapper, type IssueCode } from '@erenthedeveloper0/zen'

/**
 * Teach Zen how to read Zod's shape — rfcs/0001 §11.1, §13.3, §16.2.
 *
 * The same four lines `examples/openapi`, `examples/coercion` and
 * `examples/config` use. This is the fourth consumer of one conversion, which
 * is the point: the coercion plan, the response filter, the OpenAPI document
 * and §16.2's `expected:` line all read it, so none of them can form a
 * different opinion about what a schema says.
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
