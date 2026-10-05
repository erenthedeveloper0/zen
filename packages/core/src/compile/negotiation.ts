import type { StatusCode } from '../contracts/http.ts'
import type { AnySchema } from '../contracts/standard-schema.ts'
import type {
  MediaEncoderFactory, MediaType, NegotiationRecord, Representation, ResponseVariants,
} from '../contracts/negotiation.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { toJsonSchema } from './json-schema.ts'
import {
  isJsonMedia, isMediaProblem, isVariantRecord, normaliseMediaType, wireMediaType,
} from './media-type.ts'
import {
  compileStatusSerializer, type SerializerBuildOptions,
} from './serializer.ts'
import { exposureDiagnostics } from './exposure.ts'
import type { Serializer } from './serializer-compiler.ts'

/**
 * Boot-time content negotiation — rfcs/0001 §13.4.
 *
 * Everything expensive about negotiation happens here, once, against the frozen
 * graph: which representations exist, in what order the server prefers them,
 * which writer produces each one, and what `Content-Type` each one carries. What
 * is left for the request is a string comparison and a reference store.
 *
 * That split is the whole reason §13.4 says "known at boot, so this is an index
 * lookup, not a scan". The per-request half lives in `runtime/negotiation.ts`
 * and consumes only what this file produced.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The encoder seam
// ─────────────────────────────────────────────────────────────────────────────

const encoders = new Map<MediaType, MediaEncoderFactory>()

/**
 * Teach Zen how to write one media type.
 *
 * The exact shape of `registerSchemaConverter` (§13.3.6) and for the exact same
 * reason: `@erenthedeveloper0/zen-core` has zero runtime dependencies and imports nothing from
 * `node:` (§19.8, B3), so it is never going to contain a CSV writer or an XML
 * writer, and a framework that shipped one would have picked a dialect on the
 * author's behalf.
 *
 * ```ts
 * registerMediaEncoder('text/csv', (schema) => {
 *   const columns = Object.keys(schema?.properties ?? {})     // resolved once, at boot
 *   return (rows) => [columns.join(','), ...] .join('\n')
 * })
 * ```
 *
 * Registrations are process-global, like slots and schema converters, and for
 * the same reason: an encoder is a property of the media type, not of one
 * application, and two apps in one process that disagreed about what `text/csv`
 * means would be a worse problem than the one a per-app registry solves.
 */
export function registerMediaEncoder(media: MediaType, factory: MediaEncoderFactory): void {
  encoders.set(media.trim().toLowerCase(), factory)
}

export function mediaEncoderFor(media: MediaType): MediaEncoderFactory | undefined {
  return encoders.get(media)
}

