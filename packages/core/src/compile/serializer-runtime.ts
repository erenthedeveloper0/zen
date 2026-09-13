import { SerializationError } from '../errors/serialization-error.ts'

/**
 * The shared encoder set — rfcs/0001 §13.3.
 *
 * Both serializer engines call *these exact functions*: the compiled one
 * receives them as `new Function` externals, the walker holds them directly.
 * That is a deliberate structural choice, not convenience. The differential
 * suite can only prove the two engines agree on *control flow* if they cannot
 * disagree on *encoding* — so string escaping, the number policy, and the
 * strict-mode decisions exist exactly once, and a change to any of them moves
 * both engines together or neither.
 *
 * `strict` is bound at build time rather than passed per call, so the generated
 * source contains no mode checks and the walker branches on nothing.
 */
export interface SerRuntime {
  /** Pure escaper for values already known to be strings (the inline fast path). */
  esc(value: string): string
  str(value: unknown, path: string): string
  date(value: unknown, path: string): string
  day(value: unknown, path: string): string
  num(value: unknown, path: string): string
  int(value: unknown, path: string): string
  bool(value: unknown, path: string): string
  nul(value: unknown, path: string): string
  any(value: unknown, path: string): string
  /** `undefined` means "skip this key", matching `JSON.stringify`'s own rule. */
  extra(value: unknown, path: string): string | undefined
  none(path: string): never
  missing(path: string): never
  notObject(value: unknown, path: string): string
  notArray(value: unknown, path: string): string
  short(length: number, arity: number, path: string): void
  noBranch(value: unknown, path: string): string
  konst(value: unknown, expected: unknown, encoded: string, path: string): string
  enumOf(value: unknown, values: readonly unknown[], encoded: readonly string[], path: string): string
}

/**
 * Characters that make `'"' + s + '"'` wrong.
 *
 * Control characters, the two structural characters, and — the easily-missed
 * one — the surrogate range, because ES2019's well-formed `JSON.stringify`
 * escapes *lone* surrogates as `\udXXX`. Testing for the whole range rather
 * than only unpaired halves sends valid astral characters (emoji, CJK ext-B)
 * down the slow path too. That is a deliberate trade: the check stays one
 * linear regex, and the slow path is `JSON.stringify` itself, so output is
 * byte-identical to the platform's by construction rather than by a hand-rolled
 * escape table that has to be re-audited every time Unicode moves.
 */
