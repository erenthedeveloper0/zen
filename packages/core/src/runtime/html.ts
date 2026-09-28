import type { SafeHtml } from '../contracts/html.ts'
import { UrlReference } from '../primitives/url-reference.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * HTML that is escaped by construction — rfcs/0001 §19.5.
 *
 *     ctx.html(html`<p>Hello, ${ctx.query.name}</p>`)
 *
 * `html` is a tagged template, and the template is the unit of analysis: its
 * written text is code, its holes are data. The first time a template is
 * rendered, the written text is read once — the way the HTML tokenizer will
 * read it — and every hole is classified by where it sits. The classification
 * is cached against the template object, which the language makes unique per
 * call site, so every later render is a loop over the holes. That is §1.4
 * applied to one more thing: what can be known before the first request is not
 * rediscovered on each one.
 *
 * What a hole gets, by where it sits:
 *
 *   - **Element content** — `<title>` and `<textarea>` included — escaped
 *     (`& < > " '`), unless the value is itself `SafeHtml`, which is how
 *     templates nest: `html`<ul>${rows.map((r) => html`<li>${r.name}</li>`)}</ul>``.
 *   - **A quoted attribute value** — escaped, always, `SafeHtml` included.
 *     Markup means nothing there, and a nested fragment's own quote would
 *     otherwise end the attribute early.
 *   - **A URL attribute** (`href`, `src`, `action`, …) — escaped, and the value
 *     checked once assembled: a scheme that can run script (`javascript:`,
 *     `data:` — anything but http, https, mailto and tel) is replaced with
 *     `about:invalid#zen-unsafe-url`. Where the URL decides whose *code* or
 *     which *endpoint* the page trusts — `<script src>`, `<base href>`,
 *     `<form action>`, `formaction`, `<object data>`, `<embed src>` — the check
 *     is stricter: a hole may not choose the origin at all.
 *
 * And where no escaping can help, the template is **refused** rather than
 * rendered — `ZEN_HTML_UNSAFE`, on its first render, whatever the values: a
 * hole inside `<script>` or `<style>`, in an `on*` handler, in `srcdoc`, in a
 * tag or attribute *name* (`<div ${attrs}>`), in an unquoted attribute value,
 * in a comment, in an SVG animation's `to`/`values`, or in a
 * `<meta http-equiv="refresh">`. Each is a place where escaped text is still
 * live code — `onclick="go('${x}')"` is entity-decoded *before* the script
 * runs. A template that ends inside a tag, a comment or a `<script>` is refused
 * too: a fragment is inserted where markup goes, so it has to leave the
 * tokenizer in the state it found it, or the template it is nested in would be
 * classified against a state that is not the real one.
 *
 * Refusals happen at render because a template has no earlier moment — it is
 * called, not registered — but they are structural: the first call in a test,
 * with any values at all, is refused, which is where they belong.
 *
 * Nothing here generates code, so there is no interpreted twin (§20.5). What
 * stands in for one is an oracle: the property suite renders hostile values
 * into every kind of position and checks the output with the WHATWG URL parser
 * and a grammar for escaped text, neither of which shares a line with this file.
 */

// ── the value ───────────────────────────────────────────────────────────────

/**
 * The runtime half of `SafeHtml`. Not exported from the package: the only ways
 * to make one are `html` and `unsafeHtml`, so the brand check below is a check
 * that one of them produced the value — which a JSON body, a query string or a
 * database row cannot have done.
 */
class Markup {
  readonly #markup: string

  constructor(markup: string) {
    this.#markup = markup
  }

  toString(): string {
    return this.#markup
  }

  /** Inside a JSON document a fragment is its markup, as a string. */
  toJSON(): string {
    return this.#markup
  }

  /**
   * A fragment is an async iterable of itself — one chunk, its markup — so it
   * can be handed to `ctx.stream()` like any other body.
   *
   * The reason it exists is `finalize`. A handler may return `html`…`` the way
   * it returns a string, and recognising one costs a brand check. Made on every
   * returned object, that check measured +16% on `finalize` for every JSON
   * response in every application (`benchmarks/injection`). Being iterable puts
   * a fragment in the branch `finalize` already takes for streams and
   * `ctx.sse()`, and the check is made there: a handler returning a plain
   * object pays nothing for a feature it does not use (§9.4's rule, at runtime).
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, undefined> {
    yield this.#markup
  }

  /** A private-field brand: `instanceof` can be satisfied by `Object.create`, this cannot. */
  static is(value: unknown): value is Markup {
    return typeof value === 'object' && value !== null && #markup in value
  }

