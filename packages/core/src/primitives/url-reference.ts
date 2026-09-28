/**
 * What a browser will make of a URL reference — rfcs/0001 §19.5.
 *
 * Two defences have to answer a question about a URL before it is written:
 * `ctx.redirect()` ("does this send the client off this origin?") and the
 * `html` template tag ("could this `href` run script?"). Both are answered
 * here, by reading the reference the way the WHATWG URL parser does — which is
 * the parser every browser applies to a `Location` header and to a URL
 * attribute — for exactly as many characters as it takes to know, and no
 * more. No `URL` object is built: a path on this origin is decided by its
 * first two characters.
 *
 * Every rule below is a known bypass of a check written as a regular
 * expression, which is why this reads the reference rather than matching it:
 *
 *   - Leading C0 controls and spaces are stripped, and ASCII tab, LF and CR
 *     are removed *anywhere*. So `java\tscript:` is `javascript:`, and
 *     `/\t/evil.example` is `//evil.example`.
 *   - In an http(s) URL a backslash is a slash. So `/\evil.example` and
 *     `\\evil.example` are both references to another host.
 *   - A scheme is a letter, then letters, digits, `+`, `-` or `.`, ended by a
 *     colon — and `http:evil.example` is relative on an http page and absolute
 *     on an https one. So a reference that has any scheme at all is never
 *     "this origin", whatever the page's own scheme turns out to be.
 *
 * Markup adds one more. An attribute value is entity-decoded before it is
 * parsed as a URL, so `&#106;avascript:` *is* `javascript:`. Text a template
 * wrote may contain a character reference; text a hole supplied cannot,
 * because the hole was escaped (`&` → `&amp;`) and decodes back to a literal
 * `&`. So `feed` is told which one it is reading, and an `&` in written text
 * before the reference is decided makes the answer `'ambiguous'` rather than a
 * guess about what the reference decodes to.
 *
 * Stratum 0: a pure function of a string, shared by the runtime's redirect
 * check and the template tag, and differentially tested against the real
 * WHATWG parser.
 */

/**
 * - `'local'` — stays on the current origin: a path, a query or a fragment.
 * - `'network'` — `//host…`, in any spelling: another origin, in the page's scheme.
 * - `'scheme'` — has one, named by {@link UrlReference.scheme}.
 * - `'ambiguous'` — a character reference in written markup could still decide it.
 * - `'open'` — nothing decided yet; more text could make it any of the above.
 */
export type ReferenceKind = 'local' | 'network' | 'scheme' | 'ambiguous' | 'open'

// Where the reading is, while the kind is still open.
const START = 0 // before the first significant character
const SLASH = 1 // after one `/` or `\`
const WORD = 2 // inside a leading run that could still be a scheme

/**
 * An incremental reading of one URL reference.
 *
 *     new UrlReference().feed(target, false).settle()      // 'local' | 'network' | 'scheme'
 *
 * Incremental because a template's attribute value arrives in pieces — written
 * text, a hole, more written text — and the piece that decides the scheme can
 * be any of them.
 */
export class UrlReference {
  kind: ReferenceKind = 'open'
  /** Lowercased, and meaningful only once `kind` is `'scheme'`: `'javascript'`, `'https'`. */
  scheme = ''
  #at = START

  /**
   * Read more of the reference. `fromMarkup` is `true` for text a template
   * wrote — where an `&` may begin a character reference — and `false` for a
   * value that will be escaped before it is written, or for a header value.
   */
  feed(text: string, fromMarkup: boolean): this {
    if (this.kind !== 'open') return this
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      // Removed by the URL parser wherever they appear, before anything else.
      if (c === 0x09 || c === 0x0a || c === 0x0d) continue
      if (fromMarkup && c === 0x26) {
        this.kind = 'ambiguous'
        return this
      }
      if (this.#at === START) {
        if (c <= 0x20) continue // a leading C0 control or space
        if (c === 0x2f || c === 0x5c) {
          this.#at = SLASH
          continue
        }
        if (isAlpha(c)) {
          this.scheme = String.fromCharCode(c | 0x20)
          this.#at = WORD
          continue
        }
        // `?`, `#`, `.`, a digit, `%`…: a query, a fragment or a relative path.
        return this.#decide('local')
      }
      if (this.#at === SLASH) {
        return this.#decide(c === 0x2f || c === 0x5c ? 'network' : 'local')
      }
      // WORD
      if (c === 0x3a) return this.#decide('scheme')
      if (isAlpha(c)) {
        this.scheme += String.fromCharCode(c | 0x20)
        continue
      }
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
        this.scheme += String.fromCharCode(c)
        continue
      }
      // A first path segment that only looked like the start of a scheme.
      return this.#decide('local')
    }
    return this
  }

  /**
   * The answer once the whole reference has been fed. A reference still open
   * at its end had no scheme and no authority — `''`, `/`, `about` — and is a
   * relative reference on this origin.
   */
  settle(): Exclude<ReferenceKind, 'open'> {
    if (this.kind === 'open') this.#decide('local')
    return this.kind as Exclude<ReferenceKind, 'open'>
  }

  #decide(kind: Exclude<ReferenceKind, 'open'>): this {
    this.kind = kind
    if (kind !== 'scheme') this.scheme = ''
    return this
  }
}

/** One reference, read in one piece — a `Location` header, say. */
export function classifyReference(target: string): { readonly kind: Exclude<ReferenceKind, 'open'>; readonly scheme: string } {
  const reading = new UrlReference().feed(target, false)
  const kind = reading.settle()
  return { kind, scheme: reading.scheme }
}

/**
 * True when a browser that follows `target` stays on the origin it is already
 * on — ASP.NET's `IsLocalUrl`, and the check to make on a `?next=` parameter
 * before redirecting to it:
 *
 *     return ctx.redirect(isLocalUrl(next) ? next : '/dashboard')
 *
 * A path, a query or a fragment is local. Anything with a scheme or an
 * authority is not, however it is spelled — `//evil.example`, `/\evil.example`,
 * `/\t/evil.example`, `https:evil.example` — and neither is an absolute URL on
 * this application's own host, because the only thing that could vouch for the
 * host is the request's `Host` header, which the client writes.
 */
export function isLocalUrl(target: string): boolean {
  return typeof target === 'string' && classifyReference(target).kind === 'local'
}

function isAlpha(c: number): boolean {
  const lower = c | 0x20
  return lower >= 0x61 && lower <= 0x7a
}
