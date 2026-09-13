import { z } from '../zod.ts'

/**
 * Shared schemas live in `shared/`, features import them — §23.4.
 *
 * `.meta({ id })` is what makes this one component in the generated document
 * instead of an inline copy per operation. The generator will *work* without it
 * (structural deduplication catches repeats), but it emits an `info` diagnostic
 * asking for a name, because a generated client's type name should not change
 * when an unrelated endpoint is added.
 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).meta({ description: 'Page size, 1–100.' }),
  cursor: z.string().optional().meta({ description: 'Opaque cursor from a previous page.' }),
})

export const PageInfo = z.object({
  total: z.int().meta({ description: 'Total matching records, ignoring pagination.' }),
  cursor: z.string().nullable().meta({ description: 'Pass as `cursor` to fetch the next page.' }),
}).meta({ id: 'PageInfo', description: 'Cursor pagination envelope.' })
