import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateRequestId } from '@erenthedeveloper0/zen-core'

/**
 * The request id — `primitives/id.ts`, made on every request (§7.2's `ctx.id`).
 *
 * A correlation key, so the properties that matter are the ones a log reader
 * leans on: it is ULID-shaped, its first ten characters are the millisecond it
 * was made in, and ids made one after another sort in the order they were
 * made — within one millisecond too, where the random part counts up by one.
 * The generator re-encodes only what changed since the last id, so these are
 * also the properties a caching mistake would break.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function decode(digits: string): bigint {
  let value = 0n
  for (const digit of digits) {
    const index = CROCKFORD.indexOf(digit)
    assert.ok(index !== -1, `"${digit}" is not Crockford base32`)
    value = value * 32n + BigInt(index)
  }
  return value
}

describe('request ids (§7.2)', () => {
  test('26 Crockford base32 characters, the first ten the millisecond it was made in', () => {
    for (const now of [1_700_000_000_000, 1_700_000_000_001, 2_000_000_000_123]) {
      const id = generateRequestId(now)
      assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.equal(decode(id.slice(0, 10)), BigInt(now))
    }
  })

  test('within one millisecond the random part counts up by one, across every carry', () => {
    // 200 ids in one millisecond carry out of the last digit at least six
    // times, which is where a generator that re-encodes only what moved
    // would go wrong.
    const now = 1_800_000_000_000
    let previous = generateRequestId(now)
    for (let i = 0; i < 200; i++) {
      const id = generateRequestId(now)
      assert.equal(id.slice(0, 10), previous.slice(0, 10))
      assert.equal(decode(id.slice(10)), decode(previous.slice(10)) + 1n, `${previous} → ${id}`)
      assert.ok(id > previous, 'ids sort in the order they were made')
      previous = id
    }
  })

  test('a new millisecond starts a new time prefix, and still sorts after the last', () => {
    const before = generateRequestId(1_900_000_000_000)
    const after = generateRequestId(1_900_000_000_001)
    assert.equal(decode(after.slice(0, 10)), 1_900_000_000_001n)
    assert.ok(after > before)
    // And back: an id for an earlier millisecond is that millisecond's, not a
    // stale prefix from the one before.
    assert.equal(decode(generateRequestId(1_850_000_000_000).slice(0, 10)), 1_850_000_000_000n)
  })
})
