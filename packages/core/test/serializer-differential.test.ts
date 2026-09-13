import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProgram, compileSerializer, walkSerializer, generateSerializerSource,
  CodeGen, DEFAULT_CAPABILITIES,
  type JsonSchema, type Serializer,
} from '@zenjs/core'

/**
 * Differential testing for the serializer — rfcs/0001 §20.5, §13.3.
 *
 * The hand-written suite proves the two engines agree on the cases someone
 * thought of. This one proves it on cases nobody thought of, which is where
 * codegen bugs actually live: separator bookkeeping across an unusual mix of
 * required and optional properties, a union nested inside an array inside a
 * `$ref`, `undefined` arriving at a position the author never pictured.
 *
 * Three invariants are checked on every generated pair, and the third is the
 * security one:
 *
 *   1. compiled output === walked output, byte for byte (and identical throws)
 *   2. the output parses as JSON
 *   3. no key appears in the output that the schema did not declare
 *
 * Seeds are deterministic, so a failure is reproducible from the message alone.
 */

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })

/** Deterministic PRNG — a failing seed is committable. */
function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T

// ─────────────────────────────────────────────────────────────────────────────
// Schema generation, restricted to the supported subset so `buildProgram`
// always succeeds; unsupported constructs have their own diagnostic tests.
// ─────────────────────────────────────────────────────────────────────────────

const CLOSED_LEAVES: readonly JsonSchema[] = [
  { type: 'string' },
  { type: 'string', format: 'date-time' },
  { type: 'number' },
  { type: 'integer' },
  { type: 'boolean' },
  { type: 'null' },
  { const: 'fixed' },
  { enum: ['a', 'b', 7] },
]

/** `{}` accepts anything, so it belongs only to the open generator. */
const OPEN_LEAVES: readonly JsonSchema[] = [...CLOSED_LEAVES, {}]

const KEYS = ['a', 'b', 'c', 'd', 'content-type'] as const

/**
 * `open` decides whether the generator may emit constructs that legitimately
 * pass undeclared keys through — `additionalProperties` and the anything-schema.
 *
 * The split exists so invariant 3 can stay *exact* rather than becoming "no
 * undeclared keys, unless somewhere in the tree something allowed them", which
 * is the kind of weakened assertion that stops catching regressions.
 */
