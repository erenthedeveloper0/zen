import type { HeaderValue } from '../contracts/http.ts'
import type { RawRequest } from '../contracts/adapter.ts'
import type { MediaType, Negotiator, Representation } from '../contracts/negotiation.ts'
import { parseAccept, qualityFor } from '../compile/media-type.ts'
import { NotAcceptable, type HttpError } from '../errors/http-errors.ts'
import { withoutStack } from '../errors/zen-error.ts'

/**
 * Per-request content negotiation — rfcs/0001 §13.4, §4.2 stage 5.
 *
 * Everything structural was decided at boot (`compile/negotiation.ts`). What is
 * left is: read one header, pick one of two or three interned strings, store a
 * reference. On the three shapes real traffic actually sends — no `Accept` at
 * all, a bare wildcard, and the exact type the client wants — it does not parse
 * anything.
 *
 * ### Where this runs, and why it is not later
 *
 * The negotiation step is emitted immediately after the `onRoute` hooks and
 * **before phase middleware, intake and validation**. Three reasons, in the
 * order they mattered:
 *
 *   1. A 406 is knowable from the `Accept` header and the frozen graph alone.
 *      Discovering it after the handler has queried a database means the refusal
 *      costs more than the success, which is the trade §4.2 stage 5 exists to
 *      refuse — the same argument that puts auth and rate limiting there.
 *   2. `ctx.negotiated` is therefore set before *any* application code runs, so
 *      an `around` middleware that caches replies can key on it. A cache that
 *      cannot see the negotiated type is a cache that serves CSV to a client
 *      that asked for JSON, and it would be a cache written correctly against a
 *      framework that decided later.
 *   3. Hooks still run first. A rate-limited or unauthenticated request should
 *      not spend anything on negotiation, and `onRequest` is where those live.
 *
 * ### `Vary: Accept` is staged before the decision, not after it
 *
 * Exactly the lesson §32.2 records about `Vary: Origin`, and it is the same bug
 * with a different header: staging the `Vary` *after* the match means a request
 * that ends in a 406 — or one with no `Accept` header at all — gets a response
 * with no `Vary`, which a shared cache is then free to serve to a client that
 * asked for something else. The header describes what the response *depends
 * on*, which is a property of the route, not of this particular request. So it
 * is staged unconditionally, on the first line, before anything can throw.
 *
 * It is staged rather than written for the reason §13.6 gives: staged metadata
 * is applied by `prepareForWire` at egress, which is downstream of success,
 * error and timeout alike. That is what puts `Vary: Accept` on the 406 itself.
 */

/** What the negotiation step needs from a context. Structural, so this module
 *  does not have to know what a `Context` is — the same shape `StatusCarrier`
 *  uses in the response engine. */
export interface NegotiationCarrier {
  readonly raw: RawRequest
  $negotiated: Representation | null
  $resHeaders: Array<[string, HeaderValue, boolean]> | null
}

/** One offer, split once at boot so the matcher never calls `indexOf`. */
export interface Offer {
  readonly media: MediaType
  readonly type: string
  readonly sub: string
}

export function offersOf(medias: readonly MediaType[]): readonly Offer[] {
  return medias.map((media) => {
    const slash = media.indexOf('/')
    return { media, type: media.slice(0, slash), sub: media.slice(slash + 1) }
  })
}

/**
 * Choose an offer for this `Accept`, or `-1` for "none of them".
 *
 * The reference definition of §13.4's matcher, and the thing the property suite
 * in §20.5 fuzzes. Two rules do all the work, and both are rules the majority of
 * implementations in this ecosystem get wrong:
 *
 *   1. **The most specific matching range decides an offer's quality**, not the
 *      first or the highest. RFC 9110 §12.5.1. This is what makes
 *      `Accept: text/csv;q=0, ...wildcard...` mean "anything except CSV" rather
 *      than "everything"; scoring by the maximum q over matching ranges reads it
 *      as the opposite of what the author wrote. `qualityFor` owns that rule so
 *      there is one copy of it.
 *   2. **Ties go to the server**, in declaration order. The client expresses
 *      preference with `q`; when it has expressed none — `Accept: * / *`, or two
 *      types at the same quality — the choice is the server's, and the only
 *      place the server's preference is written down is the order the route
 *      declared its media types in. A stable sort by q would silently make it
 *      alphabetical.
 *
 * `q = 0` is never chosen, even when it is the only thing that matched. That is
 * the whole reason the loop compares against `> best` starting from `0` rather
 * than tracking "the best index seen": an offer the client explicitly refused
 * must lose to nothing at all.
 */
export function selectOffer(accept: string, offers: readonly Offer[]): number {
  const ranges = parseAccept(accept)
  // Nothing parseable is indistinguishable from nothing sent (`parseAccept`),
  // and both mean the server chooses.
  if (ranges === null) return 0

  let bestIndex = -1
  let best = 0

  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i] as Offer
    const q = qualityFor(ranges, offer.type, offer.sub)
    // Strictly greater, so an equal quality keeps the earlier — the server's
    // preference — and a `q` of 0 can never take the lead from `best = 0`.
    if (q > best) {
      best = q
      bestIndex = i
    }
  }

  return bestIndex
}

