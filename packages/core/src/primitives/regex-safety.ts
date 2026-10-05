/** Stratum 0 — no framework imports. */

/**
 * Regular expressions that can backtrack without bound — rfcs/0001 §19.3.
 *
 * §19.3 forbids backtracking regexes on the request path, and claimed a lint
 * that enforced it; until `0.1.0-alpha.4` there was none. This is the analyser
 * behind both halves of the rule as built: `scripts/check-regex.ts` runs it
 * over every regex in the framework's sources in CI, and `app.paramType()`
 * runs it over the application's `test` in development, as `ZEN_REGEX_UNSAFE`.
 *
 * A backtracking engine goes exponential when one string can be split between
 * the iterations of a repetition in many ways, and a failed match makes it try
 * every split. Two shapes produce that, and both are refused:
 *
 *   - **A variable-length repetition inside an unbounded one** — `(a+)+`,
 *     `(a*)*`, `(-?[a-z]+)*`, `(a{1,3})+` — the star-height problem.
 *   - **Alternatives under an unbounded repetition that can match the same
 *     text** — `(a|aa)+` — which is the same ambiguity spelt with `|`.
 *
 * One refinement keeps the rule from refusing the idiom every slug and host
 * name is written in: a repetition each of whose iterations **starts, or ends,
 * with a character the inner repetition cannot match** is unambiguous, because
 * that character fixes where every iteration begins. `[a-z0-9]+(?:-[a-z0-9]+)*`
 * is linear — no `[a-z0-9]` can be the `-` — and passes; `(?:-?[a-z]+)*` is
 * not, and is refused.
 *
 * Conservative where it must guess: a character it cannot place (a negated
 * class, `.`, a Unicode property) is assumed to overlap everything, so the
 * error is always a refusal of something safe, never a pass of something that
 * is not. Lookarounds are atomic in JavaScript and are analysed on their own.
 */
export interface RegexHazard {
  readonly kind: 'nested-quantifier' | 'overlapping-alternation'
  /** The repetition that is ambiguous, as written in the pattern. */
  readonly fragment: string
}

/**
 * The hazards in one pattern, or a `SyntaxError` for a pattern this cannot
 * read — which the CI check reports, since everything it reads compiled, and
 * the development warning ignores.
 */
export function regexHazards(source: string, flags = ''): readonly RegexHazard[] {
  const tree = new Parser(source, flags).parse()
  const hazards: RegexHazard[] = []
  visit(tree, (node) => {
    if (node.kind !== 'repeat' || node.max !== Infinity) return
    const fragment = source.slice(node.start, node.end)
    const inner = variableRepeats(node.body)
    if (inner.length > 0) {
      const repeated = inner.reduce<Chars>((acc, r) => union(acc, charsOf(r.body)), NONE)
      if (!delimited(node.body, repeated)) {
        hazards.push({ kind: 'nested-quantifier', fragment })
        return
      }
    }
    const body = unwrap(node.body)
    if (body.kind === 'alt' && ambiguousBranches(body.branches)) hazards.push({ kind: 'overlapping-alternation', fragment })
  })
  return hazards
}

/**
 * The regex literals in a piece of JavaScript source, by a lexer that tells a
 * regex from a division by what precedes it.
 *
 * For `app.paramType()`'s development warning, which only has the text of the
 * function it was handed (`String(test)`). Approximate by design — template
 * literals are skipped whole, and a regex the function closes over is not in
 * its text — and therefore a warning, not a refusal. The CI check over the
 * framework's own sources uses TypeScript's scanner instead.
 */
export function regexLiterals(code: string): Array<{ readonly source: string; readonly flags: string }> {
  const out: Array<{ source: string; flags: string }> = []
  let prev = ''
  let i = 0
  while (i < code.length) {
    const c = code[i] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      i = end === -1 ? code.length : end
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? code.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(code, i, c)
      prev = 'x'
      continue
    }
    if (c === '/' && (prev === '' || EXPRESSION_START.includes(prev) || KEYWORDS.has(prev))) {
      const end = regexEnd(code, i)
      if (end !== -1) {
        let j = end + 1
        while (j < code.length && /[a-z]/i.test(code[j] as string)) j++
        out.push({ source: code.slice(i + 1, end), flags: code.slice(end + 1, j) })
        i = j
        prev = 'x'
        continue
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i + 1
      while (j < code.length && /[A-Za-z0-9_$]/.test(code[j] as string)) j++
      prev = code.slice(i, j)
      i = j
      continue
    }
    prev = c
    i++
  }
  return out
}

