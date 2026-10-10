import type { Capabilities } from '../contracts/capabilities.ts'
import { Codes } from '../errors/codes.ts'
import { ZenError } from '../errors/zen-error.ts'

/**
 * The CodeGen facility — rfcs/0001 §3.4.
 *
 * All code generation in the framework goes through here rather than scattering
 * `new Function` calls. Centralising it buys four things that scattered calls
 * cannot:
 *
 *   1. One `eval: false` switch. Flip `caps.eval` and *every* subsystem falls
 *      back to its interpreted twin at once (workerd, CSP-locked environments).
 *   2. A single integration point for `zen build`: emit instead of materialise.
 *   3. Uniform diagnostics — a codegen failure reports which unit failed and
 *      prints the offending source rather than dying inside `new Function`.
 *   4. Systematic differential testing: every call site *must* supply a
 *      fallback, so the fuzzer can run both and assert equivalence (§20.5).
 */
export interface CodeUnit {
  readonly name: string
  readonly source: string
  readonly externals: Readonly<Record<string, unknown>>
}

export interface CodeGenOptions {
  readonly caps: Capabilities
  /** Dev emits formatted, commented source so `zen inspect pipeline` is readable. */
  readonly readable?: boolean | undefined
  /**
   * Keep every unit after it is compiled, for {@link CodeGen.units}. Off by
   * default: a unit is its source and its externals, held for the life of the
   * process, and nothing reads them after boot unless something asked to
   * inspect them — at 10,000 routes that is megabytes of strings. `onEmit`
   * is handed every unit either way.
   */
  readonly retain?: boolean | undefined
  readonly onEmit?: ((unit: CodeUnit) => void) | undefined
}

export class CodeGen {
  readonly enabled: boolean
  #readable: boolean
  #retain: boolean
  #onEmit: ((unit: CodeUnit) => void) | undefined
  #units: CodeUnit[] = []

  constructor(opts: CodeGenOptions) {
    this.enabled = opts.caps.eval && detectEvalSupport()
    this.#readable = opts.readable ?? false
    this.#retain = opts.retain ?? false
    this.#onEmit = opts.onEmit
  }

  get readable(): boolean {
    return this.#readable
  }

  /** Whether {@link units} holds what was compiled — see `CodeGenOptions.retain`. */
  get retains(): boolean {
    return this.#retain
  }

  /**
   * Every emitted unit, for `zen build` and `zen inspect`. Refused unless
   * `retain` was set: an empty list would read as "nothing was emitted", and a
   * check that some stage emits no code would pass by reading nothing.
   */
  get units(): readonly CodeUnit[] {
    if (!this.#retain) {
      throw new ZenError(Codes.INSPECT_DISABLED, 'CodeGen.units was read from a CodeGen that keeps no units.', {
        status: 500,
        expose: false,
        hint: 'Construct it with new CodeGen({ caps, retain: true }) where the units are wanted.',
      })
    }
    return this.#units
  }

  /**
   * Compile `unit`, or call `fallback` when codegen is unavailable.
   * The fallback is not optional — see reason 4 above.
   */
  materialise<T>(unit: CodeUnit, fallback: () => T): T {
    if (this.#retain) this.#units.push(unit)
    this.#onEmit?.(unit)

    if (!this.enabled) return fallback()

    const names = Object.keys(unit.externals)
    const values = names.map((n) => unit.externals[n])

    try {
      const factory = new Function(...names, `"use strict";\n${unit.source}`) as (...args: unknown[]) => T
      return factory(...values)
    } catch (cause) {
      throw new CodeGenError(unit, cause)
    }
  }
}

export class CodeGenError extends Error {
  readonly unit: CodeUnit

  constructor(unit: CodeUnit, cause: unknown) {
    super(
      `Failed to compile unit "${unit.name}". This is a Zen bug — please report it with the source below.\n\n` +
        numberLines(unit.source),
      { cause },
    )
    this.name = 'CodeGenError'
    this.unit = unit
  }
}

function numberLines(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n')
}

function detectEvalSupport(): boolean {
  try {
    return new Function('return 1')() === 1
  } catch {
    return false
  }
}

/** Identifier hygiene: generated names can never collide with externals. */
export function ident(prefix: string, n: number): string {
  return `${prefix}$${n}`
}
