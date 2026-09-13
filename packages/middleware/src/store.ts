/**
 * The counter store — rfcs/0001 §3.5, the `Store` seam.
 *
 * §3.5's inventory lists one interface shared by the cache, the rate limiter
 * and the session store, with an in-memory default and Redis / SQLite / D1 /
 * Durable Object as the alternates. This module is the rate limiter's half of
 * it: the narrowest contract that a fixed-window counter needs, chosen so that
 * a Redis implementation is two commands rather than a transaction.
 *
 *     INCR    zen:rl:{window}:{key}
 *     PEXPIRE zen:rl:{window}:{key} {windowMs}   // only on the first hit
 *
 * That is the whole implementation, and it is the reason `hit` returns the
 * count *including* the current request rather than taking a "should I allow
 * this" decision. A store that decided would need the limit, and a store that
 * needs the limit cannot be shared with the cache.
 */

/** One key's standing in the window it is currently inside. */
export interface Tally {
  /** Hits in this window, **including** the one that produced this tally. */
  readonly count: number
  /** Epoch milliseconds at which this window ends and the count resets. */
  readonly resetAt: number
}

/**
 * A counter keyed by string, bucketed into fixed windows.
 *
 * `hit` may be async — a Redis store is a round trip — and the rate limiter
 * awaits it only when it actually returns a promise, so the in-memory default
 * keeps the whole limiter on §8.4's synchronous fast path.
 */
export interface Store {
  hit(key: string, now: number): Tally | Promise<Tally>
  /** Drop everything. Tests use it; production has no reason to. */
  reset?(): void
  /** Release connections. Called from the limiter's `onClose` (§4.5). */
  close?(): void | Promise<void>
  /** Live keys, when the store can say. Read by the memory-bound gate. */
  readonly size?: number
}

export interface MemoryStoreOptions {
  readonly windowMs: number
}

/**
 * The default store: a fixed-window counter that forgets a window when it ends.
 *
 * **Fixed windows, stated plainly.** A key's count resets at a wall-clock
 * boundary, so a client can spend its whole budget in the last millisecond of
 * one window and its whole budget again in the first millisecond of the next —
 * up to `2 × limit` inside one window's worth of time straddling the boundary.
 * That is the known cost of fixed windows and it belongs here rather than in a
 * footnote, because the alternatives are not free: a sliding log keeps one
 * timestamp per request, which is unbounded memory per key and the key is the
 * thing an attacker chooses; and a sliding-window *counter* cannot be expressed
 * as `INCR` + `PEXPIRE`, so it would push every alternate store into a Lua
 * script or a transaction. §28.8 records it as a gap.
 *
 * **Eviction is a dropped reference, not a sweep.** The failure mode of every
 * in-memory limiter is that its map is keyed by something the client chooses —
 * an IP, an API key, a header — so whoever is attacking decides how much memory
 * the process holds. The usual answer is a timer that walks the map, and
 * walking a map with ten million keys is a pause that happens under exactly the
 * load that created the keys.
 *
 * A fixed window needs neither. When the clock crosses into a new window every
 * count in the old one is dead by definition, so the map is replaced whole: one
 * assignment, no scan, no pause, and the collector reclaims a generation at
 * once. Memory is bounded by the distinct keys seen inside a *single* window,
 * and there is no timer to leak — which also means no `unref`, a Node API this
 * package cannot use if it is to run everywhere core does.
 *
 * The saving is that the eviction rule falls out of the counting rule instead
 * of being a second mechanism bolted beside it. Everything a sweep could get
 * wrong — evicting a live key, retaining a dead one, pausing — is unreachable,
 * because there is no sweep. What *is* reachable is losing or double-counting a
 * key across the boundary, and that is what the differential suite fuzzes.
 */
export class MemoryStore implements Store {
  readonly #windowMs: number
  #counts = new Map<string, number>()
  /** The window index (`floor(now / windowMs)`) `#counts` belongs to. */
  #window = -1

  constructor(options: MemoryStoreOptions) {
    this.#windowMs = options.windowMs
  }

  hit(key: string, now: number): Tally {
    const window = Math.floor(now / this.#windowMs)
    if (window !== this.#window) {
      // Not `.clear()`: replacing the reference lets the collector take the
      // whole map, while `clear` walks it. At the sizes this exists to survive,
      // that is the difference the design is for.
      this.#counts = new Map()
      this.#window = window
    }

    const count = (this.#counts.get(key) ?? 0) + 1
    this.#counts.set(key, count)
    return { count, resetAt: (window + 1) * this.#windowMs }
  }

  reset(): void {
    this.#counts = new Map()
    this.#window = -1
  }

  get size(): number {
    return this.#counts.size
  }
}

/**
 * The reference twin — rfcs/0001 §14.5, §20.5, I6.
 *
 * Same contract, no eviction: one map keyed by window *and* key, which grows
 * forever. It is obviously correct and completely unusable, which is exactly
 * what a reference implementation is for. `MemoryStore` must agree with it on
 * every verdict over a non-decreasing clock; where they differ, the difference
 * is a count the evicting store lost or repeated at a window boundary, and that
 * is the only bug class this component has.
 *
 * They *do* diverge, in one case, and it is a documented property rather than a
 * defect: on a clock that steps **backwards** across a boundary the reference
 * still remembers the window it left and `MemoryStore` does not. Fuzzing a
 * non-decreasing clock and pinning the backwards case in one named test is the
 * honest split — a fuzzer that quietly avoided the disagreement would be
 * hiding it, and one that asserted equality there would be asserting something
 * neither implementation promises.
 *
 * Exported rather than kept in the test directory for the same reason
 * `PlainContext` and `walkSerializer` are: a twin only the framework's own
 * tests can reach is one nobody verifying an alternate store can use, and
 * §14.5 says every optimised subsystem ships its reference implementation.
 */
export class ReferenceStore implements Store {
  readonly #windowMs: number
  readonly #counts = new Map<string, number>()

  constructor(options: MemoryStoreOptions) {
    this.#windowMs = options.windowMs
  }

  hit(key: string, now: number): Tally {
    const window = Math.floor(now / this.#windowMs)
    // The window is always base-10 digits, so the text up to the first colon is
    // unambiguous however exotic the key is — no separator a key could forge.
    const composite = `${window}:${key}`
    const count = (this.#counts.get(composite) ?? 0) + 1
    this.#counts.set(composite, count)
    return { count, resetAt: (window + 1) * this.#windowMs }
  }

  reset(): void {
    this.#counts.clear()
  }

  get size(): number {
    return this.#counts.size
  }
}
