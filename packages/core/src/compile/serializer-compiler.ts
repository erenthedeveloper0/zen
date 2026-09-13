import type { SerNode, SerProgram, SerTest } from './serializer-ir.ts'
import { CodeGen, type CodeUnit } from './codegen.ts'
import { makeRuntime } from './serializer-runtime.ts'
import { walkSerializer, type Serializer } from './serializer-walk.ts'

/**
 * The Serializer Compiler — rfcs/0001 §13.3, subsystem 15.
 *
 * Turns the serializer IR into a specialised `stringify` for one response
 * schema. Four wins, in the order that decided the design:
 *
 *   1. **Security.** Only declared properties are emitted. `passwordHash`,
 *      `internalNotes` and `stripeCustomerId` cannot leak by being present on
 *      the object, because the generated source contains no key enumeration to
 *      leak them *through* — the emitted function literally does not know they
 *      exist. This is the primary justification; speed is a bonus.
 *   2. **Speed.** No `Object.keys`, no per-value type dispatch, no `toJSON`
 *      probing, no property-order rediscovery.
 *   3. **Correctness.** `Date`, `bigint`, `NaN` and missing-required are decided
 *      once by the schema instead of by whatever `JSON.stringify` does.
 *   4. **Contract enforcement.** A response that does not satisfy its own
 *      declared schema is a bug that surfaces here rather than in a client.
 *
 * The fallback is `walkSerializer`, which is not a degraded mode but the same
 * semantics interpreted — it is the production path under `caps.eval === false`
 * and the oracle the differential suite compares against.
 */

export type { Serializer }

/** Emitted encoder names. `$`-prefixed so they cannot collide with `f$N`/`t$N`. */
const RUNTIME_NAMES = [
  'esc', 'str', 'date', 'day', 'num', 'int', 'bool', 'nul', 'any', 'extra',
  'none', 'missing', 'notObject', 'notArray', 'short', 'noBranch', 'konst', 'enumOf',
] as const

export function compileSerializer(program: SerProgram, name: string, codegen: CodeGen): Serializer {
  const generated = generate(program)

  const runtime = makeRuntime(program.strict) as unknown as Record<string, unknown>
  const externals: Record<string, unknown> = { ...generated.externals }
  for (const key of RUNTIME_NAMES) externals[`$${key}`] = runtime[key]

  const unit: CodeUnit = {
    name: `serializer:${name}`,
    source: generated.source,
    externals,
  }

  return codegen.materialise<Serializer>(unit, () => walkSerializer(program))
}

/** Exposed for `zen inspect` and for tests that assert on emitted source. */
export function generateSerializerSource(program: SerProgram): string {
  return generate(program).source
}

// ─────────────────────────────────────────────────────────────────────────────

interface Generated {
  readonly source: string
  readonly externals: Readonly<Record<string, unknown>>
}

