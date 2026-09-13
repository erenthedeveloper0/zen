import type { SerNode, SerProgram, SerTest } from './serializer-ir.ts'
import { makeRuntime, type SerRuntime } from './serializer-runtime.ts'

export type Serializer = (value: unknown) => string

/**
 * The walking serializer — the interpreted twin (rfcs/0001 §13.3, I6).
 *
 * This is the *semantic definition* of Zen serialization. `compileSerializer`
 * must produce byte-identical output for every input, and the differential
 * suite asserts that over randomly generated schema/value pairs. Reading this
 * file tells you exactly what the framework promises to emit; reading the
 * compiler tells you how it avoids the interpretation overhead.
 *
 * It is also the production path wherever `new Function` is unavailable —
 * workerd, CSP-locked environments — so it is written to be *correct first and
 * unembarrassing second*, not merely as a test oracle. No per-node closures are
 * allocated per request and no schema paths are built at request time (they are
 * baked into the IR at boot).
 */
export function walkSerializer(program: SerProgram): Serializer {
  const rt = makeRuntime(program.strict)
  const defs = program.defs

  function write(node: SerNode, value: unknown): string {
    switch (node.kind) {
      case 'string':
        return node.format === 'plain' ? rt.str(value, node.path)
          : node.format === 'date-time' ? rt.date(value, node.path)
          : rt.day(value, node.path)
      case 'number': return rt.num(value, node.path)
      case 'integer': return rt.int(value, node.path)
      case 'boolean': return rt.bool(value, node.path)
      case 'null': return rt.nul(value, node.path)
      case 'any': return rt.any(value, node.path)
      case 'none': return rt.none(node.path)
      case 'const': return rt.konst(value, node.value, node.encoded, node.path)
      case 'enum': return rt.enumOf(value, node.values, node.encoded, node.path)

      case 'nullable':
        return value === null || value === undefined ? 'null' : write(node.inner, value)

      case 'ref': {
        const target = defs.get(node.name)
        // Unreachable: `buildProgram` queues every ref it names.
        return target === undefined ? rt.any(value, node.path) : write(target, value)
      }

      case 'object': return writeObject(node, value)
      case 'array': return writeArray(node, value)
      case 'tuple': return writeTuple(node, value)
      case 'union': return writeUnion(node, value)
    }
  }

  function writeObject(node: SerNode & { kind: 'object' }, value: unknown): string {
    if (value === null || typeof value !== 'object') return rt.notObject(value, node.path)
    const source = value as Record<string, unknown>

    let out = '{'
    let sep = ''

    for (const prop of node.props) {
      const child = source[prop.key]
      if (child === undefined) {
        if (prop.required) rt.missing(prop.node.path)
        continue
      }
      out += sep + prop.encodedKey + write(prop.node, child)
      sep = ','
    }

    // Undeclared keys reach the wire here and nowhere else — §13.3.1.
    if (node.additional !== 'drop') {
      const extraPath = `${node.path}[*]`
      for (const key of Object.keys(source)) {
        if (node.declared.has(key)) continue
        const child = source[key]
        if (node.additional === 'passthrough') {
          const encoded = rt.extra(child, extraPath)
          if (encoded === undefined) continue
          out += `${sep}${rt.esc(key)}:${encoded}`
        } else {
          if (child === undefined) continue
          out += `${sep}${rt.esc(key)}:${write(node.additional, child)}`
        }
        sep = ','
      }
    }

    return `${out}}`
  }

  function writeArray(node: SerNode & { kind: 'array' }, value: unknown): string {
    if (!Array.isArray(value)) return rt.notArray(value, node.path)
    let out = '['
    for (let i = 0; i < value.length; i++) {
      if (i !== 0) out += ','
      out += write(node.items, value[i])
    }
    return `${out}]`
  }

  function writeTuple(node: SerNode & { kind: 'tuple' }, value: unknown): string {
    if (!Array.isArray(value)) return rt.notArray(value, node.path)
    rt.short(value.length, node.items.length, node.path)

    let out = '['
    for (let i = 0; i < node.items.length; i++) {
      if (i !== 0) out += ','
      out += write(node.items[i] as SerNode, value[i])
    }
    if (node.rest !== null) {
      for (let i = node.items.length; i < value.length; i++) {
        if (i !== 0) out += ','
        out += write(node.rest, value[i])
      }
    }
    return `${out}]`
  }

  function writeUnion(node: SerNode & { kind: 'union' }, value: unknown): string {
    for (const branch of node.branches) {
      if (matches(branch.test, value)) return write(branch.node, value)
    }
    return rt.noBranch(value, node.path)
  }

  return (value: unknown) => write(program.root, value)
}

/** Shared with the compiler only in *meaning*; the compiler emits these inline. */
export function matches(test: SerTest, value: unknown): boolean {
  switch (test.kind) {
    case 'typeof': return typeof value === test.type
    case 'null': return value === null
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'discriminant':
      return value !== null && typeof value === 'object' &&
        Object.is((value as Record<string, unknown>)[test.prop], test.value)
    case 'present':
      return value !== null && typeof value === 'object' &&
        (value as Record<string, unknown>)[test.prop] !== undefined
    case 'const': return Object.is(value, test.value)
    case 'enum': return test.values.some((candidate) => Object.is(candidate, value))
    case 'always': return true
  }
}

/** Exposed so the compiler's generated code can share the exact runtime set. */
export type { SerRuntime }
