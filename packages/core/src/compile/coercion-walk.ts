import type { CoerceOp, CoercePlan } from '../contracts/coercion.ts'
import { coerceBoolean, coerceBooleanIn, coerceInteger, coerceNumber, splitList } from './coercion-runtime.ts'
import { BOOLEAN_WORDS } from '../contracts/coercion.ts'

/** Applied in place to the source record, and returned for call-site symmetry. */
export type Coercer = (value: unknown) => unknown

/**
 * The walking coercer — the *interpreted twin* (rfcs/0001 §14.5, I6).
 *
 * This is the semantic definition of what a coercion plan means. It is the
 * production path under `caps.eval === false` (workerd, CSP-locked runtimes),
 * and it is the oracle the differential fuzzer compares the generated form
 * against. Every compiled subsystem in Zen has one of these; the convention has
 * caught five real bugs that hand-written tests missed, and the cost of keeping
 * it is that the two must be edited together.
 *
 * It mutates the record it is given rather than building a new one, and that is
 * safe by construction rather than by convention: every object it ever sees is
 * allocated fresh per request by the thing that produced it — `parseQuery`,
 * `buildHeaders`, `parseCookies`, the router's params builder, the form parser
 * — and is handed to exactly one validator. Rebuilding would allocate a second
 * object per request per source to no end, and §4.2 stage 7 already says the
 * validated output *replaces* the lazy accessor's cache rather than living
 * beside it.
 */
export function walkCoercer(plan: CoercePlan): Coercer {
  const fields = plan.fields

  return function coerce(value: unknown): unknown {
    // A body is the only source that can be something other than an object —
    // `text/plain` parses to a string, `application/octet-stream` to bytes —
    // and a plan derived from an object schema has nothing to say about those.
    if (typeof value !== 'object' || value === null) return value
    const record = value as Record<string, unknown>

    for (const field of fields) {
      let current = record[field.key]
      // `?tags[]=a` — the bracket spelling, read only when the plain key is
      // absent, so a client that sends both does not have one silently ignored.
      if (current === undefined && field.altKey !== null) current = record[field.altKey]
      if (current === undefined) continue

      if (field.emptyToUndefined && current === '') {
        record[field.key] = undefined
        continue
      }

      if (field.op !== null) record[field.key] = apply(field.op, current)
    }

    return record
  }
}

export function apply(op: CoerceOp, value: unknown): unknown {
  switch (op.kind) {
    case 'number':
      return typeof value === 'string' ? coerceNumber(value) : value

    case 'integer':
      return typeof value === 'string' ? coerceInteger(value) : value

    case 'boolean':
      return typeof value === 'string'
        ? (op.words === BOOLEAN_WORDS ? coerceBoolean(value) : coerceBooleanIn(value, op.words))
        : value

    case 'array': {
      // Order is fixed and load-bearing: shape the list first, convert the
      // elements second. A `comma` field arriving as `?a=1,2` has to become two
      // elements before either can be a number, and a `repeat` field arriving
      // once has to become a one-element list before that element is converted.
      let list: unknown[]
      if (Array.isArray(value)) {
        list = op.split === null ? value : flatSplit(value, op.split)
      } else if (op.split !== null && typeof value === 'string') {
        list = splitList(value, op.split)
      } else if (op.wrap) {
        list = [value]
      } else {
        return value
      }

      if (op.items === null) return list
      for (let i = 0; i < list.length; i++) list[i] = apply(op.items, list[i])
      return list
    }
  }
}

/**
 * A repeated *and* comma-separated parameter — `?a=1,2&a=3`.
 *
 * Real, and produced by clients that assume the other convention. Splitting
 * each element and flattening is the only reading under which both halves of
 * that request survive; the alternative is to keep `'1,2'` as one element and
 * let it fail element conversion, which discards information the client sent.
 */
function flatSplit(values: readonly unknown[], separator: string): unknown[] {
  const out: unknown[] = []
  for (const value of values) {
    if (typeof value === 'string') out.push(...splitList(value, separator))
    else out.push(value)
  }
  return out
}
