import { z } from 'zod'
import { registerSchemaConverter } from '@erenthedeveloper0/zen'

/**
 * Teach Zen how to read Zod's shape — rfcs/0001 §11.1, §11.4, §13.3.
 *
 * The same four lines `examples/openapi` uses, and it is worth noticing that
 * they are the same. §11.4's coercion reads a request schema's shape through
 * exactly the mechanism §13.3's serializer reads a response schema's — so a
 * converter registered once serves the response filter, the OpenAPI document
 * and the query coercer, and none of the three can form a different opinion
 * about what the schema says.
 *
 * `io: 'input'` is what Zen passes for request sources, and it is not a detail:
 * `z.number().default(20)` is *optional on the way in* and guaranteed on the
 * way out. A coercion plan built from the output direction would be planning
 * against a shape the request never has.
 *
 * Zod v4 also exposes a `toJSONSchema()` method, so this file could be deleted
 * and coercion would still work — registration wins over the method, and is
 * preferred because it is an explicit act with the direction spelled out
 * (`compile/json-schema.ts` documents why that ordering was reversed once, and
 * what broke).
 */
registerSchemaConverter('zod', (schema, io) => z.toJSONSchema(schema as z.ZodType, { io }))

export { z }
