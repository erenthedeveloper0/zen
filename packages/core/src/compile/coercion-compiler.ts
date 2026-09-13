import type { CoerceField, CoerceOp, CoercePlan } from '../contracts/coercion.ts'
import { BOOLEAN_WORDS } from '../contracts/coercion.ts'
import { CodeGen, type CodeUnit } from './codegen.ts'
import { COERCE_RUNTIME } from './coercion-runtime.ts'
import { walkCoercer, type Coercer } from './coercion-walk.ts'

export type { Coercer }

/**
 * The Coercion Compiler — rfcs/0001 §11.4, §3.4.
 *
 * §11.4's contract is that coercion happens *inside the compiled validator*,
 * not as a pre-pass, "so it costs nothing where it is not used". This is the
 * mechanical form of that sentence: one generated function per (route, source)
 * whose body is the plan unrolled — one call site per coerced field, no loop
 * over a field list, no `Object.keys`, no dispatch on an op tag at request
 * time. A query schema with one numeric field compiles to one property read,
 * one `typeof`, and one call.
 *
 * And where the plan is empty there is no function at all. Not an empty one, not
 * one that returns its argument: the pipeline that consumed it is emitted with
 * the same bytes it had before this feature existed, which is the property
 * `benchmarks/coercion/run.ts` gates on — the same rule, checked the same way,
 * as §9.4's hooks and §4.4's deadlines.
 *
 * The fallback is `walkCoercer`, which is not a degraded mode but the same
 * semantics interpreted (§14.5).
 */
export function compileCoercer(plan: CoercePlan, name: string, codegen: CodeGen): Coercer {
  const generated = generate(plan)

  const externals: Record<string, unknown> = { ...generated.externals }
  externals['$num'] = COERCE_RUNTIME.num
  externals['$int'] = COERCE_RUNTIME.int
  externals['$bool'] = COERCE_RUNTIME.bool
  externals['$boolIn'] = COERCE_RUNTIME.boolIn
  externals['$split'] = COERCE_RUNTIME.split

  const unit: CodeUnit = {
    name: `coercer:${name}`,
    source: generated.source,
    externals,
  }

  return codegen.materialise<Coercer>(unit, () => walkCoercer(plan))
}

/** Exposed for `zen inspect`, and for the tests that assert on emitted source. */
export function generateCoercerSource(plan: CoercePlan): string {
  return generate(plan).source
}

// ─────────────────────────────────────────────────────────────────────────────

interface Generated {
  readonly source: string
  readonly externals: Readonly<Record<string, unknown>>
}

function generate(plan: CoercePlan): Generated {
  const externals: Record<string, unknown> = {}
  const helpers: string[] = []
  let counter = 0

  const external = (value: unknown): string => {
    const id = `$x${counter++}`
    externals[id] = value
    return id
  }

  const lines: string[] = []
  for (const field of plan.fields) {
    lines.push(...emitField(field, external, helpers))
  }

  const body =
    `${helpers.join('\n\n')}${helpers.length > 0 ? '\n\n' : ''}` +
    `return function coerce$${plan.source}(v) {\n` +
    "  if (typeof v !== 'object' || v === null) return v\n" +
    `${lines.join('\n')}\n` +
    '  return v\n' +
    '}'

  return { source: body, externals }
}

function emitField(
  field: CoerceField,
  external: (value: unknown) => string,
  helpers: string[],
): string[] {
  // A field that neither converts nor blanks contributes no source text, for
  // the same reason a hook-less phase does (§9.4): the absence *is* the feature.
  if (field.op === null && !field.emptyToUndefined) return []

  const key = lit(field.key)
  const out: string[] = ['  {']

  if (field.altKey === null) {
    out.push(`    let c = v[${key}]`)
  } else {
    out.push(`    let c = v[${key}]`, `    if (c === undefined) c = v[${lit(field.altKey)}]`)
  }
  out.push('    if (c !== undefined) {')

  const convert = field.op === null ? null : `v[${key}] = ${expr(field.op, 'c', external, helpers)}`
  if (field.emptyToUndefined) {
    out.push(`      if (c === '') v[${key}] = undefined`)
    if (convert !== null) out.push(`      else ${convert}`)
  } else if (convert !== null) {
    out.push(`      ${convert}`)
  }

  out.push('    }', '  }')
  return out
}

