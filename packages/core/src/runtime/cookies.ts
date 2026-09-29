import type { SetCookie } from '../contracts/reply.ts'
import { decodeComponent } from '../primitives/path.ts'
import { isForbiddenKey } from './query.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

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
      // Percent-decoding only: `+` in a cookie is a literal (base64 session ids
      // are full of them), never form-encoding's space.
      const decoded = decodeComponent(value)
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
export function serializeCookie(cookie: SetCookie, secureRequest = false): string {
  // The value is percent-encoded, so it cannot break out of its attribute. The
  // name, `Domain` and `Path` are written as given — and a `;` in any of them
  // starts a new attribute: `path: '/; Domain=evil.example'` sets a Domain the
  // application never chose. The header bag rejects CR and LF; `;` and the
  // other separators are legal in a header, so they are refused here (§19.5).
  assertCookie(cookie)

  let out = `${cookie.name}=${encodeURIComponent(cookie.value)}`
  if (cookie.maxAge !== undefined && Number.isFinite(cookie.maxAge)) out += `; Max-Age=${Math.floor(cookie.maxAge)}`
  if (cookie.domain !== undefined) out += `; Domain=${cookie.domain}`
  out += `; Path=${cookie.path ?? '/'}`
  if (cookie.expires !== undefined) out += `; Expires=${cookie.expires.toUTCString()}`
  if (cookie.httpOnly !== false) out += '; HttpOnly'
  // §19.2: `Secure` by default when the request arrived over HTTPS — which is
  // what `ctx.secure` says, and it only says so behind a trusted proxy
  // (§19.4). `__Secure-`/`__Host-` cookies and `SameSite=None` are discarded by
  // browsers without it, so there it is not a choice at all: leaving it off
  // would set a cookie that never arrives. An explicit `secure: false` wins.
  const sameSite = cookie.sameSite ?? 'lax'
  if (cookie.secure === true || (cookie.secure === undefined && (secureRequest || requiresSecure(cookie.name, sameSite)))) {
    out += '; Secure'
  }
  if (cookie.partitioned) out += '; Partitioned'
  out += `; SameSite=${capitalise(sameSite)}`
  return out
}

/**
 * Refuse a cookie whose name, `Domain` or `Path` would break the header — the
 * check `serializeCookie` makes, exported so `ctx.res.cookie()` can make it when
 * the cookie is staged rather than at egress (see `ReplyStage`).
 */
export function assertCookie(cookie: Pick<SetCookie, 'name' | 'domain' | 'path'>): void {
  if (typeof cookie.name !== 'string' || !COOKIE_NAME.test(cookie.name)) throw invalidCookie('name', String(cookie.name))
  if (cookie.domain !== undefined && !COOKIE_ATTRIBUTE.test(cookie.domain)) throw invalidCookie('domain', cookie.domain)
  if (cookie.path !== undefined && !COOKIE_ATTRIBUTE.test(cookie.path)) throw invalidCookie('path', cookie.path)
}

/** RFC 6265 §4.1.1 `token`: no controls, whitespace or separators. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** An attribute value may be anything printable except `;`. */
const COOKIE_ATTRIBUTE = /^[\x20-\x3A\x3C-\x7E]*$/

function requiresSecure(name: string, sameSite: string): boolean {
  return sameSite === 'none' || name.startsWith('__Secure-') || name.startsWith('__Host-')
}

function invalidCookie(part: string, value: string): ZenError {
  return new ZenError(
    Codes.HEADER_INVALID,
    `Cookie ${part} ${JSON.stringify(value)} contains a character that would end the attribute early.`,
    { status: 500, expose: false },
  )
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
