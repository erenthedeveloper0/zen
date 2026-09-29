import type { HeaderBag } from '../contracts/reply.ts'
import type { HeaderValue, LowercaseName } from '../contracts/http.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * Small-array backed header bag — rfcs/0001 §13.6.
 *
 * Real responses carry 6-12 headers. At that size a linear scan over two
 * parallel arrays beats a Map on both time and allocation: no hashing, no
 * iterator objects, no entry allocation, and insertion order is free.
 */
export class SmallHeaderBag implements HeaderBag {
  #names: string[] = []
  #values: (string | string[])[] = []

  static from(init?: Readonly<Record<string, HeaderValue>>): SmallHeaderBag {
    const bag = new SmallHeaderBag()
    if (init) {
      for (const key in init) {
        const v = init[key]
        if (v !== undefined) bag.set(key, v)
      }
    }
    return bag
  }

  #indexOf(name: LowercaseName): number {
    const names = this.#names
    for (let i = 0; i < names.length; i++) {
      if (names[i] === name) return i
    }
    return -1
  }

  get(name: LowercaseName): string | undefined {
    const i = this.#indexOf(name)
    if (i === -1) return undefined
    const v = this.#values[i]
    return Array.isArray(v) ? v[0] : v
  }

  getAll(name: LowercaseName): readonly string[] {
    const i = this.#indexOf(name)
    if (i === -1) return EMPTY
    const v = this.#values[i]
    return Array.isArray(v) ? v : [v as string]
  }

  set(name: string, value: HeaderValue): void {
    assertHeader(name, value)
    this.setChecked(name, value)
  }

  append(name: string, value: string): void {
    assertHeader(name, value)
    this.appendChecked(name, value)
  }

  /**
   * `set` for a name and value that already passed {@link assertHeader} — the
   * headers `ctx.res` staged, which were checked when the handler staged them,
   * so egress does not check each one a second time.
   */
  setChecked(name: string, value: HeaderValue): void {
    const lower = name.toLowerCase()
    const normalised = Array.isArray(value) ? value.slice() : (value as string)
    const i = this.#indexOf(lower)
    if (i === -1) {
      this.#names.push(lower)
      this.#values.push(normalised)
    } else {
      this.#values[i] = normalised
    }
  }

  /** `append`, likewise for a checked name and value. */
  appendChecked(name: string, value: string): void {
    const lower = name.toLowerCase()
    const i = this.#indexOf(lower)
    if (i === -1) {
      this.#names.push(lower)
      this.#values.push(value)
      return
    }
    const existing = this.#values[i]
    if (Array.isArray(existing)) existing.push(value)
    else this.#values[i] = [existing as string, value]
  }

  has(name: LowercaseName): boolean {
    return this.#indexOf(name) !== -1
  }

  delete(name: LowercaseName): void {
    const i = this.#indexOf(name)
    if (i === -1) return
    this.#names.splice(i, 1)
    this.#values.splice(i, 1)
  }

  /** Flattened: multi-value headers expand to one entry per value. */
  entries(): Array<[string, string]> {
    const out: Array<[string, string]> = []
    for (let i = 0; i < this.#names.length; i++) {
      const name = this.#names[i] as string
      const value = this.#values[i] as string | string[]
      if (Array.isArray(value)) {
        for (let j = 0; j < value.length; j++) out.push([name, value[j] as string])
      } else {
        out.push([name, value])
      }
    }
    return out
  }

  get size(): number {
    return this.#names.length
  }
}

const EMPTY: readonly string[] = Object.freeze([])

/**
 * §19.5 — a header is *validated* when it is set, and throws. It is never
 * silently sanitised: quietly dropping an injected newline hides the bug that
 * produced it.
 *
 * The rule is RFC 9110's, and it is also exactly what Node's `http` enforces
 * when the adapter writes the header: a name is a token (§5.1), a value is
 * tabs, spaces, visible ASCII and obs-text — no other control character, and
 * nothing past U+00FF (§5.5). Checking only CR, LF and NUL, as this once did,
 * let the rest through to the adapter, whose error then fell outside the error
 * path: the error reply carried the same staged header and failed the same way,
 * and a `ctx.res.header()` of a user's non-ASCII filename answered with the
 * adapter's last-resort 500 and no `onResponse` hook.
 *
 * Checked where it is set — `ctx.res.header()` included, though the header is
 * only applied at egress — so the throw lands in the code that caused it, and
 * the error reply goes out normally.
 */
export function assertHeader(name: string, value: HeaderValue): void {
  if (!TOKENS.has(name)) {
    if (typeof name !== 'string' || !TOKEN.test(name)) {
      throw new ZenError(
        Codes.HEADER_INVALID,
        `Header name ${JSON.stringify(name)} is not a token: letters, digits and !#$%&'*+-.^_\`|~ only.`,
        { status: 500, expose: false },
      )
    }
    // An application writes a handful of header names, over and over — the
    // security headers on every response — and a set answers for one in a
    // third of the time the pattern takes. Bounded, because a name can come
    // from a request; once full it only stops remembering.
    if (TOKENS.size < 512) TOKENS.add(name)
  }
  if (Array.isArray(value)) {
    for (const v of value) assertHeader(name, v)
    return
  }
  // A caller without types may pass a number — `ctx.res.header('x-count', 5)` —
  // which Node writes as its digits, so it is judged by the text it becomes.
  const kind = typeof value
  const text = kind === 'string' ? value as string
    : kind === 'number' || kind === 'bigint' || kind === 'boolean' ? String(value)
    : null
  const at = text === null ? 0 : firstNonFieldCharacter(text)
  if (at === -1) return
  const code = text === null ? -1 : text.charCodeAt(at)
  throw new ZenError(
    Codes.HEADER_INVALID,
    code === -1
      ? `Header "${name.toLowerCase()}" has a value that is not a string.`
      : `Header "${name.toLowerCase()}" contains a character a header cannot carry ` +
        `(U+${code.toString(16).toUpperCase().padStart(4, '0')}) at index ${at}.`,
    {
      status: 500,
      expose: false,
      hint:
        'Encode the value for the header it goes in — a URL with encodeURI(), a download name as ' +
        "filename*=UTF-8''${encodeURIComponent(name)} — and never pass a line break through.",
    },
  )
}

/**
 * Where the first character RFC 9110 §5.5 does not allow in a field value is,
 * or -1: a control but HTAB, DEL, or anything past U+00FF.
 *
 * A loop for the short values almost every header has, and the regular
 * expression past that, where it finds "nothing to refuse" several times faster
 * (see `escapeHtml`); measured, each wins on its own side of the line.
 */
function firstNonFieldCharacter(value: string): number {
  if (value.length > 48) return value.search(NOT_FIELD_VALUE)
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09) || c === 0x7f || c > 0xff) return i
  }
  return -1
}

/** RFC 9110 §5.6.2 `token`. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Names already found to be tokens — see `assertHeader`. */
const TOKENS = new Set<string>()
/** Anything RFC 9110 §5.5 does not allow in a field value: controls but HTAB, DEL, and past U+00FF. */
const NOT_FIELD_VALUE = /[^\t\x20-\x7e\x80-\xff]/
