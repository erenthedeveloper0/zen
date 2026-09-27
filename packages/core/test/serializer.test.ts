import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProgram, compileSerializer, walkSerializer, buildSerializerTable, generateSerializerSource,
  jsonSchema, registerSchemaConverter, __resetSchemaConverters, toJsonSchema,
  CodeGen, DEFAULT_CAPABILITIES, SerializationError, BootError,
  type JsonSchema, type Serializer,
} from '@visionpilot/zen-core'
import { makeApp, schema } from './helpers.ts'

/**
 * The compiled serializer — rfcs/0001 §13.3.
 *
 * Every assertion here runs *both* engines and requires them to agree before it
 * checks anything else, so the suite is a differential suite that happens to
 * also be readable as a specification. `ser()` returning a single string is the
 * whole trick: a divergence fails the test that was checking something else,
 * which means there is no way to add a compiler feature and forget the twin.
 */

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })

/** Control characters cannot be typed literally in this file; build them. */
const chr = (code: number): string => String.fromCharCode(code)

function engines(source: JsonSchema, strict = false): { compiled: Serializer; walked: Serializer } {
  const { program, diagnostics } = buildProgram(source, strict)
  assert.equal(diagnostics.length, 0, `unexpected IR diagnostics: ${JSON.stringify(diagnostics)}`)
  assert.notEqual(program, null)
  return {
    compiled: compileSerializer(program!, 'test', codegen),
    walked: walkSerializer(program!),
  }
}

/** Serialize with both engines, require agreement, return the shared output. */
function ser(source: JsonSchema, value: unknown, strict = false): string {
  const { compiled, walked } = engines(source, strict)
  const a = compiled(value)
  const b = walked(value)
  assert.equal(a, b, 'compiled and walked serializers disagree')
  return a
}

/** Both engines must throw, and with the same message. */
function serThrows(source: JsonSchema, value: unknown, strict = true): Error {
  const { compiled, walked } = engines(source, strict)
  const a = capture(() => compiled(value))
  const b = capture(() => walked(value))
  assert.notEqual(a, null, 'compiled serializer did not throw')
  assert.notEqual(b, null, 'walked serializer did not throw')
  assert.equal(a!.message, b!.message, 'engines threw different messages')
  return a!
}

function capture(fn: () => unknown): Error | null {
  try { fn(); return null } catch (error) { return error as Error }
}

function diagnose(source: JsonSchema): readonly { path: string; message: string; hint: string }[] {
  return buildProgram(source, false).diagnostics
}

// ─────────────────────────────────────────────────────────────────────────────

