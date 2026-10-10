/**
 * Print what the compiler actually emitted.
 *
 * The compilation thesis (rfcs/0001 §1.4) is only credible if you can read its
 * output. `zen inspect pipeline <route>` will wrap this; for now:
 *
 *     node scripts/show-generated.ts
 */
import { zen, slot, type Context } from '@erenthedeveloper0/zen'

const CurrentUser = slot<{ id: number }>('demo.user')

const quiet = {
  level: 'fatal' as const,
  child() { return this },
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
}

const app = zen({ dev: true, logger: quiet })

// Plain functions, as the README writes them: no `markSync()`. Each is a
// speculation point (§8.4), so the listing is what an ordinary app compiles to.
app.use(function attachUser(ctx) { ctx.set(CurrentUser, { id: 1 }) })
app.use(function cors() {})
app.around(async function timing(_ctx, next) { return next() })
app.after(function auditLog(_ctx, reply) { return reply })

app.get('/users/:id<int>', (ctx: Context<{}, {}, '/users/:id<int>'>) => ({ id: ctx.params.id }))

await app.ready()

for (const unit of app.generatedSource()) {
  if (unit.name.startsWith('pipeline') || unit.name.startsWith('params')) {
    const rule = '─'.repeat(Math.max(2, 62 - unit.name.length))
    console.log(`\n// ─── ${unit.name} ${rule}`)
    console.log(unit.source)
  }
}
