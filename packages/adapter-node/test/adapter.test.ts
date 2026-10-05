import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'
import type { SseChannel } from '@erenthedeveloper0/zen-core'
import { BootError, createApp, definePlugin, NoopLogger } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { serve, capturingLogger, openAndDrop, delay, abortedWithin } from './helpers.ts'
import { mediaTypeFor, nodeAdapter, NODE_CAPABILITIES } from '../src/index.ts'

/** A Standard Schema that accepts anything — the body just has to be *declared*. */
const anyBody = { '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } } as never

// ── §4.4: the connection signal ─────────────────────────────────────────────

describe('ctx.signal over a real socket (§4.4)', () => {
  it('is not aborted by reading the request body', async () => {
    // Node emits `close` on an IncomingMessage once its body is consumed. The
    // adapter used to treat that as a disconnect, so every request with a body
    // ran with an aborted signal.
    const seen: boolean[] = []
    const server = await serve((app) => {
      app.post('/echo', { body: anyBody }, async (ctx) => {
        seen.push(ctx.signal.aborted)
        await delay(10)
        seen.push(ctx.signal.aborted)
        return { ok: true }
      })
      app.hook('onResponse', (ctx) => { seen.push(ctx.aborted) })
    })
    try {
      const res = await fetch(`${server.url}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
      assert.equal(res.status, 200)
      await res.text()
      await delay(10)
      assert.deepEqual(seen, [false, false, false], 'after intake, after a wait, and as published to onResponse')
    } finally {
      await server.close()
    }
  })

  it('does not abandon a POST with a body on a route with a deadline', async () => {
    // The same defect's worst form: the stage check after intake saw the
    // aborted signal and answered 499 — every write endpoint, on every app that
    // followed the documentation's advice to set a default budget.
    const server = await serve((app) => {
      app.post('/orders', { body: anyBody }, (ctx) => ({ received: ctx.body }))
    }, { timeout: '5s' })
    try {
      const res = await fetch(`${server.url}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku: 'x' }),
      })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { received: { sku: 'x' } })
    } finally {
      await server.close()
    }
  })

  it('aborts when the client disconnects mid-request', async () => {
    let observed: Promise<boolean> | null = null
    const server = await serve((app) => {
      app.get('/slow', async (ctx) => {
        observed = abortedWithin(ctx.signal, 2000)
        await observed
        return 'late'
      })
    })
    try {
      // No response callback fires for a request dropped before its headers,
      // so drop it by hand once the handler is waiting.
      await new Promise<void>((resolve) => {
        const req = request(`${server.url}/slow`)
        req.on('error', () => {})
        req.end()
        setTimeout(() => { req.destroy(); resolve() }, 50)
      })
      assert.ok(observed !== null)
      assert.equal(await observed, true, 'the handler saw ctx.signal abort')
    } finally {
      await server.close()
    }
  })
})

// ── Streams: a client leaving must never take the process down ──────────────