describe('serializer: the security property (§13.3.1)', () => {
  const User: JsonSchema = {
    type: 'object',
    properties: { id: { type: 'integer' }, email: { type: 'string' } },
    required: ['id', 'email'],
  }

  test('undeclared properties cannot be emitted', () => {
    const out = ser(User, { id: 1, email: 'a@b.c', passwordHash: 'secret', stripeCustomerId: 'cus_x' })
    assert.equal(out, '{"id":1,"email":"a@b.c"}')
    assert.ok(!out.includes('secret'))
  })

  test('the generated source contains no key enumeration to leak through', () => {
    const { program } = buildProgram(User, false)
    const source = generateSerializerSource(program!)
    // The claim is structural, not behavioural: there is nothing in the emitted
    // function that could iterate the value's own keys.
    assert.ok(!source.includes('Object.keys'))
    assert.ok(!source.includes('for (const'))
    assert.ok(!source.includes('passwordHash'))
  })

  test('filtering is recursive — nested objects, arrays and refs all filter', () => {
    const nested: JsonSchema = {
      type: 'object',
      properties: {
        owner: { $ref: '#/$defs/User' },
        members: { type: 'array', items: { $ref: '#/$defs/User' } },
      },
      required: ['owner', 'members'],
      $defs: { User },
    }
    const leaky = { id: 1, email: 'a@b.c', passwordHash: 'nope' }
    const out = ser(nested, { owner: leaky, members: [leaky, leaky], auditLog: ['secret'] })
    assert.equal(out, '{"owner":{"id":1,"email":"a@b.c"},"members":[{"id":1,"email":"a@b.c"},{"id":1,"email":"a@b.c"}]}')
  })

  test('an absent `additionalProperties` drops, inverting the JSON Schema default', () => {
    // JSON Schema says absent means *allow*. §13.3.1 says drop. This is the
    // single most consequential deviation in the subsystem and is asserted
    // rather than assumed.
    const out = ser({ type: 'object', properties: { a: { type: 'integer' } } }, { a: 1, b: 2 })
    assert.equal(out, '{"a":1}')
  })

  test('`additionalProperties: true` is the explicit opt-out', () => {
    const out = ser(
      { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: true },
      { a: 1, b: 'kept', c: null },
    )
    assert.equal(out, '{"a":1,"b":"kept","c":null}')
  })

  test('`additionalProperties: <schema>` filters the values it passes through', () => {
    const out = ser(
      { type: 'object', properties: {}, additionalProperties: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      { x: { ok: true, hidden: 1 }, y: { ok: false } },
    )
    assert.equal(out, '{"x":{"ok":true},"y":{"ok":false}}')
  })

  test('undeclared keys are skipped exactly like JSON.stringify skips them', () => {
    // Functions, symbols and undefined vanish under JSON.stringify; passthrough
    // must not turn them into `null` or the output stops round-tripping.
    const source: JsonSchema = { type: 'object', properties: {}, additionalProperties: true }
    const value = { a: 1, fn: () => {}, u: undefined, s: Symbol('x') }
    assert.equal(ser(source, value), JSON.stringify(value))
  })
})

describe('serializer: strings', () => {
  const S: JsonSchema = { type: 'string' }

  test('the fast path is byte-identical to JSON.stringify', () => {
    for (const value of ['', 'plain', 'a b c', 'ünïcøde', '日本語', '😀 astral']) {
      assert.equal(ser(S, value), JSON.stringify(value))
    }
  })

  test('escapes match JSON.stringify exactly', () => {
    const cases = [
      '"quoted"',
      'back\\slash',
      `tab${chr(9)}newline${chr(10)}`,
      chr(0) + chr(1) + chr(31),
      `lone-surrogate:${chr(0xd800)}`,
      `${chr(0xd83d)}${chr(0xde00)}`, // a *paired* surrogate — a valid emoji
      chr(127), // DEL is NOT escaped by JSON.stringify; nor may we escape it
    ]
    for (const value of cases) {
      assert.equal(ser(S, value), JSON.stringify(value), `mismatch for ${JSON.stringify(value)}`)
    }
  })

  test('a Date reaching a plain string field becomes ISO, matching toJSON', () => {
    const date = new Date('2024-01-02T03:04:05.678Z')
    assert.equal(ser(S, date), JSON.stringify(date))
  })

  test('format: date-time and date', () => {
    const date = new Date('2024-01-02T03:04:05.678Z')
    assert.equal(ser({ type: 'string', format: 'date-time' }, date), '"2024-01-02T03:04:05.678Z"')
    assert.equal(ser({ type: 'string', format: 'date' }, date), '"2024-01-02"')
    assert.equal(ser({ type: 'string', format: 'date-time' }, '2024-01-02T03:04:05.678Z'), '"2024-01-02T03:04:05.678Z"')
  })

  test('an Invalid Date does not escape as a RangeError', () => {
    assert.equal(ser({ type: 'string', format: 'date-time' }, new Date('nonsense')), 'null')
    const error = serThrows({ type: 'string', format: 'date-time' }, new Date('nonsense'))
    assert.ok(error instanceof SerializationError)
    assert.match(error.message, /Invalid Date/)
  })

  test('strict rejects a non-string, lax coerces', () => {
    assert.equal(ser(S, 42), '"42"')
    assert.match(serThrows(S, 42).message, /Expected a string/)
  })
})

describe('serializer: numbers', () => {
  test('finite numbers match JSON.stringify', () => {
    for (const value of [0, -0, 1, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER, 1e-7]) {
      assert.equal(ser({ type: 'number' }, value), JSON.stringify(value))
    }
  })

  test('NaN and Infinity become null in lax mode, matching JSON.stringify', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal(ser({ type: 'number' }, value), JSON.stringify(value))
    }
    assert.match(serThrows({ type: 'number' }, NaN).message, /finite/)
  })

  test('bigint serialises losslessly where JSON.stringify throws', () => {
    const huge = 9007199254740993n
    assert.equal(ser({ type: 'integer' }, huge), '9007199254740993')
    assert.throws(() => JSON.stringify(huge))
  })

  test('integer rejects a non-integer in strict mode', () => {
    assert.equal(ser({ type: 'integer' }, 1.5), '1.5')
    assert.match(serThrows({ type: 'integer' }, 1.5).message, /Expected an integer/)
  })
})

