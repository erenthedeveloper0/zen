import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAccept, qualityFor, selectOffer, offersOf, makeNegotiator, NEGOTIATION_CACHE_LIMIT,
  type AcceptRange, type Offer, type Representation,
} from '@zenjs/core'

/**
 * Content negotiation, fuzzed — rfcs/0001 §13.4, §20.5.
 *
 * **There is no compiled twin here, and that is correct.** The convention is
 * that every *compiled* subsystem needs an interpreted one and a fuzzer that
 * makes them agree; negotiation compiles nothing. Its boot half derives a plan
 * — the offers, in preference order, and one writer per representation — and
 * its request half is a closure over that plan. There is no generated source
 * for a second implementation to disagree with, and inventing one would be
 * theatre. Config and health are the other two subsystems in this position, for
 * the same reason (§20.5).
 *
 * What replaces it is two things, and the second one *is* a differential:
 *
 * ### 1. A property suite over random offer sets and random `Accept` headers
 *
 * The bugs in a matcher are the ones nobody writes a case for: a `q=0` under a
 * wildcard, two ranges of equal specificity, a range that covers everything at
 * a lower quality than one that covers nothing. Six invariants, and the fifth
 * is the one that would be silent in production and is a security-shaped
 * silence:
 *
 *   1. **Closure** — the answer is an offer, or nothing. Never an index into
 *      something else.
 *   2. **Maximality** — no offer has a strictly higher quality than the one
 *      chosen.
 *   3. **Liveness** — if any offer has a quality above zero, something is
 *      chosen. A spurious 406 is an outage.
 *   4. **Safety** — if no offer has a quality above zero, nothing is chosen.
 *   5. **A refused representation is never served.** An offer whose most
 *      specific matching range says `q=0` must lose to *nothing at all*, not
 *      merely to a better offer. This is the invariant that fails silently: the
 *      client gets a 200 with a body it said it could not read.
 *   6. **Server preference breaks ties**, deterministically, in declaration
 *      order.
 *
 * ### 2. The cached negotiator against the uncached matcher
 *
 * This is the real differential, and it is the same shape as the rate
 * limiter's `MemoryStore` against `ReferenceStore` (§32.4): one implementation
 * has an optimisation and the other is the definition. `makeNegotiator` adds
 * three fast paths and a bounded cache on top of `selectOffer`; every one of
 * those is a chance to answer a *previous* request's question. Two thousand
 * random streams, each replayed against a fresh uncached matcher, with
 * evictions forced often enough to be exercised rather than assumed.
 *
 * Both halves assert their own **coverage**. A fuzzer whose generator never
 * produces a `q=0` under a wildcard proves nothing about the rule that exists
 * to resolve one, and reports a pass either way.
 */

const SEEDS = 2_000

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T

const TYPES = ['application', 'text', 'image'] as const
const SUBS = ['json', 'csv', 'xml', 'html', 'png', 'vnd.acme.v2+json'] as const

function randomOffers(random: () => number): readonly Offer[] {
  const count = 1 + Math.floor(random() * 4)
  const medias: string[] = []
  while (medias.length < count) {
    const media = `${pick(random, TYPES)}/${pick(random, SUBS)}`
    if (!medias.includes(media)) medias.push(media)
  }
  return offersOf(medias)
}

/**
 * A generator biased *towards* the interesting cases rather than towards
 * realistic ones. Uniform random media types almost never collide with the
 * offers, so almost every seed would be a 406 and the suite would prove one
 * branch very thoroughly.
 */
function randomAccept(random: () => number, offers: readonly Offer[]): string {
  // A header with nothing parseable in it, which is a distinct branch — it is
  // answered with the server preference rather than a 406. The generator did
  // not produce one in the first draft, so the `ranges === null` arm below ran
  // zero times and the negative control for it was NOT CAUGHT. That is exactly
  // the failure §20.5 means by "a fuzzer must assert its own coverage": the
  // branch was written, asserted, and never executed.
  if (random() < 0.04) return pick(random, ['garbage', '', '   ', ',,,', 'json'])

  const parts: string[] = []
  const count = 1 + Math.floor(random() * 4)

  for (let i = 0; i < count; i++) {
    const roll = random()
    let range: string
    if (roll < 0.35) {
      const offer = pick(random, offers)
      range = offer.media
    } else if (roll < 0.5) {
      range = '*/*'
    } else if (roll < 0.65) {
      range = `${pick(random, offers).type}/*`
    } else if (roll < 0.8) {
      range = `${pick(random, TYPES)}/${pick(random, SUBS)}`
    } else {
      range = `${pick(random, TYPES)}/*`
    }

    const q = random()
    if (q < 0.25) parts.push(`${range};q=0`)
    else if (q < 0.6) parts.push(`${range};q=${(Math.floor(random() * 10) / 10).toFixed(1)}`)
    else parts.push(range)
  }

  return parts.join(', ')
}

