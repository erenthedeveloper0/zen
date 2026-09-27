import { Conflict, NotFound, token } from '@erenthedeveloper0/zen'
import type { Clock } from '../../shared/clock.ts'
import type { NewUserIn, PatchUserIn } from './schemas.ts'

/**
 * What the database actually stores.
 *
 * Five of these ten columns must never leave the process, and the handlers in
 * `routes.ts` return this row **unmodified**. The response schema is the only
 * thing standing between `passwordHash` and the socket — which is the point of
 * the whole example.
 */
export interface UserRow {
  readonly id: number
  readonly email: string
  readonly name: string
  readonly role: 'admin' | 'member'
  readonly createdAt: string
  readonly passwordHash: string
  readonly totpSecret: string
  readonly stripeCustomerId: string
  readonly internalNotes: string
  readonly deletedAt: string | null
}

export interface UserRepo {
  list(filter: { role?: 'admin' | 'member'; limit: number }): { rows: UserRow[]; total: number }
  find(id: number): UserRow | undefined
  create(input: NewUserIn & { role: 'admin' | 'member' }): UserRow
  patch(id: number, input: PatchUserIn): UserRow
  remove(id: number): void
}

export const UserRepoToken = token<UserRepo>('users.repo')

const SEEDED = ['Ada Lovelace', 'Grace Hopper', 'Karen Spärck Jones'] as const

export function inMemoryUserRepo(clock: Clock): UserRepo {
  let nextId = 1
  const rows = new Map<number, UserRow>()

  const row = (name: string, role: 'admin' | 'member'): UserRow => {
    const id = nextId++
    return {
      id,
      email: `${name.split(' ')[0]?.toLowerCase()}@example.com`,
      name,
      role,
      createdAt: clock.now().toISOString(),
      passwordHash: `$2b$12$seeded.hash.for.${name}`,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      stripeCustomerId: `cus_${id}xxxxxxxxxx`,
      internalNotes: 'do not surface to the customer',
      deletedAt: null,
    }
  }

  for (const [index, name] of SEEDED.entries()) {
    const seeded = row(name, index === 0 ? 'admin' : 'member')
    rows.set(seeded.id, seeded)
  }

  return {
    list({ role, limit }) {
      const all = [...rows.values()].filter((r) => role === undefined || r.role === role)
      return { rows: all.slice(0, limit), total: all.length }
    },
    find(id) {
      return rows.get(id)
    },
    create(input) {
      for (const existing of rows.values()) {
        if (existing.email === input.email) throw new Conflict(`${input.email} is already registered`)
      }
      const created = { ...row(input.name, input.role), email: input.email }
      rows.set(created.id, created)
      return created
    },
    patch(id, input) {
      const existing = rows.get(id)
      if (existing === undefined) throw new NotFound(`User ${id} not found`)
      const updated: UserRow = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
      }
      rows.set(id, updated)
      return updated
    },
    remove(id) {
      if (!rows.delete(id)) throw new NotFound(`User ${id} not found`)
    },
  }
}