describe('serializer: objects', () => {
  test('a missing required property throws in BOTH modes', () => {
    const source: JsonSchema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }
    // The asymmetry with type mismatches is deliberate: a contract that only
    // holds in development is the half of the promise nobody needs.
    for (const strict of [true, false]) {
      const error = capture(() => ser(source, {}, strict))
      assert.ok(error instanceof SerializationError, `expected a throw with strict=${strict}`)
      assert.match(error.message, /Missing required property/)
      assert.equal(error.path, '$.a')
    }
  })

  test('an explicit undefined counts as missing', () => {
    const source: JsonSchema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }
    assert.throws(() => ser(source, { a: undefined }), SerializationError)
  })

  test('optional properties are omitted, and commas stay correct', () => {
    const source: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' }, c: { type: 'integer' } },
      required: ['b'],
    }
    assert.equal(ser(source, { a: 1, b: 2, c: 3 }), '{"a":1,"b":2,"c":3}')
    assert.equal(ser(source, { b: 2 }), '{"b":2}')
    assert.equal(ser(source, { a: 1, b: 2 }), '{"a":1,"b":2}')
    assert.equal(ser(source, { b: 2, c: 3 }), '{"b":2,"c":3}')
  })

  test('an all-optional object handles every subset', () => {
    // The case that exercises the runtime separator: nothing is guaranteed, so
    // the compiler cannot fold a single comma into a key literal.
    const source: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' }, c: { type: 'integer' } },
    }
    assert.equal(ser(source, {}), '{}')
    assert.equal(ser(source, { a: 1 }), '{"a":1}')
    assert.equal(ser(source, { b: 2 }), '{"b":2}')
    assert.equal(ser(source, { c: 3 }), '{"c":3}')
    assert.equal(ser(source, { a: 1, c: 3 }), '{"a":1,"c":3}')
    assert.equal(ser(source, { b: 2, c: 3 }), '{"b":2,"c":3}')
    assert.equal(ser(source, { a: 1, b: 2, c: 3 }), '{"a":1,"b":2,"c":3}')
  })

  test('optional properties followed by required ones', () => {
    const source: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' }, c: { type: 'integer' } },
      required: ['c'],
    }
    assert.equal(ser(source, { c: 3 }), '{"c":3}')
    assert.equal(ser(source, { a: 1, c: 3 }), '{"a":1,"c":3}')
    assert.equal(ser(source, { b: 2, c: 3 }), '{"b":2,"c":3}')
  })

  test('optional properties combined with passthrough', () => {
    const source: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'integer' } },
      additionalProperties: true,
    }
    assert.equal(ser(source, {}), '{}')
    assert.equal(ser(source, { a: 1 }), '{"a":1}')
    assert.equal(ser(source, { z: 9 }), '{"z":9}')
    assert.equal(ser(source, { a: 1, z: 9 }), '{"a":1,"z":9}')
  })

  test('property names that are not identifiers', () => {
    const source: JsonSchema = {
      type: 'object',
      properties: { 'content-type': { type: 'string' }, '2fa': { type: 'boolean' }, 'a"b': { type: 'integer' } },
      required: ['content-type', '2fa', 'a"b'],
    }
    assert.equal(
      ser(source, { 'content-type': 'text/plain', '2fa': true, 'a"b': 5 }),
      JSON.stringify({ 'content-type': 'text/plain', '2fa': true, 'a"b': 5 }),
    )
  })

  test('a non-object where an object is declared', () => {
    const source: JsonSchema = { type: 'object', properties: { a: { type: 'integer' } } }
    assert.equal(ser(source, 'not an object'), 'null')
    assert.match(serThrows(source, 'not an object').message, /Expected an object/)
  })
})

