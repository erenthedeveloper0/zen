import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { BREAKER_DEFAULTS, ErrorEngine, ZenError, type Logger } from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

/**
 * §12.8's circuit breaker on the error path.
 *
 * A formatter that throws once is a bug worth a `fatal`. A formatter that
 * throws on every error is a broken process, and a `fatal` per request turns
 * its log into the incident. So `threshold` failures inside `windowMs` open the
 * circuit: one `fatal`, then the minimal responder answers for `cooldownMs`
 * without calling the formatter at all, then one attempt decides whether it
 * closes again.
 */

/** A `ZenError` whose client projection cannot be built — the formatter's one external call. */
class Unformattable extends ZenError {
  static calls = 0
  static broken = true
  constructor() {
    super('ZEN_INTERNAL', 'cannot be formatted', { status: 500 })
  }
  override toProblem(instance: string, requestId: string): Record<string, unknown> {
    Unformattable.calls++
    if (Unformattable.broken) throw new Error('formatter is broken')
    return super.toProblem(instance, requestId)
  }
}

function recorder(): { logger: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = []
  const at = (level: string) => (a: unknown, b?: string): void => {
    lines.push({ level, msg: typeof a === 'string' ? a : (b ?? '') })
  }
  const logger: Logger = {
    level: 'trace',
    child: () => logger,
    trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'),
  }
  return { logger, lines }
}

const info = { requestId: 'r1', method: 'GET', path: '/x', route: null }
const formatterLines = (lines: ReadonlyArray<{ level: string; msg: string }>) =>
  lines.filter((l) => /formatter/.test(l.msg))

describe('the error formatter circuit breaker (§12.8)', () => {
  test('failures below the threshold are each an error; the one that reaches it is the only fatal', () => {
    Unformattable.calls = 0
    Unformattable.broken = true
    let now = 0
    const { logger, lines } = recorder()
    const engine = new ErrorEngine({ dev: false, logger, now: () => now, breaker: { threshold: 3, windowMs: 1000, cooldownMs: 5000 } })

    for (let i = 0; i < 3; i++) {
      const reply = engine.handle(new Unformattable(), info)
      assert.equal(reply.status, 500)
      now += 10
    }
    const logged = formatterLines(lines)
    assert.deepEqual(logged.map((l) => l.level), ['error', 'error', 'fatal'])
    assert.equal(Unformattable.calls, 3)

    // Open: ten more errors, no formatter call, no further formatter line.
    for (let i = 0; i < 10; i++) {
      const reply = engine.handle(new Unformattable(), info)
      assert.equal(reply.status, 500)
      assert.equal(reply.body.kind, 'text', 'the minimal responder')
    }
    assert.equal(Unformattable.calls, 3, 'the formatter is not called while the circuit is open')
    assert.equal(formatterLines(lines).length, 3)
  })

  test('after the cooldown one attempt decides: still broken re-opens, fixed closes and reports what it shed', () => {
    Unformattable.calls = 0
    Unformattable.broken = true
    let now = 0
    const { logger, lines } = recorder()
    const engine = new ErrorEngine({ dev: false, logger, now: () => now, breaker: { threshold: 2, windowMs: 1000, cooldownMs: 100 } })

    engine.handle(new Unformattable(), info)
    engine.handle(new Unformattable(), info) // trips
    engine.handle(new Unformattable(), info) // shed
    assert.equal(Unformattable.calls, 2)

    now += 150
    engine.handle(new Unformattable(), info) // half-open, still broken → re-opens
    assert.equal(Unformattable.calls, 3)
    assert.equal(formatterLines(lines).at(-1)?.msg, 'error formatter still throws; skipping it again')
    engine.handle(new Unformattable(), info) // shed again
    assert.equal(Unformattable.calls, 3)

    now += 150
    Unformattable.broken = false
    const reply = engine.handle(new Unformattable(), info)
    assert.equal(reply.body.kind, 'json', 'the formatted problem document again')
    const recovered = formatterLines(lines).at(-1)
    assert.equal(recovered?.level, 'warn')
    assert.match(recovered?.msg ?? '', /works again; 2 error\(s\) were answered by the minimal 500/)
    assert.equal(formatterLines(lines).filter((l) => l.level === 'fatal').length, 1, 'one fatal for the whole episode')
  })

  test('failures further apart than the window never trip it', () => {
    Unformattable.calls = 0
    Unformattable.broken = true
    let now = 0
    const { logger, lines } = recorder()
    const engine = new ErrorEngine({ dev: false, logger, now: () => now, breaker: { threshold: 3, windowMs: 100, cooldownMs: 1000 } })
    for (let i = 0; i < 10; i++) {
      engine.handle(new Unformattable(), info)
      now += 60
    }
    assert.equal(Unformattable.calls, 10)
    assert.equal(formatterLines(lines).filter((l) => l.level === 'fatal').length, 0)
  })

  test('through an application: a broken mapper target logs one fatal, not one per request', async () => {
    Unformattable.calls = 0
    Unformattable.broken = true
    const { logger, lines } = recorder()
    const app = makeApp({ logger })
    class Domain extends Error {}
    app.onError(Domain, () => new Unformattable())
    app.get('/x', () => { throw new Domain('no') })
    for (let i = 0; i < 20; i++) {
      const res = await app.inject('GET', '/x')
      assert.equal(res.status, 500)
      assert.equal(res.json<{ code: string }>().code, 'ZEN_INTERNAL')
    }
    assert.equal(formatterLines(lines).filter((l) => l.level === 'fatal').length, 1)
    assert.equal(Unformattable.calls, BREAKER_DEFAULTS.threshold)
  })
})

