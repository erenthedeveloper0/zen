import { queryStringOf, safeDecode } from '../primitives/path.ts'

export type QueryRecord = Record<string, string | string[] | undefined>

/**
 * Query parsing — rfcs/0001 §11.4, §19.5.
 *
 * Single pass, no regex, no `URLSearchParams` (which allocates an iterator per
 * entry). Repeated keys become arrays; `nested` (`a[b]=1`) parsing is *not*
 * implemented by default: it is a prototype-pollution and algorithmic-complexity
 * surface that almost nobody needs.
 *
 * The `maxParams` cap defends against hash flooding.
 */
export function parseQuery(url: string, maxParams = 100): QueryRecord {
  const qs = queryStringOf(url)
  const out: QueryRecord = Object.create(null) as QueryRecord
  if (qs === '') return out

  let count = 0
  let start = 0

  while (start <= qs.length) {
    let end = qs.indexOf('&', start)
    if (end === -1) end = qs.length
    if (end === start) {
      start = end + 1
      continue
    }

    if (++count > maxParams) break

    let eq = qs.indexOf('=', start)
    if (eq === -1 || eq > end) eq = end

    const rawKey = qs.slice(start, eq)
    const rawValue = eq === end ? '' : qs.slice(eq + 1, end)

    const key = safeDecode(rawKey)
    const value = safeDecode(rawValue)

    if (key !== null && value !== null && !isForbiddenKey(key)) {
      const existing = out[key]
      if (existing === undefined) out[key] = value
      else if (Array.isArray(existing)) existing.push(value)
      else out[key] = [existing, value]
    }

    start = end + 1
  }

  return out
}

/** §19.5 — prototype pollution defence, applied in every parser. */
export function isForbiddenKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

export function stringifyQuery(params: Readonly<Record<string, unknown>>): string {
  const parts: string[] = []
  for (const key in params) {
    const value = params[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.join('&')
}
