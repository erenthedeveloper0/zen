import type { PlainContext } from './context.ts'
import { PayloadTooLarge, UnsupportedMediaType, BodyInvalid } from '../errors/http-errors.ts'
import { isForbiddenKey } from './query.ts'

export interface BodyOptions {
  /** Enforced *during* the read — a 5GB body aborts at byte limit+1, not after
   *  buffering then rejecting (§19.3). */
  readonly maxSize: number
  readonly maxDepth: number
  /**
   * Fields in a form (`application/x-www-form-urlencoded`) body. The query
   * string has had a cap since 0.1 (§19.2's "param count", hash flooding); a
   * form is a query string with a different content type and had none, so a
   * 1 MB body of `a=&a=&…` built a quarter of a million entries.
   */
  readonly maxFields: number
}

export const BODY_DEFAULTS: BodyOptions = {
  maxSize: 1024 * 1024, // 1 MB — §19.2
  maxDepth: 32,
  maxFields: 1000,
}

export type BodyParser = (bytes: Uint8Array, ctx: PlainContext, opts: BodyOptions) => unknown

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Body intake — rfcs/0001 §4.2 stage 6.
 *
 * The single biggest divergence from Express, where `express.json()` reads and
 * parses every body on every matched route regardless of need. Here the intake
 * step is *not emitted into the pipeline at all* unless the route declares a
 * body, so GET-heavy workloads pay nothing.
 */
export function makeIntake(parsers: ReadonlyMap<string, BodyParser>, opts: BodyOptions) {
  return async function intake(raw: unknown): Promise<void> {
    const ctx = raw as PlainContext
    const source = ctx.raw.body

    if (source.kind === 'none') {
      ctx.$body = undefined
      return
    }

    const declared = source.length
    if (declared !== undefined && declared > opts.maxSize) {
      throw new PayloadTooLarge(`Body of ${declared} bytes exceeds the ${opts.maxSize} byte limit`)
    }

    const bytes = await source.read(opts.maxSize, ctx.signal)
    if (bytes.length === 0) {
      ctx.$body = undefined
      return
    }

    const contentType = ctx.raw.header('content-type')
    const media = contentType === undefined ? 'application/json' : mediaTypeOf(contentType)
    // A `+json` structured suffix (RFC 6839) *is* JSON — `application/merge-patch+json`,
    // `application/vnd.api+json` — and refusing it with a 415 made every client
    // that labels its bodies precisely look broken. Consulted only on a miss, so
    // an explicitly registered parser for one of them still wins.
    const parser = parsers.get(media) ?? (media.endsWith('+json') ? parsers.get('application/json') : undefined)
    if (parser === undefined) {
      throw new UnsupportedMediaType(`No parser registered for content type "${media}"`, {
        details: { available: [...parsers.keys()] },
      })
    }

    ctx.$body = parser(bytes, ctx, opts)
  }
}

/**
 * Compose `onParse` hooks into the intake stage — rfcs/0001 §9.2, phase 3.
 *
 * The first hook to return anything other than `undefined` *is* the parsed
 * body, and the built-in parser registry never runs. That is the phase's whole
 * purpose: multipart, protobuf, msgpack and "this one legacy endpoint posts
 * XML" are all one hook, with no monkey-patching of the parser table and no
 * global `app.use(bodyParser)` that then reads every body on every route.
 *
 * Composed rather than unrolled into the pipeline, and only ever reachable from
 * a route that declares a body — a parse hook cannot resurrect a stage the
 * route does not have (§4.2 stage 6), which is what keeps GET-heavy workloads
 * paying nothing for a multipart plugin someone installed.
 */
export function withParseHooks(
  intake: (ctx: unknown) => Promise<void>,
  hooks: readonly Function[],
): (ctx: unknown) => Promise<void> {
  if (hooks.length === 0) return intake
  return async function intakeWithParseHooks(raw: unknown): Promise<void> {
    const ctx = raw as PlainContext
    for (const hook of hooks) {
      const parsed = await (hook as (c: unknown, s: unknown) => unknown)(ctx, ctx.raw.body)
      if (parsed !== undefined) {
        ctx.$body = parsed
        return
      }
    }
    await intake(raw)
  }
}

export function mediaTypeOf(contentType: string): string {
  const semi = contentType.indexOf(';')
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
}

