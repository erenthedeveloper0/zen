import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { NotFound, withoutStack } from '@erenthedeveloper0/zen-core'

/**
 * File responses — rfcs/0001 §13.5.
 *
 * Everything that can fail happens here, **before the status line is written**.
 * That ordering is the feature: a file that does not exist is an ordinary 404
 * that goes through the error engine, `onError` hooks and the problem-details
 * envelope, rather than a 200 whose stream then fails and drops the connection
 * — which is what this adapter did before, and what a client reports as
 * "other side closed" with no status at all.
 *
 * The body stays un-materialised in the Reply IR (§13.2) precisely so this can
 * happen here: only the adapter can `stat`, and only after the `stat` does it
 * know the length, the validators, and whether a range is satisfiable.
 */

export interface FilePlan {
  /** The resolved path to stream. */
  readonly path: string
  /** 200, 206, 304 or 416 — what actually goes out. */
  readonly status: number
  /** Representation headers, applied only where the reply did not set its own. */
  readonly headers: ReadonlyArray<readonly [string, string]>
  /** Inclusive byte offsets for a 206. */
  readonly range: { readonly start: number; readonly end: number } | null
  /** False for `HEAD`, 304 and 416: headers only. */
  readonly body: boolean
}

export interface FileRequest {
  readonly method: string
  header(name: string): string | undefined
}

export interface FileBody {
  readonly path: string
  readonly media?: string | undefined
  readonly root?: string | undefined
}

/**
 * Decide what to send for a file body.
 *
 * `status` is the reply's own: conditional and range handling apply only to a
 * plain 200, because a handler that chose a 404 page or a 500 page served from
 * disk meant that status, and a `Range` header must not turn it into a 206.
 */
export async function planFile(
  body: FileBody,
  request: FileRequest,
  status: number,
  typed: boolean,
): Promise<FilePlan> {
  const path = await confine(body.root, body.path)
  if (path === null) throw missing()

  let info
  try {
    info = await stat(path)
  } catch {
    // ENOENT, EACCES and ENOTDIR all answer 404. Distinguishing them would tell
    // a client which paths exist but are unreadable, which is exactly the
    // information a traversal probe is looking for.
    throw missing()
  }
  if (!info.isFile()) throw missing()

  const size = info.size
  const lastModified = info.mtime.toUTCString()
  // Weak, and labelled so: size + mtime identifies a version cheaply, but two
  // different contents written within one mtime tick would share it. A strong
  // validator needs a content hash, which means reading the file to answer a
  // request that may only want to know whether it changed.
  const etag = `W/"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`

  const validators: Array<[string, string]> = [
    ['last-modified', lastModified],
    ['etag', etag],
  ]
  const representation: Array<[string, string]> = [...validators, ['accept-ranges', 'bytes']]
  if (!typed) representation.push(['content-type', body.media ?? mediaTypeFor(path)])

  const head = request.method === 'HEAD'
  const conditional = status === 200 && (request.method === 'GET' || head)

  if (conditional && notModified(request, etag, info.mtimeMs)) {
    return { path, status: 304, headers: validators, range: null, body: false }
  }

  if (conditional && !head) {
    const range = rangeOf(request, size, etag, lastModified)
    if (range === 'unsatisfiable') {
      return {
        path,
        status: 416,
        headers: [['content-range', `bytes */${size}`], ...validators],
        range: null,
        body: false,
      }
    }
    if (range !== null) {
      return {
        path,
        status: 206,
        headers: [
          ...representation,
          ['content-range', `bytes ${range.start}-${range.end}/${size}`],
          ['content-length', String(range.end - range.start + 1)],
        ],
        range,
        body: true,
      }
    }
  }

  return {
    path,
    status,
    headers: [...representation, ['content-length', String(size)]],
    range: null,
    body: !head,
  }
}

/**
 * Resolve `path` inside `root`, or `null` when it escapes.
 *
 * The check runs on the **real** path — after symlinks — because a symlink
 * inside a public directory pointing at `/etc` passes every string comparison
 * and then serves `/etc`. A leading slash on `path` is taken as relative to the
 * root, since `ctx.file('/' + ctx.params.path, { root })` is an easy line to
 * write and "resolve an absolute path, then refuse it" would 404 every request.
 */
