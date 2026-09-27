import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSseChannel, isSseChannel, frameOf, finalize, PlainContext, CodeGen, compileContext,
  NoopLogger, ZenContainer, DEFAULT_CAPABILITIES, type SseChannel, type RawRequest,
} from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

const decoder = new TextDecoder()

/** Drain what a channel has produced so far, without waiting for more. */
async function drain(channel: SseChannel, frames: number): Promise<string> {
  const iterator = channel[Symbol.asyncIterator]()
  let text = ''
  for (let i = 0; i < frames; i++) {
    const step = await iterator.next()
    if (step.done === true) break
    text += decoder.decode(step.value)
  }
  return text
}

async function readAll(channel: SseChannel): Promise<string> {
  let text = ''
  for await (const frame of channel) text += decoder.decode(frame)
  return text
}

describe('SSE framing (§13.5)', () => {
  it('writes event, id and retry fields, then one data line per line of payload', () => {
    assert.equal(
      frameOf({ event: 'update', id: '42', retry: 1000, data: 'first\nsecond\r\nthird' }),
      'event: update\nid: 42\nretry: 1000\ndata: first\ndata: second\ndata: third\n\n',
    )
  })

  it('JSON-encodes structured data onto a single line', () => {
    assert.equal(frameOf({ data: { text: 'a\nb', n: 1 } }), 'data: {"text":"a\\nb","n":1}\n\n')
  })

  it('writes an empty data line for undefined data, so the event still dispatches', () => {
    assert.equal(frameOf({ event: 'ping', data: undefined }), 'event: ping\ndata: \n\n')
  })

  it('refuses a line break in `event` or `id` rather than letting it forge a second field', () => {
    assert.throws(() => frameOf({ event: 'a\ndata: forged', data: 1 }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => frameOf({ id: '1\r2', data: 1 }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => frameOf({ id: 'a\u0000b', data: 1 }), { code: 'ZEN_HEADER_INVALID' })
    assert.throws(() => frameOf({ retry: -1, data: 1 }))
  })
})

describe('the SSE channel', () => {
  it('opens with a comment frame so the status line flushes before the first event', async () => {
    const channel = createSseChannel({ keepAlive: 0 })
    assert.equal(await drain(channel, 1), ':\n\n')
  })

  it('leads with the retry frame when one is set, instead of the comment', async () => {
    const channel = createSseChannel({ retry: 5000, keepAlive: 0 })
    channel.send({ data: 'x' })
    assert.equal(await drain(channel, 2), 'retry: 5000\n\ndata: x\n\n')
  })

  it('delivers what was sent before close(), then ends', async () => {
    const channel = createSseChannel({ keepAlive: 0 })
    channel.send({ data: 'one' })
    channel.comment('two')
    channel.close()
    assert.equal(channel.closed, true)
    assert.equal(await readAll(channel), 'data: one\n\n: two\n\n')
  })

  it('ignores send() after close, so a subscriber outliving its client cannot throw', () => {
    const channel = createSseChannel({ keepAlive: 0 })
    channel.close()
    assert.doesNotThrow(() => channel.send({ data: 'late' }))
    assert.doesNotThrow(() => channel.comment('late'))
  })

  it('closes when the reader stops — which is how a disconnect reaches it', async () => {
    const channel = createSseChannel({ keepAlive: 0 })
    const iterator = channel[Symbol.asyncIterator]()
    await iterator.next()
    const pending = iterator.next()
    await iterator.return?.()
    assert.equal(channel.closed, true)
    assert.deepEqual(await pending, { done: true, value: undefined }, 'a reader waiting on the next frame is released')
  })

  it('closes a stream whose reader has fallen further behind than maxBuffered', () => {
    const channel = createSseChannel({ keepAlive: 0, maxBuffered: 64 })
    channel.send({ data: 'x'.repeat(40) })
    assert.equal(channel.closed, false)
    channel.send({ data: 'y'.repeat(40) })
    assert.equal(channel.closed, true, 'the second frame would have held 96 bytes for a client that is not reading')
  })

  it('starts heartbeats only once something reads — an unconsumed channel owns no timer', async () => {
    const unread = createSseChannel({ keepAlive: 5 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    unread.close()
    assert.equal(await readAll(unread), '', 'nothing was queued while nobody was reading')

    // The heartbeat timer is unref'd on purpose — a stream is not a reason for
    // the process to stay up, its socket is. Here there is no socket, so stand
    // one in for the wait: without it Node 22's runner sees an empty event loop
    // and cancels this test and every one after it in the file.
    const socket = setTimeout(() => {}, 5_000)
    try {
      const read = createSseChannel({ keepAlive: 5 })
      const iterator = read[Symbol.asyncIterator]()
      assert.equal(decoder.decode((await iterator.next()).value as Uint8Array), ':\n\n')
      assert.equal(decoder.decode((await iterator.next()).value as Uint8Array), ': keep-alive\n\n')
      read.close()
    } finally {
      clearTimeout(socket)
    }
  })

  it('can be consumed once', () => {
    const channel = createSseChannel({ keepAlive: 0 })
    channel[Symbol.asyncIterator]()
    assert.throws(() => channel[Symbol.asyncIterator]())
  })

  it('carries a reply with the event-stream headers', () => {
    const channel = createSseChannel()
    const reply = channel.$reply
    assert.equal(reply.status, 200)
    assert.equal(reply.body.kind, 'sse')
    assert.equal(reply.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(reply.headers.get('cache-control'), 'no-cache, no-transform')
    assert.equal(reply.headers.get('x-accel-buffering'), 'no')
    channel.close()
  })

  it('validates its options', () => {
    assert.throws(() => createSseChannel({ keepAlive: -1 }))
    assert.throws(() => createSseChannel({ maxBuffered: 1.5 }))
    assert.throws(() => createSseChannel({ retry: Number.NaN }))
  })
})

describe('ctx.sse() on both context twins (I2, I6)', () => {
  // The defect this closes: `sse()` was on the public `BaseContext` type and on
  // neither class, so it type-checked and threw `ctx.sse is not a function`.
  const raw: RawRequest = {
    method: 'GET',
    url: '/events',
    header: () => undefined,
    headerNames: () => [],
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '127.0.0.1', port: 0, family: 'IPv4' },
    native: null,
  }
  const env = { log: new NoopLogger(), maxQueryParams: 100, trustProxy: false, container: new ZenContainer(), config: {} }

  it('exists on PlainContext and on the generated class, and returns a channel', () => {
    const Compiled = compileContext({ decorations: [], slotCount: 0, codegen: new CodeGen({ caps: DEFAULT_CAPABILITIES }) })
    const contexts = [
      new PlainContext(raw, null, {}, env, 0, new AbortController().signal),
      new Compiled(raw, null, {}, env, new AbortController().signal),
    ]
    for (const ctx of contexts) {
      const channel = (ctx as unknown as { sse(init?: object): SseChannel }).sse({ keepAlive: 0 })
      assert.ok(isSseChannel(channel), ctx.constructor.name)
      channel.close()
    }
  })

  it('finalize() turns a returned channel into its reply, not an octet-stream', () => {
    const channel = createSseChannel({ keepAlive: 0 })
    const reply = finalize(channel)
    assert.equal(reply, channel.$reply)
    assert.equal(reply.body.kind, 'sse')
    channel.close()
  })
})

describe('SSE through the pipeline', () => {
  it('a handler returning ctx.sse() produces an event-stream reply', async () => {
    const app = makeApp()
    app.get('/events', (ctx) => {
      const sse = ctx.sse({ keepAlive: 0 })
      sse.send({ event: 'hello', data: { n: 1 } })
      sse.close()
      return sse
    })
    const res = await app.inject('GET', '/events')
    assert.equal(res.status, 200)
    assert.equal(res.header('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(res.header('content-length'), undefined, 'a stream has no length')
    assert.equal(res.reply.body.kind, 'sse')
    const body = res.reply.body as { channel: SseChannel }
    assert.equal(await readAll(body.channel), 'event: hello\ndata: {"n":1}\n\n')
  })

  it('a HEAD request drops the stream and closes the channel', async () => {
    let channel: SseChannel | null = null
    const app = makeApp()
    app.get('/events', (ctx) => {
      channel = ctx.sse({ keepAlive: 0 })
      return channel
    })
    const res = await app.inject('HEAD', '/events')
    assert.equal(res.status, 200)
    assert.equal(res.reply.body.kind, 'empty')
    assert.equal((channel as SseChannel | null)?.closed, true)
  })
})