describe('streamed bodies and disconnects', () => {
  it('survives a client disconnecting mid-stream, with nothing logged as a failure', async () => {
    // Before: pipeline rejected → the error path sent a second reply → the
    // adapter's last-resort handler set a header after the status line →
    // ERR_HTTP_HEADERS_SENT inside a `.catch` → an unhandled rejection → exit.
    const logger = capturingLogger()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    const consoleError = console.error
    const printed: unknown[] = []
    console.error = (...args: unknown[]) => { printed.push(args) }

    const server = await serve((app) => {
      app.get('/feed', (ctx) => ctx.stream(async function* () {
        for (let i = 0; i < 100; i++) {
          yield `line ${i}\n`
          await delay(5)
        }
      }))
    }, { logger })
    try {
      const { text } = await openAndDrop(`${server.url}/feed`, (seen) => seen.length > 0)
      assert.match(text, /^line 0/)
      await delay(100)
      assert.deepEqual(rejections, [], 'no unhandled rejection')
      assert.deepEqual(printed, [], 'nothing printed by the last-resort handler')
      assert.deepEqual(logger.errors, [], 'a client leaving is not an application error')
    } finally {
      console.error = consoleError
      process.off('unhandledRejection', onRejection)
      await server.close()
    }
  })

  it('reports a source that throws after the status line, and truncates the transfer', async () => {
    const logger = capturingLogger()
    const statuses: number[] = []
    const server = await serve((app) => {
      app.get('/broken', (ctx) => ctx.stream(async function* () {
        yield 'first\n'
        await delay(5)
        throw new Error('the database cursor died')
      }))
      app.hook('onResponse', (_ctx, reply) => { statuses.push(reply.status) })
    }, { logger })
    try {
      const { status, text } = await openAndDrop(`${server.url}/broken`, () => false)
      assert.equal(status, 200, 'the status line had already gone out')
      assert.equal(text, 'first\n', 'the body stops where the source failed')
      await delay(20)
      assert.equal(logger.errors.length, 1, 'the failure reached the error engine')
      assert.deepEqual(statuses, [500], 'onResponse observed a failed exchange')
    } finally {
      await server.close()
    }
  })
})

// ── §13.5: files ────────────────────────────────────────────────────────────