function randomSchema(random: () => number, depth: number, open: boolean): JsonSchema {
  const leaves = open ? OPEN_LEAVES : CLOSED_LEAVES
  if (depth <= 0 || random() < 0.35) return pick(random, leaves)

  switch (pick(random, ['object', 'object', 'object', 'array', 'tuple', 'union', 'nullable'] as const)) {
    case 'object': {
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      const count = 1 + Math.floor(random() * 4)
      for (let i = 0; i < count; i++) {
        const key = KEYS[i] as string
        properties[key] = randomSchema(random, depth - 1, open)
        if (random() < 0.5) required.push(key)
      }
      const additional = open ? random() : 1
      return {
        type: 'object',
        properties,
        required,
        ...(additional < 0.2 ? { additionalProperties: true }
          : additional < 0.35 ? { additionalProperties: pick(random, CLOSED_LEAVES) }
          : {}),
      }
    }
    case 'array':
      return { type: 'array', items: randomSchema(random, depth - 1, open) }
    case 'tuple':
      return {
        type: 'array',
        prefixItems: [randomSchema(random, depth - 1, open), randomSchema(random, depth - 1, open)],
        ...(random() < 0.5 ? { items: pick(random, leaves) } : {}),
      }
    case 'union':
      // Discriminated: the only union shape the compiler accepts, so the only
      // one worth fuzzing for agreement.
      return {
        oneOf: [
          {
            type: 'object',
            properties: { kind: { const: 'x' }, x: randomSchema(random, depth - 1, open) },
            required: ['kind'],
          },
          {
            type: 'object',
            properties: { kind: { const: 'y' }, y: randomSchema(random, depth - 1, open) },
            required: ['kind'],
          },
        ],
      }
    case 'nullable':
      return { anyOf: [randomSchema(random, depth - 1, open), { type: 'null' }] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Value generation. Deliberately *not* schema-conforming half the time — the
// interesting divergences are in how the two engines handle wrong input.
// ─────────────────────────────────────────────────────────────────────────────

const WILD: readonly unknown[] = [
  undefined, null, 0, -0, 1.5, NaN, Infinity, '', 'text', '"quoted"', true, false,
  [], [1, 2], {}, { kind: 'x' }, { kind: 'z' }, new Date('2024-01-02T03:04:05.678Z'), new Date('bad'),
  9007199254740993n,
]

function randomValue(random: () => number, source: JsonSchema, depth: number): unknown {
  if (random() < 0.2) return pick(random, WILD)

  const type = source.type
  if (source.const !== undefined) return random() < 0.7 ? source.const : pick(random, WILD)
  if (Array.isArray(source.enum)) return random() < 0.7 ? pick(random, source.enum) : 'off-list'
  if (Array.isArray(source.oneOf) || Array.isArray(source.anyOf)) {
    const branches = (source.oneOf ?? source.anyOf) as readonly JsonSchema[]
    return randomValue(random, pick(random, branches), depth - 1)
  }

  switch (type) {
    case 'string': return source.format === 'date-time' && random() < 0.5
      ? new Date(Math.floor(random() * 1.7e12))
      : pick(random, ['', 'plain', 'with "quotes"', 'ünïcøde 😀'])
    case 'number': return random() * 1000 - 500
    case 'integer': return Math.floor(random() * 1000) - 500
    case 'boolean': return random() < 0.5
    case 'null': return null
    case 'array': {
      const length = Math.floor(random() * 4)
      const items = (Array.isArray(source.prefixItems) ? source.prefixItems : null)
      if (items !== null) {
        const out = items.map((item) => randomValue(random, item, depth - 1))
        if (source.items !== undefined && typeof source.items === 'object') {
          for (let i = 0; i < length; i++) out.push(randomValue(random, source.items, depth - 1))
        }
        return out
      }
      const element = typeof source.items === 'object' ? source.items : {}
      return Array.from({ length }, () => randomValue(random, element, depth - 1))
    }
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(source.properties ?? {})) {
        // Omit sometimes, including required keys — a thrown SerializationError
        // is an observable both engines must produce identically.
        if (random() < 0.25) continue
        out[key] = randomValue(random, child, depth - 1)
      }
      // Undeclared keys, every time: invariant 3 has to have something to catch.
      out['passwordHash'] = 'LEAK'
      if (random() < 0.5) out['nested'] = { alsoLeaked: true }
      return out
    }
    default:
      return pick(random, WILD)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface Observation {
  readonly output: string | null
  readonly error: string | null
}

function observe(serialize: Serializer, value: unknown): Observation {
  try {
    return { output: serialize(value), error: null }
  } catch (error) {
    return { output: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

/** Every key a *closed* schema could legitimately produce, for invariant 3. */
function declaredKeys(source: JsonSchema, into: Set<string>): Set<string> {
  if (typeof source !== 'object' || source === null) return into
  for (const [key, child] of Object.entries(source.properties ?? {})) {
    into.add(key)
    declaredKeys(child, into)
  }
  for (const child of [
    ...(Array.isArray(source.prefixItems) ? source.prefixItems : []),
    ...(Array.isArray(source.oneOf) ? source.oneOf : []),
    ...(Array.isArray(source.anyOf) ? source.anyOf : []),
    ...(typeof source.items === 'object' ? [source.items] : []),
  ]) {
    declaredKeys(child as JsonSchema, into)
  }
  return into
}

function collectKeys(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key)
      collectKeys(child, into)
    }
  }
  return into
}

interface RunOptions {
  readonly seeds: number
  readonly strict: boolean
  readonly open: boolean
  readonly offset: number
}

function run(options: RunOptions): number {
  let produced = 0

  for (let seed = 1 + options.offset; seed <= options.seeds + options.offset; seed++) {
    const random = rng(seed)
    const source = randomSchema(random, 3, options.open)
    const { program, diagnostics } = buildProgram(source, options.strict)

    assert.equal(diagnostics.length, 0, `seed ${seed}: ${JSON.stringify(diagnostics)}\n${JSON.stringify(source)}`)
    assert.notEqual(program, null)

    const compiled = compileSerializer(program!, `fuzz${seed}`, codegen)
    const walked = walkSerializer(program!)
    const value = randomValue(random, source, 3)

    const c = observe(compiled, value)
    const w = observe(walked, value)

    const context = () =>
      `seed ${seed}\nschema: ${JSON.stringify(source)}\nvalue: ${safe(value)}\n` +
      `generated:\n${generateSerializerSource(program!)}`

    // ── 1: the engines agree ──────────────────────────────────────────────
    assert.deepEqual(c, w, `engines diverged at ${context()}`)

    if (c.output === null) continue
    produced++

    // ── 2: the output is JSON ─────────────────────────────────────────────
    let parsed: unknown
    try {
      parsed = JSON.parse(c.output)
    } catch (error) {
      assert.fail(`emitted invalid JSON (${String(error)}): ${c.output}\nat ${context()}`)
    }

    // ── 3: nothing undeclared escaped ─────────────────────────────────────
    if (!options.open) {
      const allowed = declaredKeys(source, new Set())
      for (const key of collectKeys(parsed, new Set())) {
        assert.ok(allowed.has(key), `undeclared key "${key}" reached the wire at ${context()}`)
      }
    }
  }

  return produced
}

describe('differential: compiled serializer ≡ walking serializer', () => {
  for (const strict of [false, true]) {
    test(`1000 closed schemas — agreement, valid JSON, no leaks (strict: ${strict})`, () => {
      const produced = run({ seeds: 1000, strict, open: false, offset: 0 })
      // Guard against a generator that silently stops producing output.
      assert.ok(produced > 400, `only ${produced} of 1000 pairs produced output`)
    })
  }

  test('500 open schemas — additionalProperties and anything-schemas still agree', () => {
    const produced = run({ seeds: 500, strict: false, open: true, offset: 5_000 })
    assert.ok(produced > 200, `only ${produced} of 500 pairs produced output`)
  })
})

describe('differential: the walker is the definition, and codegen is optional', () => {
  test('caps.eval === false produces the walker for every generated schema', () => {
    const noEval = new CodeGen({ caps: { ...DEFAULT_CAPABILITIES, eval: false } })

    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed + 10_000)
      const source = randomSchema(random, 3, true)
      const { program } = buildProgram(source, false)
      const value = randomValue(random, source, 3)

      const withEval = observe(compileSerializer(program!, `e${seed}`, codegen), value)
      const without = observe(compileSerializer(program!, `n${seed}`, noEval), value)

      assert.deepEqual(without, withEval, `seed ${seed} diverged under caps.eval === false`)
    }
  })
})

function safe(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value)
  } catch {
    return String(value)
  }
}
