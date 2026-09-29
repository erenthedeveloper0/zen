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
 *     Inside `<title>`, `<textarea>`, `<noscript>` and HTML's other text
 *     elements, a fragment is refused if it could end the element; inside
 *     `<svg>` or `<math>`, if it holds a script only HTML can read.
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
 * too — and one that leaves a text element or an `<svg>` open: a fragment is
 * inserted where markup goes, so it has to leave the tokenizer in the state it
 * found it, or the template it is nested in would be classified against a
 * state that is not the real one. And because HTML and SVG read some elements
 * differently, a template on which the two readings disagree about where an
 * element ends is refused as well — see the analysis below.
 *
 * Refusals happen at render because a template has no earlier moment — it is
 * called, not registered — but they are structural: the first call in a test,
 * with any values at all, is refused, which is where they belong.
 *
 * Nothing here generates code, so there is no interpreted twin (§20.5). What
 * stands in for one is an oracle: the property suites render hostile values
 * into every kind of position and judge the output with the WHATWG URL parser,
 * a grammar for escaped text, and a spec-conformant HTML parser — none of which
 * shares a line with this file.
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
  /**
   * False when the markup holds a `<script>` whose code only HTML reads as
   * code — `if (a<b)` — which inside an `<svg>` or `<math>` is read as a tag.
   * Such a fragment is refused where it would land inside one (see the
   * analysis below). `unsafeHtml` always sets it: the application vouched for
   * the markup, wherever it puts it.
   */
  readonly #foreignSafe: boolean

  constructor(markup: string, foreignSafe: boolean) {
    this.#markup = markup
    this.#foreignSafe = foreignSafe
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

  static foreignSafe(value: Markup): boolean {
    return value.#foreignSafe
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
  return new Markup(markup, true) as unknown as SafeHtml
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
/**
 * Element content where one of the two readings below disagrees with the
 * other about what markup does: inside HTML's text elements (`<title>`,
 * `<textarea>`, `<noscript>`…) or inside `<svg>`/`<math>`. Escaped as
 * content, and `SafeHtml` is written only if it cannot end the text element
 * or smuggle an HTML-only `<script>` into SVG.
 */
const K_GUARDED = 4

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
  /** For a `K_GUARDED` hole: the HTML text elements it sits in, if any — `['title']`, `['noscript']`. */
  readonly textElements: ReadonlyArray<readonly string[] | undefined>
  /** For a `K_GUARDED` hole: 1 when it may sit inside `<svg>` or `<math>`. */
  readonly foreign: Uint8Array
  /** False when one of the template's own `<script>`s is only code to HTML — see `Markup`. */
  readonly foreignSafe: boolean
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
  // A fragment nested in element content carries what it holds with it.
  let foreignSafe = plan.foreignSafe
  for (let i = 0; i < kinds.length; i++) {
    const value = values[i]
    switch (kinds[i]) {
      case K_MARKUP:
        out += asMarkup(value)
        if (foreignSafe && typeof value === 'object' && value !== null) foreignSafe = isForeignSafe(value)
        break
      case K_GUARDED:
        out += guardedMarkup(value, plan.textElements[i], plan.foreign[i] === 1)
        if (foreignSafe && typeof value === 'object' && value !== null) foreignSafe = isForeignSafe(value)
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
  return new Markup(out, foreignSafe) as unknown as SafeHtml
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

/**
 * Element content that one reading of the page treats as text and the other as
 * markup (`K_GUARDED`). A string is escaped, which is safe in both. A fragment
 * is written as markup only if it keeps the two readings together:
 *
 *   - inside `<textarea>`, `<title>`, `<noscript>`…, it must not contain the
 *     element's end tag, or end part-way into one. HTML would end the element
 *     there and read the rest of the fragment as markup that the fragment's own
 *     analysis never saw from that position — the middle of an attribute value,
 *     say. A string cannot do this: its `<` is escaped.
 *   - inside `<svg>` or `<math>`, it must not hold a `<script>` whose code only
 *     HTML reads as code (`Markup`'s `foreignSafe`).
 */
function guardedMarkup(value: unknown, textElements: readonly string[] | undefined, foreign: boolean): string {
  if (typeof value === 'string') return escapeHtml(value)
  if (typeof value === 'object' && value !== null) {
    if (Markup.is(value)) {
      const markup = Markup.read(value)
      if (textElements !== undefined) {
        for (const element of textElements) {
          if (couldEndElement(markup, element)) throw fragmentEndsElement(element)
        }
      }
      if (foreign && !Markup.foreignSafe(value)) throw fragmentScriptInForeign()
      return markup
    }
    if (Array.isArray(value)) {
      let out = ''
      for (let i = 0; i < value.length; i++) out += guardedMarkup(value[i], textElements, foreign)
      return out
    }
  }
  return asMarkup(value)
}

/** Whether `value`, written as element content, could put an HTML-only script inside SVG. */
function isForeignSafe(value: object): boolean {
  if (Markup.is(value)) return Markup.foreignSafe(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      if (typeof item === 'object' && item !== null && !isForeignSafe(item)) return false
    }
  }
  return true
}

/**
 * True when `markup` contains `</name` in any case, or ends with the start of
 * it — `<`, `</`, `</tex` — which the template's next written text could finish.
 * HTML ends a text element at exactly that sequence (WHATWG §13.2.5), whatever
 * surrounds it; "could" is enough, because refusing is what happens next.
 */
function couldEndElement(markup: string, name: string): boolean {
  const end = `</${name}`
  const lower = asciiLowercase(markup)
  if (lower.includes(end)) return true
  for (let length = Math.min(end.length, lower.length); length > 0; length--) {
    if (lower.endsWith(end.slice(0, length))) return true
  }
  return false
}

/** ASCII only, as HTML compares tag names — `toLowerCase` would also fold the Kelvin sign, U+212A, to `k`. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase())
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
// Two readings, and a template has to mean one thing under both. HTML reads the
// content of `<script>` as script and of `<style>`, `<title>`, `<textarea>`,
// `<noscript>`, `<iframe>`, `<xmp>`, `<noembed>` and `<noframes>` as text, each
// ended by the first `</name` in it wherever that falls. SVG and MathML read the
// same names as ordinary elements whose content is markup — tags, comments,
// CDATA sections — ended by a real end tag. Which reading a browser applies
// depends on where the markup lands: inside an `<svg>` or not, in this template
// or in the one a fragment is nested into, and not every placement is visible
// from here. So neither reading may be assumed:
//
//   - Content is read as markup, as SVG does, which is what keeps a `<script>`
//     inside an SVG `<title>` from being taken for text (and a hole let into it).
//   - The HTML reading is kept alongside: a text element's end tag written
//     where the markup reading would not end the element — inside an attribute
//     value, a comment, a tag — is refused, because everything after it would
//     mean one thing to HTML and another to SVG. That is how
//     `<noscript><p title="</noscript><img onerror=${x}>">` put a value in an
//     event handler while the reader believed it was in a title.
//   - `<script>` and `<style>` are read as HTML reads them, holes refused, and
//     their text must not contain what SVG would read as markup — so both
//     readings end them at the same place. A `<script>` whose code merely looks
//     like markup (`if (a<b)`) is fine in HTML and is refused only where it could
//     reach an SVG: inside one here, or as a fragment nested into one.
//   - A CDATA section ends at the first `>` for HTML and at `]]>` inside SVG, so
//     one whose text holds a `>` is refused.
//
// Where a browser uses the text reading and the markup reading here says "tag",
// the difference is a string escaped that was safe anyway. What is refused is
// every template on which the two readings disagree about where an element ends.
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
const CDATA = 18

/**
 * Elements whose content HTML reads as text, ended by the first `</name` —
 * RCDATA (`title`, `textarea`) and raw text (the rest; `noscript` while
 * scripting is on, which is when it matters). `script`, `style` and `plaintext`
 * have states of their own.
 */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])

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
const CLOSE_BRACKET = 0x5d

/** Read a template's written text once, and decide what each hole may become. */
function analyse(template: TemplateStringsArray): Plan | Refusal {
  const strings: string[] = []
  for (let i = 0; i < template.length; i++) strings.push(template[i] ?? (template.raw[i] as string))

  const reader = new TemplateReader(strings.length - 1)
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
  return {
    strings,
    kinds,
    checks: reader.checks,
    textElements: reader.textElements,
    foreign: reader.foreign,
    foreignSafe: reader.foreignSafe,
  }
}

class TemplateReader {
  state = DATA
  refusal: Refusal | null = null
  readonly checks: Array<UrlCheck | undefined> = []
  /** Per `K_GUARDED` hole — see `Plan`. */
  readonly textElements: Array<readonly string[] | undefined> = []
  readonly foreign: Uint8Array
  foreignSafe = true

  #tag = ''
  #closing = false
  #selfClosing = false
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
  /** The text of that element so far, which the markup reading is checked against at its end. */
  #rawText = ''
  /**
   * Text elements open, outermost first (see `TEXT_ELEMENTS`). Usually none or
   * one. More than one when a text element sits inside another that the markup
   * reading treats as an element — an SVG `<title>`, which lets HTML back in,
   * holding an HTML `<textarea>` — and then every one of their end tags counts.
   */
  readonly #textElements: string[] = []
  /** `svg` and `math` elements this template opened and has not closed, outermost first. */
  readonly #foreignOpen: string[] = []
  /** Where the current CDATA section's text began, in the text being fed. */
  #cdataFrom = 0

  constructor(holes: number) {
    this.foreign = new Uint8Array(holes)
  }

  feed(text: string): void {
    for (let i = 0; i < text.length && this.refusal === null; i++) {
      const c = text.charCodeAt(i)
      // HTML ends a text element at its end tag wherever that falls. When the
      // markup reading is anywhere but element content at that point, the two
      // readings of everything after it differ — refused. (A `<` in TAG_OPEN is
      // re-read as content, so that state agrees.)
      if (c === LESS_THAN && this.#textElements.length > 0 && this.state !== DATA && this.state !== TAG_OPEN) {
        const element = this.#textElements.find((name) => isEndTagAt(text, i, name))
        if (element !== undefined) {
          this.#readTwoWays(element, this.#where())
          return
        }
      }
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
          // element that is not void. `<svg/>` is the case it decides — an
          // SVG closed on the spot, which opens nothing.
          if (c === GREATER_THAN) { this.#selfClosing = true; this.#endTag(); break }
          this.state = BEFORE_ATTRIBUTE_NAME
          i--
          break
        case MARKUP_DECLARATION:
          if (c === HYPHEN && text.charCodeAt(i + 1) === HYPHEN) { this.state = COMMENT_START; i++; break }
          if (text.startsWith('[CDATA[', i)) { this.state = CDATA; i += 6; this.#cdataFrom = i + 1; break }
          this.state = BOGUS_COMMENT // `<!DOCTYPE …>`: until the next `>`
          i--
          break
        case CDATA:
          // HTML reads `<![CDATA[` as a bogus comment, ended by the next `>`;
          // inside SVG or MathML it is a CDATA section, ended by `]]>`. Only a
          // section whose first `>` is its `]]>` ends in the same place for both.
          if (c === GREATER_THAN) {
            if (i - 2 >= this.#cdataFrom && text.charCodeAt(i - 1) === CLOSE_BRACKET && text.charCodeAt(i - 2) === CLOSE_BRACKET) {
              this.state = DATA
            } else {
              this.refusal = {
                message:
                  'Refused an html`…` template: a CDATA section holds a ">" before its "]]>". HTML ends the section at ' +
                  'that ">" and SVG at "]]>", so what lies between would be markup to one and text to the other.',
                hint: 'Take the ">" out of the CDATA section — write it as &gt; — or use a comment.',
              }
            }
          }
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

  /** Refuse the template: HTML and the markup reading disagree about where a text element ends. */
  #readTwoWays(element: string, where: string): void {
    this.refusal = {
      message:
        `Refused an html\`…\` template: HTML reads the content of <${element}> as text and ends it at the first ` +
        `"</${element}", but here that sits ${where}, where SVG and MathML — which read the content as markup — do ` +
        'not end it. Everything after it would mean one thing to HTML and another to SVG.',
      hint: `Write "</${element}" only as the element's own end tag — not in an attribute value, a tag, a comment or a script.`,
    }
  }

  /** Where the reader is, for a refusal that has to say. */
  #where(): string {
    switch (this.state) {
      case ATTRIBUTE_VALUE:
      case UNQUOTED_VALUE:
        return `inside the ${this.#attribute} attribute of <${this.#tag}>`
      case SCRIPT:
        return `inside a <${this.#rawEnd}>`
      case COMMENT_START:
      case COMMENT:
      case BOGUS_COMMENT:
      case MARKUP_DECLARATION:
      case CDATA:
        return 'inside a comment or declaration'
      default:
        return `inside the <${this.#closing ? '/' : ''}${this.#tag}> tag`
    }
  }

  /** Classify the hole that follows the text just fed. */
  hole(index: number, before: string): number {
    switch (this.state) {
      case DATA:
        if (this.#textElements.length === 0 && this.#foreignOpen.length === 0) return K_MARKUP
        if (this.#textElements.length > 0) this.textElements[index] = [...this.#textElements]
        if (this.#foreignOpen.length > 0) this.foreign[index] = 1
        return K_GUARDED
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
      case CDATA:
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
    if (this.state === DATA && this.#textElements.length === 0 && this.#foreignOpen.length === 0) return null
    // An open text element leaves HTML reading what follows the fragment as
    // text, an open <svg> leaves the browser reading it as SVG — either way the
    // template it is nested in would be read against a state it never saw.
    const where =
      this.state === SCRIPT ? `inside <${this.#rawEnd}>, which it never closes`
      : this.state === PLAINTEXT ? 'inside <plaintext>, which nothing can close'
      : this.state >= MARKUP_DECLARATION ? 'inside an unclosed comment, declaration or CDATA section'
      : this.state === ATTRIBUTE_VALUE ? `inside the ${this.#attribute} attribute of <${this.#tag}>`
      : this.state !== DATA ? `inside the <${this.#closing ? '/' : ''}${this.#tag}> tag`
      : this.#textElements.length > 0 ? `inside <${this.#textElements[0] as string}>, which it never closes`
      : `inside <${this.#foreignOpen[0] as string}>, which it never closes`
    return {
      message:
        `Refused an html\`…\` template: it ends ${where}. A fragment is inserted where markup goes, so the markup ` +
        'around it would be read as part of what it left open.',
      hint: 'Close it in the same template.',
    }
  }

  #attributeHole(index: number, before: string): number {
    // Inside a text element, HTML is reading this attribute as text: a value
    // cannot supply a `<` (it is escaped), but it can finish an end tag the
    // written text began — `</noscript` then a hole holding " x".
    const finishes = this.#textElements.find((name) => endsPartWayInto(before, `</${name}`))
    if (finishes !== undefined) {
      return this.#refuse(
        index, before,
        `could finish "</${finishes}", which HTML would read as the end of the <${finishes}> this attribute sits in`,
        `Do not write "</${finishes}", or any start of it, inside an attribute value.`,
      )
    }
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
    const end = this.#rawEnd
    if (text.charCodeAt(i) !== LESS_THAN) {
      this.#rawText += text[i]
      return i
    }
    if (isEndTagAt(text, i, end)) {
      this.#rawEnds()
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
    this.#rawText += '<'
    return i
  }

  /**
   * HTML has just ended a `<script>` or `<style>` at its first `</script`. Inside
   * SVG or MathML the same text is markup, so the element ends there too only if
   * nothing in it is: no tag, no comment, no CDATA section left open.
   *
   * A `<style>` that fails is refused wherever it is — CSS has no use for a `<`
   * before a letter, and an HTML `<select>` has at times ignored a `<style>` and
   * parsed its content as markup too. A `<script>` is refused inside an `<svg>`
   * or `<math>` of this template; elsewhere `if (a<b)` is ordinary code, so the
   * fragment is only marked, and refused where it would be nested into SVG.
   */
  #rawEnds(): void {
    const text = this.#rawText
    this.#rawText = ''
    if (!holdsMarkup(text)) return
    if (this.#rawEnd === 'script' && this.#foreignOpen.length === 0) {
      this.foreignSafe = false
      return
    }
    this.refusal = this.#rawEnd === 'style'
      ? {
        message:
          'Refused an html`…` template: its <style> holds a "<" that begins a tag, comment or CDATA section. HTML ends ' +
          'the style at the first "</style" regardless; SVG and MathML read that "<" as markup and end it somewhere else.',
        hint: 'Write "<" in CSS as \\3c, or move the rules to a stylesheet.',
      }
      : {
        message:
          `Refused an html\`…\` template: its <script> inside <${this.#foreignOpen[0] as string}> holds a "<" that begins a ` +
          'tag, comment or CDATA section. SVG and MathML read a script\'s content as markup, so it would not end where ' +
          'HTML ends it — and it would not run as the code it looks like either.',
        hint: 'Inside SVG, wrap the code in <![CDATA[ … ]]> or write "<" as &lt;.',
      }
  }

  #startTag(c: number, closing: boolean): void {
    this.state = TAG_NAME
    this.#tag = lower(c)
    this.#closing = closing
    this.#selfClosing = false
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
      const text = this.#textElements.lastIndexOf(tag)
      if (text !== -1) this.#textElements.length = text
      // `</svg>` closes the innermost open `svg`, and anything opened inside it.
      const open = this.#foreignOpen.lastIndexOf(tag)
      if (open !== -1) this.#foreignOpen.length = open
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
      this.#rawText = ''
    } else if (tag === 'plaintext') {
      this.state = PLAINTEXT
    } else {
      this.state = DATA
      // Counted even where HTML would read the tag as text — inside another text
      // element — or break back out of SVG: an element believed to be open only
      // makes the checks stricter.
      if (TEXT_ELEMENTS.has(tag)) this.#textElements.push(tag)
      else if ((tag === 'svg' || tag === 'math') && !this.#selfClosing) this.#foreignOpen.push(tag)
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

function fragmentEndsElement(element: string): ZenError {
  return new ZenError(
    Codes.HTML_UNSAFE,
    `Refused an html\`…\` fragment inside <${element}>: it holds "</${element}", or the start of it, which HTML reads as ` +
      'the end of the element — so the rest of the fragment would be read as markup from a position its own ' +
      'analysis never saw.',
    {
      status: 500,
      expose: false,
      hint: `Pass that value as a string, which is escaped, or close the <${element}> in the template before it.`,
    },
  )
}

function fragmentScriptInForeign(): ZenError {
  return new ZenError(
    Codes.HTML_UNSAFE,
    'Refused an html`…` fragment inside <svg> or <math>: it holds a <script> whose code contains a "<" that SVG and ' +
      'MathML read as a tag, so there the script would neither end nor run as written.',
    {
      status: 500,
      expose: false,
      hint: 'Keep that fragment out of the SVG, or write the script\'s "<" as &lt; or inside <![CDATA[ … ]]>.',
    },
  )
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

/** `</name` at `i`, in any ASCII case, then what ends a tag name — HTML's test for the end of a text element. */
function isEndTagAt(text: string, i: number, name: string): boolean {
  if (text.charCodeAt(i) !== LESS_THAN || text.charCodeAt(i + 1) !== SOLIDUS) return false
  for (let j = 0; j < name.length; j++) {
    const c = text.charCodeAt(i + 2 + j)
    if ((c >= 0x41 && c <= 0x5a ? c + 0x20 : c) !== name.charCodeAt(j)) return false
  }
  return endsName(text.charCodeAt(i + 2 + name.length))
}

/** Whether `text` ends with all of `sequence`, or with a start of it — in any ASCII case. */
function endsPartWayInto(text: string, sequence: string): boolean {
  const tail = asciiLowercase(text.slice(-sequence.length))
  for (let length = tail.length; length > 0; length--) {
    if (tail.endsWith(sequence.slice(0, length))) return true
  }
  return false
}

/**
 * Whether SVG or MathML would find markup in the text of a `<script>` or
 * `<style>`: a `<` that begins a tag, an end tag, a comment, a declaration or a
 * processing instruction. A CDATA section is text to them and is skipped — that
 * is how an SVG script legitimately holds `a<b` — provided it closes.
 */
function holdsMarkup(text: string): boolean {
  for (let i = text.indexOf('<'); i !== -1; i = text.indexOf('<', i + 1)) {
    const next = text.charCodeAt(i + 1)
    if (next === BANG && text.startsWith('[CDATA[', i + 2)) {
      const close = text.indexOf(']]>', i + 9)
      if (close === -1) return true
      i = close + 2
      continue
    }
    if (isAlpha(next) || next === SOLIDUS || next === BANG || next === QUESTION) return true
  }
  return false
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
