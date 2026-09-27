import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { RouteRecord, HttpMethod } from '@visionpilot/zen-core'
import { CodeGen, DEFAULT_CAPABILITIES } from '@visionpilot/zen-core'
import { ZenRouter, parsePath, renderPath, BUILTIN_PARAM_TYPES, analyzeRoutes } from '@visionpilot/zen-router'

function route(method: HttpMethod, path: string): RouteRecord {
  const parsed = parsePath(path)
  return {
    id: `${method} ${parsed.path}`,
    name: undefined,
    method,
    path: parsed.path,
    segments: parsed.segments,
    schema: {},
    handler: () => undefined,
    middleware: [],
    meta: new Map(),
    collection: null,
    origin: undefined,
  }
}

const build = (paths: Array<[HttpMethod, string]>, compile: boolean) =>
  new ZenRouter().build(paths.map(([m, p]) => route(m, p)), {
    compile,
    codegen: new CodeGen({ caps: { ...DEFAULT_CAPABILITIES, eval: compile } }),
  })

describe('path parsing', () => {
  test('parses static, param, typed param and wildcard segments', () => {
    const parsed = parsePath('/users/:id<int>/posts/*rest')
    assert.deepEqual(parsed.segments, [
      { kind: 'static', value: 'users' },
      { kind: 'param', value: 'id', type: 'int', optional: false },
      { kind: 'static', value: 'posts' },
      { kind: 'wildcard', value: 'rest' },
    ])
    assert.deepEqual(parsed.paramNames, ['id', 'rest'])
  })

  test('normalises paths', () => {
    assert.equal(parsePath('users//new/').path, '/users/new')
    assert.equal(parsePath('/').path, '/')
    assert.equal(parsePath('').path, '/')
  })

  test('round-trips through renderPath', () => {
    for (const path of ['/', '/a/b', '/users/:id', '/users/:id<int>', '/files/*path', '/p/:slug?']) {
      assert.equal(renderPath(parsePath(path).segments), parsePath(path).path === '/' ? '/' : path)
    }
  })

  test('rejects malformed paths with actionable messages', () => {
    assert.throws(() => parsePath('/files/*rest/more'), /must be the final segment/)
    assert.throws(() => parsePath('/a/:x?/b'), /must be the final segment/)
    assert.throws(() => parsePath('/a/:'), /Unnamed parameter/)
    assert.throws(() => parsePath('/a/:x<int'), /Malformed parameter type/)
    assert.throws(() => parsePath('/a/:x<>'), /Empty parameter type/)
    assert.throws(() => parsePath('/a/:x/b/:x'), /Duplicate parameter name/)
    assert.throws(() => parsePath('/v:x-suffix/y'), /mixes literal text/)
  })
})

describe('built-in param types', () => {
  const cases: Array<[string, string, boolean]> = [
    ['int', '42', true], ['int', '-7', true], ['int', '4.2', false], ['int', 'abc', false], ['int', '', false],
    ['float', '4.25', true], ['float', 'x', false],
    ['uuid', '9f1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d', true], ['uuid', 'not-a-uuid', false],
    ['ulid', '01ARZ3NDEKTSV4RRFFQ69G5FAV', true], ['ulid', 'short', false],
    ['slug', 'hello-world', true], ['slug', 'Hello World', false],
    ['hex', 'deadBEEF', true], ['hex', 'zz', false],
    ['date', '2026-01-01T00:00:00.000Z', true], ['date', 'nope', false],
  ]

  for (const [type, input, expected] of cases) {
    test(`${type} ${expected ? 'accepts' : 'rejects'} "${input}"`, () => {
      assert.equal(BUILTIN_PARAM_TYPES.get(type)?.test(input), expected)
    })
  }

  test('int and float parse to numbers, date to a Date', () => {
    assert.equal(BUILTIN_PARAM_TYPES.get('int')?.parse('42'), 42)
    assert.equal(BUILTIN_PARAM_TYPES.get('float')?.parse('4.25'), 4.25)
    assert.ok(BUILTIN_PARAM_TYPES.get('date')?.parse('2026-01-01T00:00:00.000Z') instanceof Date)
  })
})