describe('serializer: arrays and tuples', () => {
  test('arrays', () => {
    assert.equal(ser({ type: 'array', items: { type: 'integer' } }, [1, 2, 3]), '[1,2,3]')
    assert.equal(ser({ type: 'array', items: { type: 'integer' } }, []), '[]')
  })

  test('array items are filtered by the item schema', () => {
    const source: JsonSchema = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    }
    assert.equal(ser(source, [{ id: 1, secret: 'x' }]), '[{"id":1}]')
  })

  test('a hole or undefined element becomes null, matching JSON.stringify', () => {
    const value = [1, undefined, 3]
    assert.equal(ser({ type: 'array', items: { type: 'integer' } }, value), JSON.stringify(value))
  })

  test('tuples with and without a rest schema', () => {
    const pair: JsonSchema = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] }
    assert.equal(ser(pair, ['a', 1]), '["a",1]')
    assert.equal(ser(pair, ['a', 1, 'ignored']), '["a",1]')

    const withRest: JsonSchema = { ...pair, items: { type: 'boolean' } }
    assert.equal(ser(withRest, ['a', 1, true, false]), '["a",1,true,false]')
  })

  test('a short tuple is a contract violation in strict mode', () => {
    const pair: JsonSchema = { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] }
    assert.equal(ser(pair, ['a']), '["a",null]')
    assert.match(serThrows(pair, ['a']).message, /tuple of 2 items/)
  })

  test('a non-array where an array is declared', () => {
    assert.equal(ser({ type: 'array', items: {} }, { length: 2 }), 'null')
  })
})

describe('serializer: unions', () => {
  test('nullable via `type: [T, "null"]`, `nullable: true` and a two-member anyOf', () => {
    for (const source of [
      { type: ['string', 'null'] } as JsonSchema,
      { type: 'string', nullable: true } as JsonSchema,
      { anyOf: [{ type: 'string' }, { type: 'null' }] } as JsonSchema,
    ]) {
      assert.equal(ser(source, 'x'), '"x"')
      assert.equal(ser(source, null), 'null')
    }
  })

  test('a nullable object still filters when present', () => {
    const source: JsonSchema = {
      anyOf: [{ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }, { type: 'null' }],
    }
    assert.equal(ser(source, { id: 1, secret: 2 }), '{"id":1}')
    assert.equal(ser(source, null), 'null')
  })

  test('primitive branches discriminate by typeof', () => {
    const source: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] }
    assert.equal(ser(source, 'a'), '"a"')
    assert.equal(ser(source, 7), '7')
    assert.equal(ser(source, true), 'true')
  })

  test('object branches discriminate by a literal property', () => {
    const source: JsonSchema = {
      oneOf: [
        {
          type: 'object',
          properties: { kind: { const: 'user' }, email: { type: 'string' } },
          required: ['kind', 'email'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'bot' }, token: { type: 'string' } },
          required: ['kind', 'token'],
        },
      ],
    }
    assert.equal(ser(source, { kind: 'user', email: 'a@b.c', token: 'LEAK' }), '{"kind":"user","email":"a@b.c"}')
    assert.equal(ser(source, { kind: 'bot', token: 't', email: 'LEAK' }), '{"kind":"bot","token":"t"}')
  })

  test('a branch that matches nothing', () => {
    const source: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
    assert.equal(ser(source, { object: true }), 'null')
    assert.match(serThrows(source, { object: true }).message, /none of the declared union branches/)
  })

  test('an undiscriminable union is refused at boot, not guessed at', () => {
    const source: JsonSchema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'integer' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    }
    const diagnostics = diagnose(source)
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0]!.message, /branches of this union apart/)
    assert.match(diagnostics[0]!.hint, /literal discriminant/)
  })

  test('branches distinguished by a unique required property', () => {
    const source: JsonSchema = {
      oneOf: [
        { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
        { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'] },
      ],
    }
    assert.equal(ser(source, { email: 'a@b.c' }), '{"email":"a@b.c"}')
    assert.equal(ser(source, { phone: '+1' }), '{"phone":"+1"}')
  })
})

