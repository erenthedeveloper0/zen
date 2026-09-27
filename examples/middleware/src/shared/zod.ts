import { z } from 'zod'
import { registerSchemaConverter } from '@erenthedeveloper0/zen'

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

export { z }
