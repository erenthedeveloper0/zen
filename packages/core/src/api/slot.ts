import type { Slot, SlotOptions } from '../contracts/slot.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

let nextIndex = 0
const declared: Slot<unknown>[] = []
const cells = new Map<string, { index: number; kind: 'slot' | 'service' }>()

/**
 * Allocate one cell in the per-request slot array.
 *
 * Shared by `slot()` and by request-scoped DI tokens (§15.3), so a scoped
 * service resolves to `ctx.$s[i] ?? (ctx.$s[i] = create())` — an array read,
 * not a map lookup, and no per-request container object is allocated.
 *
 * **A name is the identity of a cell, so redeclaring one returns it.** The
 * first version of this function threw instead, which made building the same
 * application twice in one process impossible — and that is not an exotic
 * case, it is `inject()`-per-test, serverless warm reuse, and any process
 * hosting two apps. A plugin's `setup` runs once per application and declares
 * its slots each time; refusing the second one made the plugin system unusable
 * from a test file.
 *
 * The hazard this replaced — two unrelated declarations colliding on one name —
 * is handled where it can be handled: plugin slots are namespaced by plugin
 * automatically, `kind` mismatches still conflict, and incompatible options on
 * the same name still conflict. Two libraries that both declare a bare `"user"`
 * slot with identical options will share a cell, which is why the name is
 * documented as process-global and why the convention is `owner.thing`.
 */
export function allocateCell(name: string, kind: 'slot' | 'service'): number {
  const existing = cells.get(name)
  if (existing === undefined) {
    cells.set(name, { index: nextIndex, kind })
    return nextIndex++
  }

  if (existing.kind !== kind) {
    throw new ZenError(
      Codes.SLOT_CONFLICT,
      `"${name}" is already declared as a ${existing.kind === 'slot' ? 'slot' : 'service token'} ` +
        `and cannot also be a ${kind === 'slot' ? 'slot' : 'service token'}. ` +
        `Names are process-global; namespace yours (e.g. "billing.invoice").`,
      { status: 500, expose: false },
    )
  }

  return existing.index
}

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
 * Redeclaring a name returns the existing slot (see `allocateCell`), so a
 * function that builds an application can be called as many times as it likes.
 * Declaring it again with *different* options is still a conflict, because
 * those two declarations cannot both be right.
 */
export function slot<T>(name: string, opts: SlotOptions<T> = {}): Slot<T> {
  const existing = declared.find((candidate) => candidate.name === name)
  if (existing !== undefined) {
    const optional = opts.optional ?? false
    if (optional !== existing.optional || (opts.dispose !== undefined) !== (existing.dispose !== undefined)) {
      throw new ZenError(
        Codes.SLOT_CONFLICT,
        `Slot "${name}" is already declared with different options ` +
          `(optional: ${existing.optional}, dispose: ${existing.dispose !== undefined}). ` +
          `Names are process-global; namespace yours (e.g. "billing.invoice").`,
        { status: 500, expose: false },
      )
    }
    return existing as unknown as Slot<T>
  }

  const created: Slot<T> = {
    name,
    index: allocateCell(name, 'slot'),
    optional: opts.optional ?? false,
    defaultValue: opts.default,
    dispose: opts.dispose,
  }
  declared.push(created as unknown as Slot<unknown>)
  return created
}

/** How many cells the generated context must allocate. */
export function slotCount(): number {
  return nextIndex
}

export function declaredSlots(): readonly Slot<unknown>[] {
  return declared
}

/** Test-only: reset the process-global cell table between isolated suites. */
export function __resetSlots(): void {
  nextIndex = 0
  declared.length = 0
  cells.clear()
}
