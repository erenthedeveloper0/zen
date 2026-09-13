import type { PlainContext } from './context.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { PayloadTooLarge, UnsupportedMediaType, BadRequest } from '../errors/http-errors.ts'
import { isForbiddenKey } from './query.ts'

export interface BodyOptions {
  /** Enforced *during* the read — a 5GB body aborts at byte limit+1, not after
   *  buffering then rejecting (§19.3). */
  readonly maxSize: number
  readonly maxDepth: number
}

export const BODY_DEFAULTS: BodyOptions = {
  maxSize: 1024 * 1024, // 1 MB — §19.2
  maxDepth: 32,
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
    const parser = parsers.get(media)
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

export const jsonParser: BodyParser = (bytes, _ctx, opts) => {
  const text = decoder.decode(bytes)
  let parsed: unknown
  try {
    // §19.5 — prototype pollution is stripped during revival rather than after,
    // so a polluted object never exists, not even briefly.
    parsed = JSON.parse(text, protoStripper)
  } catch (cause) {
    throw new BadRequest('Body is not valid JSON', { cause, expose: true })
  }
  assertDepth(parsed, opts.maxDepth)
  return parsed
}

export const textParser: BodyParser = (bytes) => decoder.decode(bytes)

export const rawParser: BodyParser = (bytes) => bytes

export const formParser: BodyParser = (bytes) => {
  const text = decoder.decode(bytes)
  const out: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  for (const pair of text.split('&')) {
    if (pair === '') continue
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

/** Bounded work: stack exhaustion in parsers is a real DoS vector (§19.2). */
function assertDepth(value: unknown, max: number, depth = 0): void {
  if (depth > max) {
    throw new ZenError(Codes.BODY_INVALID, `Body nesting exceeds the maximum depth of ${max}`, {
      status: 400,
      expose: true,
    })
  }
  if (typeof value !== 'object' || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) assertDepth(item, max, depth + 1)
    return
  }
  for (const key in value) {
    assertDepth((value as Record<string, unknown>)[key], max, depth + 1)
  }
}
