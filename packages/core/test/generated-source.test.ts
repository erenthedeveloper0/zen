import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CodeGen, DEFAULT_CAPABILITIES, createApp } from '@erenthedeveloper0/zen-core'
import { ZenRouter } from '@erenthedeveloper0/zen-router'
import { generatedFixture, renderUnits } from './fixtures/generated-app.ts'
import { pathParser, silentLogger } from './helpers.ts'

/**
 * Generated-source snapshots.
 *
 * The byte-identical gates in `benchmarks/` prove what is *absent*: a route
 * that uses nothing emits nothing for it. This shows what is *present*. Every
 * unit the compilers emit for `fixtures/generated-app.ts` is committed in
 * `fixtures/generated.snap`, so a compiler change that alters emitted code for
 * any route arrives as a diff of code in review, rather than as a suite that
 * still passes.
 *
 * A change is accepted by regenerating the snapshot and committing it with the
 * change that caused it:
 *
 *     npx tsc -b && UPDATE_SNAPSHOTS=1 node --test packages/core/test/generated-source.test.ts
 */
const SNAPSHOT = fileURLToPath(new URL('./fixtures/generated.snap', import.meta.url))

describe('generated source', () => {
  it('every unit the compilers emit for the fixture app matches the committed snapshot', async () => {
    const app = await generatedFixture()
    const actual = renderUnits(app.generatedSource())

    if (process.env['UPDATE_SNAPSHOTS'] === '1') {
      writeFileSync(SNAPSHOT, actual)
      return
    }
    let expected: string
    try {
      expected = readFileSync(SNAPSHOT, 'utf8')
    } catch {
      assert.fail(`no snapshot at ${SNAPSHOT} — run with UPDATE_SNAPSHOTS=1 and commit it`)
    }
    assert.equal(actual, expected, 'the compilers emit different code — review the diff, then regenerate with UPDATE_SNAPSHOTS=1')
  })

  it('is deterministic: two builds of the fixture emit the same code', async () => {
    const first = renderUnits((await generatedFixture()).generatedSource())
    const second = renderUnits((await generatedFixture()).generatedSource())
    assert.equal(first, second)
  })

  it('covers every compiler', async () => {
    const names = (await generatedFixture()).generatedSource().map((unit) => unit.name.split(':')[0])
    for (const kind of ['context', 'params', 'pipeline', 'serializer', 'coercer']) assert.ok(names.includes(kind), `no ${kind} unit in ${[...new Set(names)].join(', ')}`)
  })
})

describe('what an app keeps after boot (§3.4)', () => {
  const build = (options: { inspect?: boolean; dev?: boolean } = {}) => {
    const app = createApp({ router: new ZenRouter(), pathParser, logger: silentLogger(), ...options })
    app.get('/users/:id<int>', (ctx) => ({ id: ctx.params.id }))
    return app
  }

  it('keeps no generated source unless asked, and says so rather than answering with nothing', async () => {
    const app = build()
    await app.ready()
    assert.equal((await app.inject('GET', '/users/7')).text(), '{"id":7}', 'the compiled code runs all the same')
    assert.throws(() => app.generatedSource(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ZEN_INSPECT_DISABLED')
      return true
    })
  })

  it('keeps it with inspect: true, compact, and with dev: true, readable', async () => {
    const inspected = build({ inspect: true })
    const dev = build({ dev: true })
    await inspected.ready()
    await dev.ready()
    const pipeline = (app: typeof inspected) => app.generatedSource().find((u) => u.name === 'pipeline:GET_/users/:id<int>')?.source ?? ''
    assert.notEqual(pipeline(inspected), '')
    assert.doesNotMatch(pipeline(inspected), /\/\/ /)
    assert.match(pipeline(dev), /\/\/ /, 'dev source carries its comments')
  })

  it('a CodeGen refuses to list units it did not keep, and hands every unit to onEmit regardless', () => {
    const emitted: string[] = []
    const quiet = new CodeGen({ caps: DEFAULT_CAPABILITIES, onEmit: (unit) => { emitted.push(unit.name) } })
    const kept = new CodeGen({ caps: DEFAULT_CAPABILITIES, retain: true })
    for (const gen of [quiet, kept]) gen.materialise({ name: 'probe', source: 'return 1', externals: {} }, () => 1)
    assert.equal(quiet.retains, false)
    assert.throws(() => quiet.units, /keeps no units/)
    assert.deepEqual(emitted, ['probe'])
    assert.deepEqual(kept.units.map((u) => u.name), ['probe'])
  })
})
