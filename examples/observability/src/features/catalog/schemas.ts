import { z } from 'zod'
import { jsonSchema } from 'zen'

/**
 * Request schemas are Standard Schema (Zod here); response schemas are plain
 * JSON Schema.
 *
 * Two different jobs. A request schema *validates and coerces* — that is real
 * work, and it is the work the `preValidation`/`postValidation` bracket exists
 * to measure. A response schema is a *contract*: it compiles to a serializer
 * that emits exactly the declared fields and nothing else (§13.3), so it needs
 * a shape, not a validator. `examples/openapi` shows the Zod-for-both route
 * when a document is also wanted.
 */

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  tag: z.string().min(1).max(40).optional(),
})

export interface Product {
  readonly id: number
  readonly name: string
  readonly priceCents: number
  readonly tags: readonly string[]
}

export const ProductView = jsonSchema<Product>({
  title: 'Product',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    priceCents: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name', 'priceCents', 'tags'],
})

export const ProductList = jsonSchema<{ items: readonly Product[]; total: number }>({
  title: 'ProductList',
  type: 'object',
  properties: {
    items: { type: 'array', items: { $ref: '#/$defs/Product' } },
    total: { type: 'integer' },
  },
  required: ['items', 'total'],
  $defs: {
    Product: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        priceCents: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name', 'priceCents', 'tags'],
    },
  },
})
