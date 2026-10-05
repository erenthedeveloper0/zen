import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, healthPlugin, NoopLogger, slot, token } from '@erenthedeveloper0/zen-core'
import { ZenRouter } from '@erenthedeveloper0/zen-router'
import { nodeAdapter } from '@erenthedeveloper0/zen-adapter-node'
import { makeApp, pathParser, uniqueName } from './helpers.ts'

/**
 * §20.7 items 1 and 2 — the two properties a long-running server is judged on
 * and no other suite checked: nothing the framework opens outlives the
 * application, and nothing one request writes is visible to another.
 *
 * Neither shows up in a unit test that passes. A leaked deadline timer or a
 * heartbeat that is never cleared is a process that will not exit and a heap
 * that grows by one closure per request; a slot shared across requests is a
 * user reading another user's session under load and never in a test that
 * sends one request at a time.
 */

/** The process's live resources, by type, counted. */
function resources(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) ?? 0) + 1)
  return counts
}

/** One request on its own connection, so the client keeps no socket alive. */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A wait the request's signal cuts short, the way a well-behaved handler waits. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** What `now` holds beyond `baseline` — the leak, if there is one. */
function grown(baseline: Map<string, number>, now: Map<string, number>): Record<string, number> {
  const extra: Record<string, number> = {}
  for (const [type, count] of now) {
    const more = count - (baseline.get(type) ?? 0)
    if (more > 0) extra[type] = more
  }
  return extra
}

/**
 * Resources close on later turns, so this waits up to a second for the extra
 * to drain. Only growth counts: the baseline can hold something transient of
 * its own — the test's file setup closing a handle — that finishes meanwhile.
 */
async function leakedSince(baseline: Map<string, number>): Promise<Record<string, number>> {
  const deadline = Date.now() + 1000
  let extra = grown(baseline, resources())
  while (Object.keys(extra).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    extra = grown(baseline, resources())
  }
  return extra
}

describe('no handle outlives the application (§20.7 item 1)', () => {
  let dir = ''
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zen-leaks-'))
    await writeFile(join(dir, 'a.txt'), 'a file on disk\n')
  })
  after(async () => { await rm(dir, { recursive: true, force: true }) })

  it('listen, SSE, a deadline kept and one blown, a file, a health probe, close() — and nothing is left open', async () => {
    const before = resources()

    const app = createApp({ router: new ZenRouter(), pathParser, adapter: nodeAdapter(), logger: new NoopLogger(), env: {} })
    app.get('/events', (ctx) => {
      const sse = ctx.sse({ keepAlive: 5 })
      sse.send({ data: 'one' })
      setTimeout(() => { sse.send({ data: 'two' }); sse.close() }, 25)
      return sse
    })
    // Long on purpose: a deadline timer left armed after its request, or a
    // handler wait the blown deadline failed to cut short, outlives the drain
    // window below and is counted, instead of firing quietly before it ends.
    app.get('/in-time', { timeout: '60s' }, async (ctx) => { await pause(5, ctx.signal); return 'in time' })
    app.get('/too-slow', { timeout: '20ms' }, async (ctx) => { await pause(60_000, ctx.signal); return 'late' })
    app.get('/file', (ctx) => ctx.file(join(dir, 'a.txt')))
    app.get('/json', () => ({ ok: true }))
    // A probe's budget is the one timer that holds the loop open on purpose
    // (§31.4: an idle process must wait for the report), so it is the one a
    // missing disarm would leave behind. Long, for the reason above.
    app.health('db', async () => ({ status: 'pass' }), { timeout: '10s' })
    app.use(healthPlugin, { path: '/healthz', readiness: '/readyz' })

    const handle = await app.listen({ port: 0 })
    const events = await get(`${handle.url}/events`)
    assert.match(events.body, /data: one\n\n[\s\S]*data: two\n\n/)
    assert.equal((await get(`${handle.url}/in-time`)).body, 'in time')
    assert.equal((await get(`${handle.url}/too-slow`)).status, 504)
    assert.equal((await get(`${handle.url}/file`)).body, 'a file on disk\n')
    assert.equal((await get(`${handle.url}/readyz`)).status, 200)
    const many = await Promise.all(Array.from({ length: 20 }, () => get(`${handle.url}/json`)))
    assert.ok(many.every((res) => res.status === 200))
    await app.close()

    assert.deepEqual(await leakedSince(before), {}, 'resources the application opened and did not close')
  })
})

describe("no request sees another request's state (§20.7 item 2)", () => {
  it('500 interleaved requests read back exactly what they wrote, across awaits, on plain and deadline routes', async () => {
    const Mine = slot<string>(uniqueName('leaks.mine'))
    const FromHook = slot<string>(uniqueName('leaks.hook'))
    const Scoped = token<{ serial: number }>(uniqueName('leaks.scoped'))

    let serial = 0
    const app = makeApp()
    app.provide(Scoped, { lifetime: 'scoped', factory: () => ({ serial: ++serial }) })
    app.hook('onRequest', async (ctx) => {
      const id = (ctx.query as { id: string }).id
      ctx.set(FromHook, `hook-${id}`)
      await new Promise((resolve) => setTimeout(resolve, Number(id) % 3))
    })
    const handler = async (ctx: { query: unknown; set: Function; get: Function; resolve: Function; resolveAsync: Function; id: string }) => {
      const id = (ctx.query as { id: string }).id
      ctx.set(Mine, id)
      await new Promise((resolve) => setTimeout(resolve, (Number(id) * 7) % 5))
      const first = await ctx.resolveAsync(Scoped)
      await new Promise((resolve) => setTimeout(resolve, Number(id) % 2))
      const again = ctx.resolve(Scoped)
      return { id, mine: ctx.get(Mine), hook: ctx.get(FromHook), serial: first.serial, same: first === again, requestId: ctx.id }
    }
    app.get('/plain', handler as never)
    app.get('/deadline', { timeout: '5s' }, handler as never)

    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) => app.inject('GET', `/${i % 2 === 0 ? 'plain' : 'deadline'}?id=${i}`)),
    )
    const ids = new Set<string>()
    const serials = new Set<number>()
    for (const [i, res] of results.entries()) {
      assert.equal(res.status, 200, `request ${i}: ${res.text()}`)
      const body = res.json<{ id: string; mine: string; hook: string; serial: number; same: boolean; requestId: string }>()
      assert.deepEqual(
        { id: body.id, mine: body.mine, hook: body.hook, same: body.same },
        { id: String(i), mine: String(i), hook: `hook-${i}`, same: true },
        `request ${i} read another request's state`,
      )
      ids.add(body.requestId)
      serials.add(body.serial)
    }
    assert.equal(ids.size, 500, 'every request has its own id')
    assert.equal(serials.size, 500, 'every request has its own scoped instance')
  })
})
