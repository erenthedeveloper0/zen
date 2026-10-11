import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { BootError, type Logger } from '@erenthedeveloper0/zen-core'
import { requestLog } from '../src/index.ts'
import { makeApp } from './helpers.ts'

/**
 * Request logging — rfcs/0001 §31.1. One line per request, through `ctx.log`,
 * so it carries the request id and the route template every other line about
 * the request carries, plus the status, duration and length only the end of a
 * request knows.
 */

interface Line { level: string; bindings: Record<string, unknown>; obj: Record<string, unknown>; msg: string }

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = []
  const make = (bindings: Record<string, unknown>): Logger => {
    const at = (level: string) => (a: unknown, b?: string): void => {
      lines.push({ level, bindings, obj: typeof a === 'object' && a !== null ? a as Record<string, unknown> : {}, msg: typeof a === 'string' ? a : (b ?? '') })
    }
    return {
      level: 'trace',
      child: (more) => make({ ...bindings, ...more }),
      trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'),
    }
  }
  return { logger: make({}), lines }
}

const requests = (lines: readonly Line[]) => lines.filter((l) => l.msg === 'request')

describe('requestLog()', () => {
  test('one line per request: method, status, duration, length — and the request id and route template from ctx.log', async () => {
    const { logger, lines } = recorder()
    const app = makeApp({ logger })
    app.use(requestLog())
    app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))
    const res = await app.inject('GET', '/users/7')
    const [line] = requests(lines)
    assert.equal(line?.level, 'info')
    assert.equal(line?.obj['method'], 'GET')
    assert.equal(line?.obj['status'], 200)
    assert.equal(line?.obj['length'], res.text().length)
    assert.equal(typeof line?.obj['durationMs'], 'number')
    assert.equal(line?.bindings['route'], '/users/:id', 'the template, not the URL')
    assert.ok(typeof line?.bindings['requestId'] === 'string' && (line.bindings['requestId'] as string).length > 0)
  })

  test('it sees the requests no route matched, and the ones that failed', async () => {
    const { logger, lines } = recorder()
    const app = makeApp({ logger })
    app.use(requestLog())
    app.get('/boom', () => { throw new Error('no') })
    await app.inject('GET', '/nowhere')
    await app.inject('GET', '/boom')
    assert.deepEqual(requests(lines).map((l) => l.obj['status']), [404, 500])
  })

  test('skip leaves out what nobody reads, and level is the line’s level', async () => {
    const { logger, lines } = recorder()
    const app = makeApp({ logger })
    app.use(requestLog({ level: 'debug', skip: (ctx) => ctx.path === '/healthz' }))
    app.get('/healthz', () => 'ok')
    app.get('/work', () => 'done')
    await app.inject('GET', '/healthz')
    await app.inject('GET', '/work')
    const logged = requests(lines)
    assert.deepEqual(logged.map((l) => l.bindings['route']), ['/work'], 'the request skip() kept, and only it')
    assert.equal(logged[0]?.level, 'debug')
  })

  test('a misspelled option is refused at boot with the one it was meant to be', async () => {
    const app = makeApp()
    app.use(requestLog({ levle: 'info' } as never))
    app.get('/', () => 'ok')
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /did you mean "level"\?/)
  })

  test('it costs a route nothing: the pipelines are the ones an app without it compiles', async () => {
    const plain = makeApp()
    const logged = makeApp()
    logged.use(requestLog())
    for (const app of [plain, logged]) app.get('/x', () => 'ok')
    await plain.ready()
    await logged.ready()
    const pipeline = (app: typeof plain) => app.generatedSource().find((u) => u.name === 'pipeline:GET_/x')?.source
    assert.equal(pipeline(logged), pipeline(plain))
  })
})
