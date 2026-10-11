import type { Logger, LogLevel } from '../contracts/logger.ts'
import { REDACTED } from '../contracts/config.ts'

const ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
}

/**
 * A `pino`-shaped default so `@erenthedeveloper0/zen-core` keeps zero runtime dependencies.
 * `@erenthedeveloper0/zen-plugin-logger` swaps in real pino; the interface is identical, which
 * is the point of I6.
 */
export class ConsoleLogger implements Logger {
  /** Shared with every child, so configuring the root at boot reaches them all. */
  readonly #state: LoggerState
  #bindings: Record<string, unknown>

  constructor(level: LogLevel = 'info', bindings: Record<string, unknown> = {}, state?: LoggerState) {
    this.#state = state ?? { level, threshold: ORDER[level], redact: null }
    this.#bindings = bindings
  }

  get level(): LogLevel {
    return this.#state.level
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.#state.level, { ...this.#bindings, ...bindings }, this.#state)
  }

  /**
   * `logging.level` and `logging.redact` from configuration — §16.1, §31.1 —
   * applied by `ready()` once configuration is resolved. Children share this
   * logger's state, so a request's `ctx.log` follows whatever was set here.
   *
   * Redaction happens when a line is serialised, on the whole line — bindings
   * and fields alike — so a secret is hidden whichever object carried it in.
   * A path is dot-separated keys; `*` stands for any one key and `**` for any
   * number of them, so `**.password` hides a `password` at any depth and
   * `req.headers.authorization` hides exactly that one. The patterns are the
   * subset pino's `redact` accepts plus `**`.
   */
  configure(options: { readonly level?: LogLevel | undefined; readonly redact?: readonly string[] | undefined }): void {
    if (options.level !== undefined) {
      this.#state.level = options.level
      this.#state.threshold = ORDER[options.level]
    }
    if (options.redact !== undefined) {
      this.#state.redact = options.redact.length === 0 ? null : options.redact.map((path) => path.split('.'))
    }
  }

  /**
   * Never throws — §12.8. A logger runs on the error path, where a throw is a
   * second failure hiding the first: the error engine logs before it formats,
   * so a `meta` object holding a cycle or a `bigint` used to escape from
   * `JSON.stringify` here and take the request down with it. The fast path is
   * the plain `JSON.stringify` it always was; only a line that cannot be
   * encoded pays for the careful one.
   */
  #write(level: LogLevel, a: object | string, b?: string): void {
    if (ORDER[level] < this.#state.threshold) return
    try {
      const obj = typeof a === 'string' ? {} : a
      const msg = typeof a === 'string' ? a : b
      let line: Record<string, unknown> = {
        level,
        time: new Date().toISOString(),
        ...this.#bindings,
        ...serialise(obj),
      }
      if (msg !== undefined) line['msg'] = msg
      const redact = this.#state.redact
      if (redact !== null) line = hide(line, redact.map((segments) => ({ segments, at: 0 })), 0) as Record<string, unknown>
      const sink = ORDER[level] >= 50 ? console.error : console.log
      let text: string
      try {
        text = JSON.stringify(line)
      } catch {
        text = JSON.stringify(line, tolerant())
      }
      sink(text)
    } catch {
      // Nothing is left that could report this. Dropping one line beats
      // throwing from inside the code that was reporting something else.
    }
  }

  trace(a: object | string, b?: string): void { this.#write('trace', a, b) }
  debug(a: object | string, b?: string): void { this.#write('debug', a, b) }
  info(a: object | string, b?: string): void { this.#write('info', a, b) }
  warn(a: object | string, b?: string): void { this.#write('warn', a, b) }
  error(a: object | string, b?: string): void { this.#write('error', a, b) }
  fatal(a: object | string, b?: string): void { this.#write('fatal', a, b) }
}

/** What a logger and its children share. */
interface LoggerState {
  level: LogLevel
  threshold: number
  /** Each redaction path, split on `.`; `null` when there is none. */
  redact: string[][] | null
}

interface Cursor {
  readonly segments: readonly string[]
  readonly at: number
}

/** How deep redaction looks. A log line deeper than this is not a log line. */
const REDACT_DEPTH = 16

/**
 * A copy of `node` with every value a path matches replaced by `********`.
 * Each path is followed down as keys match it; `**` may match no key, or any
 * number, so it is carried down unconsumed as well as advanced past.
 */
function hide(node: unknown, cursors: readonly Cursor[], depth: number): unknown {
  if (typeof node !== 'object' || node === null || cursors.length === 0 || depth > REDACT_DEPTH) return node
  const out: Record<string, unknown> | unknown[] = Array.isArray(node) ? [] : {}
  for (const key of Object.keys(node)) {
    const next: Cursor[] = []
    let hidden = false
    for (const cursor of cursors) {
      for (const advanced of step(cursor, key)) {
        if (advanced.at === advanced.segments.length) hidden = true
        else next.push(advanced)
      }
    }
    const value = (node as Record<string, unknown>)[key]
    ;(out as Record<string, unknown>)[key] = hidden ? REDACTED : next.length === 0 ? value : hide(value, next, depth + 1)
  }
  return out
}

function step(cursor: Cursor, key: string): Cursor[] {
  const segment = cursor.segments[cursor.at]
  if (segment === '**') {
    // Match this key and keep `**` open for the next, or match nothing and
    // try the segment after it against this key.
    const out: Cursor[] = [cursor]
    if (cursor.at + 1 < cursor.segments.length) out.push(...step({ segments: cursor.segments, at: cursor.at + 1 }, key))
    else out.push({ segments: cursor.segments, at: cursor.segments.length })
    return out
  }
  return segment === '*' || segment === key ? [{ segments: cursor.segments, at: cursor.at + 1 }] : []
}

/**
 * A replacer for the line `JSON.stringify` refused: cycles become
 * `"[Circular]"` and a `bigint` its decimal digits, which is what a reader of
 * the log wanted in both cases.
 */
function tolerant(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}

/** Errors do not survive JSON.stringify; flatten them explicitly. */
function serialise(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    out[key] = value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value
  }
  return out
}

export class NoopLogger implements Logger {
  readonly level: LogLevel = 'fatal'
  child(): Logger { return this }
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
}