describe('conflict analysis (§5.5)', () => {
  const analyze = (paths: Array<[HttpMethod, string]>) =>
    analyzeRoutes(paths.map(([m, p]) => route(m, p)), { paramTypes: BUILTIN_PARAM_TYPES })

  test('duplicates are errors', () => {
    const found = analyze([['GET', '/a'], ['GET', '/a']])
    assert.equal(found[0]?.code, 'ZEN_ROUTE_DUPLICATE')
  })

  test('genuine ambiguity is an error', () => {
    const found = analyze([['GET', '/:org/settings'], ['GET', '/admin/:page']])
    assert.equal(found[0]?.code, 'ZEN_ROUTE_AMBIGUOUS')
    assert.match(found[0]?.hint ?? '', /narrow one parameter with a type/)
  })

  test('shadowing is NOT an error — static beats dynamic unambiguously', () => {
    const found = analyze([['GET', '/users/:id'], ['GET', '/users/new']])
    assert.deepEqual(found.filter((d) => d.severity === 'error'), [])
  })

  test('different methods never conflict', () => {
    assert.deepEqual(analyze([['GET', '/a'], ['POST', '/a']]), [])
  })

  test('different segment counts never conflict', () => {
    assert.deepEqual(analyze([['GET', '/a/b'], ['GET', '/a/b/c']]).filter((d) => d.severity === 'error'), [])
  })

  test('disjoint typed params do not conflict', () => {
    const found = analyze([['GET', '/x/:id<int>'], ['GET', '/x/:slug<uuid>']])
    assert.deepEqual(found.filter((d) => d.severity === 'error'), [])
  })

  test('a typed param that cannot match a literal is disjoint from it', () => {
    const found = analyze([['GET', '/:id<int>/edit'], ['GET', '/new/:action']])
    assert.deepEqual(found.filter((d) => d.severity === 'error'), [])
  })
})

/**
 * Differential testing — §20.5, I6.
 *
 * The compiled engine (static Map fast path + generated params builders) and the
 * interpreted engine (pure trie walk + generic builder) must agree on every
 * match, every captured param, and every 404/405.
 */
describe('differential: compiled router ≡ interpreted router', () => {
  const ROUTES: Array<[HttpMethod, string]> = [
    ['GET', '/'],
    ['GET', '/users'],
    ['POST', '/users'],
    ['GET', '/users/new'],
    ['GET', '/users/:id<int>'],
    ['PATCH', '/users/:id<int>'],
    ['GET', '/users/:id<int>/posts'],
    ['GET', '/users/:id<int>/posts/:slug'],
    ['GET', '/orgs/:org/members/:member<uuid>'],
    ['GET', '/a/b'],
    ['GET', '/:x/c'],
    ['GET', '/files/*path'],
    ['GET', '/docs/:page?'],
    ['GET', '/events/:at<date>'],
  ]

  const PROBES: Array<[string, string]> = [
    ['GET', '/'], ['GET', '/users'], ['POST', '/users'], ['DELETE', '/users'],
    ['GET', '/users/new'], ['GET', '/users/42'], ['PATCH', '/users/42'],
    ['GET', '/users/abc'], ['GET', '/users/42/posts'], ['GET', '/users/42/posts/hello-world'],
    ['GET', '/orgs/acme/members/9f1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d'],
    ['GET', '/orgs/acme/members/not-a-uuid'],
    ['GET', '/a/b'], ['GET', '/a/c'], ['GET', '/z/c'],
    ['GET', '/files/a/b/c.txt'], ['GET', '/files/'],
    ['GET', '/docs'], ['GET', '/docs/intro'],
    ['GET', '/events/2026-01-01T00:00:00.000Z'],
    ['GET', '/nope'], ['GET', '/users/42/nope'],
    ['GET', '/users/42%2Fx'], ['GET', '/caf%C3%A9'],
    ['HEAD', '/users'],
  ]

  test('agree on every probe', () => {
    const compiled = build(ROUTES, true)
    const interpreted = build(ROUTES, false)

    assert.equal(compiled.stats.engine, 'compiled')
    assert.equal(interpreted.stats.engine, 'interpreted')

    for (const [method, path] of PROBES) {
      const a = compiled.match(method, path)
      const b = interpreted.match(method, path)

      const normalise = (r: typeof a) => {
        if (r === null) return null
        if (r.route === null) return { allowed: [...r.allowed].sort() }
        return { id: r.route.id, params: JSON.parse(JSON.stringify(r.params)) as unknown }
      }

      assert.deepEqual(normalise(a), normalise(b), `divergence for ${method} ${path}`)
    }
  })

  test('typed params are parsed to their declared type by both engines', () => {
    for (const compile of [true, false]) {
      const router = build(ROUTES, compile)
      const hit = router.match('GET', '/users/42')
      assert.ok(hit !== null && hit.route !== null)
      assert.equal(hit.params['id'], 42)
      assert.equal(typeof hit.params['id'], 'number')
    }
  })

  test('405 reports the methods that exist on the path', () => {
    for (const compile of [true, false]) {
      const router = build(ROUTES, compile)
      const miss = router.match('DELETE', '/users')
      assert.ok(miss !== null && miss.route === null)
      // HEAD is served wherever GET is (§4.2), so the 405 says so.
      assert.deepEqual([...miss.allowed].sort(), ['GET', 'HEAD', 'POST'])
    }
  })

  test('HEAD falls back to GET', () => {
    for (const compile of [true, false]) {
      const hit = build(ROUTES, compile).match('HEAD', '/users')
      assert.ok(hit !== null && hit.route !== null)
      assert.equal(hit.route.method, 'GET')
    }
  })

  test('encoded slashes never escape their segment', () => {
    for (const compile of [true, false]) {
      const hit = build(ROUTES, compile).match('GET', '/files/a%2Fb')
      assert.ok(hit !== null && hit.route !== null)
      // Decoded *after* splitting, so %2F stays inside one captured segment.
      assert.equal(hit.params['path'], 'a/b')
    }
  })

  test('optional trailing params match with and without the segment', () => {
    for (const compile of [true, false]) {
      const router = build(ROUTES, compile)
      const without = router.match('GET', '/docs')
      const with_ = router.match('GET', '/docs/intro')
      assert.ok(without !== null && without.route !== null)
      assert.ok(with_ !== null && with_.route !== null)
      assert.equal(with_.params['page'], 'intro')
    }
  })
})

