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
 */
export function pathnameOf(url: string): string {
  const q = url.indexOf('?')
  const h = url.indexOf('#')
  let end = url.length
  if (q !== -1) end = q
  if (h !== -1 && h < end) end = h
  return end === url.length ? url : url.slice(0, end)
}

export function queryStringOf(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return ''
  const h = url.indexOf('#', q)
  return h === -1 ? url.slice(q + 1) : url.slice(q + 1, h)
}

/** Percent-decoding that never throws; returns `null` on malformed input. */
export function safeDecode(value: string): string | null {
  if (value.indexOf('%') === -1 && value.indexOf('+') === -1) return value
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return null
  }
}