/** Test-only, like `__resetSchemaConverters`. */
export function __resetMediaEncoders(): void {
  encoders.clear()
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

export interface NegotiationBuildResult {
  /** `null` when the route declared no variant form — the common case. */
  readonly record: NegotiationRecord | null
  /** One entry per offer, in declaration order. `null` when `record` is. */
  readonly representations: ReadonlyMap<MediaType, Representation> | null
  readonly diagnostics: readonly Diagnostic[]
}

const NONE: NegotiationBuildResult = { record: null, representations: null, diagnostics: [] }

/**
 * Derive a route's negotiation plan from its response declaration.
 *
 * Diagnostics are *aggregated*, never thrown (§12.7): a route with three
 * unregistered media types reports three lines in one boot, not one line in
 * three restarts. When anything is wrong the plan comes back `null` alongside
 * the diagnostics, because `ready()` is going to refuse the boot anyway and a
 * half-built plan is only an opportunity for a second, more confusing failure.
 */
export function buildNegotiation(
  response: Readonly<Record<StatusCode, unknown>> | undefined,
  options: SerializerBuildOptions,
): NegotiationBuildResult {
  if (response === undefined) return NONE

  // ── 1. which statuses use the variant form ──────────────────────────────
  //
  // `unknown` values, not `AnySchema`: `isVariantRecord` is a test on the
  // *keys*, and it cannot say anything about what is under them. What a value
  // turns out to be is settled below by the same probe the plain form uses, so
  // `200: { 'application/json': 42 }` produces §13.3.6's unconvertible-schema
  // warning rather than a second, differently-worded one from here.
  const variantStatuses: Array<{ status: number; variants: Readonly<Record<string, unknown>> }> = []
  for (const key of Object.keys(response)) {
    const status = Number(key)
    if (!Number.isInteger(status)) continue // `buildSerializerTable` reports this
    const declared = (response as Record<string, unknown>)[key]
    if (isVariantRecord(declared)) variantStatuses.push({ status, variants: declared })
  }
  if (variantStatuses.length === 0) return NONE

  const diagnostics: Diagnostic[] = []

  // ── 2. validate every declared media type ───────────────────────────────
  const sequences = new Map<number, MediaType[]>()
  for (const { status, variants } of variantStatuses) {
    const offers: MediaType[] = []
    for (const raw of Object.keys(variants)) {
      const parsed = normaliseMediaType(raw)
      if (isMediaProblem(parsed)) {
        diagnostics.push(mediaTypeDiagnostic(options.routeId, status, raw, parsed))
        continue
      }
      if (offers.includes(parsed.media)) {
        diagnostics.push({
          severity: 'error',
          code: Codes.MEDIA_TYPE_INVALID,
          message: `${options.routeId} response ${status} declares "${parsed.media}" twice.`,
          hint: 'Media types are compared lowercased, so "Application/JSON" and "application/json" are one key. Keep one.',
          consequence: 'Only one of the two schemas could ever be reached, and which one depends on key order.',
          locations: [`${options.routeId} → response ${status}`],
        })
        continue
      }
      offers.push(parsed.media)
    }
    sequences.set(status, offers)
  }

  // ── 3. every variant status must offer the same thing, in the same order ─
  //
  // The offer list is a property of the *route*, because negotiation happens at
  // stage 5 and the status is not known until stage 8. Two statuses that
  // disagree would make "can this route produce CSV?" unanswerable before the
  // handler runs, and answering it afterwards means paying for the work you are
  // about to refuse — which is the trade §4.2 stage 5 exists to avoid.
  const first = variantStatuses[0] as { status: number }
  const reference = sequences.get(first.status) as MediaType[]
  for (const { status } of variantStatuses.slice(1)) {
    const offers = sequences.get(status) as MediaType[]
    if (offers.length === reference.length && offers.every((m, i) => m === reference[i])) continue
    diagnostics.push({
      severity: 'error',
      code: Codes.NEGOTIATION_INCONSISTENT,
      message:
        `${options.routeId} offers [${reference.join(', ')}] for ${first.status} but ` +
        `[${offers.join(', ')}] for ${status}.`,
      hint:
        'Declare the same media types, in the same order, for every status that uses the variant form. ' +
        'A status that is not negotiated — an error envelope, a 204 — should use the plain form: `404: ProblemSchema`.',
      consequence:
        'The `Accept` header is matched once, before the handler runs, so the offer list cannot depend on the status. ' +
        'Order is part of it: it is the server\'s preference, and it decides ties.',
      locations: [`${options.routeId} → response ${first.status}`, `${options.routeId} → response ${status}`],
    })
  }

  if (reference.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: Codes.MEDIA_TYPE_INVALID,
      message: `${options.routeId} response ${first.status} declares no usable media type.`,
      hint: 'Write `{ \'application/json\': Schema }`, or use the plain form `200: Schema` if the route serves one representation.',
      locations: [`${options.routeId} → response ${first.status}`],
    })
  }

  if (diagnostics.length > 0) return { record: null, representations: null, diagnostics }

  // ── 4. one Representation per offer ─────────────────────────────────────
  const covered = Object.freeze(new Set(variantStatuses.map((v) => v.status)))
  const representations = new Map<MediaType, Representation>()
  for (const media of reference) {
    const writers = new Map<number, Serializer>()

    for (const { status, variants } of variantStatuses) {
      const schema = mediaSchemaOf(variants, media)
      if (schema === null || schema === undefined) continue

      if (isJsonMedia(media)) {
        // The same compiled serializer §13.3 builds for the plain form, with the
        // same guarantee: an undeclared field cannot be emitted. A versioned
        // JSON API — the most common reason to negotiate at all — therefore
        // needs no encoder and costs nothing this subsystem did not already own.
        //
        // `mode: 'off'` turns the compiled contract off here exactly as it does
        // there. The *representation* survives: what the client and the route
        // agreed on is still the Content-Type, and disabling response filtering
        // is not the same statement as disabling negotiation.
        if (options.mode === 'off') continue
        const built = compileStatusSerializer(schema, status, options, media)
        diagnostics.push(...built.diagnostics)
        if (built.serializer !== null) writers.set(status, built.serializer)
        continue
      }

      const factory = mediaEncoderFor(media)
      if (factory === undefined) {
        diagnostics.push({
          severity: 'error',
          code: Codes.MEDIA_TYPE_UNSUPPORTED,
          message: `${options.routeId} response ${status} declares "${media}", and nothing knows how to write it.`,
          hint:
            `Register an encoder before ready(): registerMediaEncoder('${media}', (schema) => (value) => ...). ` +
            'The factory runs once per route and status at boot, so resolve the shape there and return a writer that only appends strings.',
          consequence:
            'Booting anyway would mean sending a JSON body under this Content-Type, which is a harder failure to diagnose ' +
            'than a refused boot: the client parses what it was told it was getting and fails somewhere else.',
          locations: [`${options.routeId} → response ${status}`],
        })
        continue
      }

      // The encoder gets the shape §13.3's serializer would have got — `null`
      // when the schema cannot be converted, which is the same honest `null`
      // §13.3.6 row 2 reports rather than a pretence that the contract holds.
      const shape = toJsonSchema(schema, 'output')
      // The same check the JSON writer gets: an encoder builds its columns from
      // this shape, so a CSV export could otherwise carry a field the JSON
      // representation of the same route may not (§13.3, §13.4.4).
      if (shape !== null) {
        const exposed = exposureDiagnostics(shape, { routeId: options.routeId, status, media })
        diagnostics.push(...exposed)
        if (exposed.some((d) => d.severity === 'error')) continue
      }
      try {
        writers.set(status, factory(shape, { routeId: options.routeId, status, media }))
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: Codes.MEDIA_TYPE_UNSUPPORTED,
          message:
            `${options.routeId} response ${status}: the encoder for "${media}" refused this schema — ` +
            (error instanceof Error ? error.message : String(error)),
          hint:
            shape === null
              ? 'The schema could not be converted to JSON Schema, so the encoder was handed `null`. Register a converter for the schema library, or declare the shape with jsonSchema().'
              : 'The encoder threw while resolving the shape at boot. Either the schema is one it cannot write, or the encoder needs a case for it.',
          locations: [`${options.routeId} → response ${status}`],
        })
      }
    }

    representations.set(media, {
      media,
      contentType: wireMediaType(media),
      statuses: covered,
      writers,
    })
  }

  // Errors refuse the plan; warnings travel with it. Any diagnostic used to
  // drop the plan, so a warning — an unconvertible JSON variant, a
  // `format: 'password'` field — quietly turned a negotiated route back into a
  // plain one, answering JSON to a client that asked for CSV, which is what
  // §13.4.4 says keeping the writers apart from the statuses exists to prevent.
  if (diagnostics.some((d) => d.severity === 'error')) return { record: null, representations: null, diagnostics }

  return {
    record: {
      offers: Object.freeze(reference.slice()),
      statuses: Object.freeze(variantStatuses.map((v) => v.status)),
    },
    representations,
    diagnostics,
  }
}

