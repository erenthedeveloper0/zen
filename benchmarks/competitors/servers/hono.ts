/**
 * Hono 4 on Node through `@hono/node-server`, idiomatically: `c.json()`,
 * `app.use(path, …)` middleware, and Zod called in the handler (Hono's own
 * validator is a separate package, `@hono/zod-validator`, which wraps the same
 * `safeParse`).
 *
 * Hono has no response schemas, so workload 2 and 6 pick the declared fields
 * by hand — what an application on Hono that must not send `passwordHash` does.
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import {
  USER_ROW, Order, Search, RATE_LIMIT, publicUser, priceOrder, verifyBearer, fixedWindow, findUsers, ready, workloadArg,
} from '../shared.ts'

const workload = workloadArg()
const app = new Hono()

switch (workload) {
  case 1:
    app.get('/w1', (c) => c.json({ hello: 'world' }))
    break
  case 2:
    app.get('/w2', (c) => c.json(publicUser(USER_ROW)))
    break
  case 3:
    app.get('/w3/:a/:b/:c/:d/:e', (c) => c.json({
      a: c.req.param('a'), b: c.req.param('b'), c: c.req.param('c'), d: c.req.param('d'), e: c.req.param('e'),
    }))
    break
  case 4:
    app.post('/w4', async (c) => {
      const parsed = Order.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ error: 'invalid order' }, 400)
      return c.json(priceOrder(parsed.data))
    })
    break
  case 5:
    for (let i = 0; i < 10; i++) app.use('/w5', async (_c, next) => { await next() })
    app.get('/w5', (c) => c.json({ ok: true }))
    break
  case 6: {
    const limited = fixedWindow(RATE_LIMIT, 60_000)
    app.use('/w6', async (c, next) => {
      if (verifyBearer(c.req.header('authorization')) === null) return c.json({ error: 'unauthorized' }, 401)
      await next()
      return undefined
    })
    app.use('/w6', async (c, next) => {
      if (!limited(getConnInfo(c).remote.address ?? '')) return c.json({ error: 'rate limited' }, 429)
      await next()
      return undefined
    })
    app.post('/w6', async (c) => {
      const parsed = Search.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ error: 'invalid search' }, 400)
      const rows = await findUsers(parsed.data.limit)
      return c.json({ users: rows.map(publicUser), count: rows.length })
    })
    break
  }
}

serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => ready(info.port))
