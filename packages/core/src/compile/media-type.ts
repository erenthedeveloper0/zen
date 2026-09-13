import type { MediaType } from '../contracts/negotiation.ts'

/**
 * `Accept` and media types — rfcs/0001 §13.4.
 *
 * This module is the *shared vocabulary* of the negotiation subsystem, in the
 * same sense that `SerNode` is the shared vocabulary of the two serializers
 * (§13.3.3): the boot-time validator, the compiled matcher and the interpreted
 * matcher all reduce to the functions here, so none of them can disagree about
 * what `text/*;q=0.5` means. A divergence between the engines can only ever be
 * about *control flow*, never about parsing — which is what makes the
 * differential suite in §20.5 tractable rather than a re-implementation race.
 *
 * Nothing here is on the hot path in the common case: the negotiator caches by
 * raw header string, and real traffic has a handful of distinct `Accept`
 * values. See `runtime/negotiation.ts` for why that cache is a cache and not an
 * LRU.
 */

/**
 * One media range from an `Accept` header, already lowercased.
 *
 * `specificity` is what makes `Accept: text/csv;q=0, * / *` mean "anything but
 * CSV" rather than "everything, including CSV": RFC 9110 §12.5.1 says a more
 * specific range overrides a less specific one, so the match is decided by the
 * *most specific* range that covers an offer, not by the first or the highest.
 * Every library that scores by "highest q among matching ranges" gets that case
 * backwards, and it is the case an author writes deliberately.
 */
export interface AcceptRange {
  /** Lowercase type, or `*`. */
  readonly type: string
  /** Lowercase subtype, or `*`. */
  readonly sub: string
  /** Quality, 0–1. `0` means explicitly unacceptable. */
  readonly q: number
  /** A fully wildcard range is 0, `type/` + wildcard is 1, `type/subtype` is 2. */
  readonly specificity: 0 | 1 | 2
}

/**
 * The number of media ranges parsed from one header.
 *
 * Browsers send between one and five. The adapter already caps header *size*
 * (§4.2 stage 2), but an 8 kB `Accept` is still roughly 800 ranges, and parsing
 * 800 ranges per distinct attacker-chosen header is an amplification factor on
 * the cheapest request there is. Ranges past the cap are ignored rather than
 * rejected: truncation gives a well-formed client a slightly worse answer,
 * where a 400 would give a proxy that concatenated two headers no answer at all.
 */
export const MAX_ACCEPT_RANGES = 32

/**
 * Parse an `Accept` header into media ranges.
 *
 * Returns `null` when the header is absent, empty, or contains nothing
 * parseable — all three of which mean the same thing to a server, and all three
 * of which are answered with the route's first declared representation.
 *
 * **Malformed ranges are skipped, not fatal.** `Accept: text/csv, garbage`
 * negotiates on `text/csv`. The reasoning is worth stating because the other
 * choice is defensible too: a 400 for a malformed `Accept` turns a proxy's
 * header mangling into a total outage for every client behind it, and the
 * client that sent a range we could not read has still told us about the ranges
 * we could. A header with *no* readable range is indistinguishable from one
 * that was never sent, and is treated as such.
 *
 * Two limits, both deliberate and both visible in the result:
 *
 *   - **Media-range parameters other than `q` are ignored.** `Accept:
 *     application/json;profile="urn:x"` matches an `application/json` offer.
 *     RFC 9110 makes those parameters part of the range, so this is a genuine
 *     simplification; it is the one every implementation makes, because the
 *     alternative is negotiating on parameters no route in this framework can
 *     declare — offers are `type/subtype` by construction (`normaliseMediaType`).
 *     When a route can declare `;profile=`, this is where it changes.
 *   - **A malformed `q` is treated as absent**, i.e. `1`, which is the RFC's
 *     default. `q=banana` therefore means "I want this" rather than "I refuse
 *     it"; refusing on unparseable input would let a typo silently produce a
 *     406 that looks like a server bug.
 */
export function parseAccept(header: string | undefined): readonly AcceptRange[] | null {
  if (header === undefined) return null

  const ranges: AcceptRange[] = []
  for (const part of splitCommas(header, MAX_ACCEPT_RANGES)) {
    const range = parseRange(part)
    if (range !== null) ranges.push(range)
  }
  return ranges.length > 0 ? ranges : null
}

function parseRange(part: string): AcceptRange | null {
  let head = part
  let q = 1

  const semi = part.indexOf(';')
  if (semi !== -1) {
    head = part.slice(0, semi)
    q = qualityOf(part.slice(semi + 1))
  }

  const name = head.trim().toLowerCase()
  const slash = name.indexOf('/')
  if (slash <= 0 || slash === name.length - 1) return null

  const type = name.slice(0, slash)
  const sub = name.slice(slash + 1)
  if (sub.indexOf('/') !== -1) return null
  if (!isToken(type) || !isToken(sub)) return null

  // A wildcard type with a concrete subtype has no meaning in RFC 9110 and no
  // client sends it. Reading it as a full wildcard would make a nonsense header
  // match everything, which is the wrong direction to guess in.
  if (type === '*' && sub !== '*') return null

  return {
    type,
    sub,
    q,
    specificity: type === '*' ? 0 : sub === '*' ? 1 : 2,
  }
}