describe('router build errors', () => {
  test('an unknown param type names the known ones', () => {
    assert.throws(
      () => build([['GET', '/x/:id<wat>']], true),
      /Unknown parameter type "<wat>".*Known types: int, float/s,
    )
  })

  test('duplicate registration reports the conflict', () => {
    assert.throws(() => build([['GET', '/dup'], ['GET', '/dup']], true), /Duplicate route/)
  })
})

describe('<int> refuses what it cannot represent (§11.4.1)', () => {
  for (const compile of [true, false]) {
    test(`an id past 2^53 does not match rather than rounding to another row (${compile ? 'compiled' : 'interpreted'})`, () => {
      const router = build([['GET', '/orders/:id<int>']], compile)
      const safe = router.match('GET', '/orders/9007199254740991')
      assert.ok(safe !== null && safe.route !== null)
      assert.equal(safe.params['id'], 9007199254740991)
      assert.equal(router.match('GET', '/orders/9007199254740993'), null, '…993 would have become …992')
      assert.equal(router.match('GET', '/orders/99999999999999999'), null)
      const negative = router.match('GET', '/orders/-9007199254740991')
      assert.ok(negative !== null && negative.route !== null)
    })
  }
})

describe('405 Allow names every route that matches the path', () => {
  test('a static route beside a dynamic one contributes both method sets', () => {
    const router = build([['GET', '/users/me'], ['DELETE', '/users/:id'], ['PATCH', '/users/:id']], true)
    // DELETE /users/me is served by the dynamic route, so it is allowed…
    const served = router.match('DELETE', '/users/me')
    assert.ok(served !== null && served.route !== null)
    // …and a PUT there must say so, instead of advertising only the static GET.
    const refused = router.match('PUT', '/users/me')
    assert.ok(refused !== null && refused.route === null)
    assert.deepEqual([...refused.allowed].sort(), ['DELETE', 'GET', 'HEAD', 'PATCH'])
  })
})

