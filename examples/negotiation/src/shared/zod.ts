import { z } from 'zod'
import { registerSchemaConverter } from '@visionpilot/zen'

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

export { z }
