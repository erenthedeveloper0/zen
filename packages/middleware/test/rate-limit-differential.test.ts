import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, ReferenceStore, type Store, type Tally } from '../src/index.ts'

/**
 * The store's differential suite — rfcs/0001 §14.5, §20.5, I6.
 *
 * `MemoryStore` is the optimised implementation and `ReferenceStore` is its
 * twin: same contract, no eviction, a map keyed by window *and* key that grows
 * forever. The reference is obviously correct and completely unusable, which is
 * what a reference implementation is for.
 *
 * The bug class this exists to find is specific. Everything a *sweep* could get
 * wrong is unreachable here because there is no sweep — the eviction rule falls
 * out of the counting rule. What is reachable is the boundary: dropping a
 * generation one hit too early, or one too late, or failing to notice a window
 * change at all. Every one of those is a limiter that silently stops limiting
 * or starts refusing traffic it should not, and none of them is visible in a
 * hand-written test that stays inside one window.
 *
 * ### It asserts its own coverage
 *
 * Two implementations that agree because neither ran anything report a pass and
 * prove nothing. A stream that never crosses a window boundary would exercise
 * exactly the code path that cannot be wrong. So the generator's statistics are
 * checked at the end: boundaries crossed, multi-window jumps, keys reused
 * across a boundary, and keys seen for the first time after one.
 *
 * ### The one place they disagree, pinned rather than hidden
 *
 * On a clock that steps **backwards** across a boundary the reference still
 * remembers the window it left and `MemoryStore` does not. That is a property
 * of forgetting, not a defect, and it is asserted in its own named test. A
 * fuzzer that quietly avoided the case would be concealing it; one that
 * asserted equality there would be asserting something neither implementation
 * promises.
 */

const SEEDS = 2_000
const STEPS = 24

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T

/** Deliberately few keys, so collisions and reuse across boundaries are common. */
const KEYS = ['1.2.3.4', '::1', 'tenant-a', 'tenant-b', 'k'] as const

interface Step {
  readonly key: string
  readonly now: number
}

interface Stream {
  readonly windowMs: number
  readonly steps: readonly Step[]
}

/**
 * A non-decreasing clock, which is the only kind a fixed window is defined
 * against. Deltas are drawn to straddle the window length: about a third stay
 * inside, a third cross exactly one boundary, and the rest jump several.
 */
function generate(seed: number): Stream {
  const random = rng(seed)
  const windowMs = pick(random, [10, 100, 1_000, 60_000])
  const steps: Step[] = []
  let now = Math.floor(random() * 1_000_000)

  for (let i = 0; i < STEPS; i++) {
    steps.push({ key: pick(random, KEYS), now })
    const roll = random()
    now += roll < 0.45 ? Math.floor(random() * windowMs * 0.4)
      : roll < 0.8 ? windowMs + Math.floor(random() * windowMs * 0.5)
      : windowMs * (2 + Math.floor(random() * 5))
  }

  return { windowMs, steps }
}

interface Coverage {
  boundaries: number
  jumps: number
  reusedAcross: number
  freshAfter: number
  sameWindowRepeats: number
  maxCount: number
}

function replay(store: Store, stream: Stream): Tally[] {
  return stream.steps.map((step) => store.hit(step.key, step.now) as Tally)
}

describe('MemoryStore ≡ ReferenceStore (§20.5)', () => {
  test(`${SEEDS} seeds agree on every count and every reset`, () => {
    const coverage: Coverage = {
      boundaries: 0, jumps: 0, reusedAcross: 0, freshAfter: 0, sameWindowRepeats: 0, maxCount: 0,
    }

    for (let seed = 1; seed <= SEEDS; seed++) {
      const stream = generate(seed)
      const fast = replay(new MemoryStore({ windowMs: stream.windowMs }), stream)
      const slow = replay(new ReferenceStore({ windowMs: stream.windowMs }), stream)

      for (let i = 0; i < stream.steps.length; i++) {
        const step = stream.steps[i] as Step
        const where = `seed ${seed} step ${i} (key ${step.key} at ${step.now}, window ${stream.windowMs})`
        assert.equal(fast[i]?.count, slow[i]?.count, `count disagrees — ${where}`)
        assert.equal(fast[i]?.resetAt, slow[i]?.resetAt, `resetAt disagrees — ${where}`)
      }

      // ── coverage, measured on the stream rather than assumed ─────────────
      const seenSinceBoundary = new Set<string>()
      const everSeen = new Set<string>()
      let previousWindow = -1
      for (let i = 0; i < stream.steps.length; i++) {
        const step = stream.steps[i] as Step
        const window = Math.floor(step.now / stream.windowMs)
        if (previousWindow !== -1 && window !== previousWindow) {
          if (window === previousWindow + 1) coverage.boundaries++
          else coverage.jumps++
          seenSinceBoundary.clear()
          if (everSeen.has(step.key)) coverage.reusedAcross++
          else coverage.freshAfter++
        } else if (seenSinceBoundary.has(step.key)) {
          coverage.sameWindowRepeats++
        }
        seenSinceBoundary.add(step.key)
        everSeen.add(step.key)
        previousWindow = window
        coverage.maxCount = Math.max(coverage.maxCount, fast[i]?.count ?? 0)
      }
    }

    // A pass with any of these at zero would mean the agreement was vacuous.
    assert.ok(coverage.boundaries > 5_000, `single-window boundaries crossed: ${coverage.boundaries}`)
    assert.ok(coverage.jumps > 2_000, `multi-window jumps: ${coverage.jumps}`)
    assert.ok(coverage.reusedAcross > 2_000, `keys reused across a boundary: ${coverage.reusedAcross}`)
    assert.ok(coverage.freshAfter > 500, `keys first seen after a boundary: ${coverage.freshAfter}`)
    assert.ok(coverage.sameWindowRepeats > 2_000, `repeats inside one window: ${coverage.sameWindowRepeats}`)
    assert.ok(coverage.maxCount >= 5, `deepest count reached: ${coverage.maxCount}`)
  })

  test('the reference grows without bound and the memory store does not', () => {
    // The property the whole eviction design exists for, stated as a
    // comparison rather than as an absolute number: the two agree on every
    // verdict *and* differ by three orders of magnitude in what they retain.
    const windowMs = 1_000
    const fast = new MemoryStore({ windowMs })
    const slow = new ReferenceStore({ windowMs })

    for (let i = 0; i < 5_000; i++) {
      const now = i * 10 // crosses a boundary every 100 hits
      const key = `client-${i}`
      assert.equal(fast.hit(key, now).count, slow.hit(key, now).count)
    }

    assert.equal(slow.size, 5_000)
    assert.ok((fast.size ?? 0) <= 100, `memory store retained ${fast.size}`)
  })
})