/**
 * Whether a JSON text could hold a key the reviver exists to drop — §19.5.
 *
 * A key is `__proto__`, `constructor` or `prototype` only if the text spells
 * the word out or writes some of it as a `\u` escape: the other JSON escapes
 * (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`) cannot produce a letter or an
 * underscore. A text with none of the three words and no `\u` therefore parses
 * to exactly what the reviver would have produced, and skips it — which matters
 * because a reviver makes `JSON.parse` about eight times slower on every body,
 * and it was the largest per-request cost in the framework. A body that merely
 * mentions `constructor` in a value takes the careful path; that is correct,
 * and rare.
 */
const MAY_POLLUTE = /__proto__|constructor|prototype|\\u/

export const jsonParser: BodyParser = (bytes, _ctx, opts) => {
  const text = decoder.decode(bytes)
  let parsed: unknown
  try {
    // §19.5 — prototype pollution is stripped during revival rather than after,
    // so a polluted object never exists, not even briefly; a text that cannot
    // carry a forbidden key is not revived at all.
    parsed = MAY_POLLUTE.test(text) ? JSON.parse(text, protoStripper) : JSON.parse(text)
  } catch (cause) {
    throw new BodyInvalid('Body is not valid JSON', { cause })
  }
  assertDepth(parsed, opts.maxDepth)
  return parsed
}

export const textParser: BodyParser = (bytes) => decoder.decode(bytes)

export const rawParser: BodyParser = (bytes) => bytes

export const formParser: BodyParser = (bytes, _ctx, opts) => {
  const text = decoder.decode(bytes)
  const out: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  // `?? BODY_DEFAULTS` so a parser invoked with a hand-built options object from
  // before the field existed still has a bound rather than none.
  const maxFields = opts.maxFields ?? BODY_DEFAULTS.maxFields
  let fields = 0
  // Scanned with `indexOf` rather than `split('&')`, which would materialise
  // every pair before the bound below could refuse the body.
  for (let start = 0; start <= text.length;) {
    let end = text.indexOf('&', start)
    if (end === -1) end = text.length
    const pair = text.slice(start, end)
    start = end + 1
    if (pair === '') continue
    // Refused rather than truncated, unlike the query string: a form is data
    // the client meant to submit, and silently keeping the first thousand
    // fields of it is data loss that looks like success.
    if (++fields > maxFields) {
      throw new PayloadTooLarge(`Form body has more than ${maxFields} fields`)
    }
    const eq = pair.indexOf('=')
    const key = decodeFormComponent(eq === -1 ? pair : pair.slice(0, eq))
    const value = eq === -1 ? '' : decodeFormComponent(pair.slice(eq + 1))
    if (key === null || value === null || isForbiddenKey(key)) continue
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

export const DEFAULT_PARSERS: ReadonlyMap<string, BodyParser> = new Map<string, BodyParser>([
  ['application/json', jsonParser],
  ['application/problem+json', jsonParser],
  ['text/plain', textParser],
  ['text/html', textParser],
  ['application/x-www-form-urlencoded', formParser],
  ['application/octet-stream', rawParser],
])

function protoStripper(this: unknown, key: string, value: unknown): unknown {
  return isForbiddenKey(key) ? undefined : value
}

function decodeFormComponent(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/**
 * Bounded work: stack exhaustion in parsers is a real DoS vector (§19.2). The
 * body is refused when any value in it, a scalar included, sits more than
 * `max` levels down — the top-level value being level 0.
 */
function assertDepth(value: unknown, max: number): void {
  if (max < 0) throw tooDeep(max)
  if (typeof value === 'object' && value !== null) assertChildren(value, max, 1)
}

/**
 * The walk visits containers only, and judges the level of their children by
 * the container's own: a scalar is refused for where it sits without a call
 * of its own. It made one call per value, and scalars are most of the values:
 * on a 1 KB order body that walk was about a tenth of a clean body's intake
 * once the reviver had gone, and this one takes some 40% less.
 */
function assertChildren(container: object, max: number, level: number): void {
  if (Array.isArray(container)) {
    if (level > max && container.length > 0) throw tooDeep(max)
    for (let i = 0; i < container.length; i++) {
      const item: unknown = container[i]
      if (typeof item === 'object' && item !== null) assertChildren(item, max, level + 1)
    }
    return
  }
  for (const key in container) {
    if (level > max) throw tooDeep(max)
    const item = (container as Record<string, unknown>)[key]
    if (typeof item === 'object' && item !== null) assertChildren(item, max, level + 1)
  }
}

const tooDeep = (max: number): Error => new BodyInvalid(`Body nesting exceeds the maximum depth of ${max}`)
