import { z } from 'zod'
import { registerSchemaConverter, registerIssueMapper, type IssueCode } from '@erenthedeveloper0/zen'

/**
 * Teach Zen how to read Zod's shape — rfcs/0001 §11.1, §13.3.
 *
 * This is the whole integration. Four lines, in application code, and neither
 * `@erenthedeveloper0/zen-core` nor `@erenthedeveloper0/zen-openapi` has ever heard of Zod: they ask a Standard
 * Schema for `~standard.vendor` and look up a converter that userland
 * registered. Swapping to Valibot or ArkType changes this file and nothing else.
 *
 * Two details that are not incidental:
 *
 *   - **`io` matters.** `z.enum([...]).default('member')` is optional on input
 *     and guaranteed on output, so the request body and the response are
 *     genuinely different documents. Zen passes the direction; ignoring it would
 *     mark `role` required in a POST body that does not require it.
 *
 *   - **`unrepresentable` is left at its default (`'throw'`) on purpose.** Zod
 *     throws for constructs with no JSON Schema equivalent — `z.transform`,
 *     `z.custom`, `z.instanceof`. Zen catches that and reports an honest boot
 *     warning. Setting `'any'` would instead hand back `{}`, which the
 *     serializer reads as *"anything may be emitted"* — turning a documentation
 *     gap into a silently disabled response filter (§13.3). Loud beats tidy.
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
