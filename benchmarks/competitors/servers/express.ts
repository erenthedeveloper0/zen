/**
 * Express 5, idiomatically: `res.json()`, `express.json()` on the routes that
 * read a body, route-level middleware arrays, and Express's defaults left as
 * they are — `X-Powered-By` and the weak `ETag` it computes for every `res.json`
 * body are part of what an Express application pays.
 *
 * Express has no response schemas, so workloads 2 and 6 pick the declared
 * fields by hand, as an Express application that must not send `passwordHash`
 * does.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import {
  USER_ROW, Order, Search, RATE_LIMIT, publicUser, priceOrder, verifyBearer, fixedWindow, findUsers, ready, workloadArg,
} from '../shared.ts'

const workload = workloadArg()
const app = express()

const pass = (_req: Request, _res: Response, next: NextFunction): void => next()

switch (workload) {
  case 1:
    app.get('/w1', (_req, res) => { res.json({ hello: 'world' }) })
    break
  case 2:
    app.get('/w2', (_req, res) => { res.json(publicUser(USER_ROW)) })
    break
  case 3:
    app.get('/w3/:a/:b/:c/:d/:e', (req, res) => {
      const p = req.params
      res.json({ a: p['a'], b: p['b'], c: p['c'], d: p['d'], e: p['e'] })
    })
    break
  case 4:
    app.post('/w4', express.json(), (req, res) => {
      const parsed = Order.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid order' })
        return
      }
      res.json(priceOrder(parsed.data))
    })
    break
  case 5:
    app.get('/w5', ...Array.from({ length: 10 }, () => pass), (_req: Request, res: Response) => { res.json({ ok: true }) })
    break
  case 6: {
    const limited = fixedWindow(RATE_LIMIT, 60_000)
    const auth = (req: Request, res: Response, next: NextFunction): void => {
      if (verifyBearer(req.headers.authorization) === null) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      next()
    }
    const limit = (req: Request, res: Response, next: NextFunction): void => {
      if (!limited(req.ip ?? '')) {
        res.status(429).json({ error: 'rate limited' })
        return
      }
      next()
    }
    app.post('/w6', auth, limit, express.json(), async (req, res) => {
      const parsed = Search.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid search' })
        return
      }
      const rows = await findUsers(parsed.data.limit)
      res.json({ users: rows.map(publicUser), count: rows.length })
    })
    break
  }
}

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address()
  ready(typeof address === 'object' && address !== null ? address.port : 0)
})
