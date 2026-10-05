import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { regexHazards, regexLiterals, type Logger } from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

/**
 * §19.3 — no regex on the request path may backtrack without bound.
 *
 * The analyser is held to the cases the RFC names, the idioms it must not
 * refuse, and the near-misses between them. Each refused case is exponential
 * on a backtracking engine; each accepted one is linear. A refusal of a safe
 * pattern costs a rewrite; a pass of an unsafe one costs an outage — so the
 * conservative side is the refusing one, and the table says which is which.
 */
describe('the regex-safety analyser (§19.3)', () => {
  const refused: Array<[string, string?]> = [
    ['(a+)+'], ['(a*)*'], ['(a|aa)+'], ['(a{1,3})+'], ['(-?[a-z]+)*'], ['(?:a+|b)+'], ['(x+x+)+y'],
    ['(\\w+\\s?)+$'], ['(?:\\s*,\\s*[a-z]+)*'], ['(?:.+,)*'], ['(?=(a+)+)'], ['(?:A+)+', 'i'], ['(?:a|A)+', 'i'],
  ]
  const accepted: Array<[string, string?]> = [
    ['^[a-z0-9]+(?:-[a-z0-9]+)*$'], ['^(?:[a-z0-9-]+\\.)*[a-z0-9-]+$'], ['(?:ab|ac)+'], ['(?:GET|POST|PUT)+'],
    ['^[A-Za-z0-9._-]{8,128}$'], ['(?:[0-9a-f]{2})+'], ['(a|b)+'], ['(?:,\\s*[a-z]+)*'], ['[^"]*(?:"[^"]*")*'],
    ['^(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)$'], ['^(\\d+)(ms|s|m|h|d)$'],
    ['(?:[^,]+,)*'], ['(a+){2,5}'],
  ]

  for (const [source, flags] of refused) {
    it(`refuses /${source}/${flags ?? ''}`, () => {
      assert.notEqual(regexHazards(source, flags).length, 0)
    })
  }
  for (const [source, flags] of accepted) {
    it(`accepts /${source}/${flags ?? ''}`, () => {
      assert.deepEqual(regexHazards(source, flags), [])
    })
  }

  it('names the repetition that is ambiguous', () => {
    assert.deepEqual(regexHazards('^id-(\\d+)+$'), [{ kind: 'nested-quantifier', fragment: '(\\d+)+' }])
    assert.deepEqual(regexHazards('^(a|aa)+$'), [{ kind: 'overlapping-alternation', fragment: '(a|aa)+' }])
  })

  it('a pattern it cannot read is a SyntaxError, not a pass', () => {
    assert.throws(() => regexHazards('(a+'), SyntaxError)
  })
})

describe('regex literals in function source', () => {
  it('finds regexes and leaves divisions alone', () => {
    const found = regexLiterals(String((s: string) => s.length / 2 > 1 && /^(a+)+$/.test(s) && /x\/y[/]z/gi.test(s)))
    assert.deepEqual(found, [{ source: '^(a+)+$', flags: '' }, { source: 'x\\/y[/]z', flags: 'gi' }])
  })

  it('skips strings and comments', () => {
    assert.deepEqual(regexLiterals("const a = '/not/'; // /nor/\n/* /this/ */ const b = /yes/"), [{ source: 'yes', flags: '' }])
  })
})

describe('app.paramType() warns about a test that can backtrack (§5.2, §19.3)', () => {
  const recording = (): Logger & { warnings: Array<{ obj: unknown; msg: string }> } => {
    const warnings: Array<{ obj: unknown; msg: string }> = []
    const noop = () => {}
    const logger = {
      level: 'warn' as const,
      warnings,
      child() { return logger },
      trace: noop, debug: noop, info: noop, error: noop, fatal: noop,
      warn: (obj: unknown, msg?: string) => { warnings.push({ obj, msg: msg ?? '' }) },
    }
    return logger
  }

  it('in development, names the param type and the repetition', () => {
    const logger = recording()
    makeApp({ dev: true, logger }).paramType('sku', { test: (s) => /^([A-Z]+-?)+$/.test(s), parse: (s) => s })
    assert.equal(logger.warnings.length, 1)
    assert.equal((logger.warnings[0]?.obj as { code: string }).code, 'ZEN_REGEX_UNSAFE')
    assert.match(logger.warnings[0]?.msg ?? '', /Param type "sku" tests with .*at \(\[A-Z\]\+-\?\)\+/)
  })

  it('says nothing about a linear test, or outside development', () => {
    const quiet = recording()
    makeApp({ dev: true, logger: quiet }).paramType('slug2', { test: (s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s), parse: (s) => s })
    assert.equal(quiet.warnings.length, 0)
    const production = recording()
    makeApp({ logger: production }).paramType('sku2', { test: (s) => /^([A-Z]+-?)+$/.test(s), parse: (s) => s })
    assert.equal(production.warnings.length, 0)
  })
})