/** The `q` parameter, or 1. Anything unreadable is 1 — see `parseAccept`. */
function qualityOf(params: string): number {
  for (const param of splitSemicolons(params)) {
    const eq = param.indexOf('=')
    if (eq === -1) continue
    if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue

    const raw = unquote(param.slice(eq + 1).trim())
    const value = Number(raw)
    if (raw === '' || !Number.isFinite(value)) return 1
    return value < 0 ? 0 : value > 1 ? 1 : value
  }
  return 1
}

/**
 * Does this range cover this offer?
 *
 * The offer is always a concrete `type/subtype` — a route cannot declare a
 * wildcard — so this is three comparisons and no normalisation.
 */
export function rangeCovers(range: AcceptRange, type: string, sub: string): boolean {
  if (range.type === '*') return true
  if (range.type !== type) return false
  return range.sub === '*' || range.sub === sub
}

/**
 * The quality this `Accept` assigns to one offer, or `-1` for "no range covers
 * it at all".
 *
 * `-1` and `0` are deliberately different values even though both mean the
 * offer is unusable, because only one of them is a *decision*: `q=0` is a
 * client that named this representation and refused it, and no range matching
 * is a client that never considered it. Nothing downstream needs the
 * distinction today; the diagnostics that will want it are cheaper to keep than
 * to reconstruct.
 */
export function qualityFor(ranges: readonly AcceptRange[], type: string, sub: string): number {
  let bestSpecificity = -1
  let best = -1

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i] as AcceptRange
    if (!rangeCovers(range, type, sub)) continue
    if (range.specificity > bestSpecificity) {
      bestSpecificity = range.specificity
      best = range.q
    } else if (range.specificity === bestSpecificity && range.q > best) {
      // Two ranges of equal specificity covering one offer is malformed input
      // (`text/csv;q=0.2, text/csv;q=0.9`). Taking the larger is the reading
      // that treats the client as having changed its mind rather than as having
      // meant the stricter of two things it wrote by accident.
      best = range.q
    }
  }

  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Declarations
// ─────────────────────────────────────────────────────────────────────────────

/** A media type as a route may declare it: `type/subtype`, and nothing else. */
export interface DeclaredMedia {
  readonly media: MediaType
  readonly type: string
  readonly sub: string
}

export type MediaProblem =
  | 'not-a-media-type'
  | 'has-parameters'
  | 'wildcard'

/**
 * Validate one declared media type — the boot-time half of this module.
 *
 * Strict on purpose, and the strictness is the same lesson §32.4 learned about
 * a CORS allowlist with a trailing slash: an allowlist entry that can never
 * match is worse than a missing one, because it looks like the feature is
 * configured. Three refusals, each with a distinct fix:
 *
 *   - `'json'` — not a media type. Nothing would ever match it.
 *   - `'text/csv; charset=utf-8'` — parameters belong on the wire, not in the
 *     declaration. Zen appends the charset itself (`wireMediaType`), and a
 *     declaration carrying one would be compared against an `Accept` range that
 *     never carries it, so it would match nothing.
 *   - a wildcard in either half — a route cannot offer "anything". The set of
 *     things it can produce is exactly the set it declares; a wildcard would
 *     make the 406 unreachable and `Content-Type` unanswerable.
 */
export function normaliseMediaType(raw: string): DeclaredMedia | MediaProblem {
  const media = raw.trim().toLowerCase()
  if (media.indexOf(';') !== -1) return 'has-parameters'

  const slash = media.indexOf('/')
  if (slash <= 0 || slash === media.length - 1) return 'not-a-media-type'

  const type = media.slice(0, slash)
  const sub = media.slice(slash + 1)
  if (sub.indexOf('/') !== -1) return 'not-a-media-type'
  if (!isToken(type) || !isToken(sub)) return 'not-a-media-type'
  if (type === '*' || sub === '*') return 'wildcard'

  return { media, type, sub }
}

export function isMediaProblem(value: DeclaredMedia | MediaProblem): value is MediaProblem {
  return typeof value === 'string'
}