  /** Read without going through `toString`, which an instance could shadow. */
  static read(value: Markup): string {
    return value.#markup
  }
}

/** True for a value `html` or `unsafeHtml` produced, and for nothing else. */
export function isSafeHtml(value: unknown): value is SafeHtml {
  return Markup.is(value)
}

/**
 * Markup the application vouches for — rfcs/0001 §19.5.
 *
 *     ctx.html(unsafeHtml(renderToString(<App />)))
 *
 * For a string that is already safe HTML: a template engine's output, a page
 * rendered at boot. Named for what it asks a reviewer to check — where the
 * string came from — because §19.2's rule is that relaxing a default must be a
 * line of code that appears in review, and this is that line.
 */
export function unsafeHtml(markup: string): SafeHtml {
  if (typeof markup !== 'string') {
    throw new ZenError(
      Codes.HTML_UNSAFE,
      `unsafeHtml() takes a string of markup, and was given ${describe(markup)}.`,
      { status: 500, expose: false },
    )
  }
  return new Markup(markup) as unknown as SafeHtml
}

/**
 * The markup `ctx.html()` writes — and `ZEN_HTML_UNSAFE` for anything that is
 * not `SafeHtml`, which is the runtime half of the type-level brand, for the
 * caller without types.
 */
export function safeHtmlMarkup(value: unknown): string {
  if (Markup.is(value)) return Markup.read(value)
  throw new ZenError(
    Codes.HTML_UNSAFE,
    `ctx.html() takes SafeHtml, and was given ${describe(value)}: a string is not HTML the framework can vouch for.`,
    {
      status: 500,
      expose: false,
      hint:
        'Build the page with html`…`, which escapes what it interpolates — ctx.html(html`<p>${text}</p>`) — ' +
        'or mark markup that is already safe with unsafeHtml(markup).',
    },
  )
}

// ── escaping ────────────────────────────────────────────────────────────────

/**
 * The five characters that end or begin something in HTML, as entities — the
 * encoding that is correct in element content and in a quoted attribute value
 * alike (OWASP's rule #1).
 *
 * Two halves, because two measurements disagreed (`benchmarks/injection`
 * prints both). Finding the *first* markup character is a job for the regex
 * engine, which skips a clean kilobyte in ~70 ns where a `charCodeAt` loop
 * takes ~2 µs — and most text is clean, so most calls end there and return
 * the string itself. Once there is something to escape, a hand-written scan
 * beats `replace` with a callback by about 2×. The first version was the scan
 * alone, and it was thirty times slower on exactly the common case.
 */
export function escapeHtml(text: string): string {
  const first = text.search(MARKUP_CHARACTER)
  if (first === -1) return text
  let out = ''
  let from = 0
  for (let i = first; i < text.length; i++) {
    let entity: string
    switch (text.charCodeAt(i)) {
      case 0x26: entity = '&amp;'; break
      case 0x3c: entity = '&lt;'; break
      case 0x3e: entity = '&gt;'; break
      case 0x22: entity = '&quot;'; break
      case 0x27: entity = '&#39;'; break
      default: continue
    }
    out += from === i ? entity : text.slice(from, i) + entity
    from = i + 1
  }
  return out + text.slice(from)
}