describe('serializer: enums, consts and refs', () => {
  test('const', () => {
    assert.equal(ser({ const: 'admin' }, 'admin'), '"admin"')
    assert.match(serThrows({ const: 'admin' }, 'user').message, /Expected the constant/)
  })

  test('enum', () => {
    const source: JsonSchema = { enum: ['a', 'b', 3, null, true] }
    assert.equal(ser(source, 'b'), '"b"')
    assert.equal(ser(source, 3), '3')
    assert.equal(ser(source, null), 'null')
    assert.equal(ser(source, 'z'), 'null')
    assert.match(serThrows(source, 'z').message, /not one of the declared enum members/)
  })

  test('$ref, including #/definitions and a self-recursive root', () => {
    const viaDefs: JsonSchema = {
      type: 'object',
      properties: { child: { $ref: '#/definitions/Leaf' } },
      required: ['child'],
      definitions: { Leaf: { type: 'object', properties: { v: { type: 'integer' } }, required: ['v'] } },
    }
    assert.equal(ser(viaDefs, { child: { v: 1, secret: 2 } }), '{"child":{"v":1}}')

    const tree: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } },
      required: ['name'],
    }
    assert.equal(
      ser(tree, { name: 'root', children: [{ name: 'a', children: [] }, { name: 'b', secret: 1 }] }),
      '{"name":"root","children":[{"name":"a","children":[]},{"name":"b"}]}',
    )
  })

  test('an unresolvable $ref is a diagnostic, not a crash', () => {
    const diagnostics = diagnose({ $ref: '#/$defs/Nope' })
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0]!.message, /Unresolvable \$ref/)
  })

  test('a circular $ref chain is refused rather than hanging the compiler', () => {
    const diagnostics = diagnose({ $ref: '#/$defs/A', $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } } })
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0]!.message, /Circular \$ref chain/)
  })
})