/**
 * Is this status's declaration a media-type record rather than a schema?
 *
 * The test is structural because it has to be: a Standard Schema is an opaque
 * object, and asking the author to write `variants({ ... })` would be a second
 * way to say something the shape already says. Four gates, and the last one is
 * the one that carries the weight:
 *
 *   - not a `~standard` schema, and not a `jsonSchema()` marker;
 *   - not an array;
 *   - **at least one own key contains a `/`.**
 *
 * No JSON Schema keyword contains a slash — `type`, `properties`, `$ref`,
 * `$defs`, `anyOf`, `additionalProperties`, all of them are bare tokens — and
 * every media type does, by definition. So the two vocabularies cannot be
 * confused by anything a person would plausibly write. (A `$ref`'s *value*
 * contains slashes; its key does not, which is the half this looks at.)
 *
 * **`any` rather than `every`, and the difference is a real message.** The
 * strict reading was the first draft, and the test that argued it down is
 * `{ 'application/json': A, 'csv': B }` — plainly a variant record with one
 * typo'd key. Under `every`, that is not a variant record at all, so the whole
 * declaration falls through to the schema path and the author is told their
 * *schema* would not convert. Under `any`, it is a variant record with one bad
 * media type, and the diagnostic says `"csv" is not a media type` and names the
 * shape to write. The looser test produces the sharper error, which is the
 * opposite of the usual trade.
 *
 * `{}` and `{ nope: Schema }` remain deliberately *not* variant records: with no
 * slash anywhere there is nothing to distinguish them from a half-written
 * schema, and they fall through to §13.3.6's unconvertible-schema warning,
 * which is the message that actually helps for the more likely mistake.
 *
 * It lives here, next to the media-type grammar, rather than in the negotiation
 * planner, because the question it answers is "are these keys media types?" —
 * and because putting it there made `serializer.ts` and `negotiation.ts` import
 * each other.
 */
export function isVariantRecord(value: unknown): value is Readonly<Record<MediaType, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if ('~standard' in value) return false

  for (const key of Object.keys(value)) {
    if (key.indexOf('/') !== -1) return true
  }
  return false
}

/**
 * Is this media type written by the compiled JSON serializer?
 *
 * `application/json` and the `+json` structured suffix (RFC 6839), which is
 * what every versioned API vendor type uses — `application/vnd.acme.v2+json`.
 * That case is the single most common reason to negotiate at all, and it needs
 * no encoder: two versions of one resource are two schemas and one writer.
 */
export function isJsonMedia(media: MediaType): boolean {
  return media === 'application/json' || media.endsWith('+json')
}

/**
 * The `Content-Type` for a representation.
 *
 * The charset is appended unconditionally, because it is not a guess:
 * `MediaEncoderFactory` returns a `string`, egress encodes it with
 * `TextEncoder`, and `TextEncoder` is UTF-8 by definition. Omitting it is how
 * `text/csv` opens as mojibake in Excel and how a `text/html` variant gets
 * sniffed, and a parameter that is always true is better stated than inferred.
 *
 * A declaration that already carries a parameter cannot reach here —
 * `normaliseMediaType` refuses it at boot — so this never doubles one up.
 */
export function wireMediaType(media: MediaType): string {
  return `${media}; charset=utf-8`
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split on commas that are not inside a quoted string, capped at `limit`.
 *
 * The quote handling is not theoretical tidiness: a media-range parameter is
 * allowed to be a quoted string, a quoted string is allowed to contain a comma,
 * and a splitter that does not know that turns one range into two malformed
 * ones. It costs a boolean.
 */
function splitCommas(input: string, limit: number): string[] {
  const parts: string[] = []
  let start = 0
  let quoted = false

  for (let i = 0; i < input.length && parts.length < limit; i++) {
    const ch = input.charCodeAt(i)
    if (ch === 0x22 /* " */) quoted = !quoted
    else if (ch === 0x5c /* \ */ && quoted) i++
    else if (ch === 0x2c /* , */ && !quoted) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
  }

  if (parts.length < limit && start <= input.length) parts.push(input.slice(start))
  return parts
}

function splitSemicolons(input: string): string[] {
  const parts: string[] = []
  let start = 0
  let quoted = false

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    if (ch === 0x22 /* " */) quoted = !quoted
    else if (ch === 0x5c /* \ */ && quoted) i++
    else if (ch === 0x3b /* ; */ && !quoted) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
  }

  parts.push(input.slice(start))
  return parts
}

function unquote(value: string): string {
  return value.length >= 2 && value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22
    ? value.slice(1, -1)
    : value
}

/** RFC 9110 `token`, plus `*` so a range's wildcard survives the check. */
function isToken(value: string): boolean {
  if (value.length === 0) return false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    const ok =
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5a) || // A-Z (normalised away, but valid input)
      c === 0x2d || c === 0x2e || c === 0x2b || c === 0x5f || // - . + _
      c === 0x2a || c === 0x21 || c === 0x23 || c === 0x24 || // * ! # $
      c === 0x25 || c === 0x26 || c === 0x27 || c === 0x5e || // % & ' ^
      c === 0x60 || c === 0x7c || c === 0x7e // ` | ~
    if (!ok) return false
  }
  return true
}