function generate(program: SerProgram): Generated {
  const decls: string[] = []
  const externals: Record<string, unknown> = {}
  const helpers = new Map<SerNode, string>()
  let counter = 0
  let temps: string[] = []

  const external = (value: unknown): string => {
    const id = `$x${counter++}`
    externals[id] = value
    return id
  }

  const temp = (): string => {
    const id = `t${temps.length}`
    temps.push(id)
    return id
  }

  /**
   * `src` must be a plain identifier.
   *
   * Several node kinds read it more than once, and a property access could be a
   * getter — evaluating one twice would be observable. Every call site binds to
   * a temporary first, which is why this can stay an expression compiler
   * (statements only appear inside helper functions).
   */
  function emit(node: SerNode, src: string): string {
    const path = lit(node.path)

    switch (node.kind) {
      case 'string':
        // Deliberately *not* inlining the escape branch: `$esc` is monomorphic
        // on string and V8 inlines it, whereas duplicating the escape rule into
        // generated source would give this subsystem two definitions of what a
        // JSON string is. The typeof guard is the part worth having inline —
        // it keeps the common case off the polymorphic `$str`.
        return node.format === 'plain'
          ? `(typeof ${src} === 'string' ? $esc(${src}) : $str(${src}, ${path}))`
          : node.format === 'date-time'
            // Rows come back from most drivers with the timestamp already an ISO
            // string, so the string case is the common one even here.
            ? `(typeof ${src} === 'string' ? $esc(${src}) : $date(${src}, ${path}))`
            : `$day(${src}, ${path})`

      // `x - x === 0` is false for exactly NaN and ±Infinity, which is the whole
      // of the number policy's fast-path condition; `'' + x` is ToString(Number),
      // identical to `String(x)` including for -0.
      case 'number': return `(typeof ${src} === 'number' && ${src} - ${src} === 0 ? '' + ${src} : $num(${src}, ${path}))`
      // `(x | 0) === x` is exact for the 32-bit range that covers essentially
      // every id, index and count; anything wider falls through to `$int`.
      case 'integer': return `(typeof ${src} === 'number' && (${src} | 0) === ${src} ? '' + ${src} : $int(${src}, ${path}))`
      case 'boolean': return `(${src} === true ? 'true' : ${src} === false ? 'false' : $bool(${src}, ${path}))`
      case 'null': return `$nul(${src}, ${path})`
      case 'any': return `$any(${src}, ${path})`
      case 'none': return `$none(${path})`

      case 'const':
        // A non-primitive const can never satisfy `Object.is`, so the strict
        // check is meaningless there; the literal is the contract either way.
        return node.value === null || typeof node.value !== 'object'
          ? `$konst(${src}, ${lit(node.value)}, ${lit(node.encoded)}, ${path})`
          : lit(node.encoded)

      case 'enum':
        return `$enumOf(${src}, ${external(node.values)}, ${external(node.encoded)}, ${path})`

      case 'nullable':
        return `(${src} === null || ${src} === undefined ? 'null' : ${emit(node.inner, src)})`

      case 'ref': {
        const target = program.defs.get(node.name)
        return target === undefined ? `$any(${src}, ${path})` : emit(target, src)
      }

      case 'object':
      case 'array':
      case 'tuple':
      case 'union':
        return `${helper(node)}(${src})`
    }
  }

  /** Registers the name *before* generating the body, so recursion terminates. */
  function helper(node: SerNode): string {
    const existing = helpers.get(node)
    if (existing !== undefined) return existing

    const name = `f$${counter++}`
    helpers.set(node, name)

    const outer = temps
    temps = []
    const body =
      node.kind === 'object' ? objectBody(node)
      : node.kind === 'array' ? arrayBody(node)
      : node.kind === 'tuple' ? tupleBody(node)
      : unionBody(node as SerNode & { kind: 'union' })
    const declarations = temps.length > 0 ? `  let ${temps.join(', ')}\n` : ''
    temps = outer

    decls.push(`function ${name}(v) {\n${declarations}${body}\n}`)
    return name
  }

  function objectBody(node: SerNode & { kind: 'object' }): string {
    const lines: string[] = [
      `  if (v === null || typeof v !== 'object') return $notObject(v, ${lit(node.path)})`,
      `  let s = '{'`,
    ]

    // `sep` is the separator the *next* emitted property needs, when it is
    // statically known. It becomes null — meaning "consult the runtime variable
    // `c`" — only when an optional property has been emitted with nothing
    // guaranteed before it. A schema whose properties are all required (the
    // common shape for a well-specified API) therefore pays nothing: every
    // comma is a literal folded into the adjacent key.
    let sep: string | null = ''
    let usesC = false
    const prefix = (encodedKey: string): string =>
      sep === null ? `c + ${lit(encodedKey)}` : lit(sep + encodedKey)

    for (const prop of node.props) {
      const slot = temp()
      lines.push(`  ${slot} = ${member('v', prop.key)}`)

      if (prop.required) {
        lines.push(`  if (${slot} === undefined) $missing(${lit(prop.node.path)})`)
        lines.push(`  s += ${prefix(prop.encodedKey)} + ${emit(prop.node, slot)}`)
        sep = ','
      } else {
        const assign = sep === ',' ? '' : ` c = ','`
        if (sep !== ',') usesC = true
        lines.push(`  if (${slot} !== undefined) { s += ${prefix(prop.encodedKey)} + ${emit(prop.node, slot)};${assign} }`)
        if (sep !== ',') sep = null
      }
    }

    if (node.additional !== 'drop') {
      if (sep !== null) {
        usesC = true
        lines.push(`  c = ${lit(sep)}`)
      }
      const key = temp()
      const value = temp()
      const encoded = temp()
      lines.push(
        `  const ks = Object.keys(v)`,
        `  for (let i = 0; i < ks.length; i++) {`,
        `    ${key} = ks[i]`,
        node.declared.size > 0 ? `    if (${external(node.declared)}.has(${key})) continue` : '',
        `    ${value} = v[${key}]`,
      )
      if (node.additional === 'passthrough') {
        lines.push(
          `    ${encoded} = $extra(${value}, ${lit(`${node.path}[*]`)})`,
          `    if (${encoded} === undefined) continue`,
          `    s += c + $esc(${key}) + ':' + ${encoded}`,
        )
      } else {
        lines.push(
          `    if (${value} === undefined) continue`,
          `    s += c + $esc(${key}) + ':' + ${emit(node.additional, value)}`,
        )
      }
      lines.push(`    c = ','`, `  }`)
    }

    lines.push(`  return s + '}'`)
    if (usesC) lines.splice(1, 0, `  let c = ''`)
    return lines.filter((line) => line !== '').join('\n')
  }

  function arrayBody(node: SerNode & { kind: 'array' }): string {
    const slot = temp()
    return [
      `  if (!Array.isArray(v)) return $notArray(v, ${lit(node.path)})`,
      `  let s = '['`,
      `  for (let i = 0; i < v.length; i++) {`,
      `    if (i !== 0) s += ','`,
      `    ${slot} = v[i]`,
      `    s += ${emit(node.items, slot)}`,
      `  }`,
      `  return s + ']'`,
    ].join('\n')
  }

  function tupleBody(node: SerNode & { kind: 'tuple' }): string {
    const lines: string[] = [
      `  if (!Array.isArray(v)) return $notArray(v, ${lit(node.path)})`,
      `  $short(v.length, ${node.items.length}, ${lit(node.path)})`,
      `  let s = '['`,
    ]
    node.items.forEach((item, index) => {
      const slot = temp()
      lines.push(`  ${slot} = v[${index}]`)
      lines.push(`  s += ${index === 0 ? '' : `',' + `}${emit(item, slot)}`)
    })
    if (node.rest !== null) {
      const slot = temp()
      lines.push(
        `  for (let i = ${node.items.length}; i < v.length; i++) {`,
        `    if (i !== 0) s += ','`,
        `    ${slot} = v[i]`,
        `    s += ${emit(node.rest, slot)}`,
        `  }`,
      )
    }
    lines.push(`  return s + ']'`)
    return lines.join('\n')
  }

  function unionBody(node: SerNode & { kind: 'union' }): string {
    const lines: string[] = []
    for (const branch of node.branches) {
      lines.push(`  if (${test(branch.test, 'v', external)}) return ${emit(branch.node, 'v')}`)
    }
    lines.push(`  return $noBranch(v, ${lit(node.path)})`)
    return lines.join('\n')
  }

  // ── entry point ────────────────────────────────────────────────────────────
  const root = program.root
  let entry: string
  if (root.kind === 'object' || root.kind === 'array' || root.kind === 'tuple' || root.kind === 'union') {
    entry = helper(root)
  } else {
    temps = []
    const expression = emit(root, 'v')
    const declarations = temps.length > 0 ? `  let ${temps.join(', ')}\n` : ''
    entry = `f$root`
    decls.push(`function f$root(v) {\n${declarations}  return ${expression}\n}`)
    temps = []
  }

  return { source: `${decls.join('\n\n')}\n\nreturn ${entry}`, externals }
}

