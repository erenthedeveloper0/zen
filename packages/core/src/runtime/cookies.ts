import type { SetCookie } from '../contracts/reply.ts'
import { safeDecode } from '../primitives/path.ts'
import { isForbiddenKey } from './query.ts'

export type CookieRecord = Record<string, string | undefined>

/** Single-pass scanner with explicit bounds (§19.3). */
export function parseCookies(header: string | undefined, maxCookies = 64): CookieRecord {
  const out: CookieRecord = Object.create(null) as CookieRecord
  if (!header) return out

  let start = 0
  let count = 0

  while (start < header.length) {
    let end = header.indexOf(';', start)
    if (end === -1) end = header.length

    let eq = header.indexOf('=', start)
    if (eq === -1 || eq > end) {
      start = end + 1
      continue
    }

    if (++count > maxCookies) break

    const key = header.slice(start, eq).trim()
    let value = header.slice(eq + 1, end).trim()
    if (value.length >= 2 && value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) {
      value = value.slice(1, -1)
    }

    if (key !== '' && !isForbiddenKey(key) && out[key] === undefined) {
      const decoded = safeDecode(value)
      if (decoded !== null) out[key] = decoded
    }

    start = end + 1
  }

  return out
}

/**
 * Cookies are staged as values and only serialised at egress (§13.6), so a
 * later middleware can override an earlier one's cookie by name rather than
 * emitting two conflicting `Set-Cookie` headers.
 */
export function serializeCookie(cookie: SetCookie): string {
  let out = `${cookie.name}=${encodeURIComponent(cookie.value)}`
  if (cookie.maxAge !== undefined) out += `; Max-Age=${Math.floor(cookie.maxAge)}`
  if (cookie.domain !== undefined) out += `; Domain=${cookie.domain}`
  out += `; Path=${cookie.path ?? '/'}`
  if (cookie.expires !== undefined) out += `; Expires=${cookie.expires.toUTCString()}`
  if (cookie.httpOnly !== false) out += '; HttpOnly'
  if (cookie.secure) out += '; Secure'
  if (cookie.partitioned) out += '; Partitioned'
  out += `; SameSite=${capitalise(cookie.sameSite ?? 'lax')}`
  return out
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