const NEEDS_ESCAPE = /[\u0000-\u001f"\\\ud800-\udfff]/

/**
 * Above this length, hand the string to `JSON.stringify` without testing it.
 *
 * Measured, not guessed (`benchmarks/serializer/escape.ts`). V8's
 * `JSON.stringify` has a C++ fast path for strings that scales better than a
 * regex scan followed by a concatenation: the two are level at ~96 characters
 * and native is 1.8x ahead by 256. Skipping the test above the crossover is
 * therefore free — a long string that *does* need escaping was going to end up
 * in `JSON.stringify` regardless, so the scan was pure overhead either way.
 */
const NATIVE_ABOVE = 96

export function escapeString(value: string): string {
  return value.length > NATIVE_ABOVE || NEEDS_ESCAPE.test(value)
    ? JSON.stringify(value)
    : `"${value}"`
}

export function makeRuntime(strict: boolean): SerRuntime {
  /** In strict mode a contract violation is a bug worth surfacing loudly. */
  const fail = (message: string, path: string): never => {
    throw new SerializationError(message, path)
  }

  const describe = (value: unknown): string => {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'an array'
    const type = typeof value
    if (type === 'object') return `a ${(value as object).constructor?.name ?? 'object'}`
    if (type === 'string') return `the string ${JSON.stringify((value as string).slice(0, 32))}`
    return `${type} ${String(value)}`
  }

  const stringify = (value: unknown, path: string): string | undefined => {
    try {
      return JSON.stringify(value)
    } catch (cause) {
      // Circular structures and bigints. `JSON.stringify`'s own message is
      // good; what it lacks is *where*, which is the whole point of carrying
      // the schema path through.
      throw new SerializationError(
        `Value is not JSON-serialisable: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
      )
    }
  }

  const isoOf = (value: Date, path: string): string | null => {
    // `toISOString` throws RangeError on an Invalid Date, which would otherwise
    // escape as a bare RangeError from inside generated code.
    if (Number.isNaN(value.getTime())) {
      if (strict) fail('Expected a valid Date, got Invalid Date', path)
      return null
    }
    return value.toISOString()
  }

  return {
    esc: escapeString,

    str(value, path) {
      if (typeof value === 'string') return escapeString(value)
      // `JSON.stringify` reaches Date.prototype.toJSON, so ISO here is parity,
      // not a Zen invention — and it is what the wire almost always wanted.
      if (value instanceof Date) {
        const iso = isoOf(value, path)
        return iso === null ? 'null' : escapeString(iso)
      }
      if (value === null || value === undefined) {
        if (strict) fail('Expected a string, got ' + describe(value), path)
        return 'null'
      }
      if (strict) fail('Expected a string, got ' + describe(value), path)
      return escapeString(String(value))
    },

    date(value, path) {
      if (value instanceof Date) {
        const iso = isoOf(value, path)
        return iso === null ? 'null' : escapeString(iso)
      }
      if (typeof value === 'string') return escapeString(value)
      if (typeof value === 'number') {
        const iso = isoOf(new Date(value), path)
        return iso === null ? 'null' : escapeString(iso)
      }
      if (strict) fail('Expected a date-time, got ' + describe(value), path)
      return value === null || value === undefined ? 'null' : escapeString(String(value))
    },

    day(value, path) {
      if (value instanceof Date) {
        const iso = isoOf(value, path)
        return iso === null ? 'null' : escapeString(iso.slice(0, 10))
      }
      if (typeof value === 'string') return escapeString(value)
      if (strict) fail('Expected a date, got ' + describe(value), path)
      return value === null || value === undefined ? 'null' : escapeString(String(value))
    },

    num(value, path) {
      if (typeof value === 'number') {
        if (value === value && value !== Infinity && value !== -Infinity) return String(value)
        if (strict) fail(`Expected a finite number, got ${String(value)}`, path)
        return 'null' // JSON.stringify parity
      }
      // `JSON.stringify` throws on bigint. The schema said "number", the value
      // carries an exact integer, and decimal digits are the lossless answer —
      // §13.3.3's "decided once by the schema" in practice.
      if (typeof value === 'bigint') return value.toString()
      if (strict) fail('Expected a number, got ' + describe(value), path)
      const coerced = Number(value)
      return coerced === coerced && coerced !== Infinity && coerced !== -Infinity ? String(coerced) : 'null'
    },

    int(value, path) {
      if (typeof value === 'number') {
        if (Number.isInteger(value)) return String(value)
        if (strict) fail(`Expected an integer, got ${String(value)}`, path)
        return value === value && value !== Infinity && value !== -Infinity ? String(value) : 'null'
      }
      if (typeof value === 'bigint') return value.toString()
      if (strict) fail('Expected an integer, got ' + describe(value), path)
      const coerced = Number(value)
      return coerced === coerced && coerced !== Infinity && coerced !== -Infinity ? String(coerced) : 'null'
    },

    bool(value, path) {
      if (value === true) return 'true'
      if (value === false) return 'false'
      if (strict) fail('Expected a boolean, got ' + describe(value), path)
      return value ? 'true' : 'false'
    },

    nul(value, path) {
      if (value === null || value === undefined) return 'null'
      if (strict) fail('Expected null, got ' + describe(value), path)
      return 'null'
    },

    /**
     * The declared-anything escape hatch (`{}`, `true`, `z.unknown()`), and the
     * only place undeclared keys can reach the wire. Reached solely because the
     * schema asked for it.
     */
    any(value, path) {
      // `undefined` at a value position is `null` under JSON.stringify's array
      // semantics; declared object properties never reach here undefined.
      return stringify(value, path) ?? 'null'
    },

    extra(value, path) {
      return stringify(value, path)
    },

    none(path) {
      return fail('Schema is `false`: nothing may be emitted here', path)
    },

    /**
     * Missing required properties throw in **both** modes, unlike type
     * mismatches.
     *
     * The asymmetry is deliberate. A wrong-typed value can be coerced into
     * something the client can still read; an absent required field cannot —
     * it breaks the generated client's types and every consumer that trusted
     * the contract. Omitting it quietly in production would mean the contract
     * holds only in development, which is the half of the promise nobody
     * needs. Fastify's serializer makes the same call.
     */
    missing(path) {
      return fail('Missing required property', path)
    },

    notObject(value, path) {
      if (strict) fail('Expected an object, got ' + describe(value), path)
      return 'null'
    },

    notArray(value, path) {
      if (strict) fail('Expected an array, got ' + describe(value), path)
      return 'null'
    },

    short(length, arity, path) {
      if (strict && length < arity) {
        fail(`Expected a tuple of ${arity} item${arity === 1 ? '' : 's'}, got ${length}`, path)
      }
    },

    noBranch(value, path) {
      if (strict) fail('Value matches none of the declared union branches: ' + describe(value), path)
      return 'null'
    },

    konst(value, expected, encoded, path) {
      // A const in the schema *is* the contract, so the encoded literal is what
      // ships either way; strict mode only decides whether a handler that
      // disagreed with its own schema gets told about it.
      if (strict && !Object.is(value, expected)) {
        fail(`Expected the constant ${encoded}, got ` + describe(value), path)
      }
      return encoded
    },

    enumOf(value, values, encoded, path) {
      const index = values.indexOf(value)
      if (index !== -1) return encoded[index] as string
      if (strict) fail('Value is not one of the declared enum members: ' + describe(value), path)
      return 'null'
    },
  }
}
