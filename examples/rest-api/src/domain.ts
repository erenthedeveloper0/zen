import * as s from './schema.ts'

/**
 * The domain, declared once.
 *
 * `UserRow` is what the database hands back: the public columns *and* the ones
 * that must never leave the process. This example is built around that gap on
 * purpose — it is the situation every real API is in, and the reason §13.3
 * exists. The handler below returns the row unmodified; `PublicUser` is what
 * reaches the client.
 */
export interface UserRow {
  readonly id: number
  readonly email: string
  readonly name: string
  readonly role: 'admin' | 'member'
  readonly createdAt: string

  // ── never leaves the process ───────────────────────────────────────────────
  readonly passwordHash: string
  readonly totpSecret: string | null
  readonly stripeCustomerId: string
  readonly internalNotes: string
  readonly deletedAt: string | null
}

// ─── response contracts ──────────────────────────────────────────────────────

/**
 * The five fields a client may see. Not a convention, not a `pick()` the
 * handler has to remember — the compiled serializer has no way to emit
 * anything else. `node scripts/show-serializer.ts` prints the function.
 */
export const PublicUser = s.object({
  id: s.int(),
  email: s.email(),
  name: s.string(),
  role: s.enumOf('admin', 'member'),
  createdAt: s.isoDate(),
})

export const UserList = s.object({
  users: s.array(PublicUser),
  total: s.int(),
})

export const Created = s.object({
  id: s.int(),
  createdAt: s.isoDate(),
})

// ─── request contracts ───────────────────────────────────────────────────────

export const NewUser = s.object({
  email: s.email(),
  name: s.string({ min: 1, max: 80 }),
  password: s.string({ min: 8 }),
  role: s.optional(s.enumOf('admin', 'member')),
})

export const PatchUser = s.object({
  name: s.optional(s.string({ min: 1, max: 80 })),
  role: s.optional(s.enumOf('admin', 'member')),
})

export const ListQuery = s.object({
  limit: s.optional(s.string()),
  role: s.optional(s.enumOf('admin', 'member')),
})

export type NewUserInput = s.Infer<typeof NewUser>
export type PatchUserInput = s.Infer<typeof PatchUser>
