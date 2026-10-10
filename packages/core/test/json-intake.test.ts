import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { jsonParser, BODY_DEFAULTS, BodyInvalid } from '@erenthedeveloper0/zen-core'

/**
 * JSON intake against its definition — rfcs/0001 §19.5, §4.2 stage 6.
 *
 * `jsonParser` revives a body only when its text could hold a key named
 * `__proto__`, `constructor` or `prototype`, and parses every other body with
 * no reviver at all. That is safe if, and only if, the two paths never disagree
 * — so the oracle here is the definition the parser used for every body before:
 * `JSON.parse` with a reviver dropping those three keys. It shares nothing with
 * the guard it checks.
 *
 * The texts are written by hand rather than with `JSON.stringify`, because the
 * case the guard exists for — a forbidden key spelled with `\u` escapes — is one
 * `JSON.stringify` never writes, and a generator that cannot produce it would
 * agree with a guard that forgot it.
 */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const reference = (text: string): unknown =>
  JSON.parse(text, function (key, value) { return FORBIDDEN.has(key) ? undefined : value })

const encoder = new TextEncoder()
const parse = (text: string): unknown => jsonParser(encoder.encode(text), null as never, BODY_DEFAULTS)

/** Deterministic, so a failing seed is reproducible and committable. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** Every character of a key written as `\uXXXX` — the spelling the guard's `\u` arm exists for. */
const escapeAll = (key: string): string => [...key].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
/** One character escaped, the rest plain — the half-hidden spelling. */
const escapeOne = (key: string, at: number): string => {
  const i = at % key.length
  return key.slice(0, i) + escapeAll(key[i] as string) + key.slice(i + 1)
}

interface Generated {
  readonly text: string
  /** The text holds a forbidden word, or a `\u` escape — what the guard sends to the reviver. */
  readonly careful: boolean
  readonly escapedForbiddenKeys: number
  readonly forbiddenWordsInValues: number
}

/**
 * One text. With `hazards` off it holds no forbidden word and no `\u` escape —
 * only the near misses (`proto`, `construct`, `prototyp`) — so the fast path
 * is exercised on purpose rather than by luck: a text with several keys and
 * values almost always draws at least one hazard otherwise.
 */
function generate(random: () => number, hazards: boolean): Generated {
  let escapedForbiddenKeys = 0
  let forbiddenWordsInValues = 0
  let careful = false
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const plainKeys = ['id', 'name', 'items', 'qty', 'price', 'proto', 'construct', 'prototyp', 'type', 'café', 'a b', '']

  const key = (): string => {
    const roll = hazards ? random() : 1
    if (roll < 0.06) { careful = true; return JSON.stringify(pick([...FORBIDDEN])) }
    if (roll < 0.12) {
      careful = true
      escapedForbiddenKeys++
      const word = pick([...FORBIDDEN])
      return `"${random() < 0.5 ? escapeAll(word) : escapeOne(word, Math.floor(random() * 16))}"`
    }
    if (roll < 0.16) { careful = true; return `"${escapeOne(pick(plainKeys.filter((k) => k !== '')), Math.floor(random() * 8))}"` }
    return JSON.stringify(pick(plainKeys))
  }

  const value = (depth: number): string => {
    const roll = random()
    if (depth >= 4 || roll < 0.35) {
      const scalar = random()
      if (hazards && scalar < 0.15) {
        careful = true
        forbiddenWordsInValues++
        return JSON.stringify(`the ${pick([...FORBIDDEN])} of a thing`)
      }
      if (scalar < 0.4) return JSON.stringify(`text ${Math.floor(random() * 1e6)}`)
      if (scalar < 0.7) return String(Math.round(random() * 1e6) / 100)
      if (scalar < 0.85) return random() < 0.5 ? 'true' : 'false'
      return 'null'
    }
    if (roll < 0.6) {
      const length = Math.floor(random() * 4)
      return `[${Array.from({ length }, () => value(depth + 1)).join(',')}]`
    }
    const length = Math.floor(random() * 5)
    return `{${Array.from({ length }, () => `${key()}:${value(depth + 1)}`).join(',')}}`
  }

  const text = `{${Array.from({ length: 1 + Math.floor(random() * 5) }, () => `${key()}:${value(1)}`).join(',')}}`
  return { text, careful, escapedForbiddenKeys, forbiddenWordsInValues }
}