describe('the documented divergence', () => {
  test('a clock that steps backwards across a boundary: the reference remembers, the memory store forgets', () => {
    const windowMs = 1_000
    const fast = new MemoryStore({ windowMs })
    const slow = new ReferenceStore({ windowMs })

    for (const store of [fast, slow]) {
      assert.equal(store.hit('a', 1_500).count, 1)
      assert.equal(store.hit('a', 2_500).count, 1, 'a new window either way')
    }

    // Back into the first window. This is an NTP step, not traffic.
    assert.equal(slow.hit('a', 1_600).count, 2, 'the reference never forgot window 1')
    assert.equal(fast.hit('a', 1_600).count, 1, 'the memory store dropped it when the window rolled')
  })

  test('the divergence can only ever undercount, never refuse traffic wrongly', () => {
    // Which direction it errs in is the part that matters operationally. A
    // forgotten window means a client gets a fresh budget it had already spent;
    // it can never mean a client is refused for requests it did not make.
    const windowMs = 1_000
    const fast = new MemoryStore({ windowMs })
    const slow = new ReferenceStore({ windowMs })
    const times = [500, 1_500, 700, 1_700, 200, 2_500, 900]

    for (const now of times) {
      const a = fast.hit('a', now).count
      const b = slow.hit('a', now).count
      assert.ok(a <= b, `memory=${a} reference=${b} at ${now}`)
    }
  })
})

describe('contract properties both implementations hold', () => {
  const stores = (): ReadonlyArray<[string, Store]> => [
    ['MemoryStore', new MemoryStore({ windowMs: 1_000 })],
    ['ReferenceStore', new ReferenceStore({ windowMs: 1_000 })],
  ]

  test('the first hit for a key in a window is always 1', () => {
    for (const [name, store] of stores()) {
      assert.equal((store.hit('fresh', 0) as Tally).count, 1, name)
      assert.equal((store.hit('other', 0) as Tally).count, 1, name)
    }
  })

  test('counts increase by exactly one inside a window', () => {
    for (const [name, store] of stores()) {
      for (let i = 1; i <= 20; i++) {
        assert.equal((store.hit('a', 500) as Tally).count, i, `${name} hit ${i}`)
      }
    }
  })

  test('resetAt is strictly in the future of the hit that produced it', () => {
    for (const [name, store] of stores()) {
      for (const now of [0, 1, 999, 1_000, 1_001, 123_456]) {
        const tally = store.hit('a', now) as Tally
        assert.ok(tally.resetAt > now, `${name} at ${now}: resetAt ${tally.resetAt}`)
        assert.ok(tally.resetAt - now <= 1_000, `${name} at ${now}: reset is more than a window away`)
      }
    }
  })

  test('a key containing the separator cannot forge another key\'s counter', () => {
    // `ReferenceStore` composes `${window}:${key}`. A key of `0:victim` must not
    // land on window 0's `victim`, and the leading digits make that impossible —
    // but only because the window prefix is unambiguous, so it is asserted.
    for (const [name, store] of stores()) {
      assert.equal((store.hit('victim', 0) as Tally).count, 1, name)
      assert.equal((store.hit('0:victim', 0) as Tally).count, 1, name)
      assert.equal((store.hit('victim', 0) as Tally).count, 2, name)
    }
  })
})
