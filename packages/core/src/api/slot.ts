import type { Slot, SlotOptions } from '../contracts/slot.ts'
import { declareSlot } from '../registry/slot-registry.ts'

/**
 * Declare a typed per-request cell — rfcs/0001 §7.4.
 *
 *     export const CurrentUser = slot<User>('auth.user')
 *     app.use(async ctx => { ctx.set(CurrentUser, await authenticate(ctx)) })
 *     app.get('/me', ctx => ctx.get(CurrentUser))
 *
 * No globals mutated, no module augmented, and the read site is typed without
 * an optional. `ctx.get(s)` compiles to `this.$s[3]`.
 *
 * Redeclaring a name returns the existing slot, so a function that builds an
 * application can be called as many times as it likes. Declaring it again with
 * *different* options is still a conflict, because those two declarations
 * cannot both be right. The cell table itself is the Slot Registry's
 * (`registry/slot-registry.ts`, §3.2).
 */
export function slot<T>(name: string, opts: SlotOptions<T> = {}): Slot<T> {
  return declareSlot<T>(name, opts)
}
