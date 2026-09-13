/**
 * Run with: node --allow-natives-syntax packages/core/test/fixtures/monomorphism.ts
 *
 * Asserts invariant I2 mechanically — rfcs/0001 §20.7.
 *
 * Every context V8 sees for a given application must have identical shape. This
 * is the only reliable way to defend that: a change that reintroduces a dynamic
 * property assignment silently costs throughput and would otherwise be caught by
 * nobody. `%HaveSameMap` is reached through `new Function` so the source stays
 * valid TypeScript.
 */
import { compileContext, CodeGen, DEFAULT_CAPABILITIES, slot, PlainContext } from '@zenjs/core'
import type { RawRequest } from '@zenjs/core'

const haveSameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)') as (a: object, b: object) => boolean

const noop = () => {}
const logger = { level: 'fatal' as const, child() { return logger }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }

const UserSlot = slot<{ id: number }>('mono.user')

const Ctx = compileContext({
  decorations: [{ name: 'user', slotIndex: UserSlot.index, accessor: null, source: 'test' }],
  slotCount: 8,
  codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }),
})

function rawRequest(url: string): RawRequest {
  return {
    method: 'GET',
    url,
    header: () => undefined,
    headerNames: () => [],
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '127.0.0.1', port: 0, family: 'IPv4' },
    native: null,
  }
}

const env = { log: logger, maxQueryParams: 100, trustProxy: false, container: null as never, config: Object.freeze({ a: 1 }) }
const signal = new AbortController().signal

const first = new Ctx(rawRequest('/a'), null, {}, env, signal)
const second = new Ctx(rawRequest('/b?x=1'), null, { id: '1' }, env, signal)

// Exercise the lazy accessors and the slot channel on one of them only — the
// shapes must still match afterwards, because nothing here adds a property.
void second.query
void second.headers
void second.path
second.set(UserSlot, { id: 1 })
void second.res.header('x-test', '1')
// §16.3 — `ctx.config` is a getter over the shared `ContextEnv`, not a field.
// Reading it here is the assertion: a future change that made it a per-context
// field would add a store to the constructor, and this file is the only thing
// in the repo that would notice.
void (second as unknown as { config: unknown }).config

const third = new Ctx(rawRequest('/c'), null, {}, env, signal)

/**
 * The generated class against the interpreted twin — the other half of I2.
 *
 * `%HaveSameMap` cannot answer this one: two different constructors always
 * produce two different maps, however identical their fields. What actually
 * has to hold is that the two declare the *same field names in the same order*,
 * because that ordering is the hidden class, and `PlainContext` is what runs
 * verbatim when `caps.eval === false` (§14.5). A field added to one and not the
 * other means the compiled app and the CSP-locked app disagree about the shape
 * of every context, and nothing else in the repo would notice.
 *
 * The HANDOFF has claimed this file asserts that for three passes. It did not;
 * it compared the generated class against itself. Added when §13.4 put
 * `$negotiated` on both.
 */
const plain = new PlainContext(rawRequest('/d'), null, {}, env, 8, signal)
const generatedFields = Object.getOwnPropertyNames(first)
const twinFields = Object.getOwnPropertyNames(plain)

const checks: Array<[string, boolean]> = [
  ['fresh contexts share a map', haveSameMap(first, third)],
  ['an exercised context still shares the map', haveSameMap(first, second)],
  [
    `the twin declares the same fields in the same order (${generatedFields.length})`,
    generatedFields.length === twinFields.length &&
      generatedFields.every((name, i) => name === twinFields[i]),
  ],
]

if (generatedFields.join(',') !== twinFields.join(',')) {
  console.log(`  generated: ${generatedFields.join(' ')}`)
  console.log(`  twin:      ${twinFields.join(' ')}`)
}

let failed = false
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}`)
  if (!ok) failed = true
}

process.exitCode = failed ? 1 : 0
