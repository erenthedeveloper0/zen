import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ConsoleLogger, ZenError } from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

/**
 * The default logger — §12.8, §31.1.
 *
 * It runs on the error path, where a throw is a second failure hiding the
 * first: the error engine logs a failure *before* it formats the response, so
 * a logger that throws there loses the response too.
 */
describe('ConsoleLogger never throws (§12.8)', () => {
  let lines: string[] = []
  const original = { log: console.log, error: console.error }

  beforeEach(() => {
    lines = []
    console.log = (line: string) => { lines.push(line) }
    console.error = (line: string) => { lines.push(line) }
  })
  afterEach(() => {
    console.log = original.log
    console.error = original.error
  })

  it('writes a line for a value JSON.stringify refuses — a cycle, a bigint', () => {
    const logger = new ConsoleLogger('info')
    const cycle: Record<string, unknown> = { name: 'order' }
    cycle['self'] = cycle

    assert.doesNotThrow(() => logger.info({ cycle, total: 10n }, 'checkout'))
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>
    assert.equal(line['msg'], 'checkout')
    assert.equal(line['total'], '10', 'a bigint keeps its digits')
    assert.equal((line['cycle'] as Record<string, unknown>)['self'], '[Circular]')
  })

  it('an ordinary line is exactly what JSON.stringify produces', () => {
    const logger = new ConsoleLogger('info', { service: 'api' })
    logger.warn({ code: 'X', n: 1 }, 'plain')
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>
    assert.deepEqual(
      { level: line['level'], service: line['service'], code: line['code'], n: line['n'], msg: line['msg'] },
      { level: 'warn', service: 'api', code: 'X', n: 1, msg: 'plain' },
    )
  })

  it('an error whose metadata cannot be serialised still gets its response, and its log line', async () => {
    // The error engine spreads `meta` into the log line. A `bigint` there used
    // to throw out of the logger and take the problem document with it.
    const logger = new ConsoleLogger('info')
    const app = makeApp({ logger })
    app.get('/', () => {
      throw new ZenError('APP_LEDGER', 'ledger is out of balance', { status: 500, meta: { delta: 12n } })
    })

    const res = await app.inject('GET', '/')
    assert.equal(res.status, 500)
    assert.equal(res.json<{ code: string }>().code, 'APP_LEDGER')
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['code'] === 'APP_LEDGER')
    assert.ok(logged !== undefined, 'the failure was logged')
    assert.equal(logged['delta'], '12')
  })

  it('metadata can add to a log line but not overwrite the fields dashboards filter on', async () => {
    const logger = new ConsoleLogger('info')
    const app = makeApp({ logger })
    app.get('/', () => {
      throw new ZenError('APP_REAL', 'boom', { status: 503, meta: { status: 200, code: 'FAKE', shard: 3 } })
    })

    await app.inject('GET', '/')
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['msg'] === 'boom')
    assert.ok(logged !== undefined)
    assert.equal(logged['status'], 503)
    assert.equal(logged['code'], 'APP_REAL')
    assert.equal(logged['shard'], 3)
  })
})
