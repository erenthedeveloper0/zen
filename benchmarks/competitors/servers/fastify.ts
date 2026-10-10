/**
 * Fastify 5, idiomatically: async handlers that return values, a JSON Schema
 * response contract compiled by fast-json-stringify, route-level hooks for the
 * middleware workloads, and no logger (Fastify's default).
 *
 * Workloads 4 and 6 validate with Zod in the handler, as every server here
 * does: Annex C's row 4 is "POST + body validation (Zod)", and Fastify has no
 * built-in Standard Schema path. A Fastify application validating with JSON
 * Schema and Ajv would be a different workload, not a fairer version of this one.
 */
import Fastify, { type FastifyReply, type FastifyRequest, type HookHandlerDoneFunction } from 'fastify'
import {
  USER_ROW, Order, Search, RATE_LIMIT, PUBLIC_USER_JSON_SCHEMA, USER_LIST_JSON_SCHEMA,
  priceOrder, verifyBearer, fixedWindow, findUsers, ready, workloadArg,
} from '../shared.ts'

const workload = workloadArg()
const app = Fastify({ logger: false })

const pass = (_req: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void => done()

switch (workload) {
  case 1:
    app.get('/w1', async () => ({ hello: 'world' }))
    break
  case 2:
    app.get('/w2', { schema: { response: { 200: PUBLIC_USER_JSON_SCHEMA } } }, async () => USER_ROW)
    break
  case 3:
    app.get<{ Params: { a: string; b: string; c: string; d: string; e: string } }>('/w3/:a/:b/:c/:d/:e', async (req) => {
      const p = req.params
      return { a: p.a, b: p.b, c: p.c, d: p.d, e: p.e }
    })
    break
  case 4:
    app.post('/w4', async (req, reply) => {
      const parsed = Order.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid order' })
      return priceOrder(parsed.data)
    })
    break
  case 5:
    app.get('/w5', { onRequest: Array.from({ length: 10 }, () => pass) }, async () => ({ ok: true }))
    break
  case 6: {
    const limited = fixedWindow(RATE_LIMIT, 60_000)
    app.post('/w6', {
      schema: { response: { 200: USER_LIST_JSON_SCHEMA } },
      onRequest: [
        (req, reply, done) => {
          if (verifyBearer(req.headers.authorization) === null) {
            void reply.code(401).send({ error: 'unauthorized' })
            return
          }
          done()
        },
        (req, reply, done) => {
          if (!limited(req.ip)) {
            void reply.code(429).send({ error: 'rate limited' })
            return
          }
          done()
        },
      ],
    }, async (req, reply) => {
      const parsed = Search.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid search' })
      const rows = await findUsers(parsed.data.limit)
      return { users: rows, count: rows.length }
    })
    break
  }
}

await app.listen({ port: 0, host: '127.0.0.1' })
const address = app.server.address()
ready(typeof address === 'object' && address !== null ? address.port : 0)
