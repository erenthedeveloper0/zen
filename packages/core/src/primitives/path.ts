/** Stratum 0 — no framework imports. */

/**
 * Normalise a path: leading slash, no trailing slash (except root), no empty or
 * `.` segments, collapsed duplicate slashes. Deterministic and total.
 */
export function normalizePath(path: string): string {
  if (path === '' || path === '/') return '/'
  let out = path
  if (out.charCodeAt(0) !== 47 /* / */) out = '/' + out
  if (out.indexOf('//') !== -1) out = out.replace(/\/{2,}/g, '/')
  if (out.length > 1 && out.charCodeAt(out.length - 1) === 47) out = out.slice(0, -1)
  return out
}

/** Compose a collection prefix with a child path. */
export function joinPath(prefix: string, path: string): string {
  const p = normalizePath(prefix)
  const c = normalizePath(path)
  if (p === '/') return c
  if (c === '/') return p
  return p + c
}

/**
 * Split a *normalised* path into segments with no leading empty entry.
 * `/users/42` → `['users', '42']`; `/` → `[]`.
 */
export function splitSegments(path: string): string[] {
  if (path === '/' || path === '') return []
  const start = path.charCodeAt(0) === 47 ? 1 : 0
  const end = path.length > 1 && path.charCodeAt(path.length - 1) === 47 ? path.length - 1 : path.length
  if (start >= end) return []
  return path.slice(start, end).split('/')
}

/**
 * Extract the pathname from a raw request target without constructing a URL.
 * `new URL()` costs ~2µs and allocates; this is an `indexOf` and a `slice`.
 *
 * The absolute form — `GET http://api.example/users HTTP/1.1` — is one
 * comparison away from the fast path and only paid for when it is used. RFC
 * 9112 §3.2.2 says a server MUST accept it, clients behind a forward proxy
 * send it, and Node hands it to the application verbatim: treated as a path it
 * matched nothing, so every such request was a 404.
 */
export function pathnameOf(url: string): string {
  const target = url.charCodeAt(0) === 47 /* / */ ? url : originForm(url)
  const q = target.indexOf('?')
  const h = target.indexOf('#')
  let end = target.length
  if (q !== -1) end = q
  if (h !== -1 && h < end) end = h
  return end === target.length ? target : target.slice(0, end)
}

/**
 * The origin form of a request target that is not already one: the part of
 * `scheme://authority/path?query` from the path on. Anything else — the
 * asterisk form `OPTIONS *`, or garbage — is returned as given, and the router
 * answers it 404 exactly as before.
 */
function originForm(url: string): string {
  const scheme = url.indexOf('://')
  if (scheme === -1) return url
  const path = url.indexOf('/', scheme + 3)
  if (path !== -1) return url.slice(path)
  // `http://example.com?x=1` — an authority with no path is the root.
  const query = url.indexOf('?', scheme + 3)
  return query === -1 ? '/' : `/${url.slice(query)}`
}

export function queryStringOf(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return ''
  const h = url.indexOf('#', q)
  return h === -1 ? url.slice(q + 1) : url.slice(q + 1, h)
}

/**
 * Form-style decoding — `+` is a space — that never throws; `null` on
 * malformed input. For query strings and `application/x-www-form-urlencoded`
 * bodies, the two places where `+` means a space.
 */
export function safeDecode(value: string): string | null {
  if (value.indexOf('%') === -1 && value.indexOf('+') === -1) return value
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

/**
 * Percent-decoding only — `+` is a plus — that never throws; `null` on
 * malformed input. For path segments and cookie values.
 *
 * The distinction is not pedantry. `+` means a space only in form encoding
 * (the query string and form bodies); in a path it is a literal, and in a
 * cookie it is usually base64. Routing both through {@link safeDecode} turned
 * a session id `ab+cd==` into `ab cd==` — a cookie no server would recognise —
 * and `/files/a+b%20c` into `a b c`.
 */
export function decodeComponent(value: string): string | null {
  if (value.indexOf('%') === -1) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