/**
 * How many distinct `Accept` strings one route remembers.
 *
 * §13.4 calls this an LRU; it is not, and the difference is deliberate. Real
 * traffic sends a handful of distinct `Accept` values — a browser's, a `*` from
 * curl, the one string the SDK hardcodes — so every eviction policy behaves
 * identically on the workload the cache exists for. The only workload where
 * they differ is one where the keys are attacker-chosen and *no* policy helps,
 * and there the cheapest correct behaviour is to stop trying: clear the map and
 * stay bounded, rather than pay a delete-and-reinsert per request to maintain a
 * recency order that will never be read.
 *
 * The bound is what matters and it is the reason this is not a plain `Map`: the
 * key is a header, the header is attacker-controlled, and an unbounded cache
 * keyed on attacker input is a memory leak with a CVE number waiting for it.
 */
export const NEGOTIATION_CACHE_LIMIT = 32

/**
 * Build the per-route matcher.
 *
 * Closed over the plan, so there is one of these per negotiated route and none
 * at all for every other route in the application.
 *
 * The three fast paths ahead of the cache are the measured ones (§13.4's
 * benchmark): a request with no `Accept`, a request whose `Accept` is exactly
 * one of the declared offers, and a bare wildcard. Together they are the great
 * majority of real requests, and none of them allocates or parses. Everything
 * else parses once and is remembered.
 */
export function makeNegotiator(
  medias: readonly MediaType[],
  representations: ReadonlyMap<MediaType, Representation>,
): Negotiator {
  const offers = offersOf(medias)
  const chosen = medias.map((media) => representations.get(media) as Representation)
  const preferred = chosen[0] as Representation
  const cache = new Map<string, Representation | null>()

  return (accept) => {
    // No `Accept` is the server's choice — RFC 9110 §12.5.1, "will accept any".
    if (accept === undefined) return preferred
    if (accept === '*/*') return preferred

    // An exact hit on a declared type. `application/json` is what most SDKs
    // send verbatim, and comparing two interned strings beats parsing one.
    for (let i = 0; i < offers.length; i++) {
      if ((offers[i] as Offer).media === accept) return chosen[i] as Representation
    }

    const hit = cache.get(accept)
    // `null` is a cached 406 and is a real answer; only `undefined` is a miss.
    if (hit !== undefined) return hit

    const index = selectOffer(accept, offers)
    const result = index === -1 ? null : (chosen[index] as Representation)

    if (cache.size >= NEGOTIATION_CACHE_LIMIT) cache.clear()
    cache.set(accept, result)
    return result
  }
}

/**
 * The step the pipeline emits, on negotiated routes only.
 *
 * Built once per route at boot and installed as a dependency, so the generated
 * source contains one call and no negotiation logic — the same treatment intake
 * and the validators get (§8.3).
 */
export function makeNegotiationStep(
  negotiator: Negotiator,
  offers: readonly MediaType[],
): (ctx: NegotiationCarrier) => void {
  // Frozen at boot so the 406's `errors` block cannot be mutated by a handler
  // that got hold of it through the problem document.
  const available = Object.freeze(offers.slice())

  return (ctx) => {
    // First, unconditionally, before anything can throw — see the note above.
    // Written straight into the staging array rather than through `ctx.res`
    // because `ctx.res` allocates a `ReplyStage` on first touch, and this runs
    // on every request to the route.
    const staged = ctx.$resHeaders
    if (staged === null) ctx.$resHeaders = [['vary', 'Accept', true]]
    else staged.push(['vary', 'Accept', true])

    const representation = negotiator(ctx.raw.header('accept'))
    if (representation === null) throw notAcceptable(available)
    ctx.$negotiated = representation
  }
}

/**
 * The 406 — rfcs/0001 §13.4, Annex B `ZEN_NOT_ACCEPTABLE`.
 *
 * An ordinary `HttpError`, thrown from inside the pipeline, so it takes the
 * whole of §12.4: `onError` hooks observe it, an error mapper can replace it,
 * it is logged at the level its status implies, and it comes out as an RFC 9457
 * problem document like every other refusal. The same decision the rate
 * limiter's 429 made (§32.4), and for the same reason — a status the framework
 * produces should not be a second kind of thing.
 *
 * The available types are on the response, which is the part RFC 9110 asks for
 * ("SHOULD generate a payload containing a list of available representation
 * characteristics") and the part that makes the error actionable: a client that
 * is told only "not acceptable" has to guess, and what it usually guesses is
 * that the server is broken.
 */
export function notAcceptable(available: readonly MediaType[]): HttpError {
  // A routine refusal: its stack is always this function's, so it is not
  // captured — see `withoutStack` (§28.8).
  return withoutStack(() => new NotAcceptable(
    `This route can produce ${available.join(', ')}, and the request's Accept header allows none of them.`,
    { details: { available } },
  ))
}
