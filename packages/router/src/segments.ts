import type { PathSegment } from '@zenjs/core'
import { ZenError, Codes, normalizePath, splitSegments } from '@zenjs/core'

/**
 * Path syntax parsing — rfcs/0001 §5.2.
 *
 * Deliberately small and statically analysable. There is no regex form: regex
 * paths defeat trie compilation, cannot be reflected into OpenAPI, and carry
 * the ReDoS history of `path-to-regexp`. Typed params (`:id<int>`) cover the
 * real use cases with better errors and free documentation.
 */
export interface ParsedPath {
  readonly path: string
  readonly segments: readonly PathSegment[]
  readonly paramNames: readonly string[]
  readonly hasOptional: boolean
}

export function parsePath(rawPath: string): ParsedPath {
  const path = normalizePath(rawPath)
  const raw = splitSegments(path)
  const segments: PathSegment[] = []
  const paramNames: string[] = []
  let hasOptional = false

  for (let i = 0; i < raw.length; i++) {
    const text = raw[i] as string
    const last = i === raw.length - 1

    if (text.charCodeAt(0) === 42 /* * */) {
      if (!last) {
        throw invalid(path, `Wildcard "*${text.slice(1)}" must be the final segment.`)
      }
      const name = text.slice(1) || 'wildcard'
      assertUniqueParam(path, paramNames, name)
      paramNames.push(name)
      segments.push({ kind: 'wildcard', value: name })
      continue
    }

    if (text.charCodeAt(0) === 58 /* : */) {
      let body = text.slice(1)
      let optional = false

      if (body.endsWith('?')) {
        if (!last) {
          throw invalid(path, `Optional parameter ":${body}" must be the final segment.`)
        }
        optional = true
        hasOptional = true
        body = body.slice(0, -1)
      }

      let type: string | undefined
      const open = body.indexOf('<')
      if (open !== -1) {
        if (!body.endsWith('>')) {
          throw invalid(path, `Malformed parameter type in ":${body}" — expected ":name<type>".`)
        }
        type = body.slice(open + 1, -1)
        body = body.slice(0, open)
        if (type === '') throw invalid(path, `Empty parameter type in segment ":${text.slice(1)}".`)
      }

      if (body === '') throw invalid(path, `Unnamed parameter in segment "${text}".`)
      assertUniqueParam(path, paramNames, body)
      paramNames.push(body)
      segments.push({ kind: 'param', value: body, type, optional })
      continue
    }

    if (text.includes(':') || text.includes('*')) {
      throw invalid(
        path,
        `Segment "${text}" mixes literal text with a parameter. ` +
          `Zen parameters occupy a whole segment; use "/:${text.replace(/[:*]/g, '')}" or move the literal into its own segment.`,
      )
    }

    segments.push({ kind: 'static', value: text })
  }

  return { path, segments, paramNames, hasOptional }
}

function assertUniqueParam(path: string, names: readonly string[], name: string): void {
  if (names.includes(name)) {
    throw invalid(path, `Duplicate parameter name ":${name}".`)
  }
}

function invalid(path: string, detail: string): ZenError {
  return new ZenError(Codes.ROUTE_INVALID_PATH, `Invalid route path "${path}": ${detail}`, {
    status: 500,
    expose: false,
  })
}

/**
 * Expand trailing optional parameters into concrete variants.
 *
 * `/posts/:slug?` becomes `/posts` and `/posts/:slug`. Doing this at build time
 * keeps the matcher free of optionality handling entirely — the hot path never
 * asks "was that segment optional?", because by then the question is settled.
 */
export function expandOptional(segments: readonly PathSegment[]): PathSegment[][] {
  const trailingOptional = countTrailingOptional(segments)
  if (trailingOptional === 0) return [segments as PathSegment[]]

  const variants: PathSegment[][] = []
  const base = segments.length - trailingOptional
  for (let extra = 0; extra <= trailingOptional; extra++) {
    variants.push(segments.slice(0, base + extra) as PathSegment[])
  }
  return variants
}

function countTrailingOptional(segments: readonly PathSegment[]): number {
  let n = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i] as PathSegment
    if (s.kind === 'param' && s.optional === true) n++
    else break
  }
  return n
}

/** Render segments back to a path template — used by diagnostics and OpenAPI. */
export function renderPath(segments: readonly PathSegment[]): string {
  if (segments.length === 0) return '/'
  let out = ''
  for (const s of segments) {
    if (s.kind === 'static') out += `/${s.value}`
    else if (s.kind === 'wildcard') out += `/*${s.value}`
    else out += `/:${s.value}${s.type !== undefined ? `<${s.type}>` : ''}${s.optional === true ? '?' : ''}`
  }
  return out
}
