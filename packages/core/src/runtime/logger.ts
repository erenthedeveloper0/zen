import type { Logger, LogLevel } from '../contracts/logger.ts'

const ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
}

/**
 * A `pino`-shaped default so `@zenjs/core` keeps zero runtime dependencies.
 * `@zenjs/plugin-logger` swaps in real pino; the interface is identical, which
 * is the point of I6.
 */
export class ConsoleLogger implements Logger {
  readonly level: LogLevel
  #bindings: Record<string, unknown>
  #threshold: number

  constructor(level: LogLevel = 'info', bindings: Record<string, unknown> = {}) {
    this.level = level
    this.#bindings = bindings
    this.#threshold = ORDER[level]
  }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.level, { ...this.#bindings, ...bindings })
  }

  #write(level: LogLevel, a: object | string, b?: string): void {
    if (ORDER[level] < this.#threshold) return
    const obj = typeof a === 'string' ? {} : a
    const msg = typeof a === 'string' ? a : b
    const line: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      ...this.#bindings,
      ...serialise(obj),
    }
    if (msg !== undefined) line['msg'] = msg
    const sink = ORDER[level] >= 50 ? console.error : console.log
    sink(JSON.stringify(line))
  }

  trace(a: object | string, b?: string): void { this.#write('trace', a, b) }
  debug(a: object | string, b?: string): void { this.#write('debug', a, b) }
  info(a: object | string, b?: string): void { this.#write('info', a, b) }
  warn(a: object | string, b?: string): void { this.#write('warn', a, b) }
  error(a: object | string, b?: string): void { this.#write('error', a, b) }
  fatal(a: object | string, b?: string): void { this.#write('fatal', a, b) }
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
