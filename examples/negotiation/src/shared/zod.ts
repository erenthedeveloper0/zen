import { z } from 'zod'
import { registerSchemaConverter, registerIssueMapper, type IssueCode } from '@erenthedeveloper0/zen'

/**
 * Teach Zen how to read Zod's shape — rfcs/0001 §11.1, §13.3, §13.4.
 *
 * The same four lines `examples/openapi`, `examples/coercion`,
 * `examples/config` and `examples/middleware` use. This is now the *fifth*
 * consumer of one conversion, and §13.4 added a sixth reader of it inside this
 * example: a media encoder is handed the same JSON Schema the response
 * serializer compiles from, so the CSV columns and the JSON fields are derived
 * from one declaration and cannot disagree about what a report contains.
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
