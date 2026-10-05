import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generatedFixture, renderUnits } from './fixtures/generated-app.ts'

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
