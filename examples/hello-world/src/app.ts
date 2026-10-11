import { z } from 'zod'
import { zen, slot, NotFound, type Context, type ZenAppOptions } from '@erenthedeveloper0/zen'

// ─── A slot: the typed replacement for `req.user = x` (rfcs/0001 §7.4) ───────
interface User {
  readonly id: number
  readonly name: string
}
const CurrentUser = slot<User>('demo.user')

// ─── A response schema: what may leave the process, field by field (§13.3) ──
const Info = z.object({ framework: z.string(), compiled: z.boolean() })

/**
 * The application, built and not started — so `main.ts` can listen and a test
 * can `inject()` the same thing (rfcs/0001 §20.2).
 */
export function makeApp(options: ZenAppOptions = {}) {
  const app = zen(options)

  // ─── Phase middleware: no `next`, no closure, returns to short-circuit ─────
  app.use(function attachUser(ctx) {
    ctx.set(CurrentUser, { id: 1, name: 'ada' })
  })

  // Note the explicit bare `return`. Phase middleware returns a Reply to
  // short-circuit and nothing to continue — but *implicitly* falling off the end
  // of a function that returns a value elsewhere trips TypeScript's
  // `noImplicitReturns`. One `return` keeps the idiom compatible with strict
  // configurations; see rfcs/0001 §8.2.
  app.use(function requireKey(ctx) {
    if (!ctx.path.startsWith('/admin')) return
    if (ctx.headers['x-api-key'] !== 'secret') {
      return ctx.json({ error: 'forbidden' }, { status: 403 })
    }
    return
  })

  // ─── Around middleware: explicit, allocates — and it can see the reply ────
  app.around(async function timing(ctx, next) {
    const started = performance.now()
    const reply = await next()
    ctx.log.info({ ms: +(performance.now() - started).toFixed(3), status: reply.status }, ctx.path)
    return reply
  })

  // ─── Routes. The handler *returns* the response; nothing is a side effect ──
  app.get('/', () => 'Hello world')

  // Declared, so only these two fields are serialized — and, with
  // `validation.response` on (development's default), a value of the wrong
  // type is refused instead of sent (§11.5).
  app.get('/json', { response: { 200: Info } }, () => ({ framework: 'zen', compiled: true }))

  // `ctx.params.id` is `number` — typed from the path template, no schema needed.
  app.get('/users/:id<int>', (ctx) => {
    if (ctx.params.id !== 1) throw new NotFound(`User ${ctx.params.id} not found`)
    return ctx.get(CurrentUser)
  })

  app.get('/whoami', (ctx) => ctx.get(CurrentUser))

  app.get('/search', (ctx) => ({ q: ctx.query['q'] ?? null }))

  app.collection('/admin', { name: 'admin' }, (admin) => {
    admin.get('/stats', () => ({ uptime: process.uptime() }))
  })

  app.post('/echo', async (ctx: Context) => ctx.json({ received: ctx.raw.method }))

  app.get('/boom', () => {
    throw new Error('this message must never reach the client')
  })

  app.get('/stream', (ctx) =>
    ctx.stream(
      async function* () {
        for (let i = 1; i <= 3; i++) yield `chunk ${i}\n`
      },
      { media: 'text/plain; charset=utf-8' },
    ),
  )

  return app
}