const EXPRESSION_START = '(,=:[!&|?{};+-*%<>~^'
const KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])

function skipQuoted(code: string, start: number, quote: string): number {
  let i = start + 1
  while (i < code.length && code[i] !== quote) i += code[i] === '\\' ? 2 : 1
  return i + 1
}

/** The index of the `/` that closes the regex opened at `start`, or -1. */
function regexEnd(code: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i]
    if (c === '\\') { i++; continue }
    if (c === '\n') return -1
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') inClass = true
    else if (c === '/') return i === start + 1 ? -1 : i
  }
  return -1
}

// ─────────────────────────────────────────────────────────────────────────────
// Character sets: 128 ASCII bits, and whether anything beyond ASCII is in it
// ─────────────────────────────────────────────────────────────────────────────

interface Chars {
  readonly bits: readonly [number, number, number, number]
  readonly beyond: boolean
}

const NONE: Chars = { bits: [0, 0, 0, 0], beyond: false }
const ANY: Chars = { bits: [-1, -1, -1, -1], beyond: true }

function range(lo: number, hi: number): Chars {
  const bits: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = lo; c <= Math.min(hi, 127); c++) bits[c >> 5] = (bits[c >> 5] as number) | (1 << (c & 31))
  return { bits, beyond: hi > 127 }
}

const single = (code: number): Chars => range(code, code)

function union(a: Chars, b: Chars): Chars {
  return {
    bits: [a.bits[0] | b.bits[0], a.bits[1] | b.bits[1], a.bits[2] | b.bits[2], a.bits[3] | b.bits[3]],
    beyond: a.beyond || b.beyond,
  }
}

function complement(a: Chars): Chars {
  return { bits: [~a.bits[0], ~a.bits[1], ~a.bits[2], ~a.bits[3]], beyond: true }
}

function overlaps(a: Chars, b: Chars): boolean {
  return (a.bits[0] & b.bits[0]) !== 0 || (a.bits[1] & b.bits[1]) !== 0 ||
    (a.bits[2] & b.bits[2]) !== 0 || (a.bits[3] & b.bits[3]) !== 0 || (a.beyond && b.beyond)
}

function has(a: Chars, code: number): boolean {
  return code < 128 && ((a.bits[code >> 5] as number) & (1 << (code & 31))) !== 0
}

/** Under the `i` flag a letter matches both of its cases. */
function folded(a: Chars): Chars {
  let out = a
  for (let c = 65; c <= 90; c++) {
    if (has(a, c)) out = union(out, single(c + 32))
    if (has(a, c + 32)) out = union(out, single(c))
  }
  return out
}

const DIGIT = range(48, 57)
const WORD = union(union(range(65, 90), range(97, 122)), union(DIGIT, single(95)))
const SPACE: Chars = { bits: union(range(9, 13), single(32)).bits, beyond: true }
const DOT = complement(union(single(10), single(13)))

// ─────────────────────────────────────────────────────────────────────────────
// The pattern, as a tree
// ─────────────────────────────────────────────────────────────────────────────

type Node =
  | { readonly kind: 'atom'; readonly chars: Chars; readonly start: number; readonly end: number }
  | { readonly kind: 'empty'; readonly start: number; readonly end: number }
  | { readonly kind: 'seq'; readonly items: readonly Node[]; readonly start: number; readonly end: number }
  | { readonly kind: 'alt'; readonly branches: readonly Node[]; readonly start: number; readonly end: number }
  | { readonly kind: 'group'; readonly body: Node; readonly start: number; readonly end: number }
  | { readonly kind: 'look'; readonly body: Node; readonly start: number; readonly end: number }
  | {
      readonly kind: 'repeat'; readonly body: Node; readonly min: number; readonly max: number
      readonly start: number; readonly end: number
    }

type Repeat = Extract<Node, { kind: 'repeat' }>