describe('serializer: allOf and unsupported keywords', () => {
  test('allOf of object schemas merges', () => {
    const source: JsonSchema = {
      allOf: [
        { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    }
    assert.equal(ser(source, { id: 1, name: 'x', secret: 2 }), '{"id":1,"name":"x"}')
  })

  test('allOf that is not an object merge is refused', () => {
    const diagnostics = diagnose({ allOf: [{ type: 'string' }, { type: 'integer' }] })
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0]!.message, /allOf of object schemas/)
  })

  test('patternProperties is refused because it changes what is emitted', () => {
    const diagnostics = diagnose({ type: 'object', patternProperties: { '^x-': { type: 'string' } } })
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0]!.message, /patternProperties/)
  })

  test('validation-only keywords are ignored rather than refused', () => {
    // `minLength` cannot change which bytes are emitted, and re-validating on
    // the way out would be a second validator with no new authority (§13.3).
    const source: JsonSchema = { type: 'string', minLength: 10, pattern: '^a', not: { const: 'x' } }
    assert.equal(diagnose(source).length, 0)
    assert.equal(ser(source, 'ab'), '"ab"')
  })

  test('`true`, `{}` and `false` schemas', () => {
    assert.equal(ser({}, { anything: [1, { deep: true }] }), '{"anything":[1,{"deep":true}]}')
    assert.equal(ser({ type: 'object', properties: { a: {} }, required: ['a'] }, { a: { x: 1 }, b: 2 }), '{"a":{"x":1}}')
    assert.throws(() => ser({ type: 'object', properties: { a: false }, required: ['a'] }, { a: 1 }), SerializationError)
  })

  test('a circular value reports where it broke', () => {
    const value: Record<string, unknown> = { a: 1 }
    value['self'] = value
    const error = capture(() => ser({ type: 'object', properties: { self: {} }, required: ['self'] }, value))
    assert.ok(error instanceof SerializationError)
    assert.equal(error.path, '$.self')
  })
})

describe('serializer: schema conversion (§13.3 fallbacks)', () => {
  test('a bare JSON Schema object is recognised', () => {
    assert.deepEqual(toJsonSchema({ type: 'string' }), { type: 'string' })
    assert.equal(toJsonSchema({ notASchema: true }), null)
  })

  test('jsonSchema() carries its shape', () => {
    const declared = jsonSchema<{ id: number }>({ type: 'object', properties: { id: { type: 'integer' } } })
    assert.deepEqual(toJsonSchema(declared), { type: 'object', properties: { id: { type: 'integer' } } })
  })

  test('a toJsonSchema() method is honoured (the ArkType convention)', () => {
    const arkLike = { '~standard': { version: 1, vendor: 'arktype', validate: () => ({ value: null }) }, toJsonSchema: () => ({ type: 'string' as const }) }
    assert.deepEqual(toJsonSchema(arkLike), { type: 'string' })
  })

  test('the io direction reaches both the converter and the method probe', () => {
    __resetSchemaConverters()
    try {
      registerSchemaConverter('directional', (_schema, io) => ({ type: 'string', title: io }))
      const viaConverter = { '~standard': { version: 1, vendor: 'directional', validate: () => ({ value: null }) } }
      assert.equal(toJsonSchema(viaConverter, 'input')?.title, 'input')
      assert.equal(toJsonSchema(viaConverter, 'output')?.title, 'output')
      // Default is `output`: core's only caller is the serializer, which
      // describes what leaves the process.
      assert.equal(toJsonSchema(viaConverter)?.title, 'output')

      const viaMethod = {
        '~standard': { version: 1, vendor: 'methodical', validate: () => ({ value: null }) },
        toJsonSchema: (options?: { io?: string }) => ({ type: 'string' as const, title: options?.io ?? 'none' }),
      }
      assert.equal(toJsonSchema(viaMethod, 'input')?.title, 'input')
    } finally {
      __resetSchemaConverters()
    }
  })

  test('a registered converter outranks a toJSONSchema() method on the same schema', () => {
    __resetSchemaConverters()
    try {
      // Zod schemas carry *both*. Registering a converter is an explicit act and
      // a method merely exists, so the registration wins — and it is the only
      // way the caller can control the input/output direction. Getting this
      // backwards silently described every request body as a response.
      registerSchemaConverter('zod-like', (_schema, io) => ({ type: 'integer', title: `converter:${io}` }))
      const both = {
        '~standard': { version: 1, vendor: 'zod-like', validate: () => ({ value: null }) },
        toJSONSchema: () => ({ type: 'string' as const, title: 'method' }),
      }
      assert.deepEqual(toJsonSchema(both, 'input'), { type: 'integer', title: 'converter:input' })
    } finally {
      __resetSchemaConverters()
    }
  })

  test('a registered converter is used for its vendor, and a throwing one degrades', () => {
    __resetSchemaConverters()
    try {
      registerSchemaConverter('fictional', () => ({ type: 'integer' }))
      registerSchemaConverter('explodes', () => { throw new Error('no JSON Schema for this') })

      const ok = { '~standard': { version: 1, vendor: 'fictional', validate: () => ({ value: null }) } }
      const bad = { '~standard': { version: 1, vendor: 'explodes', validate: () => ({ value: null }) } }

      assert.deepEqual(toJsonSchema(ok), { type: 'integer' })
      // A converter that throws is a legitimate "cannot convert", not a crash.
      assert.equal(toJsonSchema(bad), null)
    } finally {
      __resetSchemaConverters()
    }
  })

  test('an unconvertible response schema warns rather than failing the boot', () => {
    const result = buildSerializerTable(
      { 200: schema<{ id: number }>((value) => ({ value: value as { id: number } })) },
      { routeId: 'GET /x', strict: false, mode: 'compiled', codegen },
    )
    assert.equal(result.table, null)
    assert.equal(result.diagnostics.length, 1)
    assert.equal(result.diagnostics[0]!.severity, 'warning')
    assert.match(result.diagnostics[0]!.message, /will NOT be filtered/)
    assert.match(result.diagnostics[0]!.hint!, /registerSchemaConverter/)
  })

  test('`response: { 204: null }` declares "no contract" without a diagnostic', () => {
    const result = buildSerializerTable({ 204: null }, { routeId: 'GET /x', strict: false, mode: 'compiled', codegen })
    assert.equal(result.table, null)
    assert.equal(result.diagnostics.length, 0)
  })
})