describe('two parameter types in one position (§5.5, §5.6)', () => {
  const analyzeWith = (paths: Array<[HttpMethod, string]>, paramTypes = BUILTIN_PARAM_TYPES) =>
    analyzeRoutes(paths.map(([m, p]) => route(m, p)), { paramTypes })

  test('types that share a value are ambiguous, and the message names the value', () => {
    // `/items/42` satisfies both. The trie used to try typed children in the
    // order they were inserted — registration order — so which route answered
    // depended on which file was imported first.
    const found = analyzeWith([['GET', '/items/:id<int>'], ['GET', '/items/:key<slug>']])
    const errors = found.filter((d) => d.severity === 'error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.code, 'ZEN_ROUTE_AMBIGUOUS')
    assert.match(errors[0]?.message ?? '', /satisfies both/)
  })

  test('every overlapping builtin pair is caught, and every disjoint one is left alone', () => {
    const overlapping: Array<[string, string]> = [
      ['int', 'float'], ['int', 'slug'], ['int', 'hex'], ['float', 'slug'], ['float', 'hex'],
      ['uuid', 'slug'], ['ulid', 'slug'], ['ulid', 'hex'], ['ulid', 'float'], ['date', 'slug'], ['slug', 'hex'],
    ]
    const disjoint: Array<[string, string]> = [
      ['int', 'uuid'], ['int', 'ulid'], ['int', 'date'], ['uuid', 'ulid'], ['uuid', 'hex'], ['uuid', 'date'],
    ]
    for (const [a, b] of overlapping) {
      const errors = analyzeWith([['GET', `/x/:a<${a}>`], ['GET', `/x/:b<${b}>`]]).filter((d) => d.severity === 'error')
      assert.equal(errors[0]?.code, 'ZEN_ROUTE_AMBIGUOUS', `<${a}> and <${b}> share a value`)
    }
    for (const [a, b] of disjoint) {
      const found = analyzeWith([['GET', `/x/:a<${a}>`], ['GET', `/x/:b<${b}>`]])
      assert.deepEqual(found, [], `<${a}> and <${b}> cannot share a value`)
    }
  })

  test('application types are checked through jsonSchema.examples, and undecidable pairs warn', () => {
    const sku = { name: 'sku', test: (s: string) => /^[A-Z]{3}-\d{4}$/.test(s), parse: (s: string) => s, jsonSchema: { examples: ['ABC-1234'] } }
    const code = { name: 'code', test: (s: string) => /^[A-Z]{3}-\d+$/.test(s), parse: (s: string) => s, jsonSchema: { examples: ['XYZ-9'] } }
    const opaque = { name: 'opaque', test: (s: string) => s.startsWith('o_'), parse: (s: string) => s }
    const opaque2 = { name: 'opaque2', test: (s: string) => s.startsWith('o'), parse: (s: string) => s }
    const types = new Map([...BUILTIN_PARAM_TYPES, ['sku', sku], ['code', code], ['opaque', opaque], ['opaque2', opaque2]])

    const shared = analyzeWith([['GET', '/p/:a<sku>'], ['GET', '/p/:b<code>']], types)
    assert.equal(shared.filter((d) => d.severity === 'error')[0]?.code, 'ZEN_ROUTE_AMBIGUOUS', 'ABC-1234 is also a code')

    const unknown = analyzeWith([['GET', '/q/:a<opaque>'], ['GET', '/q/:b<opaque2>']], types)
    assert.deepEqual(unknown.filter((d) => d.severity === 'error'), [])
    assert.equal(unknown[0]?.code, 'ZEN_ROUTE_TYPES_UNDECIDED', 'said out loud, not silently resolved')
  })

  test('the matcher tries typed params in the same order however they were registered', () => {
    const custom = (name: string) => ({ name, test: (s: string) => s.startsWith('v'), parse: (s: string) => `${name}:${s}` })
    const paramTypes = new Map([...BUILTIN_PARAM_TYPES, ['beta', custom('beta')], ['alpha', custom('alpha')]])
    const answer = (paths: Array<[HttpMethod, string]>) => {
      const router = new ZenRouter().build(paths.map(([m, p]) => route(m, p)), { paramTypes })
      const hit = router.match('GET', '/v/v1')
      return hit !== null && hit.route !== null ? hit.route.path : null
    }
    const forwards = answer([['GET', '/v/:x<alpha>'], ['GET', '/v/:y<beta>']])
    const backwards = answer([['GET', '/v/:y<beta>'], ['GET', '/v/:x<alpha>']])
    assert.equal(forwards, backwards, 'registration order never decides (§5.6)')
    assert.equal(forwards, '/v/:x<alpha>', 'the type whose name sorts first')
  })
})
