import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NoopLogger, renderError, sourceReader, terminalReporter, zen } from '../src/index.ts'

/**
 * Development error rendering — rfcs/0001 §12.6. Core supplies the facts; the
 * meta-package reads the source for the code frame and renders for a
 * terminal, and core renders the page a browser gets.
 */

function app(dev: boolean, report?: (problem: Readonly<Record<string, unknown>>) => void) {
  const a = zen({
    dev,
    lifecycle: false,
    env: {},
    logger: new NoopLogger(),
    ...(report === undefined ? {} : { devErrors: { readSource: sourceReader(), report } }),
  })
  a.get('/users/:id', function showUser() {
    throw new Error('the database is gone') // the line the frame points at
  })
  return a
}

describe('development errors carry facts (§12.6)', () => {
  test('where the route was registered, where it was raised, the code around it, the chain, the docs', async () => {
    const reported: Array<Readonly<Record<string, unknown>>> = []
    const res = await app(true, (p) => { reported.push(p) }).inject('GET', '/users/7')
    assert.equal(res.status, 500)
    const debug = res.json<{ debug: Record<string, unknown> }>().debug
    assert.equal(debug['message'], 'the database is gone')
    assert.match(String(debug['thrown']), /dev-errors\.test\.ts:\d+:\d+$/)
    assert.match(String(debug['origin']), /dev-errors\.test\.ts:\d+:\d+$/)
    const frame = debug['frame'] as { lines: Array<{ line: number; text: string }>; line: number }
    assert.ok(frame.lines.some((l) => l.line === frame.line && l.text.includes("throw new Error('the database is gone')")))
    assert.ok((debug['chain'] as string[]).includes('handler showUser'))
    assert.match(String(debug['docs']), /errors\.md#zen_internal$/)
    assert.equal(reported.length, 1, 'a 5xx is reported once')
  })

  test('production carries none of it, and reports nothing', async () => {
    const reported: unknown[] = []
    const res = await app(false, (p) => { reported.push(p) }).inject('GET', '/users/7')
    assert.equal(res.json<Record<string, unknown>>()['debug'], undefined)
    assert.equal(reported.length, 0)
  })

  test('a browser gets a page, every value escaped; an API client keeps its document', async () => {
    const a = zen({ dev: true, lifecycle: false, env: {}, logger: new NoopLogger() })
    a.get('/x', () => { throw new Error('<script>alert(1)</script>') })
    const page = await a.inject('GET', '/x', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
    assert.equal(page.status, 500)
    assert.match(page.header('content-type') ?? '', /^text\/html/)
    assert.doesNotMatch(page.text(), /<script>alert/)
    assert.match(page.text(), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    const api = await a.inject('GET', '/x', { headers: { accept: 'application/json' } })
    assert.match(api.header('content-type') ?? '', /application\/problem\+json/)
  })
})

describe('renderError — the terminal half', () => {
  const problem = {
    status: 500,
    code: 'ZEN_INTERNAL',
    instance: '/users/7',
    debug: {
      message: 'the database is gone',
      thrown: 'src/users.ts:12:5',
      route: '/users/:id',
      origin: 'src/routes.ts:3:1',
      frame: { file: 'src/users.ts', line: 12, lines: [{ line: 11, text: 'const x = 1' }, { line: 12, text: "throw new Error('gone')" }] },
      chain: ['phase [global] authenticate', 'handler showUser'],
      docs: 'https://example.invalid/errors#zen_internal',
    },
  }

  test('plain, it is readable on its own', () => {
    const text = renderError(problem)
    assert.match(text, /✖ 500 ZEN_INTERNAL {2}the database is gone/)
    assert.match(text, /raised at {2}src\/users\.ts:12:5/)
    assert.match(text, /❯ 12 │ throw new Error\('gone'\)/)
    assert.match(text, /chain {6}phase \[global\] authenticate → handler showUser/)
    assert.doesNotMatch(text, /\u001b/, 'no escape codes unless asked')
  })

  test('a validation problem lists its issues, one per line', () => {
    const text = renderError({
      status: 422,
      code: 'ZEN_VALIDATION',
      title: 'Validation failed',
      errors: [
        { path: ['body', 'email'], code: 'format', message: 'Invalid email', received: 'not-an-email' },
        { path: [], code: 'type', message: 'Expected object' },
      ],
    })
    assert.match(text, /body\.email {3}format {3}Invalid email {3}received "not-an-email"/)
    assert.match(text, /\(root\) {3}type {3}Expected object$/m)
  })

  test('with links, a location is an OSC 8 hyperlink to the file', () => {
    // An absolute root on this platform — `C:\work\app` on Windows — and the
    // URL its file has there, so the expectation is the platform's, not POSIX's.
    const root = resolve('/work/app')
    const href = pathToFileURL(join(root, 'src/users.ts')).href
    const text = renderError(problem, { links: true, root })
    assert.ok(text.includes(`\u001b]8;;${href}\u001b\\src/users.ts:12:5\u001b]8;;\u001b\\`), JSON.stringify(text))
  })

  test('the reporter writes to a terminal, and to nothing else', () => {
    const stderr = process.stderr as { isTTY?: boolean; write: (text: string) => boolean }
    const { isTTY, write } = stderr
    const written: string[] = []
    stderr.write = (text: string) => { written.push(text); return true }
    try {
      stderr.isTTY = false
      terminalReporter()(problem)
      assert.deepEqual(written, [], 'a pipe or a test run keeps its output')
      stderr.isTTY = true
      terminalReporter()(problem)
      assert.equal(written.length, 1)
      assert.match(written[0] ?? '', /ZEN_INTERNAL/)
    } finally {
      stderr.write = write
      stderr.isTTY = isTTY
    }
  })

  test('a file that cannot be read is no frame, never an error', () => {
    const read = sourceReader()
    assert.equal(read('/definitely/not/here.ts'), undefined)
    assert.equal(read('/definitely/not/here.ts'), undefined, 'and is not tried twice')
  })
})
