/**
 * Slots — rfcs/0001 §7.4. The replacement for `req.user = x`.
 *
 * A slot is a declared, typed, integer-indexed cell of per-request state.
 * `ctx.get(s)` compiles to `this.$s[3]`: monomorphic array access, no hashing,
 * no string keys, no global type augmentation, and no hidden-class churn.
 *
 * Indices are assigned by a process-wide monotonic counter at declaration time
 * rather than per-app, so a slot declared at module scope has one stable index
 * across every app in the process. The cost is a slot array sized to the number
 * of *declared* slots rather than the number used by a given app — a handful of
 * array elements, in exchange for O(1) access with no per-app indirection.
 */
export interface Slot<T> {
  readonly name: string
  /** Dense index into the context's slot array. */
  readonly index: number
  readonly optional: boolean
  readonly defaultValue: (() => T) | undefined
  readonly dispose: ((value: T) => void | Promise<void>) | undefined
  /** Phantom type carrier. Never present at runtime. */
  readonly $type?: T
}

export interface SlotOptions<T> {
  /** Reading before writing yields `undefined` instead of throwing. */
  readonly optional?: boolean | undefined
  readonly default?: (() => T) | undefined
  /** Run at lifecycle stage 10, in reverse creation order. */
  readonly dispose?: ((value: T) => void | Promise<void>) | undefined
}
