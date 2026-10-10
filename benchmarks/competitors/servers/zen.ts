/**
 * Zen, written the way its README teaches: plain functions, schemas as the
 * contract, `app.use` for middleware, the first-party rate limiter.
 *
 * Deliberately no `markSync()`. None of the examples use it and nobody writing
 * an application from the README would, so a number that depended on it would
 * describe an application nobody writes.
 */
import { z } from 'zod'
import { zen, NoopLogger, registerSchemaConverter, rateLimit, slot } from '@erenthedeveloper0/zen'
import {
  USER_ROW, PublicUser, Order, Search, UserList, RATE_LIMIT, priceOrder, verifyBearer, findUsers, ready, workloadArg,
} from '../shared.ts'

registerSchemaConverter('zod', (schema, io) => z.toJSONSchema(schema as z.ZodType, { io }))

const workload = workloadArg()
const app = zen({ logger: new NoopLogger(), lifecycle: false })

const CurrentUser = slot<{ sub: string }>('bench.user')

switch (workload) {
  case 1:
    app.get('/w1', () => ({ hello: 'world' }))
    break
  case 2:
    app.get('/w2', { response: { 200: PublicUser } }, () => USER_ROW)
    break
  case 3:
    app.get('/w3/:a/:b/:c/:d/:e', (ctx) => ({
      a: ctx.params.a, b: ctx.params.b, c: ctx.params.c, d: ctx.params.d, e: ctx.params.e,
    }))
    break
  case 4:
    app.post('/w4', { body: Order }, (ctx) => priceOrder(ctx.body))
    break
  case 5:
    for (let i = 0; i < 10; i++) app.use(() => {})
    app.get('/w5', () => ({ ok: true }))
    break
  case 6:
    app.use((ctx) => {
      const user = verifyBearer(ctx.headers['authorization'])
      if (user === null) return ctx.json({ error: 'unauthorized' }, { status: 401 })
      ctx.set(CurrentUser, user)
      return undefined
    })
    app.use(rateLimit({ limit: RATE_LIMIT, window: '1m' }))
    app.post('/w6', { body: Search, response: { 200: UserList } }, async (ctx) => {
      const rows = await findUsers(ctx.body.limit)
      return { users: rows, count: rows.length }
    })
    break
}

const handle = await app.listen({ port: 0, host: '127.0.0.1' })
ready(handle.address.port)