describe('JSON intake parses every body exactly as the reviver did (§19.5)', () => {
  test('2,000 generated texts, every one identical to the definition — or refused by both', () => {
    let careful = 0
    let fast = 0
    let escaped = 0
    let wordsInValues = 0
    let refusedByBoth = 0

    for (let seed = 1; seed <= 2000; seed++) {
      const random = rng(seed * 2654435761)
      const generated = generate(random, random() >= 0.3)
      // A tenth of the texts are cut short, so the two must also agree on what is not JSON.
      const text = random() < 0.1 ? generated.text.slice(0, Math.max(1, Math.floor(generated.text.length * random()))) : generated.text

      let expected: unknown
      let expectedError = false
      try { expected = reference(text) } catch { expectedError = true }

      if (expectedError) {
        assert.throws(() => parse(text), (error: unknown) => error instanceof BodyInvalid, `seed ${seed}: the reference refused ${text}`)
        refusedByBoth++
        continue
      }
      assert.deepStrictEqual(parse(text), expected, `seed ${seed}: ${text}`)

      if (generated.careful) careful++
      else fast++
      escaped += generated.escapedForbiddenKeys
      wordsInValues += generated.forbiddenWordsInValues
    }

    // Two paths that agree because one of them never ran prove nothing: each
    // branch of the guard, and each reason to take the careful one, must have
    // come up often enough to have been tested on purpose.
    assert.ok(fast >= 400, `expected ≥ 20% of texts on the fast path; got ${fast}`)
    assert.ok(careful >= 400, `expected ≥ 20% of texts on the careful path; got ${careful}`)
    assert.ok(escaped >= 100, `expected forbidden keys spelled with \\u escapes; got ${escaped}`)
    assert.ok(wordsInValues >= 100, `expected forbidden words inside values; got ${wordsInValues}`)
    assert.ok(refusedByBoth >= 50, `expected invalid texts refused by both; got ${refusedByBoth}`)
  })

  test('a forbidden key is dropped however it is spelled, at any depth', () => {
    const cases = [
      '{"a":1,"__proto__":{"polluted":true}}',
      `{"a":1,"${escapeAll('__proto__')}":{"polluted":true}}`,
      `{"a":{"b":[{"${escapeOne('constructor', 3)}":{"prototype":1}}]}}`,
      `{"${escapeOne('prototype', 0)}":1,"a":1}`,
    ]
    for (const text of cases) {
      const parsed = parse(text) as Record<string, unknown>
      assert.deepStrictEqual(parsed, reference(text), text)
      assert.equal(Object.hasOwn(parsed, '__proto__'), false, text)
      assert.equal(({} as Record<string, unknown>)['polluted'], undefined, text)
    }
  })

  test('the depth limit refuses exactly the bodies the per-value walk refused', () => {
    // The walk that visited every value, scalars included, verbatim from
    // 0.1.0-alpha.4 — the definition the container-only walk must reproduce.
    const tooDeep = (value: unknown, max: number, depth = 0): boolean => {
      if (depth > max) return true
      if (typeof value !== 'object' || value === null) return false
      if (Array.isArray(value)) return value.some((item) => tooDeep(item, max, depth + 1))
      return Object.keys(value).some((key) => tooDeep((value as Record<string, unknown>)[key], max, depth + 1))
    }
    const random = rng(7)
    const nest = (depth: number): string => {
      const roll = random()
      if (depth > 6 || roll < 0.25) return roll < 0.1 ? '1' : roll < 0.15 ? '"s"' : roll < 0.2 ? 'null' : random() < 0.5 ? '[]' : '{}'
      const length = Math.floor(random() * 3)
      return roll < 0.6
        ? `[${Array.from({ length }, () => nest(depth + 1)).join(',')}]`
        : `{${Array.from({ length }, (_, i) => `"k${i}":${nest(depth + 1)}`).join(',')}}`
    }
    let refused = 0
    let accepted = 0
    for (let i = 0; i < 3000; i++) {
      const text = nest(0)
      const max = Math.floor(random() * 6) - 1
      const expected = tooDeep(JSON.parse(text), max)
      const options = { ...BODY_DEFAULTS, maxDepth: max }
      let actual = false
      try { jsonParser(encoder.encode(text), null as never, options) } catch (error) {
        assert.ok(error instanceof BodyInvalid, text)
        actual = true
      }
      assert.equal(actual, expected, `max ${max}: ${text}`)
      if (expected) refused++
      else accepted++
    }
    assert.ok(refused >= 500 && accepted >= 500, `both outcomes, often: ${refused} refused, ${accepted} accepted`)
  })

  test('a body that cannot carry a forbidden key is parsed without a reviver — the cost this exists to remove', () => {
    const original = JSON.parse
    const revived: boolean[] = []
    JSON.parse = function (this: unknown, text: string, reviver?: (key: string, value: unknown) => unknown) {
      revived.push(reviver !== undefined)
      return original.call(JSON, text, reviver as never)
    } as typeof JSON.parse
    try {
      parse('{"order":{"items":[{"sku":"A-1","qty":2,"price":9.5}],"note":"leave it at the door"}}')
      parse('{"note":"the constructor of the year"}')
      parse('{"caf\\u00e9":1}')
    } finally {
      JSON.parse = original
    }
    assert.deepStrictEqual(revived, [false, true, true])
  })
})