/** Not global: `search` ignores `lastIndex`, so this is safe to share. */
const MARKUP_CHARACTER = /[&<>"']/

// ── the tag ─────────────────────────────────────────────────────────────────

/** Element content: `SafeHtml` verbatim, everything else escaped. */
const K_MARKUP = 0
/** An attribute value, or `<plaintext>`: escaped, `SafeHtml` included. */
const K_TEXT = 1
/** The first hole of a URL attribute whose written text left the scheme open. */
const K_URL = 2
/** A later hole of that same attribute value — written unless the value was neutralised. */
const K_URL_REST = 3

/** What a URL attribute that could run script, or load from elsewhere, becomes instead. */
export const NEUTRAL_URL = 'about:invalid#zen-unsafe-url'

interface UrlCheck {
  /** `<script src>` and friends: the value must stay on this origin, not merely avoid a script scheme. */
  readonly origin: boolean
  /** Written text of the value before its first hole. */
  readonly prefix: string
  /** The last hole in the same value, and the written text after it, up to the closing quote. */
  last: number
  suffix: string
}

interface Plan {
  /** The written text, cooked — with the raw form where a cooked one does not exist. */
  readonly strings: readonly string[]
  readonly kinds: Uint8Array
  readonly checks: ReadonlyArray<UrlCheck | undefined>
}

interface Refusal {
  readonly message: string
  readonly hint: string
}

/**
 * One plan per call site, keyed by the template object — which the language
 * guarantees is the same frozen array on every evaluation of one tagged
 * template, and which a `WeakMap` releases with the module that holds it.
 */
const plans = new WeakMap<object, Plan | Refusal>()

/**
 * HTML with every interpolation escaped for where it sits — rfcs/0001 §19.5.
 *
 *     html`<a href="${profile.url}" title="${profile.name}">${profile.name}</a>`
 *
 * Returns `SafeHtml`, which is what `ctx.html()` takes and what a handler can
 * return directly. Nest fragments by interpolating them; interpolate an array
 * to write each element; `null`, `undefined`, `true` and `false` write nothing,
 * so `${isAdmin && html`<a href="/admin">Admin</a>`}` works as it reads.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let plan = plans.get(strings as object)
  if (plan === undefined) {
    if (!isTemplateObject(strings, values.length)) throw calledAsFunction()
    plan = analyse(strings)
    plans.set(strings, plan)
  }
  if (!('kinds' in plan)) throw refused(plan)

  const kinds = plan.kinds
  if (values.length !== kinds.length) throw calledAsFunction()
  const written = plan.strings
  let out = written[0] as string
  // The last hole of a URL value that was replaced — its later holes write nothing.
  let silenced = -1
  for (let i = 0; i < kinds.length; i++) {
    const value = values[i]
    switch (kinds[i]) {
      case K_MARKUP:
        out += asMarkup(value)
        break
      case K_TEXT:
        out += escapeHtml(asText(value))
        break
      case K_URL: {
        const check = plan.checks[i] as UrlCheck
        if (urlIsUnsafe(check, written, values, i)) {
          out += NEUTRAL_URL
          silenced = check.last
        } else {
          out += escapeHtml(asText(value))
        }
        break
      }
      default:
        if (i > silenced) out += escapeHtml(asText(value))
    }
    out += written[i + 1] as string
  }
  return new Markup(out) as unknown as SafeHtml
}

/** A value written as element content. */
function asMarkup(value: unknown): string {
  if (typeof value === 'string') return escapeHtml(value)
  if (typeof value === 'object') {
    if (value === null) return ''
    if (Markup.is(value)) return Markup.read(value)
    if (Array.isArray(value)) {
      let out = ''
      for (let i = 0; i < value.length; i++) out += asMarkup(value[i])
      return out
    }
    return escapeHtml(String(value))
  }
  if (value === undefined || typeof value === 'boolean') return ''
  return escapeHtml(String(value))
}

/** The characters a value stands for, before escaping — `SafeHtml` as its text. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    if (value === null) return ''
    if (Markup.is(value)) return Markup.read(value)
    if (Array.isArray(value)) {
      let out = ''
      for (let i = 0; i < value.length; i++) out += asText(value[i])
      return out
    }
    return String(value)
  }
  if (value === undefined || typeof value === 'boolean') return ''
  return String(value)
}

/**
 * Read a URL attribute's whole value — written text and holes, in order — and
 * decide whether it may be written.
 *
 * The holes are fed as values that will be escaped, so an `&` in one is a
 * literal `&` and cannot start a character reference; the written text is fed
 * as markup, where it can. That distinction is what makes
 * `href="${x}&colon;alert(1)"` with `x = 'javascript'` neutralised, while a
 * relative link to `Tom&Jerry` is not.
 */
function urlIsUnsafe(check: UrlCheck, written: readonly string[], values: readonly unknown[], first: number): boolean {
  const reading = new UrlReference().feed(check.prefix, true).feed(asText(values[first]), false)
  for (let j = first + 1; j <= check.last; j++) {
    reading.feed(written[j] as string, true).feed(asText(values[j]), false)
  }
  const kind = reading.feed(check.suffix, true).settle()
  if (check.origin) return kind !== 'local'
  return kind === 'ambiguous' || (kind === 'scheme' && !SAFE_SCHEMES.has(reading.scheme))
}

function isTemplateObject(strings: unknown, holes: number): strings is TemplateStringsArray {
  return (
    Array.isArray(strings) &&
    Array.isArray((strings as { raw?: unknown }).raw) &&
    Object.isFrozen(strings) &&
    strings.length === holes + 1
  )
}

// ── the analysis ────────────────────────────────────────────────────────────

/** Schemes a link may carry: none of them can run script in the page. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel'])
const HTTP_SCHEMES: ReadonlySet<string> = new Set(['http', 'https'])

/** Attributes a browser reads as a URL it may navigate to or load — HTML and SVG. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'cite', 'poster', 'background', 'data',
  'codebase', 'longdesc', 'usemap', 'manifest', 'icon', 'lowsrc', 'dynsrc', 'archive', 'classid',
  'profile',
])

/**
 * The URL attributes that decide whose code the page runs, or where it sends
 * what a user typed — so for them "not `javascript:`" is not enough, and a hole
 * may not choose the origin. A link to another site is ordinary; a script from
 * one is the whole attack.
 */
const ORIGIN_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['script', new Set(['src', 'href', 'xlink:href'])],
  ['base', new Set(['href'])],
  ['form', new Set(['action'])],
  ['button', new Set(['formaction'])],
  ['input', new Set(['formaction'])],
  ['object', new Set(['data', 'codebase'])],
  ['embed', new Set(['src'])],
])