/**
 * One op as an expression over `src`, which must be a plain identifier.
 *
 * The `typeof` guard is inlined rather than pushed into the runtime helper for
 * the same reason the serializer inlines its string check: it keeps the common
 * case — a value that is already the right type, which is every request after
 * validation replaced the cache, and every path param the router already parsed
 * — off a polymorphic call. `$num` itself stays monomorphic on string, which is
 * what lets V8 inline it.
 */
function expr(
  op: CoerceOp,
  src: string,
  external: (value: unknown) => string,
  helpers: string[],
): string {
  switch (op.kind) {
    case 'number':
      return `(typeof ${src} === 'string' ? $num(${src}) : ${src})`

    case 'integer':
      return `(typeof ${src} === 'string' ? $int(${src}) : ${src})`

    case 'boolean':
      return op.words === BOOLEAN_WORDS
        ? `(typeof ${src} === 'string' ? $bool(${src}) : ${src})`
        : `(typeof ${src} === 'string' ? $boolIn(${src}, ${external(op.words)}) : ${src})`

    case 'array': {
      // Arrays are the one shape that needs statements — a split, a wrap and a
      // per-element loop do not fit in an expression — so they become a named
      // helper hoisted above the entry function. One per array position, so a
      // route with two list parameters emits two, each specialised to its own
      // element type.
      //
      // The slot is reserved *before* the body is generated. An array of arrays
      // would otherwise name its inner helper from the same `helpers.length`
      // the outer one is about to claim, and the second declaration would
      // silently shadow the first.
      const index = helpers.length
      helpers.push('')
      const name = `a$${index}`
      helpers[index] = arrayHelper(name, op, external, helpers)
      return `${name}(${src})`
    }
  }
}

function arrayHelper(
  name: string,
  op: Extract<CoerceOp, { kind: 'array' }>,
  external: (value: unknown) => string,
  helpers: string[],
): string {
  const lines: string[] = [`function ${name}(x) {`, '  let list']

  if (op.split === null) {
    lines.push('  if (Array.isArray(x)) list = x')
    lines.push(op.wrap ? '  else list = [x]' : '  else return x')
  } else {
    const sep = lit(op.split)
    lines.push(`  if (Array.isArray(x)) { list = []`)
    lines.push(`    for (let i = 0; i < x.length; i++) {`)
    lines.push(`      const e = x[i]`)
    lines.push(`      if (typeof e === 'string') { const p = $split(e, ${sep}); for (let j = 0; j < p.length; j++) list.push(p[j]) }`)
    lines.push('      else list.push(e)')
    lines.push('    } }')
    lines.push(`  else if (typeof x === 'string') list = $split(x, ${sep})`)
    lines.push(op.wrap ? '  else list = [x]' : '  else return x')
  }

  if (op.items !== null) {
    lines.push('  for (let i = 0; i < list.length; i++) {')
    lines.push('    const e = list[i]')
    lines.push(`    list[i] = ${expr(op.items, 'e', external, helpers)}`)
    lines.push('  }')
  }

  lines.push('  return list', '}')
  return lines.join('\n')
}

/**
 * A property key as a JS string literal.
 *
 * Bracket notation with a quoted literal rather than dot notation, because a
 * schema property is any string — `content-type`, `2fa`, `'` — and a generated
 * `v.content-type` is a subtraction. `JSON.stringify` is the escape rule for
 * exactly this and is what the serializer uses for the same job.
 */
function lit(value: string): string {
  return JSON.stringify(value)
}