async function confine(root: string | undefined, path: string): Promise<string | null> {
  if (path.includes('\0')) return null
  if (root === undefined) return path

  const base = await realBase(root)
  const candidate = resolve(base, path.replace(/^[/\\]+/, ''))
  if (!within(base, candidate)) return null

  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    // Does not exist. The `stat` that follows reports it as the 404 it is.
    return candidate
  }
  return within(base, real) ? real : null
}

const bases = new Map<string, string>()

/** A root is declared by the application and never changes; resolve it once. */
async function realBase(root: string): Promise<string> {
  const cached = bases.get(root)
  if (cached !== undefined) return cached
  let base: string
  try {
    base = await realpath(resolve(root))
  } catch {
    base = resolve(root)
  }
  bases.set(root, base)
  return base
}

function within(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * RFC 9110 §13.1.2 and §13.1.3: `If-None-Match` wins when present, and uses
 * weak comparison; `If-Modified-Since` is consulted only without it.
 */
function notModified(request: FileRequest, etag: string, mtimeMs: number): boolean {
  const inm = request.header('if-none-match')
  if (inm !== undefined) {
    if (inm.trim() === '*') return true
    const ours = opaque(etag)
    return inm.split(',').some((tag) => opaque(tag.trim()) === ours)
  }
  const ims = request.header('if-modified-since')
  if (ims === undefined) return false
  const since = Date.parse(ims)
  // HTTP dates have one-second resolution; the file's mtime does not.
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000)
}

function opaque(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/**
 * One byte range, or `null` to send the whole file.
 *
 * Several ranges are answered with the whole file rather than a
 * `multipart/byteranges` body. RFC 9110 §14.2 permits ignoring `Range`, every
 * client handles a 200 to a range request, and a multi-range response is a
 * known amplification vector (§19.3) for a feature almost nothing uses.
 */
function rangeOf(
  request: FileRequest,
  size: number,
  etag: string,
  lastModified: string,
): { start: number; end: number } | 'unsatisfiable' | null {
  const header = request.header('range')
  if (header === undefined || !header.startsWith('bytes=')) return null

  // A range against a representation that changed since the client cached the
  // first part would splice two versions together. Our ETag is weak, and a weak
  // validator never matches `If-Range` (RFC 9110 §13.1.5), so only the date form
  // can keep the range.
  const ifRange = request.header('if-range')
  if (ifRange !== undefined && ifRange !== lastModified) return null

  const spec = header.slice(6).trim()
  if (spec.includes(',')) return null

  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const first = spec.slice(0, dash).trim()
  const last = spec.slice(dash + 1).trim()
  if (!DIGITS.test(first) && first !== '') return null
  if (!DIGITS.test(last) && last !== '') return null
  if (first === '' && last === '') return null

  if (size === 0) return 'unsatisfiable'

  if (first === '') {
    // `bytes=-500` — the final 500 bytes.
    const suffix = Number(last)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(first)
  if (start >= size) return 'unsatisfiable'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (end < start) return null
  return { start, end }
}

const DIGITS = /^\d{1,15}$/

/** A routine refusal: its stack would only ever show this module (§28.8). */
function missing(): InstanceType<typeof NotFound> {
  return withoutStack(() => new NotFound('File not found'))
}

/**
 * Content types for the extensions a web service actually serves.
 *
 * A table rather than a dependency: `mime-types` is 100 kB of database for a
 * question this adapter answers for static assets, exports and downloads. An
 * application serving something exotic passes `media` and skips the lookup.
 */
export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream'
}

const UTF8 = '; charset=utf-8'

const MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', `text/html${UTF8}`],
  ['.htm', `text/html${UTF8}`],
  ['.css', `text/css${UTF8}`],
  ['.js', `text/javascript${UTF8}`],
  ['.mjs', `text/javascript${UTF8}`],
  ['.cjs', `text/javascript${UTF8}`],
  ['.json', `application/json${UTF8}`],
  ['.map', `application/json${UTF8}`],
  ['.webmanifest', `application/manifest+json${UTF8}`],
  ['.txt', `text/plain${UTF8}`],
  ['.md', `text/markdown${UTF8}`],
  ['.csv', `text/csv${UTF8}`],
  ['.xml', `application/xml${UTF8}`],
  ['.svg', `image/svg+xml${UTF8}`],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
  ['.wasm', 'application/wasm'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
])