class Parser {
  #i = 0
  readonly #src: string
  readonly #unicode: boolean
  readonly #sets: boolean
  readonly #fold: boolean
  readonly #dotAll: boolean

  constructor(source: string, flags: string) {
    this.#src = source
    this.#unicode = flags.includes('u') || flags.includes('v')
    this.#sets = flags.includes('v')
    this.#fold = flags.includes('i')
    this.#dotAll = flags.includes('s')
  }

  parse(): Node {
    const tree = this.#alternation()
    if (this.#i < this.#src.length) throw new SyntaxError('unbalanced )')
    return tree
  }

  #alternation(): Node {
    const start = this.#i
    const branches = [this.#sequence()]
    while (this.#src[this.#i] === '|') {
      this.#i++
      branches.push(this.#sequence())
    }
    return branches.length === 1 ? (branches[0] as Node) : { kind: 'alt', branches, start, end: this.#i }
  }

  #sequence(): Node {
    const start = this.#i
    const items: Node[] = []
    while (this.#i < this.#src.length && this.#src[this.#i] !== '|' && this.#src[this.#i] !== ')') {
      items.push(this.#quantified(this.#term()))
    }
    return { kind: 'seq', items, start, end: this.#i }
  }

  #quantified(node: Node): Node {
    const src = this.#src
    let min: number
    let max: number
    const c = src[this.#i]
    if (c === '*') { min = 0; max = Infinity; this.#i++ }
    else if (c === '+') { min = 1; max = Infinity; this.#i++ }
    else if (c === '?') { min = 0; max = 1; this.#i++ }
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(this.#i))
      if (m === null) return node
      min = Number(m[1])
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3])
      this.#i += m[0].length
    } else return node
    if (src[this.#i] === '?') this.#i++
    return { kind: 'repeat', body: node, min, max, start: node.start, end: this.#i }
  }

  #term(): Node {
    const src = this.#src
    const start = this.#i
    const c = src[this.#i] as string
    if (c === '(') {
      this.#i++
      let look = false
      if (src[this.#i] === '?') {
        const next = src[this.#i + 1]
        if (next === '=' || next === '!') { this.#i += 2; look = true }
        else if (next === '<' && (src[this.#i + 2] === '=' || src[this.#i + 2] === '!')) { this.#i += 3; look = true }
        else if (next === '<') this.#i = src.indexOf('>', this.#i) + 1
        else this.#i = src.indexOf(':', this.#i) + 1
      }
      const body = this.#alternation()
      if (src[this.#i] !== ')') throw new SyntaxError('unterminated group')
      this.#i++
      return look ? { kind: 'look', body, start, end: this.#i } : { kind: 'group', body, start, end: this.#i }
    }
    if (c === '[') return this.#atom(this.#class(), start)
    if (c === '^' || c === '$') { this.#i++; return { kind: 'empty', start, end: this.#i } }
    if (c === '.') { this.#i++; return this.#atom(this.#dotAll ? ANY : DOT, start) }
    if (c === '\\') {
      const next = src[this.#i + 1] as string
      if (next === 'b' || next === 'B') { this.#i += 2; return { kind: 'empty', start, end: this.#i } }
      // A back-reference can repeat any text; it is placed nowhere.
      if (/[1-9]/.test(next) || (next === 'k' && src[this.#i + 2] === '<')) {
        this.#i = next === 'k' ? src.indexOf('>', this.#i) + 1 : this.#i + 2
        while (/[0-9]/.test(src[this.#i] ?? '')) this.#i++
        return this.#atom(ANY, start)
      }
      return this.#atom(this.#escape(), start)
    }
    const code = this.#unicode ? (src.codePointAt(this.#i) as number) : src.charCodeAt(this.#i)
    this.#i += code > 0xffff ? 2 : 1
    return this.#atom(single(code), start)
  }

  #atom(chars: Chars, start: number): Node {
    return { kind: 'atom', chars: this.#fold ? folded(chars) : chars, start, end: this.#i }
  }

  /** `[...]`, including ranges and escapes; a `v`-mode set operation is placed nowhere. */
  #class(): Chars {
    const src = this.#src
    this.#i++
    const negate = src[this.#i] === '^'
    if (negate) this.#i++
    let set = NONE
    while (this.#i < src.length && src[this.#i] !== ']') {
      if (this.#sets && (src[this.#i] === '[' || src.startsWith('&&', this.#i) || src.startsWith('--', this.#i))) {
        let depth = 1
        while (this.#i < src.length && depth > 0) {
          const ch = src[this.#i]
          if (ch === '\\') this.#i++
          else if (ch === '[') depth++
          else if (ch === ']') depth--
          this.#i++
        }
        this.#i--
        set = ANY
        break
      }
      const lo = this.#classAtom()
      if (src[this.#i] === '-' && src[this.#i + 1] !== ']' && lo.code !== null) {
        this.#i++
        const hi = this.#classAtom()
        set = hi.code === null ? union(union(set, lo.chars), union(single(45), hi.chars)) : union(set, range(lo.code, hi.code))
      } else {
        set = union(set, lo.chars)
      }
    }
    if (src[this.#i] !== ']') throw new SyntaxError('unterminated class')
    this.#i++
    return negate ? complement(set) : set
  }

  #classAtom(): { readonly code: number | null; readonly chars: Chars } {
    const src = this.#src
    if (src[this.#i] === '\\') {
      if (src[this.#i + 1] === 'b') { this.#i += 2; return { code: 8, chars: single(8) } }
      const chars = this.#escape()
      return { code: this.#lastCode, chars }
    }
    const code = this.#unicode ? (src.codePointAt(this.#i) as number) : src.charCodeAt(this.#i)
    this.#i += code > 0xffff ? 2 : 1
    return { code, chars: single(code) }
  }

  /** The single code point the last escape stood for, or null for a class escape. */
  #lastCode: number | null = null

  #escape(): Chars {
    const src = this.#src
    const c = src[this.#i + 1] as string
    this.#i += 2
    this.#lastCode = null
    switch (c) {
      case 'd': return DIGIT
      case 'D': return complement(DIGIT)
      case 'w': return WORD
      case 'W': return complement(WORD)
      case 's': return SPACE
      case 'S': return complement(SPACE)
      case 'p': case 'P':
        if (src[this.#i] === '{') this.#i = src.indexOf('}', this.#i) + 1
        return ANY
      case 'n': return this.#code(10)
      case 'r': return this.#code(13)
      case 't': return this.#code(9)
      case 'v': return this.#code(11)
      case 'f': return this.#code(12)
      case '0': return this.#code(0)
      case 'c': {
        const letter = src.charCodeAt(this.#i)
        this.#i++
        return this.#code(letter % 32)
      }
      case 'x': {
        const hex = src.slice(this.#i, this.#i + 2)
        this.#i += 2
        return this.#code(Number.parseInt(hex, 16))
      }
      case 'u': {
        if (src[this.#i] === '{') {
          const close = src.indexOf('}', this.#i)
          const code = Number.parseInt(src.slice(this.#i + 1, close), 16)
          this.#i = close + 1
          return this.#code(code)
        }
        const code = Number.parseInt(src.slice(this.#i, this.#i + 4), 16)
        this.#i += 4
        return this.#code(code)
      }
      default:
        return this.#code(c.charCodeAt(0))
    }
  }

  #code(code: number): Chars {
    this.#lastCode = code
    return single(code)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Every node, lookaround bodies included — each is a pattern of its own. */
function visit(node: Node, fn: (node: Node) => void): void {
  fn(node)
  switch (node.kind) {
    case 'seq': for (const item of node.items) visit(item, fn); break
    case 'alt': for (const branch of node.branches) visit(branch, fn); break
    case 'group': case 'look': case 'repeat': visit(node.body, fn); break
    default: break
  }
}

/** Repetitions inside `node` that match a varying number of times — outside lookarounds, which are atomic. */
function variableRepeats(node: Node): Repeat[] {
  const out: Repeat[] = []
  const walk = (n: Node): void => {
    switch (n.kind) {
      case 'repeat': if (n.min !== n.max) out.push(n); walk(n.body); break
      case 'seq': for (const item of n.items) walk(item); break
      case 'alt': for (const branch of n.branches) walk(branch); break
      case 'group': walk(n.body); break
      default: break
    }
  }
  walk(node)
  return out
}

/** Every character `node` can consume. */
function charsOf(node: Node): Chars {
  switch (node.kind) {
    case 'atom': return node.chars
    case 'seq': return node.items.reduce<Chars>((acc, item) => union(acc, charsOf(item)), NONE)
    case 'alt': return node.branches.reduce<Chars>((acc, branch) => union(acc, charsOf(branch)), NONE)
    case 'group': case 'repeat': return charsOf(node.body)
    default: return NONE
  }
}

/** Groups and one-item sequences removed, so `((?:a|aa))` is the alternation it holds. */
function unwrap(node: Node): Node {
  let current = node
  for (;;) {
    if (current.kind === 'group') current = current.body
    else if (current.kind === 'seq' && current.items.length === 1) current = current.items[0] as Node
    else return current
  }
}

/** The characters a node must consume exactly once — a delimiter — or null. */
function mandatoryChar(node: Node): Chars | null {
  const n = unwrap(node)
  if (n.kind === 'atom') return n.chars
  if (n.kind === 'repeat' && n.min === 1 && n.max === 1) return mandatoryChar(n.body)
  if (n.kind === 'alt') {
    let all = NONE
    for (const branch of n.branches) {
      const chars = mandatoryChar(branch)
      if (chars === null) return null
      all = union(all, chars)
    }
    return all
  }
  return null
}

/** Whether every iteration of `body` starts, or ends, with a character `repeated` cannot match. */
function delimited(body: Node, repeated: Chars): boolean {
  const n = unwrap(body)
  const items = (n.kind === 'seq' ? n.items : [n]).filter((item) => item.kind !== 'empty' && item.kind !== 'look')
  if (items.length === 0) return false
  const first = mandatoryChar(items[0] as Node)
  if (first !== null && !overlaps(first, repeated)) return true
  const last = mandatoryChar(items[items.length - 1] as Node)
  return last !== null && !overlaps(last, repeated)
}

/**
 * Whether two alternatives can match the same text. Two fixed strings of
 * single characters are compared position by position — `ab|ac` diverge and
 * are safe, `a|aa` do not — and anything else by the characters it can begin
 * with, which is the conservative answer.
 */
function ambiguousBranches(branches: readonly Node[]): boolean {
  const shapes = branches.map(fixedChars)
  const firsts = branches.map(firstChars)
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      const x = shapes[a] as Chars[] | null
      const y = shapes[b] as Chars[] | null
      if (x !== null && y !== null) {
        let diverge = false
        for (let k = 0; k < Math.min(x.length, y.length); k++) {
          if (!overlaps(x[k] as Chars, y[k] as Chars)) { diverge = true; break }
        }
        if (!diverge) return true
        continue
      }
      const fa = firsts[a] as Chars | null
      const fb = firsts[b] as Chars | null
      if (fa === null || fb === null || overlaps(fa, fb)) return true
    }
  }
  return false
}

/** A branch that is a fixed run of single characters, as one set per position; or null. */
function fixedChars(node: Node): Chars[] | null {
  const n = unwrap(node)
  const items = n.kind === 'seq' ? n.items : [n]
  const out: Chars[] = []
  for (const item of items) {
    const chars = mandatoryChar(item)
    if (chars === null) return null
    out.push(chars)
  }
  return out
}

/** What a node can begin with; null when it can match the empty string. */
function firstChars(node: Node): Chars | null {
  const n = unwrap(node)
  switch (n.kind) {
    case 'atom': return n.chars
    case 'seq': {
      let acc = NONE
      for (const item of n.items) {
        if (item.kind === 'empty' || item.kind === 'look') continue
        const first = firstChars(item)
        if (first === null) {
          acc = union(acc, charsOf(item))
          continue
        }
        return union(acc, first)
      }
      return null
    }
    case 'alt': {
      let acc = NONE
      for (const branch of n.branches) {
        const first = firstChars(branch)
        if (first === null) return null
        acc = union(acc, first)
      }
      return acc
    }
    case 'repeat': return n.min === 0 ? null : firstChars(n.body)
    default: return null
  }
}