describe('development error facts (§12.6)', () => {
  const failing = new ZenError('ZEN_UNAUTHENTICATED', 'no session', {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
    hint: 'Send a session cookie.',
    consequence: 'Nothing was written.',
  })

  test('development: the message, the fix, its consequence and the docs link, with the facts only the application knows', () => {
    const reported: unknown[] = []
    const engine = new ErrorEngine({
      dev: true,
      logger: recorder().logger,
      explain: () => ({ origin: 'src/routes.ts:3:1', chain: ['handler show'] }),
      report: (problem) => { reported.push(problem) },
    })
    const reply = engine.handle(failing, info)
    assert.equal(reply.status, 401)
    const debug = (reply.body as { value: { debug: Record<string, unknown> } }).value.debug
    assert.equal(debug['message'], 'no session')
    assert.equal(debug['hint'], 'Send a session cookie.')
    assert.equal(debug['consequence'], 'Nothing was written.')
    assert.match(String(debug['docs']), /errors\.md#zen_unauthenticated$/)
    assert.equal(debug['origin'], 'src/routes.ts:3:1')
    assert.deepEqual(debug['chain'], ['handler show'])
    assert.equal(reported.length, 0, 'a 4xx is not reported; it is the client\'s')
    engine.handle(new ZenError('ZEN_INTERNAL', 'boom', { status: 500 }), info)
    assert.equal(reported.length, 1)
  })

  test('facts that cannot be gathered, or a reporter that throws, still leave an answer', () => {
    const engine = new ErrorEngine({
      dev: true,
      logger: recorder().logger,
      explain: () => { throw new Error('explain is broken') },
      report: () => { throw new Error('report is broken') },
    })
    const reply = engine.handle(new ZenError('ZEN_INTERNAL', 'boom', { status: 500 }), info)
    assert.equal(reply.status, 500)
    assert.equal((reply.body as { value: { debug: { message: string } } }).value.debug.message, 'boom')
  })

  test('a browser gets the page, escaped, with the error\'s own headers; never in production', () => {
    const dev = new ErrorEngine({ dev: true, logger: recorder().logger })
    const page = dev.handle(new ZenError('ZEN_INTERNAL', '<img src=x onerror=alert(1)>', { status: 500 }), { ...info, html: true })
    assert.equal(page.body.kind, 'text')
    const markup = (page.body as { value: string }).value
    assert.doesNotMatch(markup, /<img/)
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/)
    const challenged = dev.handle(failing, { ...info, html: true })
    assert.equal(challenged.headers.get('www-authenticate'), 'Bearer', 'a 401 still challenges')
    assert.match((challenged.body as { media?: string }).media ?? '', /^text\/html/)

    const prod = new ErrorEngine({ dev: false, logger: recorder().logger, explain: () => { throw new Error('never called') } })
    const document = prod.handle(failing, { ...info, html: true })
    assert.equal(document.body.kind, 'json', 'production answers with the problem document whatever Accept says')
    assert.equal((document.body as { value: Record<string, unknown> }).value['debug'], undefined)
  })
})

describe('development error facts, from an application (§12.6)', () => {
  test('where the route was registered, where the error was raised, the chain; a frame only when the host reads source', async () => {
    const app = makeApp({ dev: true })
    app.use(function authenticate() { return undefined })
    app.get('/users/:id', function showUser() {
      throw new Error('the database is gone')
    })
    const debug = (await app.inject('GET', '/users/1')).json<{ debug: Record<string, unknown> }>().debug
    assert.match(String(debug['origin']), /error-engine\.test\.ts:\d+:\d+$/)
    assert.match(String(debug['thrown']), /error-engine\.test\.ts:\d+:\d+$/)
    assert.deepEqual(debug['chain'], ['phase [global] authenticate', 'handler showUser'])
    assert.equal(debug['frame'], undefined, 'core reads no files (§3.3 B2)')

    const read: string[] = []
    const source = Array.from({ length: 2000 }, (_, i) => `source line ${i + 1}`).join('\n')
    const withSource = makeApp({ dev: true, devErrors: { readSource: (file) => { read.push(file); return source } } })
    withSource.get('/x', function fails() { throw new Error('x') })
    type Frame = { line: number; lines: Array<{ line: number; text: string }> }
    const frame = (await withSource.inject('GET', '/x')).json<{ debug: { frame: Frame } }>().debug.frame
    assert.equal(read.length, 1)
    assert.ok(read[0]?.endsWith('error-engine.test.ts'), 'the file the error was raised in')
    assert.deepEqual(frame.lines.map((l) => l.line), [frame.line - 2, frame.line - 1, frame.line, frame.line + 1, frame.line + 2])
    assert.equal(frame.lines[2]?.text, `source line ${frame.line}`)
  })

  test('production: none of it, and the reader is never called', async () => {
    let reads = 0
    const app = makeApp({ dev: false, devErrors: { readSource: () => { reads++; return '' }, report: () => { reads++ } } })
    app.get('/x', () => { throw new Error('x') })
    const res = await app.inject('GET', '/x', { headers: { accept: 'text/html' } })
    assert.match(res.header('content-type') ?? '', /application\/problem\+json/)
    assert.equal(res.json<Record<string, unknown>>()['debug'], undefined)
    assert.equal(reads, 0)
  })
})