/** The definition the properties are checked against — no cache, no fast path. */
function qualityOfOffer(header: string, offer: Offer): number {
  const ranges = parseAccept(header)
  if (ranges === null) return 1
  return qualityFor(ranges as readonly AcceptRange[], offer.type, offer.sub)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the matcher, fuzzed (§13.4, §20.5)', () => {
  test('six invariants over 2,000 random offer sets and Accept headers', () => {
    const coverage = {
      chose: 0,
      refused: 0,
      wildcardOnly: 0,
      explicitZero: 0,
      zeroUnderWildcard: 0,
      ties: 0,
      unparseable: 0,
    }

    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const offers = randomOffers(random)
      const header = randomAccept(random, offers)
      const index = selectOffer(header, offers)

      // 1. closure
      assert.ok(index === -1 || (index >= 0 && index < offers.length), `seed ${seed}: index ${index} out of range`)

      const qualities = offers.map((offer) => qualityOfOffer(header, offer))
      const best = Math.max(...qualities)
      const ranges = parseAccept(header)

      if (ranges === null) {
        coverage.unparseable++
        assert.equal(index, 0, `seed ${seed}: nothing parseable must take the server preference`)
        continue
      }

      if (index === -1) {
        coverage.refused++
        // 4. safety
        assert.ok(best <= 0, `seed ${seed}: refused "${header}" although an offer had q=${best}`)
        continue
      }

      coverage.chose++
      const chosenQuality = qualities[index] as number

      // 2. maximality
      assert.equal(chosenQuality, best, `seed ${seed}: chose q=${chosenQuality} when q=${best} was available`)
      // 5. a refused representation is never served — the silent one
      assert.ok(chosenQuality > 0, `seed ${seed}: served "${(offers[index] as Offer).media}" at q=${chosenQuality}`)
      // 6. server preference breaks ties
      const firstBest = qualities.findIndex((q) => q === best)
      assert.equal(index, firstBest, `seed ${seed}: tie broken against declaration order`)

      // 3. liveness is the contrapositive of the branch above, asserted here so
      // a generator that stopped producing matches would fail rather than pass.
      assert.ok(best > 0)

      if (qualities.filter((q) => q === best).length > 1) coverage.ties++
      if (qualities.some((q) => q === 0)) coverage.explicitZero++
      if (ranges.every((r) => r.specificity === 0)) coverage.wildcardOnly++
      if (
        ranges.some((r) => r.q === 0 && r.specificity > 0) &&
        ranges.some((r) => r.specificity === 0 && r.q > 0)
      ) {
        coverage.zeroUnderWildcard++
      }
    }

    // ── coverage: two implementations that agree because neither ran anything
    //    report a pass and prove nothing (§20.5) ────────────────────────────
    assert.ok(coverage.chose > 1_000, `seeds that chose a representation: ${coverage.chose}`)
    assert.ok(coverage.refused > 100, `seeds that produced a 406: ${coverage.refused}`)
    assert.ok(coverage.ties > 100, `seeds where server preference decided: ${coverage.ties}`)
    assert.ok(coverage.explicitZero > 200, `seeds with an offer at q=0: ${coverage.explicitZero}`)
    assert.ok(
      coverage.zeroUnderWildcard > 50,
      `seeds with a q=0 under a permissive wildcard — the case libraries invert: ${coverage.zeroUnderWildcard}`,
    )
    assert.ok(coverage.wildcardOnly > 20, `seeds whose Accept was wildcards only: ${coverage.wildcardOnly}`)
    assert.ok(
      coverage.unparseable > 20,
      `seeds whose Accept had nothing parseable in it: ${coverage.unparseable}`,
    )
  })
})

