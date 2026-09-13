import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCoercePlan, compileCoercer, walkCoercer, generateCoercerSource,
  CodeGen, DEFAULT_CAPABILITIES, COERCION_DEFAULTS,
  type CoercePlan, type CoercionProfile, type JsonSchema,
} from '@zenjs/core'
import { shaped } from './helpers.ts'

/**
 * Differential testing for coercion — rfcs/0001 §20.5, §11.4.
 *
 * `coercion.test.ts` proves the two engines agree on the cases someone thought
 * of. This proves it on the cases nobody thought of, which is where codegen
 * bugs actually live: an array of arrays whose helper names collide, a `bracket`
 * key that is present *and* empty, a value that is already the target type
 * arriving at a position that expected a string.
 *
 * Four invariants on every generated pair, and the last two are the ones that
 * would be silent in production:
 *
 *   1. compiled output === walked output, deeply (and identical throws)
 *   2. **idempotence** — coercing twice equals coercing once. This is what lets
 *      §11.4 sit in front of a schema that also coerces (`z.coerce.number()`)
 *      without the two fighting, and it is the property a naive "wrap in an
 *      array" implementation breaks on the second pass.
 *   3. **no key is invented** — the output's keys are a subset of the input's
 *      plus the plan's own, so coercion cannot smuggle a field past a schema
 *      that would have rejected it
 *   4. **a position that accepts a string is untouched** — §11.4's first rule,
 *      checked against the schema the plan was derived from rather than against
 *      the plan, so a bug in the derivation cannot hide behind itself
 *
 * Seeds are deterministic, so a failure is reproducible from the message alone.
 */

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })

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
// Schema generation
// ─────────────────────────────────────────────────────────────────────────────

const LEAVES: readonly JsonSchema[] = [
  { type: 'string' },
  { type: 'number' },
  { type: 'integer' },
  { type: 'boolean' },
  { type: 'null' },
  { enum: [1, 2, 3] },
  { enum: ['a', 'b'] },
  { type: 'number', const: 7 },
  { type: 'object' },
  {},
]

function randomLeaf(random: () => number, depth: number): JsonSchema {
  const roll = random()
  if (depth > 0 && roll < 0.28) {
    return { type: 'array', items: randomLeaf(random, depth - 1) }
  }
  if (depth > 0 && roll < 0.42) {
    return { anyOf: [randomLeaf(random, depth - 1), randomLeaf(random, depth - 1)] }
  }
  if (roll < 0.5) {
    const base = pick(random, LEAVES)
    return random() < 0.3 ? { ...base, nullable: true } : base
  }
  return pick(random, LEAVES)
}

function randomSchema(random: () => number): JsonSchema {
  const count = 1 + Math.floor(random() * 5)
  const properties: Record<string, JsonSchema> = {}
  for (let i = 0; i < count; i++) properties[`f${i}`] = randomLeaf(random, 2)
  return { type: 'object', properties }
}

const RAW_VALUES: readonly unknown[] = [
  '42', '-3.5', '0x10', '01234', '', 'true', 'false', '1', '0', 'yes', 'banana',
  'a,b', 'a, b ,c', '9007199254740993', '1e3',
  7, 3.5, true, false, null, undefined,
]

function randomValue(random: () => number): unknown {
  const roll = random()
  if (roll < 0.2) {
    const length = Math.floor(random() * 3)
    return Array.from({ length }, () => pick(random, RAW_VALUES))
  }
  if (roll < 0.24) return { nested: 'object' }
  return pick(random, RAW_VALUES)
}