describe('serializer: engine selection', () => {
  test('caps.eval === false falls back to the walker with identical output', () => {
    const source: JsonSchema = {
      type: 'object',
      properties: { id: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'tags'],
    }
    const { program } = buildProgram(source, false)
    const noEval = new CodeGen({ caps: { ...DEFAULT_CAPABILITIES, eval: false } })
    const fallback = compileSerializer(program!, 'noeval', noEval)
    const compiled = compileSerializer(program!, 'eval', codegen)

    const value = { id: 1, tags: ['a', 'b'], leak: true }
    assert.equal(fallback(value), compiled(value))
    assert.equal(fallback(value), '{"id":1,"tags":["a","b"]}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('serializer: end to end through the app', () => {
  const User = jsonSchema<{ id: number; email: string }>({
    type: 'object',
    properties: { id: { type: 'integer' }, email: { type: 'string' } },
    required: ['id', 'email'],
  })

  test('a declared response schema filters the handler result', async () => {
    const app = makeApp()
    app.get('/me', { response: { 200: User } }, () => ({
      id: 1, email: 'a@b.c', passwordHash: 'secret', internalNotes: 'do not ship',
    }) as never)

    const response = await app.inject('GET', '/me')
    assert.equal(response.status, 200)
    assert.equal(response.text(), '{"id":1,"email":"a@b.c"}')
    assert.ok(!response.text().includes('secret'))
  })

  test('content-length matches the filtered body, not the handler value', async () => {
    const app = makeApp()
    app.get('/me', { response: { 200: User } }, () => ({ id: 1, email: 'a@b.c', huge: 'x'.repeat(1000) }) as never)

    const response = await app.inject('GET', '/me')
    assert.equal(response.header('content-length'), String(Buffer.byteLength('{"id":1,"email":"a@b.c"}')))
  })

  test('a status with no declared schema is left alone', async () => {
    const app = makeApp()
    app.get('/me', { response: { 200: User } }, (ctx) => {
      ctx.res.status(201)
      return { id: 1, email: 'a@b.c', extra: true } as never
    })

    const response = await app.inject('GET', '/me')
    assert.equal(response.status, 201)
    assert.deepEqual(response.json(), { id: 1, email: 'a@b.c', extra: true })
  })

  test('a middleware short-circuit is filtered by the status it returns', async () => {
    // The reason `attachSerializer` runs at the end of the pipeline rather than
    // next to the handler: a cached or synthesised 200 is still a 200.
    const app = makeApp()
    app.use(() => ({ status: 200, headers: new Map(), cookies: [], body: { kind: 'json', value: { id: 9, email: 'z@z.z', token: 'LEAK' } } }) as never)
    app.get('/me', { response: { 200: User } }, () => ({ id: 1, email: 'a@b.c' }) as never)

    const response = await app.inject('GET', '/me')
    assert.equal(response.text(), '{"id":9,"email":"z@z.z"}')
  })

  test('an after middleware that replaces the body keeps the contract', async () => {
    const app = makeApp()
    app.get('/me', { response: { 200: User } }, () => ({ id: 1, email: 'a@b.c' }) as never)
    app.after((_ctx, reply) => {
      ;(reply as { body: unknown }).body = { kind: 'json', value: { id: 2, email: 'b@b.c', swapped: 'LEAK' } }
      return reply
    })

    const response = await app.inject('GET', '/me')
    assert.equal(response.text(), '{"id":2,"email":"b@b.c"}')
  })

  test('mode: "walk" and mode: "off"', async () => {
    const walkApp = makeApp({ serialization: { mode: 'walk' } })
    walkApp.get('/me', { response: { 200: User } }, () => ({ id: 1, email: 'a@b.c', leak: 1 }) as never)
    assert.equal((await walkApp.inject('GET', '/me')).text(), '{"id":1,"email":"a@b.c"}')

    const offApp = makeApp({ serialization: { mode: 'off' } })
    offApp.get('/me', { response: { 200: User } }, () => ({ id: 1, email: 'a@b.c', leak: 1 }) as never)
    assert.deepEqual((await offApp.inject('GET', '/me')).json(), { id: 1, email: 'a@b.c', leak: 1 })
  })

  test('a contract violation is a 500 whose path reaches dev and never production', async () => {
    const dev = makeApp({ dev: true })
    dev.get('/me', { response: { 200: User } }, () => ({ id: 1 }) as never)
    const devResponse = await dev.inject('GET', '/me')
    assert.equal(devResponse.status, 500)
    assert.equal(devResponse.json<{ code: string }>().code, 'ZEN_SERIALIZATION')
    // Dev puts `meta` under `debug` on purpose: knowing *which* property broke
    // the contract is the entire value of the check.
    assert.ok(devResponse.text().includes('$.email'))

    const prod = makeApp({ dev: false, serialization: { strict: true } })
    prod.get('/me', { response: { 200: User } }, () => ({ id: 1 }) as never)
    const prodResponse = await prod.inject('GET', '/me')
    assert.equal(prodResponse.status, 500)
    // `expose: false` — the subsystem that exists not to leak fields must not
    // leak its own field names either.
    assert.equal(prodResponse.json<{ title: string }>().title, 'Internal Server Error')
    assert.ok(!prodResponse.text().includes('$.email'))
    assert.ok(!prodResponse.text().includes('email'))
  })

  test('jsonSchema() on a request source is a boot error, not a silent pass-through', async () => {
    const app = makeApp()
    app.post('/x', { body: User }, () => 'ok')

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /cannot validate/)
    assert.match(error.message, /ZEN_SCHEMA_UNCONVERTIBLE/)
  })

  test('an ambiguous response schema fails the boot with an actionable diagnostic', async () => {
    const app = makeApp()
    app.get('/x', {
      response: {
        200: jsonSchema({
          oneOf: [
            { type: 'object', properties: { a: { type: 'integer' } } },
            { type: 'object', properties: { b: { type: 'integer' } } },
          ],
        }),
      },
    }, () => ({}) as never)

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /branches of this union apart/)
    assert.match(error.message, /fix: Give every branch a literal discriminant/)
  })
})
