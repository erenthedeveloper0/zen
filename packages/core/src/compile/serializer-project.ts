import type { SerNode, SerProgram } from './serializer-ir.ts'
import { matches } from './serializer-walk.ts'

/**
 * A response value as the serializer will write it — rfcs/0001 §11.5, §13.3.
 *
 * Response validation judges what is sent, and what is sent is not the value a
 * handler returned: the compiled serializer drops every field the schema does
 * not declare (§13.3.1), and writes a `Date` where the schema says string as its
 * ISO text and a `bigint` where it says number as its digits — in strict mode
 * and out of it. A validator handed the raw value refused all three: a row
 * returned with its `passwordHash`, which is the README's own example, failed a
 * `.strict()` schema, and a `createdAt: Date` failed `z.iso.datetime()` — a 500
 * in development, where validation is on by default, for responses the wire
 * carried correctly.
 *
 * So the value is projected through the same IR the serializer runs, and only
 * those three things change. A value of the wrong type is left exactly as it
 * was, because finding it is what validation is for: the serializer's
 * production-mode coercions are not applied here, or they would hide the bugs
 * this exists to report.
 *
 * Built at boot, per route and status, and only where validation is on; a
 * route whose validation is off never builds one.
 */
export function projector(program: SerProgram): (value: unknown) => unknown {
  const defs = program.defs

  function project(node: SerNode, value: unknown): unknown {
    switch (node.kind) {
      case 'string':
        return node.format === 'plain' ? asText(value)
          : node.format === 'date-time' ? asDateTime(value)
          : asDay(value)
      case 'number':
      case 'integer':
        return typeof value === 'bigint' ? Number(value) : value
      case 'null':
        return value === undefined ? null : value
      case 'nullable':
        return value === null || value === undefined ? null : project(node.inner, value)
      case 'ref': {
        const target = defs.get(node.name)
        return target === undefined ? value : project(target, value)
      }
      case 'object': return projectObject(node, value)
      case 'array': return Array.isArray(value) ? value.map((item) => project(node.items, item)) : value
      case 'tuple': return projectTuple(node, value)
      case 'union': {
        for (const branch of node.branches) {
          if (matches(branch.test, value)) return project(branch.node, value)
        }
        return value
      }
      default:
        // `any`, `none`, `boolean`, `const`, `enum`: written as they are, or
        // refused for being wrong — either way the value is what to judge.
        return value
    }
  }

  function projectObject(node: SerNode & { kind: 'object' }, value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const prop of node.props) {
      const child = source[prop.key]
      if (child !== undefined) put(out, prop.key, project(prop.node, child))
    }
    if (node.additional !== 'drop') {
      for (const key of Object.keys(source)) {
        if (node.declared.has(key)) continue
        const child = source[key]
        if (child === undefined) continue
        put(out, key, node.additional === 'passthrough' ? child : project(node.additional, child))
      }
    }
    return out
  }

  function projectTuple(node: SerNode & { kind: 'tuple' }, value: unknown): unknown {
    if (!Array.isArray(value)) return value
    const out: unknown[] = []
    for (let i = 0; i < node.items.length && i < value.length; i++) out.push(project(node.items[i] as SerNode, value[i]))
    if (node.rest !== null) {
      for (let i = node.items.length; i < value.length; i++) out.push(project(node.rest, value[i]))
    }
    return out
  }

  return (value) => project(program.root, value)
}

/**
 * What is sent when no serializer runs — `serialization: { mode: 'off' }`, or a
 * schema with no JSON Schema form: `JSON.stringify`'s view of the value, which
 * keeps every field and writes a `Date` through its `toJSON`.
 */
export function stringifiedView(value: unknown): unknown {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? value : JSON.parse(text)
  } catch {
    // A value `JSON.stringify` refuses fails at egress anyway; judge it as it is.
    return value
  }
}

/** The serializer's `str`: a `Date` is written as its ISO text. */
function asText(value: unknown): unknown {
  return value instanceof Date ? isoOf(value) ?? value : value
}

/** The serializer's `date`: a `Date`, or epoch milliseconds, as ISO text. */
function asDateTime(value: unknown): unknown {
  if (value instanceof Date) return isoOf(value) ?? value
  if (typeof value === 'number') return isoOf(new Date(value)) ?? value
  return value
}

/** The serializer's `day`: a `Date` as its `YYYY-MM-DD`. */
function asDay(value: unknown): unknown {
  if (!(value instanceof Date)) return value
  const iso = isoOf(value)
  return iso === null ? value : iso.slice(0, 10)
}

/** An Invalid Date stays a `Date`, so the schema reports it rather than this. */
function isoOf(date: Date): string | null {
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** A key named `__proto__` is data here too: defined, never assigned through the setter. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  else out[key] = value
}
