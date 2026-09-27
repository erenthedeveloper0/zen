/**
 * Stratum 0 — no framework imports.
 *
 * `.env` text → entries, with line numbers — rfcs/0001 §16.1 layer 5.
 *
 * It takes a **string**, not a path. §3.2 says the Config Store is not
 * responsible for reading files and assigns that to the CLI or the adapter, and
 * the reason is concrete rather than procedural: `@visionpilot/zen-core` has no `node:`
 * imports (§3.3 B2), so a parser that opened a file would be a core module that
 * cannot run on workerd. Splitting it here puts the *policy* — what a line
 * means, what quoting does, which layer it lands in — in core, where it is
 * tested, and leaves the four lines that call `readFile` to whoever has a
 * filesystem:
 *
 * ```ts
 * import { readFileSync } from 'node:fs'
 * const dotenv = (file: string) => ({
 *   layer: 'dotenv' as const,
 *   name: file,
 *   entries: parseDotenv(readFileSync(file, 'utf8')),
 * })
 * ```
 *
 * The `line` on every entry is the point of parsing rather than `eval`-ing: it
 * is what turns "PORT is not a valid integer" into "`.env:3` says PORT is not a
 * valid integer", and a config subsystem that cannot say *which file and which
 * line* has not actually answered the question it exists for.
 *
 * ### The grammar
 *
 * The de-facto one, which no two implementations agree on completely. What is
 * supported, and why:
 *
 *   - `KEY=value`, with optional surrounding whitespace and an optional
 *     `export ` prefix, so a file can be `source`d by a shell as well as read
 *     here. People do this and it costs one `startsWith`.
 *   - `#` starts a comment at the beginning of a line, and after an *unquoted*
 *     value. Inside quotes it is a `#`, because `PASSWORD=hunter#2` is a
 *     password and truncating it silently would be the worst possible failure
 *     mode for this parser.
 *   - `'single'` is literal. `"double"` expands `\n`, `\r`, `\t`, `\\` and
 *     `\"` — the set a multi-line PEM key needs, which is the only common
 *     reason a `.env` value contains a newline at all.
 *   - Unquoted values are trimmed; quoted values are not, because the quotes
 *     are how you say "the trailing space is mine".
 *   - A line with no `=` is skipped rather than refused. A `.env` is edited by
 *     hand under time pressure, often by someone who is not the author of this
 *     parser, and taking a service down over a stray word helps nobody. It is
 *     reported instead — see the return of `parseDotenv` in `problems`.
 *
 * Multi-line *unquoted* values are not supported, and neither is variable
 * interpolation (`${OTHER}`). Interpolation in particular is deliberate: it is
 * a small language, it has an escaping problem, and §16.2's answer to "this
 * value is derived from that one" is a thunk in `zen.config.ts` where it is
 * typed and testable.
 */

/**
 * One variable, as one source saw it.
 *
 * Defined here rather than in `contracts/config.ts` and re-exported from there
 * as `EnvEntry`, for the same reason `Duration` lives in `primitives/time.ts`:
 * stratum 0 may not import the vocabulary, and one definition in the lower
 * stratum is better than two definitions that agree today.
 */
export interface EnvEntry {
  readonly key: string
  readonly value: string
  /** 1-based, when the source has lines. Absent for `process.env`. */
  readonly line?: number | undefined
}

export interface DotenvResult {
  readonly entries: readonly EnvEntry[]
  /** Lines that were not blank, not comments, and not `KEY=value`. */
  readonly problems: readonly { readonly line: number; readonly text: string }[]
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/

export function parseDotenv(text: string): DotenvResult {
  const entries: EnvEntry[] = []
  const problems: Array<{ line: number; text: string }> = []

  // `\r\n` and a leading BOM both arrive from Windows editors, and both would
  // otherwise end up inside a key or a value where nothing would ever explain
  // why `PORT` was not found.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim()
    if (raw === '' || raw.startsWith('#')) continue

    const line = i + 1
    const body = raw.startsWith('export ') ? raw.slice(7).trimStart() : raw
    const eq = body.indexOf('=')
    if (eq <= 0) {
      problems.push({ line, text: raw })
      continue
    }

    const key = body.slice(0, eq).trim()
    if (!KEY.test(key)) {
      problems.push({ line, text: raw })
      continue
    }

    entries.push({ key, value: readValue(body.slice(eq + 1)), line })
  }

  return { entries, problems }
}

function readValue(rest: string): string {
  const trimmed = rest.trim()
  const quote = trimmed.charAt(0)

  if (quote === '"' || quote === "'") {
    const end = findClosing(trimmed, quote)
    // An unterminated quote is treated as the value running to end of line
    // rather than as an error, because the alternative — refusing to boot over
    // a missing `"` — is worse than the value being one character long.
    const inner = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
    return quote === '"' ? unescape(inner) : inner
  }

  // Unquoted: an inline `#` starts a comment. Quoted values never reach here,
  // which is what keeps `hunter#2` intact.
  const hash = trimmed.indexOf(' #')
  return (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim()
}

function findClosing(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text.charAt(i) === '\\') { i++; continue }
    if (text.charAt(i) === quote) return i
  }
  return -1
}

function unescape(value: string): string {
  if (!value.includes('\\')) return value
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i)
    if (ch !== '\\' || i === value.length - 1) { out += ch; continue }
    const next = value.charAt(++i)
    out += next === 'n' ? '\n'
      : next === 'r' ? '\r'
      : next === 't' ? '\t'
      : next === '\\' ? '\\'
      : next === '"' ? '"'
      // An unknown escape keeps both characters. A Windows path in a `.env`
      // (`ROOT=C:\\Users`) is far more likely than a novel escape sequence, and
      // eating the backslash would corrupt it.
      : '\\' + next
  }
  return out
}

/**
 * The `.env` precedence chain of §16.1 layer 5, as an ordering over filenames.
 *
 * `.env` → `.env.local` → `.env.<mode>` → `.env.<mode>.local`, and the caller
 * reads whichever of them exist. Kept here, next to the parser, rather than
 * left to each host to remember: the ordering is the specification, and a host
 * that got it backwards would put a committed `.env` above a developer's
 * uncommitted `.env.local` and no test anywhere would notice.
 *
 * `.env.local` is skipped when mode is `test`, which is the one exception every
 * implementation of this convention has and is worth stating: a test run must
 * produce the same result on a developer's machine as in CI, and `.env.local`
 * is by definition the file that differs between them.
 */
export function dotenvChain(mode: string): readonly string[] {
  const files = ['.env']
  if (mode !== 'test') files.push('.env.local')
  files.push(`.env.${mode}`)
  if (mode !== 'test') files.push(`.env.${mode}.local`)
  return files
}
