import { z } from 'zod'
import { jsonSchema } from '@visionpilot/zen'

/**
 * Request schemas validate; response schemas are contracts (§13.3).
 *
 * The response shape here is deliberate: `missed` and `partial` are *declared*,
 * so a degraded answer is part of the API rather than an undocumented surprise.
 * A client can branch on `partial` instead of discovering that `quotes` is
 * sometimes shorter than it expected.
 */

export const QuoteQuery = z.object({
  providers: z
    .string()
    .default('fast,steady,slow')
    .transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['fast', 'steady', 'slow'])).min(1).max(3)),
})

export interface QuoteEnvelope {
  readonly quotes: readonly { provider: string; priceCents: number; latencyMs: number }[]
  readonly missed: readonly string[]
  readonly partial: boolean
  readonly budgetMs: number
}

export const QuoteEnvelopeView = jsonSchema<QuoteEnvelope>({
  title: 'QuoteEnvelope',
  type: 'object',
  properties: {
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          priceCents: { type: 'integer' },
          latencyMs: { type: 'integer' },
        },
        required: ['provider', 'priceCents', 'latencyMs'],
      },
    },
    missed: { type: 'array', items: { type: 'string' } },
    partial: { type: 'boolean' },
    budgetMs: { type: 'integer' },
  },
  required: ['quotes', 'missed', 'partial', 'budgetMs'],
})
