import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zen, processLifecycle, NoopLogger } from '@erenthedeveloper0/zen'

const fixture = fileURLToPath(new URL('./fixtures/serve.ts', import.meta.url))

/** Start the fixture and resolve once it reports it is listening. */
function start(mode: string): Promise<{ child: ChildProcess; output: () => string; exited: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
    child.stdout?.on('data', (chunk) => {
      text += String(chunk)
      if (text.includes('ready ')) resolve({ child, output: () => text, exited })
    })
    child.stderr?.on('data', (chunk) => { text += String(chunk) })
    child.once('error', reject)
    setTimeout(() => reject(new Error(`fixture did not start: ${text}`)), 10_000).unref()
  })
}

const posix = process.platform !== 'win32'

describe('process lifecycle (§4.5, §12.8)', () => {
  it('SIGTERM runs the graceful shutdown and exits 0', { skip: !posix && 'Windows cannot deliver SIGTERM to a handler' }, async () => {
    const { child, output, exited } = await start('serve')
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.match(output(), /onClose SIGTERM/, 'onClose hooks ran — the process drained rather than dying')
  })

  it('an uncaught exception is logged, shuts down gracefully, and exits 1', async () => {
    const { output, exited } = await start('crash')
    assert.equal(await exited, 1)
    assert.match(output(), /onClose uncaughtException/)
  })

  it('an unhandled rejection does the same', async () => {
    const { output, exited } = await start('reject')
    assert.equal(await exited, 1)
    assert.match(output(), /onClose unhandledRejection/)
  })

  it('installs nothing until listen(), and removes everything at close()', async () => {
    const count = () => ({
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
      exception: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
    })
    const before = count()
    const app = zen({ env: {}, logger: new NoopLogger(), lifecycle: processLifecycle({ exit: false }) })
    app.get('/', () => 'ok')
    await app.inject('GET', '/')
    assert.deepEqual(count(), before, 'inject() alone installs nothing — a test file stays clean')
    await app.listen({ port: 0 })
    assert.deepEqual(count(), {
      term: before.term + 1, int: before.int + 1, exception: before.exception + 1, rejection: before.rejection + 1,
    })
    await app.close()
    assert.deepEqual(count(), before)
  })

  it('lifecycle: false leaves the process alone', async () => {
    const before = process.listenerCount('SIGTERM')
    const app = zen({ env: {}, logger: new NoopLogger(), lifecycle: false })
    app.get('/', () => 'ok')
    await app.listen({ port: 0 })
    assert.equal(process.listenerCount('SIGTERM'), before)
    await app.close()
  })

  it('close() called twice runs the sequence once', async () => {
    const app = zen({ env: {}, logger: new NoopLogger(), lifecycle: false })
    let closes = 0
    app.hook('onClose', () => { closes++ })
    app.get('/', () => 'ok')
    await app.listen({ port: 0 })
    await Promise.all([app.close('a'), app.close('b')])
    await app.close('c')
    assert.equal(closes, 1)
  })
})