/** SVG animation can *set* `href` to whatever `to`/`values` hold, after the check above ran. */
const ANIMATION_ELEMENTS: ReadonlySet<string> = new Set(['set', 'animate', 'animatemotion', 'animatetransform'])
const ANIMATION_ATTRIBUTES: ReadonlySet<string> = new Set(['to', 'from', 'by', 'values', 'attributename'])

/** An authority the written text already finished: `https://host/`, `//host?`… */
const AUTHORITY_CLOSED = /^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}[^\\/?#]+[\\/?#]/i

// Tokenizer states — the part of the WHATWG HTML tokenizer (§13.2.5) that
// decides what a hole can become.
//
// One simplification, and it is the load-bearing one. HTML reads the content
// of `<title>`, `<textarea>`, `<noscript>`, `<iframe>` and a few others as text
// — but *not* inside `<svg>` or `<math>`, where the same names are ordinary
// elements whose content is tags. A reader that followed the HTML rule would,
// inside an `<svg>`, take a `<script>` for text and let a hole into it. So only
// `<script>` and `<style>` are read as the raw text they are (and refused):
// everything else is read as markup. Where a browser actually uses raw text,
// that can only mean escaping a string that was safe anyway; the other
// direction — believing "text" where the browser sees tags — cannot happen.
const DATA = 0
const TAG_OPEN = 1
const END_TAG_OPEN = 2
const TAG_NAME = 3
const BEFORE_ATTRIBUTE_NAME = 4
const ATTRIBUTE_NAME = 5
const AFTER_ATTRIBUTE_NAME = 6
const BEFORE_ATTRIBUTE_VALUE = 7
const ATTRIBUTE_VALUE = 8
const UNQUOTED_VALUE = 9
const AFTER_ATTRIBUTE_VALUE = 10
const SELF_CLOSING = 11
const MARKUP_DECLARATION = 12
const COMMENT_START = 13
const COMMENT = 14
const BOGUS_COMMENT = 15
const SCRIPT = 16
const PLAINTEXT = 17

const TAB = 0x09
const LF = 0x0a
const FF = 0x0c
const CR = 0x0d
const SPACE = 0x20
const BANG = 0x21
const QUOTE = 0x22
const APOSTROPHE = 0x27
const HYPHEN = 0x2d
const SOLIDUS = 0x2f
const LESS_THAN = 0x3c
const EQUALS = 0x3d
const GREATER_THAN = 0x3e
const QUESTION = 0x3f

/** Read a template's written text once, and decide what each hole may become. */
function analyse(template: TemplateStringsArray): Plan | Refusal {
  const strings: string[] = []
  for (let i = 0; i < template.length; i++) strings.push(template[i] ?? (template.raw[i] as string))

  const reader = new TemplateReader()
  const kinds = new Uint8Array(strings.length - 1)
  for (let i = 0; i < strings.length; i++) {
    reader.feed(strings[i] as string)
    if (reader.refusal !== null) return reader.refusal
    if (i === kinds.length) break
    kinds[i] = reader.hole(i, strings[i] as string)
    if (reader.refusal !== null) return reader.refusal
  }
  const unfinished = reader.finish()
  if (unfinished !== null) return unfinished
  return { strings, kinds, checks: reader.checks }
}

class TemplateReader {
  state = DATA
  refusal: Refusal | null = null
  readonly checks: Array<UrlCheck | undefined> = []

  #tag = ''
  #closing = false
  #attribute = ''
  #quote = 0
  /** Written text of the current attribute value since it opened, or since its last hole. */
  #value = ''
  #valueHoles = 0
  #check: UrlCheck | null = null
  /** Written values of the current tag's attributes that had no hole — what `<meta>` is judged on. */
  #attributes = new Map<string, string>()
  #metaContentHole = false
  /** `script` or `style` — the element whose end tag leaves SCRIPT. */
  #rawEnd = ''

  feed(text: string): void {
    for (let i = 0; i < text.length && this.refusal === null; i++) {
      const c = text.charCodeAt(i)
      switch (this.state) {
        case DATA:
          if (c === LESS_THAN) this.state = TAG_OPEN
          break
        case TAG_OPEN:
          if (isAlpha(c)) this.#startTag(c, false)
          else if (c === SOLIDUS) this.state = END_TAG_OPEN
          else if (c === BANG) this.state = MARKUP_DECLARATION
          else if (c === QUESTION) this.state = BOGUS_COMMENT
          else { this.state = DATA; i-- } // a `<` that starts nothing is text
          break
        case END_TAG_OPEN:
          if (isAlpha(c)) this.#startTag(c, true)
          else if (c === GREATER_THAN) this.state = DATA // `</>` is ignored
          else { this.state = BOGUS_COMMENT; i-- }
          break
        case TAG_NAME:
          if (isSpace(c)) this.state = BEFORE_ATTRIBUTE_NAME
          else if (c === SOLIDUS) this.state = SELF_CLOSING
          else if (c === GREATER_THAN) this.#endTag()
          else this.#tag += lower(c)
          break
        case BEFORE_ATTRIBUTE_NAME:
          if (isSpace(c)) break
          if (c === SOLIDUS || c === GREATER_THAN) { this.state = AFTER_ATTRIBUTE_NAME; i--; break }
          this.#startAttribute(c)
          break
        case ATTRIBUTE_NAME:
          if (isSpace(c) || c === SOLIDUS || c === GREATER_THAN) { this.state = AFTER_ATTRIBUTE_NAME; i--; break }
          if (c === EQUALS) { this.state = BEFORE_ATTRIBUTE_VALUE; break }
          this.#attribute += lower(c)
          break
        case AFTER_ATTRIBUTE_NAME:
          if (isSpace(c)) break
          if (c === SOLIDUS) { this.state = SELF_CLOSING; break }
          if (c === EQUALS) { this.state = BEFORE_ATTRIBUTE_VALUE; break }
          if (c === GREATER_THAN) { this.#endTag(); break }
          this.#startAttribute(c)
          break
        case BEFORE_ATTRIBUTE_VALUE:
          if (isSpace(c)) break
          if (c === QUOTE || c === APOSTROPHE) { this.#startValue(c); break }
          if (c === GREATER_THAN) { this.#endTag(); break }
          this.#startValue(0)
          i--
          break
        case ATTRIBUTE_VALUE:
          if (c === this.#quote) { this.#endValue(); this.state = AFTER_ATTRIBUTE_VALUE; break }
          this.#value += text[i]
          break
        case UNQUOTED_VALUE:
          if (isSpace(c)) { this.#endValue(); this.state = BEFORE_ATTRIBUTE_NAME; break }
          if (c === GREATER_THAN) { this.#endValue(); this.#endTag(); break }
          this.#value += text[i]
          break
        case AFTER_ATTRIBUTE_VALUE:
          if (isSpace(c)) { this.state = BEFORE_ATTRIBUTE_NAME; break }
          if (c === SOLIDUS) { this.state = SELF_CLOSING; break }
          if (c === GREATER_THAN) { this.#endTag(); break }
          this.state = BEFORE_ATTRIBUTE_NAME
          i--
          break
        case SELF_CLOSING:
          // `<script/>` still opens a script: HTML ignores the slash on an
          // element that is not void, so the flag decides nothing here.
          if (c === GREATER_THAN) { this.#endTag(); break }
          this.state = BEFORE_ATTRIBUTE_NAME
          i--
          break
        case MARKUP_DECLARATION:
          if (c === HYPHEN && text.charCodeAt(i + 1) === HYPHEN) { this.state = COMMENT_START; i++; break }
          this.state = BOGUS_COMMENT // `<!DOCTYPE …>`, `<![CDATA[…`: until the next `>`
          i--
          break
        case COMMENT_START:
          // `<!-->` and `<!--->` are whole comments.
          if (c === GREATER_THAN) { this.state = DATA; break }
          if (c === HYPHEN && text.charCodeAt(i + 1) === GREATER_THAN) { this.state = DATA; i++; break }
          this.state = COMMENT
          i--
          break
        case COMMENT:
          // `-->`, and `--!>`, which ends a comment too.
          if (c === HYPHEN && text.charCodeAt(i + 1) === HYPHEN) {
            const after = text.charCodeAt(i + 2)
            if (after === GREATER_THAN) { this.state = DATA; i += 2 }
            else if (after === BANG && text.charCodeAt(i + 3) === GREATER_THAN) { this.state = DATA; i += 3 }
          }
          break
        case BOGUS_COMMENT:
          if (c === GREATER_THAN) this.state = DATA
          break
        case SCRIPT:
          i = this.#scriptText(text, i)
          break
        default: // PLAINTEXT — nothing ends it
          break
      }
    }
  }

  /** Classify the hole that follows the text just fed. */
  hole(index: number, before: string): number {
    switch (this.state) {
      case DATA:
        return K_MARKUP
      case ATTRIBUTE_VALUE:
        return this.#attributeHole(index, before)
      case SCRIPT:
        return this.#refuse(
          index, before,
          this.#rawEnd === 'script'
            ? 'sits inside <script>, and escaping HTML does not make JavaScript safe'
            : 'sits inside <style>, and escaping HTML does not make CSS safe',
          'Hand data to a script as JSON in a data- attribute — data-state="${JSON.stringify(state)}" — and read it with ' +
            'JSON.parse(element.dataset.state); or build the element yourself and mark it with unsafeHtml().',
        )
      case PLAINTEXT:
        return K_TEXT
      case COMMENT:
      case COMMENT_START:
      case BOGUS_COMMENT:
      case MARKUP_DECLARATION:
        return this.#refuse(
          index, before,
          'sits inside an HTML comment or declaration, where a value can end it early and turn what follows into markup',
          'Take the hole out of the comment.',
        )
      case TAG_OPEN:
      case END_TAG_OPEN:
      case TAG_NAME:
        return this.#refuse(
          index, before,
          'sits in a tag name',
          'Write every tag name in the template. To choose between elements, choose between two html`` fragments.',
        )
      case BEFORE_ATTRIBUTE_VALUE:
      case UNQUOTED_VALUE:
        return this.#refuse(
          index, before,
          `is the unquoted value of ${this.#attribute}=, where a space in the value starts a new attribute — an onclick, say`,
          `Quote it: ${this.#attribute}="\${…}".`,
        )
      default:
        return this.#refuse(
          index, before,
          `sits where an attribute name goes in <${this.#tag}>, so its value could add any attribute, onclick included`,
          'Write every attribute name in the template and put only values in holes, inside quotes. For an attribute ' +
            'that is present or not, choose between two html`` fragments.',
        )
    }
  }

  /** The template ended: it must leave the tokenizer where it found it. */
  finish(): Refusal | null {
    if (this.state === DATA) return null
    const where =
      this.state === SCRIPT ? `inside <${this.#rawEnd}>, which it never closes`
      : this.state === PLAINTEXT ? 'inside <plaintext>, which nothing can close'
      : this.state >= MARKUP_DECLARATION ? 'inside an unclosed comment or declaration'
      : this.state === ATTRIBUTE_VALUE ? `inside the ${this.#attribute} attribute of <${this.#tag}>`
      : `inside the <${this.#closing ? '/' : ''}${this.#tag}> tag`
    return {
      message:
        `Refused an html\`…\` template: it ends ${where}. A fragment is inserted where markup goes, so the markup ` +
        'around it would be read as part of what it left open.',
      hint: 'Close it in the same template.',
    }
  }

  #attributeHole(index: number, before: string): number {
    const first = this.#valueHoles === 0
    const written = this.#value
    this.#valueHoles++
    this.#value = ''
    if (this.#check !== null) this.#check.last = index
    if (!first) return this.#check !== null ? K_URL_REST : K_TEXT

    const tag = this.#tag
    const attribute = this.#attribute
    if (attribute.startsWith('on')) {
      return this.#refuse(
        index, before,
        `is inside the event handler ${attribute}="…", which is JavaScript — and the attribute is entity-decoded before it runs, so escaping undoes itself`,
        'Put the value in a data- attribute and read it from the handler: data-id="${id}" onclick="go(this.dataset.id)".',
      )
    }
    if (attribute === 'srcdoc') {
      return this.#refuse(
        index, before,
        'is inside srcdoc, whose value is decoded once and then parsed as a second HTML document',
        'Serve the inner document from a route and point src at it.',
      )
    }
    if (ANIMATION_ELEMENTS.has(tag) && ANIMATION_ATTRIBUTES.has(attribute)) {
      return this.#refuse(
        index, before,
        `is inside ${attribute}= on <${tag}>, which can set an href after the page has loaded`,
        'Write SVG animation values in the template.',
      )
    }
    if (tag === 'meta') {
      if (attribute === 'http-equiv') {
        return this.#refuse(index, before, 'is the http-equiv of a <meta>, which is a response header', 'Write it in the template.')
      }
      if (attribute === 'content') this.#metaContentHole = true
      return K_TEXT
    }

    const origin = ORIGIN_ATTRIBUTES.get(tag)?.has(attribute) === true
    if (!origin && !URL_ATTRIBUTES.has(attribute)) return K_TEXT

    // A URL. What did the written text before the hole already decide?
    const reading = new UrlReference().feed(written, true)
    const kind = reading.kind
    if (kind === 'ambiguous') {
      return this.#refuse(
        index, before,
        `follows a character reference in ${attribute}="…" before the URL's scheme is decided — "&#106;avascript:" is "javascript:"`,
        'Write the start of the URL without character references.',
      )
    }
    if (kind === 'scheme' && !(origin ? HTTP_SCHEMES : SAFE_SCHEMES).has(reading.scheme)) {
      return this.#refuse(
        index, before,
        `is inside a ${reading.scheme}: URL in ${attribute}="…"`,
        'Do not build script-capable URLs from values.',
      )
    }
    if (kind === 'open') {
      // Nothing decided yet: the value, whole, is checked at every render.
      this.#check = { origin, prefix: written, last: index, suffix: '' }
      this.checks[index] = this.#check
      return K_URL
    }
    // The written text fixed the scheme, or committed to a path on this
    // origin. A link may go anywhere after that; code may not.
    if (!origin || kind === 'local' || AUTHORITY_CLOSED.test(withoutUrlWhitespace(written))) return K_TEXT
    return this.#refuse(
      index, before,
      `lets its value choose the host <${tag} ${attribute}> loads from or sends to`,
      `Write the origin in the template — ${attribute}="https://cdn.example/\${path}" — or use a path on this origin.`,
    )
  }

  /** Inside `<script>` or `<style>`: only `</script` or `</style` (then whitespace, `/` or `>`) ends it. */
  #scriptText(text: string, i: number): number {
    if (text.charCodeAt(i) !== LESS_THAN) return i
    const end = this.#rawEnd
    if (
      text.charCodeAt(i + 1) === SOLIDUS &&
      text.slice(i + 2, i + 2 + end.length).toLowerCase() === end &&
      endsName(text.charCodeAt(i + 2 + end.length))
    ) {
      this.#tag = end
      this.#closing = true
      this.state = TAG_NAME
      return i + 1 + end.length
    }
    if (end === 'script' && text.charCodeAt(i + 1) === BANG && text.startsWith('--', i + 2)) {
      // `<!--` in script data opens the escaped states, where a later
      // `</script>` can fail to end the script. Where it ends is the whole question.
      this.refusal = {
        message: 'Refused an html`…` template: its <script> contains "<!--", which changes where the script ends.',
        hint: 'Remove the HTML comment from the script.',
      }
    }
    return i
  }

  #startTag(c: number, closing: boolean): void {
    this.state = TAG_NAME
    this.#tag = lower(c)
    this.#closing = closing
    this.#attribute = ''
    this.#attributes = new Map()
    this.#metaContentHole = false
  }

  #startAttribute(c: number): void {
    this.state = ATTRIBUTE_NAME
    this.#attribute = lower(c)
  }

  #startValue(quote: number): void {
    this.state = quote === 0 ? UNQUOTED_VALUE : ATTRIBUTE_VALUE
    this.#quote = quote
    this.#value = ''
    this.#valueHoles = 0
    this.#check = null
  }

  #endValue(): void {
    if (this.#check !== null) {
      this.#check.suffix = this.#value
      this.#check = null
    }
    if (this.#valueHoles === 0) this.#attributes.set(this.#attribute, this.#value)
  }

  #endTag(): void {
    const tag = this.#tag
    if (this.#closing) {
      this.state = DATA
      return
    }
    if (tag === 'meta' && this.#metaContentHole && (this.#attributes.get('http-equiv') ?? '').trim().toLowerCase() === 'refresh') {
      this.refusal = {
        message:
          'Refused an html`…` template: a <meta http-equiv="refresh"> takes its content from a hole, and a refresh ' +
          'is a redirect nothing checks.',
        hint: 'Redirect with ctx.redirect(), which keeps the client on this origin.',
      }
      return
    }
    if (tag === 'script' || tag === 'style') {
      this.state = SCRIPT
      this.#rawEnd = tag
    } else {
      this.state = tag === 'plaintext' ? PLAINTEXT : DATA
    }
  }

  #refuse(index: number, before: string, what: string, hint: string): number {
    this.refusal = {
      message: `Refused an html\`…\` template: hole ${index + 1}, after "${lastOf(before, 40)}", ${what}.`,
      hint,
    }
    return K_TEXT
  }
}