/**
 * The schema this status declares for this media type.
 *
 * Keys are compared after normalisation, so `Application/JSON` in the source
 * finds the `application/json` offer. Duplicates were already refused above, so
 * the first match is the only match.
 */
function mediaSchemaOf(
  variants: Readonly<Record<string, unknown>>,
  media: MediaType,
): AnySchema | null | undefined {
  for (const raw of Object.keys(variants)) {
    const parsed = normaliseMediaType(raw)
    if (!isMediaProblem(parsed) && parsed.media === media) {
      const value = variants[raw]
      // The one cast, and it is the same one the plain form makes implicitly:
      // a declaration is *claimed* to be a schema, and `toJsonSchema` is what
      // finds out. Anything that is not one comes back `null` from the probe
      // and takes the honest-warning path.
      return value === null || value === undefined ? null : (value as AnySchema)
    }
  }
  return undefined
}

function mediaTypeDiagnostic(
  routeId: string,
  status: number,
  raw: string,
  problem: 'not-a-media-type' | 'has-parameters' | 'wildcard',
): Diagnostic {
  const where = `${routeId} → response ${status}`
  if (problem === 'has-parameters') {
    return {
      severity: 'error',
      code: Codes.MEDIA_TYPE_INVALID,
      message: `${routeId} response ${status} declares "${raw}", which carries a parameter.`,
      hint: `Declare the bare type: "${raw.slice(0, raw.indexOf(';')).trim()}". Zen appends "; charset=utf-8" on the wire itself.`,
      consequence:
        'An Accept header never carries this parameter, so the declaration would match nothing and the route would ' +
        'answer 406 for every request — the failure mode of a CORS allowlist with a trailing slash (§32.4).',
      locations: [where],
    }
  }
  if (problem === 'wildcard') {
    return {
      severity: 'error',
      code: Codes.MEDIA_TYPE_INVALID,
      message: `${routeId} response ${status} declares "${raw}", and a route cannot offer a wildcard.`,
      hint: 'List the media types this route can actually produce. A wildcard is the client\'s word, not the server\'s.',
      consequence: 'There would be no answer to what Content-Type the response carries, and the 406 could never be reached.',
      locations: [where],
    }
  }
  return {
    severity: 'error',
    code: Codes.MEDIA_TYPE_INVALID,
    message: `${routeId} response ${status} declares "${raw}", which is not a media type.`,
    hint: 'A media type is `type/subtype` — `application/json`, `text/csv`, `application/vnd.acme.v2+json`.',
    locations: [where],
  }
}
