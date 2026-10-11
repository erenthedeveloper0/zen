import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Development error rendering — rfcs/0001 §12.6, the half that needs a host.
 *
 * Core puts the facts in a development problem document's `debug`: the code,
 * where the route was registered, where in the application the error was
 * raised and the code around that line, the route's resolved chain, the fix.
 * Reading the source for that code frame needs a filesystem, and writing the
 * result where a developer looks needs a terminal, and core has neither
 * (§3.3 B2) — so this module supplies both, and `zen()` installs them in
 * development only.
 */

interface Frame {
  readonly file: string
  readonly line: number
  readonly lines: ReadonlyArray<{ readonly line: number; readonly text: string }>
}

interface Debug {
  readonly message?: string
  readonly thrown?: string
  readonly origin?: string
  readonly route?: string | null
  readonly frame?: Frame
  readonly chain?: readonly string[]
  readonly hint?: string
  readonly consequence?: string
  readonly docs?: string
}

/** One entry of a validation problem's `errors` — §11.3. */
interface Issue {
  readonly path?: readonly unknown[]
  readonly code?: string
  readonly message?: string
  readonly received?: unknown
}

export interface RenderOptions {
  /** ANSI colour. */
  readonly color?: boolean | undefined
  /** OSC 8 hyperlinks on file locations — what modern terminals make clickable. */
  readonly links?: boolean | undefined
  /** The directory relative locations are under, for the links' absolute paths. */
  readonly root?: string | undefined
}

/**
 * A development problem document, as text for a terminal:
 *
 * ```
 *  ✖ 500 ZEN_INTERNAL  database is gone
 *    raised at  src/services/users.ts:88:11
 *    route      GET /users/:id   registered src/routes.ts:31:3
 *
 *       86 │   const user = await repo.find(id)
 *     ❯ 88 │   throw new Error('database is gone')
 *
 *    chain      onRequest [global] rateLimit → phase [global] authenticate → handler showUser
 *    docs       https://github.com/erenthedeveloper0/zen/blob/main/docs/errors.md#zen_internal
 * ```
 */
export function renderError(problem: Readonly<Record<string, unknown>>, options: RenderOptions = {}): string {
  const debug = (problem['debug'] ?? {}) as Debug
  const paint = painter(options.color === true)
  const link = (location: string): string => (options.links === true ? hyperlink(location, options.root) : location)
  const out: string[] = []
  const status = String(problem['status'] ?? 500)
  const code = String(problem['code'] ?? 'ZEN_INTERNAL')
  out.push(` ${paint.red(`✖ ${status} ${code}`)}  ${debug.message ?? String(problem['title'] ?? '')}`)
  const issues = Array.isArray(problem['errors']) ? (problem['errors'] as Issue[]) : []
  if (issues.length > 0) {
    out.push('')
    for (const issue of issues) {
      const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
      const received = issue.received === undefined ? '' : `   ${paint.dim('received')} ${JSON.stringify(issue.received)}`
      out.push(`   ${path || '(root)'}   ${paint.dim(String(issue.code ?? ''))}   ${String(issue.message ?? '')}${received}`)
    }
    out.push('')
  }
  if (debug.thrown !== undefined) out.push(`   ${paint.dim('raised at')}  ${link(debug.thrown)}`)
  if (debug.route !== undefined && debug.route !== null) {
    out.push(`   ${paint.dim('route    ')}  ${String(problem['instance'] ?? '')} ${paint.dim('→')} ${debug.route}` +
      (debug.origin === undefined ? '' : `   ${paint.dim('registered')} ${link(debug.origin)}`))
  }
  if (debug.frame !== undefined) {
    out.push('')
    const width = String(debug.frame.lines.at(-1)?.line ?? debug.frame.line).length
    for (const line of debug.frame.lines) {
      const hit = line.line === debug.frame.line
      const number = String(line.line).padStart(width)
      out.push(hit ? `   ${paint.red('❯')} ${paint.bold(number)} │ ${line.text}` : `     ${paint.dim(number)} │ ${paint.dim(line.text)}`)
    }
  }
  if (debug.chain !== undefined && debug.chain.length > 0) {
    out.push('')
    out.push(`   ${paint.dim('chain    ')}  ${debug.chain.join(paint.dim(' → '))}`)
  }
  if (debug.hint !== undefined) out.push(`   ${paint.green('fix:')}       ${debug.hint}`)
  if (debug.consequence !== undefined) out.push(`   ${paint.yellow('also:')}      ${debug.consequence}`)
  if (debug.docs !== undefined) out.push(`   ${paint.dim('docs     ')}  ${debug.docs}`)
  return out.join('\n')
}

/**
 * What `zen()` reports a development 5xx through: rendered to stderr, with
 * colour and links, when stderr is a terminal — and nothing otherwise, so a
 * test run's output and a log pipeline are left as they were. `NO_COLOR`
 * turns the colour off (https://no-color.org).
 */
export function terminalReporter(options: { readonly root?: string | undefined } = {}): (problem: Readonly<Record<string, unknown>>) => void {
  const host = globalThis as {
    process?: { stderr?: { isTTY?: boolean; write?: (text: string) => unknown }; env?: Record<string, string | undefined> }
  }
  return (problem) => {
    const stderr = host.process?.stderr
    if (stderr?.isTTY !== true || typeof stderr.write !== 'function') return
    const color = host.process?.env?.['NO_COLOR'] === undefined
    stderr.write(`\n${renderError(problem, { color, links: true, root: options.root })}\n\n`)
  }
}

/**
 * Read a source file for a code frame, once per file per process. Errors are
 * the one place this runs, and a frame is worth the read; a file that cannot
 * be read is no frame, never an error of its own.
 */
export function sourceReader(): (file: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  return (file) => {
    if (cache.has(file)) return cache.get(file)
    let text: string | undefined
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      text = undefined
    }
    cache.set(file, text)
    return text
  }
}

function hyperlink(location: string, root: string | undefined): string {
  const last = location.lastIndexOf(':')
  const second = last <= 0 ? -1 : location.lastIndexOf(':', last - 1)
  const file = second <= 0 ? location : location.slice(0, second)
  const absolute = isAbsolute(file) ? file : join(root ?? '', file)
  let uri: string
  try {
    uri = pathToFileURL(absolute).href
  } catch {
    return location
  }
  return `\u001b]8;;${uri}\u001b\\${location}\u001b]8;;\u001b\\`
}

function painter(enabled: boolean) {
  const wrap = (open: number, close: number) => (text: string): string =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text
  return {
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  }
}
