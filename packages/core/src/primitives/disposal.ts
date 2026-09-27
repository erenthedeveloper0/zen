/** Stratum 0 — no framework imports. */

/**
 * One thing a request must release at lifecycle stage 10 — rfcs/0001 §4.2,
 * §7.4, §15.3: the value a disposable slot held, or a request-scoped service.
 *
 * The *value* is recorded, not only the slot it lived in. Recording the slot
 * and reading its current value at settle time was how a slot set twice leaked
 * its first value and disposed its second twice — a transaction replaced
 * mid-request was never rolled back, and the one that replaced it was rolled
 * back two times.
 */
export interface Disposal {
  readonly name: string
  readonly value: unknown
  readonly dispose: (value: never) => void | Promise<void>
}

/** What a context exposes to have something released at settle. */
export interface DisposalCarrier {
  $disposers: Disposal[] | null
  /** Where a disposer that fails after the request has settled is reported. */
  readonly log?: { error(obj: object, msg?: string): void } | undefined
}

/**
 * The list a request carries once stage 10 has run — it is over, and nothing
 * will read its list again.
 *
 * Something can still arrive afterwards. A deadline answers the client while
 * the handler is suspended in `await ctx.resolveAsync(Tx)`; the transaction
 * finishes opening a moment later and is queued on a list nobody will release,
 * so it is never rolled back. §4.2 stage 10 is explicit that a request that
 * gave up still has to release what it took — so anything queued against a
 * settled request is released on the spot instead.
 *
 * A frozen empty array rather than a second field: the context's shape is its
 * hidden class (I2), and this is one more value of a field it already has.
 */
export const SETTLED: Disposal[] = Object.freeze([]) as unknown as Disposal[]

/**
 * Queue `value` for release when the request settles, in reverse order of
 * arrival — or release it now, when the request already has.
 *
 * `undefined` is nothing to release, and a value already queued with the same
 * disposer is not queued twice — setting a slot to the value it already holds
 * must not dispose it twice. The list is scanned rather than indexed because it
 * holds a handful of entries on the rare requests that have any, and nothing at
 * all on every other request.
 */
export function trackDisposal(
  carrier: DisposalCarrier,
  name: string,
  dispose: (value: never) => void | Promise<void>,
  value: unknown,
): void {
  if (value === undefined) return
  const list = carrier.$disposers
  if (list === SETTLED) {
    releaseLate(carrier, name, dispose, value)
    return
  }
  if (list === null) {
    carrier.$disposers = [{ name, value, dispose }]
    return
  }
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as Disposal
    if (entry.value === value && entry.dispose === dispose) return
  }
  list.push({ name, value, dispose })
}

/**
 * Release something that arrived after its request settled. Never throws: the
 * caller is whatever finished late — a factory's promise, an abandoned handler
 * — and the request it belonged to has already been answered and logged.
 */
function releaseLate(
  carrier: DisposalCarrier,
  name: string,
  dispose: (value: never) => void | Promise<void>,
  value: unknown,
): void {
  const report = (error: unknown): void => {
    carrier.log?.error({ err: error, slot: name }, 'dispose threw for a value that arrived after its request settled')
  }
  try {
    const result = dispose(value as never)
    if (result !== undefined && result !== null && typeof (result as Promise<void>).then === 'function') {
      ;(result as Promise<void>).then(undefined, report)
    }
  } catch (error) {
    report(error)
  }
}