/**
 * Branch tests mirror `matches()` in the walker one-for-one. They are emitted
 * inline rather than called because each is one or two comparisons — a call
 * would cost more than the test.
 */
function test(spec: SerTest, src: string, external: (value: unknown) => string): string {
  switch (spec.kind) {
    case 'typeof': return `typeof ${src} === ${lit(spec.type)}`
    case 'null': return `${src} === null`
    case 'array': return `Array.isArray(${src})`
    case 'object': return `${src} !== null && typeof ${src} === 'object' && !Array.isArray(${src})`
    case 'discriminant':
      return `${src} !== null && typeof ${src} === 'object' && Object.is(${member(src, spec.prop)}, ${lit(spec.value)})`
    case 'present':
      return `${src} !== null && typeof ${src} === 'object' && ${member(src, spec.prop)} !== undefined`
    case 'const': return `Object.is(${src}, ${lit(spec.value)})`
    // An `||` chain rather than a closure over an external array: no allocation
    // per call, and it reads the same as `matches()`.
    case 'enum': return `(${spec.values.map((v) => `Object.is(${src}, ${lit(v)})`).join(' || ')})`
    case 'always': return 'true'
  }
}

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function member(src: string, key: string): string {
  return SAFE_IDENTIFIER.test(key) ? `${src}.${key}` : `${src}[${lit(key)}]`
}

/**
 * `JSON.stringify` is the literal emitter throughout.
 *
 * Every value that reaches it here is JSON-representable by construction (schema
 * paths, property keys, and `const`/`enum` members that came out of a JSON
 * document), and its output is always a valid JavaScript expression — including
 * the escaping of quotes, backslashes and lone surrogates, which is precisely
 * the thing a hand-rolled emitter gets wrong.
 */
function lit(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined'
}
