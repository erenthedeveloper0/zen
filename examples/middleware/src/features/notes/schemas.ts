import { z } from '../../shared/zod.ts'

export const Note = z.object({
  id: z.number().int(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
})

export const NewNote = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(10_000),
})

export const NoteList = z.object({
  items: z.array(Note),
  total: z.number().int(),
})

export const NoteId = z.object({ id: z.number().int() })

export const Page = z.object({
  page: z.number().int().min(1).default(1),
  perPage: z.number().int().min(1).max(50).default(10),
})
