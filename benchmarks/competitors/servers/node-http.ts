/**
 * The baseline — a hand-written `http.createServer` handler doing each job.
 *
 * rfcs/0001 §1.4: "Zen's per-request work should be within noise of a
 * hand-written `http.createServer` handler that does the same job." This is
 * that handler, written the way a careful person writes one with no framework:
 * a branch on method and path, `JSON.stringify`, a body read with a size limit,
 * and the shared Zod schemas and helpers every other server uses.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  USER_ROW, Order, Search, RATE_LIMIT, publicUser, priceOrder, verifyBearer, fixedWindow, findUsers, ready, workloadArg,
} from '../shared.ts'

const workload = workloadArg()

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const notFound = (res: ServerResponse): void => send(res, 404, { error: 'not found' })

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function parseJson(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req))
  } catch {
    return undefined
  }
}

const pathOf = (url: string | undefined): string => {
  const raw = url ?? '/'
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

/** Ten middleware that each continue — the shape of workload 5, without a framework to run them. */
const middleware: Array<(req: IncomingMessage) => void> = Array.from({ length: 10 }, () => (_req: IncomingMessage) => {})

const limited = fixedWindow(RATE_LIMIT, 60_000)

const handlers: Record<number, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {
  1: (req, res) => {
    if (req.method === 'GET' && pathOf(req.url) === '/w1') send(res, 200, { hello: 'world' })
    else notFound(res)
  },
  2: (req, res) => {
    if (req.method === 'GET' && pathOf(req.url) === '/w2') send(res, 200, publicUser(USER_ROW))
    else notFound(res)
  },
  3: (req, res) => {
    const parts = pathOf(req.url).split('/')
    if (req.method !== 'GET' || parts.length !== 7 || parts[1] !== 'w3') return notFound(res)
    const [, , a, b, c, d, e] = parts.map((p) => decodeURIComponent(p))
    send(res, 200, { a, b, c, d, e })
  },
  4: async (req, res) => {
    if (req.method !== 'POST' || pathOf(req.url) !== '/w4') return notFound(res)
    const parsed = Order.safeParse(await parseJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid order' })
    send(res, 200, priceOrder(parsed.data))
  },
  5: (req, res) => {
    if (req.method !== 'GET' || pathOf(req.url) !== '/w5') return notFound(res)
    for (const step of middleware) step(req)
    send(res, 200, { ok: true })
  },
  6: async (req, res) => {
    if (req.method !== 'POST' || pathOf(req.url) !== '/w6') return notFound(res)
    if (verifyBearer(req.headers.authorization) === null) return send(res, 401, { error: 'unauthorized' })
    if (!limited(req.socket.remoteAddress ?? '')) return send(res, 429, { error: 'rate limited' })
    const parsed = Search.safeParse(await parseJson(req))
    if (!parsed.success) return send(res, 400, { error: 'invalid search' })
    const rows = await findUsers(parsed.data.limit)
    send(res, 200, { users: rows.map(publicUser), count: rows.length })
  },
}

const handle = handlers[workload] as (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
// A promise only where the handler made one: the baseline must not pay for
// machinery the synchronous workloads do not need.
const server = createServer((req, res) => {
  const pending = handle(req, res)
  if (pending !== undefined) pending.catch(() => send(res, 500, { error: 'internal' }))
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  ready(typeof address === 'object' && address !== null ? address.port : 0)
})
