/**
 * What every server in this comparison shares — written once, so that the work
 * each framework is timed doing is the same work.
 *
 * Annex C's rule is that a competitor app is written idiomatically, and a
 * benchmark where one side does more than the other measures the difference in
 * the job rather than in the framework. So everything that is not the
 * framework's own business lives here: the payloads, the Zod schemas, the JWT
 * check and the stub database. Where a framework has a built-in way to do part
 * of a workload — a response schema, a rate limiter — its server uses it, and
 * the run's notes say so.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

// ── workload 2: a stored row with fields that must never be sent ────────────

export const USER_ROW = {
  id: 42,
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  role: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  passwordHash: '$2b$12$benchmark.hash.never.sent',
  internalNotes: 'never sent',
}

/** The declared contract, as a Zod schema (Zen) and as JSON Schema (Fastify). */
export const PublicUser = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  createdAt: z.string(),
})

export const PUBLIC_USER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    createdAt: { type: 'string' },
  },
  required: ['id', 'name', 'email', 'role', 'createdAt'],
  additionalProperties: false,
} as const

/** What a framework without response schemas does by hand: pick the declared fields. */
export function publicUser(row: typeof USER_ROW): z.infer<typeof PublicUser> {
  return { id: row.id, name: row.name, email: row.email, role: row.role, createdAt: row.createdAt }
}

// ── workload 4: a ~1 KB order, validated with Zod ───────────────────────────

export const Order = z.object({
  customerId: z.number().int().positive(),
  currency: z.enum(['EUR', 'USD', 'GBP']),
  items: z.array(z.object({
    sku: z.string().min(1).max(32),
    qty: z.number().int().min(1).max(100),
    price: z.number().nonnegative(),
  })).min(1).max(100),
  note: z.string().max(500).optional(),
})

export type OrderInput = z.infer<typeof Order>

export const ORDER_BODY = JSON.stringify({
  customerId: 1234,
  currency: 'EUR',
  items: Array.from({ length: 12 }, (_, i) => ({ sku: `SKU-${1000 + i}`, qty: 1 + (i % 4), price: 9.5 + i })),
  note: 'Leave at the reception desk. The building has two entrances; use the one on the north side, please.',
})

/** The handler's job, identical everywhere: sum the order. */
export function priceOrder(order: OrderInput): { ok: true; items: number; total: number } {
  let total = 0
  for (const item of order.items) total += item.qty * item.price
  return { ok: true, items: order.items.length, total: Math.round(total * 100) / 100 }
}

// ── workload 6: JWT → rate limit → validate → 5 ms "DB" → 2 kB response ─────

const JWT_KEY = Buffer.from('benchmark-only-hs256-key-of-32-bytes!', 'utf8')

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** HS256, `{ sub, exp }` — the token every workload-6 request carries. */
export function signJwt(payload: Record<string, unknown>): string {
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', JWT_KEY).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${signature}`
}

export const JWT = signJwt({ sub: 'user-42', exp: 4_102_444_800 })

/** The same verification in every server: algorithm pinned, signature compared in constant time, expiry checked. */
export function verifyBearer(header: string | undefined): { sub: string } | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null
  const token = header.slice(7)
  const first = token.indexOf('.')
  const second = token.indexOf('.', first + 1)
  if (first === -1 || second === -1) return null
  const expected = createHmac('sha256', JWT_KEY).update(token.slice(0, second)).digest()
  const given = Buffer.from(token.slice(second + 1), 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const header0 = JSON.parse(Buffer.from(token.slice(0, first), 'base64url').toString('utf8')) as { alg?: unknown }
    if (header0.alg !== 'HS256') return null
    const payload = JSON.parse(Buffer.from(token.slice(first + 1, second), 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown }
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    return { sub: payload.sub }
  } catch {
    return null
  }
}

/**
 * A fixed-window counter keyed by client — the algorithm Zen's own
 * `rateLimit()` store uses, for the frameworks whose rate limiter is a separate
 * package. The limit is set far above anything a run sends: the workload times
 * the counting, not the refusing.
 */
export function fixedWindow(limit: number, windowMs: number): (key: string) => boolean {
  let window = Math.floor(Date.now() / windowMs)
  let counts = new Map<string, number>()
  return (key) => {
    const now = Math.floor(Date.now() / windowMs)
    if (now !== window) {
      window = now
      counts = new Map()
    }
    const next = (counts.get(key) ?? 0) + 1
    counts.set(key, next)
    return next <= limit
  }
}

export const RATE_LIMIT = 1_000_000_000

export const Search = z.object({
  query: z.string().min(1).max(100),
  limit: z.number().int().min(1).max(10),
})

export const SEARCH_BODY = JSON.stringify({ query: 'lovelace', limit: 10 })

/** The stub database: 5 ms of latency, then ten rows of ~200 bytes each — a ~2 kB response. */
export async function findUsers(limit: number): Promise<Array<typeof USER_ROW>> {
  await new Promise((resolve) => setTimeout(resolve, 5))
  return Array.from({ length: limit }, (_, i) => ({
    ...USER_ROW,
    id: i + 1,
    name: `Ada Lovelace the ${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}`,
    email: `ada${i + 1}@analytical-engine.example`,
  }))
}

export const UserList = z.object({ users: z.array(PublicUser), count: z.number().int() })

export const USER_LIST_JSON_SCHEMA = {
  type: 'object',
  properties: {
    users: { type: 'array', items: PUBLIC_USER_JSON_SCHEMA },
    count: { type: 'integer' },
  },
  required: ['users', 'count'],
  additionalProperties: false,
} as const

// ── how a server announces itself to the harness ────────────────────────────

/**
 * One line on stdout once the server is accepting: its port, and how long the
 * process took to get there (module loading, registration and — for Zen —
 * compilation; `performance.now()` counts from process start).
 */
export function ready(port: number): void {
  process.stdout.write(`READY ${JSON.stringify({ port, bootMs: Math.round(performance.now() * 10) / 10 })}\n`)
}

export function workloadArg(): number {
  const n = Number(process.argv[2])
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    process.stderr.write('usage: node servers/<name>.ts <workload 1-6>\n')
    process.exit(2)
  }
  return n
}
