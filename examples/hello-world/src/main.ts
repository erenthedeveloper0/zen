import { zen, slot, NotFound, type Context } from '@erenthedeveloper0/zen'

// ─── A slot: the typed replacement for `req.user = x` (rfcs/0001 §7.4) ───────
interface User {
  readonly id: number
  readonly name: string
}
const CurrentUser = slot<User>('demo.user')

const app = zen()

// ─── Phase middleware: no `next`, no closure, returns to short-circuit ───────
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

// ─── Around middleware: explicit, allocates — and it can see the reply ──────
app.around(async function timing(ctx, next) {
  const started = performance.now()
  const reply = await next()
  ctx.log.info({ ms: +(performance.now() - started).toFixed(3), status: reply.status }, ctx.path)
  return reply
})

// ─── Routes. The handler *returns* the response; nothing is a side effect ────
app.get('/', () => 'Hello world')

app.get('/json', () => ({ framework: 'zen', compiled: true }))

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

const handle = await app.listen({ port: 3000 })
console.log(`\n  zen listening on ${handle.url}`)
console.log(`  routes: ${app.graph().routes.length}`)
console.log(`  try:    curl ${handle.url}/users/1\n`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