// ── errors ──────────────────────────────────────────────────────────────────

function refused(refusal: Refusal): ZenError {
  return new ZenError(Codes.HTML_UNSAFE, refusal.message, { status: 500, expose: false, hint: refusal.hint })
}

function calledAsFunction(): ZenError {
  return new ZenError(
    Codes.HTML_UNSAFE,
    'html was called as a function. It is a tagged template: its written text is trusted as markup, so that text has ' +
      'to be the template literal itself, not a string built at runtime.',
    {
      status: 500,
      expose: false,
      hint: 'Write html`<p>${text}</p>`. To escape one string use escapeHtml(text); to insert markup you already trust, unsafeHtml(markup).',
    },
  )
}

// ── characters ──────────────────────────────────────────────────────────────

function isAlpha(c: number): boolean {
  const folded = c | 0x20
  return folded >= 0x61 && folded <= 0x7a
}

function isSpace(c: number): boolean {
  return c === SPACE || c === LF || c === TAB || c === FF || c === CR
}

function endsName(c: number): boolean {
  return isSpace(c) || c === SOLIDUS || c === GREATER_THAN
}

/** ASCII-lowercase one character, the way tag and attribute names are compared. */
function lower(c: number): string {
  return String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c)
}

/** What the URL parser strips and removes before it reads anything. */
function withoutUrlWhitespace(text: string): string {
  let out = ''
  let leading = true
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === TAB || c === LF || c === CR) continue
    if (leading && c <= SPACE) continue
    leading = false
    out += text[i]
  }
  return out
}

function lastOf(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= length ? flat : `…${flat.slice(flat.length - length)}`
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const type = typeof value
  return type === 'undefined' ? 'undefined' : type === 'object' ? 'an object' : `a ${type}`
}
