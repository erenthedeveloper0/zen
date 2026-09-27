import { token, Conflict, NotFound } from '@visionpilot/zen'
import type { NewUserInput, PatchUserInput, UserRow } from './domain.ts'

/**
 * Services and the container — rfcs/0001 §15.
 *
 * Three things worth noticing, because they are the whole argument for Zen's DI
 * being different from the usual one:
 *
 *   1. **Tokens are values, not classes.** `UserRepo` is an interface; there is
 *      no runtime artefact standing in for it. No decorators, no
 *      `reflect-metadata`, and it survives `isolatedModules` and tree-shaking.
 *   2. **Dependencies are declared, not reflected.** `deps: [Clock]` is what
 *      makes boot-time cycle and captive-dependency analysis possible at all.
 *   3. **It is optional.** Half of this example could have used module-scoped
 *      singletons and been fine. The container earns its place here because
 *      `RequestAudit` is genuinely per-request.
 */

// ─── contracts ───────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date
}

export interface UserRepo {
  list(filter: { role?: 'admin' | 'member'; limit: number }): UserRow[]
  find(id: number): UserRow | undefined
  create(input: NewUserInput): UserRow
  patch(id: number, input: PatchUserInput): UserRow
  remove(id: number): void
}

/** One per request. Resolving it twice in a request returns the same object. */
export interface RequestAudit {
  readonly startedAt: number
  record(action: string): void
  readonly trail: readonly string[]
}

export const ClockToken = token<Clock>('app.clock')
export const UserRepoToken = token<UserRepo>('app.userRepo')
export const AuditToken = token<RequestAudit>('app.audit')

// ─── implementations ─────────────────────────────────────────────────────────

export function systemClock(): Clock {
  return { now: () => new Date() }
}

/**
 * An in-memory store standing in for a database. Rows carry the columns a real
 * `SELECT *` would carry, including the ones that must not ship — that is the
 * point of the example, not an oversight.
 */
export function inMemoryUserRepo(clock: Clock): UserRepo {
  let sequence = 0
  const rows = new Map<number, UserRow>()

  /**
   * Seeded rows carry a fixed timestamp rather than `clock.now()`.
   *
   * A fixture whose contents depend on when it was built cannot be compared
   * across two instances of the application — which is exactly what the
   * compiled-vs-interpreted test in `test/api.test.ts` does.
   */
  const SEEDED_AT = '2024-03-01T12:00:00.000Z'

  const seed = (email: string, name: string, role: 'admin' | 'member'): void => {
    const id = ++sequence
    rows.set(id, {
      id,
      email,
      name,
      role,
      createdAt: SEEDED_AT,
      passwordHash: `$2b$12$seeded.hash.for.${name}`,
      totpSecret: role === 'admin' ? 'JBSWY3DPEHPK3PXP' : null,
      stripeCustomerId: `cus_${id}${'x'.repeat(10)}`,
      internalNotes: role === 'admin' ? 'founder account — do not suspend' : 'flagged by fraud review',
      deletedAt: null,
    })
  }

  seed('ada@example.com', 'Ada Lovelace', 'admin')
  seed('grace@example.com', 'Grace Hopper', 'member')
  seed('katherine@example.com', 'Katherine Johnson', 'member')

  return {
    list({ role, limit }) {
      const all = [...rows.values()].filter((row) => row.deletedAt === null)
      return (role === undefined ? all : all.filter((row) => row.role === role)).slice(0, limit)
    },

    find(id) {
      const row = rows.get(id)
      return row === undefined || row.deletedAt !== null ? undefined : row
    },

    create(input) {
      for (const row of rows.values()) {
        if (row.email === input.email) throw new Conflict(`A user with email ${input.email} already exists`)
      }
      const id = ++sequence
      const row: UserRow = {
        id,
        email: input.email,
        name: input.name,
        role: input.role ?? 'member',
        createdAt: clock.now().toISOString(),
        passwordHash: `$2b$12$pretend.this.is.bcrypt.${input.password.length}`,
        totpSecret: null,
        stripeCustomerId: `cus_${id}${'y'.repeat(10)}`,
        internalNotes: '',
        deletedAt: null,
      }
      rows.set(id, row)
      return row
    },

    patch(id, input) {
      const row = this.find(id)
      if (row === undefined) throw new NotFound(`User ${id} not found`)
      const updated: UserRow = {
        ...row,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
      }
      rows.set(id, updated)
      return updated
    },

    remove(id) {
      const row = this.find(id)
      if (row === undefined) throw new NotFound(`User ${id} not found`)
      rows.set(id, { ...row, deletedAt: clock.now().toISOString() })
    },
  }
}

export function requestAudit(): RequestAudit {
  const trail: string[] = []
  return {
    startedAt: performance.now(),
    record(action) { trail.push(action) },
    get trail() { return trail },
  }
}