function randomRecord(random: () => number, schema: JsonSchema, bracket: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(schema.properties ?? {})) {
    const roll = random()
    if (roll < 0.12) continue
    if (bracket && roll < 0.35) out[`${key}[]`] = randomValue(random)
    else out[key] = randomValue(random)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────

const PROFILES: readonly Partial<CoercionProfile>[] = [
  {},
  { arrays: 'comma' },
  { arrays: 'bracket' },
  { arrays: 'none' },
  { emptyStringAsUndefined: true },
  { numbers: false },
  { booleans: { true: ['y'], false: ['n'] } },
  { arrays: 'comma', emptyStringAsUndefined: true, booleans: false },
]

interface Coverage {
  plans: number
  changed: number
  ops: Record<string, number>
}

function observe(run: (value: unknown) => unknown, input: Record<string, unknown>): unknown {
  try {
    return { ok: run({ ...input }) }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}

function countOps(plan: CoercePlan, coverage: Coverage): void {
  const walk = (op: CoercePlan['fields'][number]['op']): void => {
    if (op === null) return
    coverage.ops[op.kind] = (coverage.ops[op.kind] ?? 0) + 1
    if (op.kind === 'array') walk(op.items)
  }
  for (const field of plan.fields) {
    walk(field.op)
    if (field.emptyToUndefined) coverage.ops['empty'] = (coverage.ops['empty'] ?? 0) + 1
    if (field.altKey !== null) coverage.ops['bracket'] = (coverage.ops['bracket'] ?? 0) + 1
  }
}

/** Property names whose declared type includes `string` — §11.4's first rule. */
function stringPositions(schema: JsonSchema): Set<string> {
  const out = new Set<string>()
  const accepts = (node: JsonSchema | boolean | undefined): boolean => {
    if (node === undefined || node === true) return true
    if (typeof node !== 'object') return false
    if (node.type === 'string') return true
    if (Array.isArray(node.enum) && node.enum.some((v) => typeof v === 'string')) return true
    if (Array.isArray(node.anyOf) && node.anyOf.some((b) => accepts(b as JsonSchema))) return true
    if (node.type === undefined && node.enum === undefined && node.anyOf === undefined && node.const === undefined) return true
    return false
  }
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    if (accepts(node as JsonSchema)) out.add(key)
  }
  return out
}

function run(seeds: number, offset: number): Coverage {
  const coverage: Coverage = { plans: 0, changed: 0, ops: {} }

  for (let seed = 1 + offset; seed <= seeds + offset; seed++) {
    const random = rng(seed)
    const schema = randomSchema(random)
    const overrides = pick(random, PROFILES)
    const profile: CoercionProfile = { ...COERCION_DEFAULTS.query, ...overrides }

    const outcome = buildCoercePlan(shaped(schema as Record<string, unknown>), 'query', profile)
    assert.equal(outcome.kind, 'ok', `seed ${seed}: ${outcome.kind} for ${JSON.stringify(schema)}`)
    const plan = outcome.kind === 'ok' ? outcome.plan : null
    if (plan === null) continue

    coverage.plans++
    countOps(plan, coverage)

    const input = randomRecord(random, schema, profile.arrays === 'bracket')
    const compiled = compileCoercer(plan, `fuzz${seed}`, codegen)
    const walked = walkCoercer(plan)

    const context = () =>
      `seed ${seed}\nschema: ${JSON.stringify(schema)}\nprofile: ${JSON.stringify(overrides)}\n` +
      `input: ${JSON.stringify(input)}\ngenerated:\n${generateCoercerSource(plan)}`

    // ── 1: the engines agree ────────────────────────────────────────────────
    const c = observe(compiled, input)
    const w = observe(walked, input)
    assert.deepEqual(c, w, `engines diverged at ${context()}`)

    const out = (c as { ok?: Record<string, unknown> }).ok
    if (out === undefined) continue
    if (JSON.stringify(out) !== JSON.stringify(input)) coverage.changed++

    // ── 2: idempotence ──────────────────────────────────────────────────────
    const twice = walked({ ...out })
    assert.deepEqual(twice, out, `coercion is not idempotent at ${context()}`)

    // ── 3: no key is invented ───────────────────────────────────────────────
    const allowed = new Set([...Object.keys(input), ...plan.fields.map((f) => f.key)])
    for (const key of Object.keys(out)) {
      assert.ok(allowed.has(key), `invented key "${key}" at ${context()}`)
    }

    // ── 4: a position that accepts a string is untouched ────────────────────
    for (const key of stringPositions(schema)) {
      if (!(key in input)) continue
      // `emptyStringAsUndefined` deletes rather than converts, and applies to
      // every field including string ones — that is the switch's whole purpose,
      // so it is excluded here rather than weakening the rule it is not part of.
      if (profile.emptyStringAsUndefined && input[key] === '') {
        assert.equal(out[key], undefined, `empty string survived at ${context()}`)
        continue
      }
      assert.deepEqual(out[key], input[key], `a string-accepting position was coerced at ${context()}`)
    }
  }

  return coverage
}

describe('differential: compiled coercer ≡ walking coercer', () => {
  test('2000 random schema/profile/value triples agree and stay honest', () => {
    const coverage = run(2000, 0)

    // A fuzzer that agrees because neither engine ran anything reports a pass
    // and proves nothing, so the run has to account for itself (§20.5).
    assert.ok(coverage.plans > 800, `only ${coverage.plans} of 2000 seeds produced a plan`)
    assert.ok(coverage.changed > 300, `only ${coverage.changed} runs actually changed a value`)
    for (const kind of ['number', 'integer', 'boolean', 'array', 'empty', 'bracket']) {
      assert.ok((coverage.ops[kind] ?? 0) > 10, `op "${kind}" was exercised ${coverage.ops[kind] ?? 0} times`)
    }
  })
})

describe('differential: the walker is the definition, and codegen is optional', () => {
  test('caps.eval === false produces the walker for every generated plan', () => {
    const noEval = new CodeGen({ caps: { ...DEFAULT_CAPABILITIES, eval: false } })

    for (let seed = 1; seed <= 400; seed++) {
      const random = rng(seed + 90_000)
      const schema = randomSchema(random)
      const profile: CoercionProfile = { ...COERCION_DEFAULTS.query, ...pick(random, PROFILES) }
      const outcome = buildCoercePlan(shaped(schema as Record<string, unknown>), 'query', profile)
      const plan = outcome.kind === 'ok' ? outcome.plan : null
      if (plan === null) continue

      const input = randomRecord(random, schema, profile.arrays === 'bracket')
      const withEval = observe(compileCoercer(plan, `e${seed}`, codegen), input)
      const without = observe(compileCoercer(plan, `n${seed}`, noEval), input)

      assert.deepEqual(without, withEval, `seed ${seed} diverged under caps.eval === false`)
    }
  })
})
