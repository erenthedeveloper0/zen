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

describe('redaction and configuration (§31.1, §16.1)', () => {
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
  const last = (): Record<string, unknown> => JSON.parse(lines.at(-1) as string) as Record<string, unknown>

  it('hides what a path names, at the depth it names, and leaves the rest', () => {
    const logger = new ConsoleLogger('info')
    logger.configure({ redact: ['req.headers.authorization', '*.token', '**.password'] })
    logger.info({
      req: { headers: { authorization: 'Bearer abc', accept: 'text/html' } },
      session: { token: 't0k3n', user: 'ada' },
      token: 'top-level-kept',
      deep: { a: { b: { password: 'hunter2' } } },
      password: 'hunter3',
    }, 'line')
    const line = last()
    assert.deepEqual(line['req'], { headers: { authorization: '********', accept: 'text/html' } })
    assert.deepEqual(line['session'], { token: '********', user: 'ada' })
    assert.equal(line['token'], 'top-level-kept', '`*.token` is one level down, not the top')
    assert.deepEqual(line['deep'], { a: { b: { password: '********' } } })
    assert.equal(line['password'], '********', '`**` matches no key as well as many')
  })

  it('hides a binding as well as a field: the whole line is serialised, then redacted', () => {
    const logger = new ConsoleLogger('info')
    logger.configure({ redact: ['**.cookie'] })
    logger.child({ cookie: 'session=1' }).info({ path: '/x' }, 'bound')
    assert.equal(last()['cookie'], '********')
  })

  it('children follow what the root is configured with, even when made before it', () => {
    const logger = new ConsoleLogger('info')
    const child = logger.child({ requestId: 'r1' })
    logger.configure({ level: 'error', redact: ['secret'] })
    child.info('dropped')
    child.error({ secret: 's' }, 'kept')
    assert.equal(lines.length, 1)
    assert.equal(last()['secret'], '********')
    assert.equal(child.level, 'error')
  })

  it("an application's logging configuration reaches the built-in logger — and its defaults hide credentials", async () => {
    const app = makeApp({ logger: undefined, overrides: { logging: { level: 'warn' } } })
    app.get('/', (ctx) => {
      ctx.log.info('not at warn')
      ctx.log.warn({ headers: { authorization: 'Bearer abc', cookie: 'sid=1' }, user: { password: 'p' } }, 'seen')
      return 'ok'
    })
    await app.inject('GET', '/')
    const written = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['msg'] === 'seen' || l['msg'] === 'not at warn')
    assert.deepEqual(written.map((l) => l['msg']), ['seen'])
    assert.deepEqual(written[0]?.['headers'], { authorization: '********', cookie: '********' })
    assert.deepEqual(written[0]?.['user'], { password: '********' })
  })
})