describe('file responses (§13.5)', () => {
  let dir = ''
  let publicDir = ''
  const content = 'Hello from a file on disk.\n'.repeat(10)

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zen-adapter-'))
    publicDir = join(dir, 'public')
    await mkdir(join(publicDir, 'nested'), { recursive: true })
    await writeFile(join(publicDir, 'hello.txt'), content)
    await writeFile(join(publicDir, 'app.css'), 'body{}')
    await writeFile(join(publicDir, 'nested', 'data.json'), '{"a":1}')
    await writeFile(join(dir, 'secret.txt'), 'outside the root')
    const past = new Date('2026-01-01T00:00:00Z')
    await utimes(join(publicDir, 'hello.txt'), past, past)
    if (process.platform !== 'win32') await symlink(join(dir, 'secret.txt'), join(publicDir, 'link.txt'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const withFiles = () => serve((app) => {
    app.get('/files/*path', (ctx) => ctx.file(ctx.params.path, { root: publicDir }))
    app.get('/raw', (ctx) => ctx.file(join(publicDir, 'hello.txt')))
    app.get('/typed', (ctx) => ctx.file(join(publicDir, 'hello.txt'), { media: 'text/x-custom' }))
    app.get('/missing', (ctx) => ctx.file(join(dir, 'nope.txt')))
  })

  it('serves a file with its type, length and validators', async () => {
    const server = await withFiles()
    try {
      const res = await fetch(`${server.url}/files/hello.txt`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.equal(res.headers.get('content-length'), String(content.length))
      assert.equal(res.headers.get('accept-ranges'), 'bytes')
      assert.match(res.headers.get('etag') ?? '', /^W\/"[0-9a-f]+-[0-9a-f]+"$/)
      assert.equal(res.headers.get('last-modified'), 'Thu, 01 Jan 2026 00:00:00 GMT')
      assert.equal(await res.text(), content)
    } finally {
      await server.close()
    }
  })

  it('answers a missing file with a 404 problem document, not a dropped connection', async () => {
    const server = await withFiles()
    try {
      const res = await fetch(`${server.url}/missing`)
      assert.equal(res.status, 404)
      assert.equal(res.headers.get('content-type'), 'application/problem+json; charset=utf-8')
      const problem = await res.json() as { code: string }
      assert.equal(problem.code, 'ZEN_NOT_FOUND')
    } finally {
      await server.close()
    }
  })

  it('refuses paths that escape the root, including through a symlink', async () => {
    const server = await withFiles()
    try {
      for (const path of ['/files/..%2Fsecret.txt', '/files/nested/..%2F..%2Fsecret.txt', '/files/%2E%2E/secret.txt']) {
        const res = await fetch(`${server.url}${path}`)
        assert.equal(res.status, 404, path)
        await res.text()
      }
      if (process.platform !== 'win32') {
        const res = await fetch(`${server.url}/files/link.txt`)
        assert.equal(res.status, 404, 'a symlink inside the root pointing outside it')
        await res.text()
      }
      const inside = await fetch(`${server.url}/files/nested/data.json`)
      assert.equal(inside.status, 200)
      assert.equal(inside.headers.get('content-type'), 'application/json; charset=utf-8')
      assert.equal(await inside.text(), '{"a":1}')
    } finally {
      await server.close()
    }
  })

  it('answers 404 for a directory', async () => {
    const server = await withFiles()
    try {
      const res = await fetch(`${server.url}/files/nested`)
      assert.equal(res.status, 404)
      await res.text()
    } finally {
      await server.close()
    }
  })

  it('revalidates with If-None-Match and If-Modified-Since (304)', async () => {
    const server = await withFiles()
    try {
      const first = await fetch(`${server.url}/raw`)
      const etag = first.headers.get('etag') ?? ''
      await first.text()

      const byTag = await fetch(`${server.url}/raw`, { headers: { 'if-none-match': etag } })
      assert.equal(byTag.status, 304)
      assert.equal(byTag.headers.get('etag'), etag)
      assert.equal(await byTag.text(), '')

      const byDate = await fetch(`${server.url}/raw`, { headers: { 'if-modified-since': 'Fri, 02 Jan 2026 00:00:00 GMT' } })
      assert.equal(byDate.status, 304)
      await byDate.text()

      const stale = await fetch(`${server.url}/raw`, { headers: { 'if-none-match': 'W/"other"' } })
      assert.equal(stale.status, 200, 'a different validator gets the file')
      await stale.text()
    } finally {
      await server.close()
    }
  })

  it('serves a single byte range (206) and refuses an unsatisfiable one (416)', async () => {
    const server = await withFiles()
    try {
      const head = await fetch(`${server.url}/raw`, { headers: { range: 'bytes=0-4' } })
      assert.equal(head.status, 206)
      assert.equal(head.headers.get('content-range'), `bytes 0-4/${content.length}`)
      assert.equal(head.headers.get('content-length'), '5')
      assert.equal(await head.text(), 'Hello')

      const tail = await fetch(`${server.url}/raw`, { headers: { range: 'bytes=-6' } })
      assert.equal(tail.status, 206)
      assert.equal(await tail.text(), content.slice(-6))

      const open = await fetch(`${server.url}/raw`, { headers: { range: `bytes=${content.length - 3}-` } })
      assert.equal(open.status, 206)
      assert.equal(await open.text(), content.slice(-3))

      const beyond = await fetch(`${server.url}/raw`, { headers: { range: `bytes=${content.length}-` } })
      assert.equal(beyond.status, 416)
      assert.equal(beyond.headers.get('content-range'), `bytes */${content.length}`)
      await beyond.text()

      const multi = await fetch(`${server.url}/raw`, { headers: { range: 'bytes=0-1,4-5' } })
      assert.equal(multi.status, 200, 'several ranges get the whole file (RFC 9110 §14.2 permits ignoring Range)')
      assert.equal(await multi.text(), content)

      const stale = await fetch(`${server.url}/raw`, { headers: { range: 'bytes=0-4', 'if-range': 'W/"old"' } })
      assert.equal(stale.status, 200, 'If-Range that does not match drops the range')
      await stale.text()
    } finally {
      await server.close()
    }
  })

  it('answers HEAD with the real length and no body', async () => {
    const server = await withFiles()
    try {
      const res = await fetch(`${server.url}/raw`, { method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-length'), String(content.length))
      assert.equal((await res.arrayBuffer()).byteLength, 0)
    } finally {
      await server.close()
    }
  })

  it('lets `media` override the extension', async () => {
    const server = await withFiles()
    try {
      const res = await fetch(`${server.url}/typed`)
      assert.equal(res.headers.get('content-type'), 'text/x-custom')
      await res.text()
    } finally {
      await server.close()
    }
  })

  it('maps common extensions', () => {
    assert.equal(mediaTypeFor('a/b/app.CSS'), 'text/css; charset=utf-8')
    assert.equal(mediaTypeFor('logo.png'), 'image/png')
    assert.equal(mediaTypeFor('font.woff2'), 'font/woff2')
    assert.equal(mediaTypeFor('archive.unknown'), 'application/octet-stream')
    assert.equal(mediaTypeFor('Makefile'), 'application/octet-stream')
  })
})

// ── §13.5, §30.2: server-sent events ────────────────────────────────────────

describe('server-sent events (§13.5)', () => {
  it('streams framed events with the headers that keep proxies out of the way', async () => {
    const server = await serve((app) => {
      app.get('/events', (ctx) => {
        const sse = ctx.sse({ retry: 2500, keepAlive: 0 })
        sse.send({ event: 'greeting', id: '1', data: { hello: 'world' } })
        sse.send({ data: 'two\nlines' })
        sse.close()
        return sse
      })
    })
    try {
      const res = await fetch(`${server.url}/events`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
      assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform')
      assert.equal(res.headers.get('x-accel-buffering'), 'no')
      assert.equal(res.headers.get('content-length'), null)
      assert.equal(
        await res.text(),
        'retry: 2500\n\n' +
          'event: greeting\nid: 1\ndata: {"hello":"world"}\n\n' +
          'data: two\ndata: lines\n\n',
      )
    } finally {
      await server.close()
    }
  })

  it('sends heartbeats while the stream is quiet', async () => {
    const server = await serve((app) => {
      app.get('/quiet', (ctx) => ctx.sse({ keepAlive: 20 }))
    })
    try {
      const { text } = await openAndDrop(`${server.url}/quiet`, (seen) => seen.split(': keep-alive').length > 2)
      assert.match(text, /^:\n\n: keep-alive\n\n: keep-alive/)
    } finally {
      await server.close()
    }
  })

  it('closes the channel and aborts ctx.signal when the client leaves — on a route with a deadline too', async () => {
    let channel: SseChannel | null = null
    let aborted: Promise<boolean> | null = null
    let timer: ReturnType<typeof setInterval> | undefined
    const server = await serve((app) => {
      app.get('/live', (ctx) => {
        const sse = ctx.sse({ keepAlive: 0 })
        channel = sse
        aborted = abortedWithin(ctx.signal, 2000)
        timer = setInterval(() => sse.send({ data: Date.now() }), 5)
        ctx.signal.addEventListener('abort', () => clearInterval(timer))
        return sse
      })
    }, { timeout: '5s' })
    try {
      await openAndDrop(`${server.url}/live`, (seen) => seen.includes('data:'))
      assert.ok(aborted !== null)
      assert.equal(await aborted, true, 'ctx.signal aborted — so the subscription above was released')
      await delay(20)
      assert.equal((channel as SseChannel | null)?.closed, true)
    } finally {
      // When the assertion above fails the abort never fired, and a live
      // interval would keep this test process from ever exiting.
      clearInterval(timer)
      await server.close()
    }
  })

  it('answers HEAD without a body and closes the channel', async () => {
    let channel: SseChannel | null = null
    const server = await serve((app) => {
      app.get('/events', (ctx) => {
        channel = ctx.sse()
        return channel
      })
    })
    try {
      const res = await fetch(`${server.url}/events`, { method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
      assert.equal((await res.arrayBuffer()).byteLength, 0)
      assert.equal((channel as SseChannel | null)?.closed, true)
    } finally {
      await server.close()
    }
  })

  it('ends open streams with a final `shutdown` event when the app closes (§30.2)', async () => {
    const server = await serve((app) => {
      app.get('/events', (ctx) => {
        const sse = ctx.sse({ keepAlive: 0 })
        sse.send({ data: 'hello' })
        return sse
      })
    }, { adapter: { shutdownTimeout: 10_000 } })

    const received = new Promise<string>((resolve) => {
      let text = ''
      const req = request(`${server.url}/events`, (res) => {
        res.on('data', (chunk) => { text += String(chunk) })
        res.on('end', () => resolve(text))
      })
      req.end()
    })
    await delay(50)
    const started = performance.now()
    await server.close()
    const elapsed = performance.now() - started

    assert.match(await received, /data: hello\n\nevent: shutdown\ndata: \n\n$/)
    assert.ok(elapsed < 5000, `close() finished in ${elapsed.toFixed(0)}ms rather than waiting out shutdownTimeout`)
  })
})

// ── §4.5 step 2: shutdown and keep-alive ────────────────────────────────────

describe('graceful shutdown and keep-alive connections (§4.5)', () => {
  it('does not wait out shutdownTimeout for connections a client is keeping alive', async () => {
    // A connection that finished a response just before close() began used to
    // sit idle until the client hung up — which a load balancer's upstream pool
    // never does — so close() ran into shutdownTimeout on every deploy.
    for (const kind of ['text', 'stream', 'file'] as const) {
      const server = await serve((app) => {
        app.get('/x', (ctx) =>
          kind === 'text' ? 'hi'
            : kind === 'stream' ? ctx.stream(async function* () { yield 'hi' })
            : ctx.file(fileURLToPath(import.meta.url)))
      }, { adapter: { shutdownTimeout: 4000 } })
      const res = await fetch(`${server.url}/x`)
      await res.text()
      const started = performance.now()
      await server.close()
      const elapsed = performance.now() - started
      assert.ok(elapsed < 1000, `${kind}: close() took ${elapsed.toFixed(0)}ms`)
    }
  })

  it('tells a request that is in flight when shutdown begins that its connection is closing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve })
    const server = await serve((app) => {
      app.get('/slow', async () => {
        entered()
        await gate
        return 'done'
      })
    }, { adapter: { shutdownTimeout: 4000 } })

    const pending = fetch(`${server.url}/slow`)
    await inside
    const closing = server.close()
    await delay(20)
    release()
    const res = await pending
    assert.equal(await res.text(), 'done', 'the in-flight request was allowed to finish')
    assert.equal(res.headers.get('connection'), 'close')
    const started = performance.now()
    await closing
    assert.ok(performance.now() - started < 1000)
  })
})

// ── §13.6: repeated headers ─────────────────────────────────────────────────

describe('repeated response headers (§13.6)', () => {
  it('keeps every value of a header produced by independent stagers', async () => {
    const server = await serve((app) => {
      app.hook('onRequest', (ctx) => { ctx.res.vary('origin') })
      app.get('/', (ctx) => {
        ctx.res.vary('accept')
        return 'ok'
      })
    })
    try {
      const res = await fetch(server.url)
      assert.equal(res.headers.get('vary'), 'origin, accept')
      await res.text()
    } finally {
      await server.close()
    }
  })
})

// ── listen() — the Express spelling, the signal, and the URL it reports ─────

describe('listen() (§1.2, §16.3)', () => {
  const bare = () => createApp({
    router: new ZenRouter(),
    pathParser: { parse: (path: string) => { const parsed = parsePath(path); return { path: parsed.path, segments: parsed.segments } } },
    adapter: nodeAdapter(),
    logger: new NoopLogger(),
    env: {},
  })

  it('takes a port number, as the five-line app of §1.2 writes it', async () => {
    // `app.listen(8080)` used to be spread into an options object as nothing,
    // so a JavaScript caller got the configured default port and no error.
    // The free port is found through the *options* form: probing with the
    // number form would share the defect under test, and both calls would
    // agree on the same wrong port — which is exactly how the negative control
    // for this test first came back NOT CAUGHT.
    const probe = bare()
    const taken = await probe.listen({ port: 0 })
    const port = taken.address?.port as number
    await probe.close()

    const app = bare()
    app.get('/', () => 'on the port that was asked for')
    const handle = await app.listen(port, '127.0.0.1')
    try {
      assert.equal(handle.address?.port, port)
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'on the port that was asked for')
    } finally {
      await app.close()
    }
  })

  it('shuts down gracefully when its signal aborts', async () => {
    // `ListenOptions.signal` was declared and read by nothing.
    const app = bare()
    app.get('/', () => 'up')
    const controller = new AbortController()
    const handle = await app.listen({ port: 0, signal: controller.signal })
    try {
      assert.equal(await (await fetch(handle.url)).text(), 'up')

      controller.abort()
      for (let i = 0; i < 50 && app.state !== 'stopped'; i++) await delay(10)
      assert.equal(app.state, 'stopped', 'the whole §4.5 sequence ran')
      await assert.rejects(fetch(handle.url), 'and nothing answers any more')
    } finally {
      // Idempotent, and the only thing standing between a failed assertion and
      // a server that keeps this test process alive forever.
      await app.close()
    }
  })

  it('refuses a signal that has already aborted, before binding anything', async () => {
    const app = bare()
    app.get('/', () => 'never')
    await assert.rejects(app.listen({ port: 0, signal: AbortSignal.abort() }))
    assert.equal(app.state, 'starting')
  })

  it('reports a usable URL for an IPv6 address', async () => {
    const app = bare()
    app.get('/', () => 'v6')
    let handle
    try {
      handle = await app.listen({ port: 0, host: '::1' })
    } catch {
      return // no IPv6 loopback on this machine — nothing to assert
    }
    try {
      assert.match(handle.url, /^http:\/\/\[::1\]:\d+$/)
      assert.equal(await (await fetch(handle.url)).text(), 'v6')
    } finally {
      await app.close()
    }
  })
})

// ── a client that leaves halfway through its own request ────────────────────

describe('a client that leaves mid-upload (§4.4)', () => {
  it('is reported as the client leaving, not logged as an application failure', async () => {
    // Node ends the body read with its own `aborted` / ECONNRESET error, which
    // used to reach the error engine as an unknown throwable: a 500, logged at
    // `error`, for every upload a user cancelled.
    const logger = capturingLogger()
    const server = await serve((app) => {
      app.post('/upload', { body: anyBody }, (ctx) => ({ received: typeof ctx.body }))
    }, { logger })
    try {
      for (let round = 0; round < 3; round++) {
        await new Promise<void>((resolve) => {
          const req = request(`${server.url}/upload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': '100000' },
          })
          req.on('error', () => {})
          req.write(`{"payload":"${'x'.repeat(4096)}`)
          setTimeout(() => { req.destroy(); resolve() }, 30)
        })
        await delay(40)
      }
      assert.deepEqual(logger.errors, [], 'a cancelled upload is not the application failing')
    } finally {
      await server.close()
    }
  })
})

// ── §14.1: what this adapter says it can do ──────────────────────────────────

describe('capabilities (§14.1, §14.2)', () => {
  it('claims no compression and no WebSocket, because it implements neither', () => {
    assert.equal(NODE_CAPABILITIES.compression, 'none')
    assert.equal(NODE_CAPABILITIES.websocket, 'none')
    assert.equal(NODE_CAPABILITIES.fs, true)
  })

  it('is what Plugin.requires is checked against, with no caps option', async () => {
    const realtime = definePlugin({ name: 'realtime', version: '1.0.0', requires: { websocket: 'library' }, setup() {} })
    const app = createApp({
      router: new ZenRouter(),
      pathParser: { parse: (p: string) => ({ path: parsePath(p).path, segments: parsePath(p).segments }) },
      logger: new NoopLogger(),
      adapter: nodeAdapter(),
    }).use(realtime)
    app.get('/', () => 'ok')
    await assert.rejects(() => app.ready(), (error: unknown) => {
      assert.ok(error instanceof BootError)
      assert.equal(error.diagnostics[0]?.code, 'ZEN_CAPABILITY_UNAVAILABLE')
      return true
    })
  })
})