describe('the cache against the definition (§13.4, §20.5)', () => {
  /**
   * The differential. `makeNegotiator` is the optimised form — three fast paths
   * and a bounded map — and `selectOffer` is the definition; they must agree on
   * every request of every stream, in the order the stream sends them.
   *
   * Streams rather than independent calls, because the whole class of bug a
   * cache introduces is order-dependent: an answer that is right in isolation
   * and wrong after some other header went through. Replaying each request
   * against a *fresh* uncached matcher is what makes the comparison honest.
   */
  test('2,000 random streams, and the cache never changes an answer', () => {
    const coverage = { requests: 0, hits: 0, evictions: 0, fastPaths: 0, refusals: 0, distinctMax: 0 }

    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed * 7919)
      const offers = randomOffers(random)
      const medias = offers.map((o) => o.media)

      const representations = new Map<string, Representation>(
        medias.map((media) => [media, {
          media,
          contentType: `${media}; charset=utf-8`,
          statuses: new Set([200]),
          writers: new Map(),
        }]),
      )
      const negotiate = makeNegotiator(medias, representations)

      // Long enough that the deepest streams pass through the cache limit
      // several times over: eviction has to be a thing the suite *does*, not a
      // thing it hopes for. The coverage assertion below is what keeps that
      // honest if this number is ever trimmed.
      const length = 4 + Math.floor(random() * 160)
      const distinct = new Set<string>()

      for (let i = 0; i < length; i++) {
        // A stream that only ever sends new headers exercises eviction and
        // never exercises a hit, so the generator repeats deliberately.
        const header = random() < 0.4 && distinct.size > 0
          ? pick(random, [...distinct])
          : randomAccept(random, offers)

        if (distinct.has(header)) coverage.hits++
        distinct.add(header)
        coverage.requests++

        const actual = negotiate(header)
        const index = selectOffer(header, offers)
        const expected = index === -1 ? null : (representations.get(medias[index] as string) as Representation)

        assert.equal(
          actual,
          expected,
          `seed ${seed} request ${i}: "${header}" over [${medias.join(', ')}] — ` +
            `cached said ${actual === null ? '406' : actual.media}, definition said ${expected === null ? '406' : expected.media}`,
        )

        if (expected === null) coverage.refusals++
        if (header === '*/*' || medias.includes(header)) coverage.fastPaths++
      }

      coverage.distinctMax = Math.max(coverage.distinctMax, distinct.size)
      if (distinct.size > NEGOTIATION_CACHE_LIMIT) coverage.evictions++
    }

    assert.ok(coverage.requests > 50_000, `requests compared: ${coverage.requests}`)
    assert.ok(coverage.hits > 5_000, `repeated headers, i.e. cache hits: ${coverage.hits}`)
    assert.ok(coverage.refusals > 1_000, `refusals, cached and uncached: ${coverage.refusals}`)
    assert.ok(coverage.fastPaths > 1_000, `requests that took a pre-cache fast path: ${coverage.fastPaths}`)
    assert.ok(
      coverage.evictions > 50,
      `streams that overflowed the ${NEGOTIATION_CACHE_LIMIT}-entry cache: ${coverage.evictions}`,
    )
    assert.ok(
      coverage.distinctMax > NEGOTIATION_CACHE_LIMIT * 2,
      `deepest distinct-header stream: ${coverage.distinctMax}`,
    )
  })

  /**
   * The pinned disagreement.
   *
   * `rate-limit-differential.test.ts` established the discipline and it is
   * worth copying: a fuzzer that quietly avoids a case where two
   * implementations legitimately differ is concealing it. Here the case is the
   * fast path, and the answer is that there is **no** legitimate divergence —
   * `makeNegotiator`'s shortcuts are required to be exactly what `selectOffer`
   * would have said, not merely close. So the disagreement is pinned at zero,
   * by asserting the shortcut against the definition on the inputs the shortcut
   * exists for.
   *
   * That is a real assertion rather than a formality: `Accept: application/json`
   * on a route that declares `text/csv` first is a case where "return the
   * matching offer" and "return the preferred offer" differ, and a fast path
   * written the lazy way returns the wrong one.
   */
  test('the fast paths say exactly what the definition says', () => {
    const medias = ['text/csv', 'application/json']
    const offers = offersOf(medias)
    const representations = new Map<string, Representation>(
      medias.map((media) => [media, {
        media, contentType: media, statuses: new Set([200]), writers: new Map(),
      }]),
    )
    const negotiate = makeNegotiator(medias, representations)

    for (const header of [...medias, '*/*']) {
      const index = selectOffer(header, offers)
      assert.notEqual(index, -1)
      assert.equal(
        negotiate(header)?.media,
        medias[index],
        `the fast path for "${header}" disagreed with selectOffer`,
      )
    }

    // The one that catches "return the first offer" written as a shortcut.
    assert.equal(negotiate('application/json')?.media, 'application/json')
    assert.equal(negotiate('*/*')?.media, 'text/csv', 'a wildcard takes the declaration order')
    assert.equal(negotiate(undefined)?.media, 'text/csv')
  })
})
