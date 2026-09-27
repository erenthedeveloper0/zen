import { zen, NotFound, type ZenApp, type ZenAppOptions } from '@visionpilot/zen'
import { Created, ListQuery, NewUser, PatchUser, PublicUser, UserList } from './domain.ts'
import type { UserRow } from './domain.ts'
import { auth, adminOnly, requestTiming } from './plugins.ts'
import {
  AuditToken, ClockToken, UserRepoToken,
  inMemoryUserRepo, requestAudit, systemClock,
} from './services.ts'

/**
 * The application, built in one function so tests can `inject()` into it
 * without a socket (rfcs/0001 §20.2).
 *
 * Read this file top to bottom: services, plugins, routes. Nothing is
 * registered implicitly, nothing is discovered by scanning the filesystem, and
 * the whole application graph is available as data via `app.graph()`.
 */
export function build(options: ZenAppOptions = {}): ZenApp<{ user: UserRow }> {
  const app = zen(options)
    // ── services (§15) ─────────────────────────────────────────────────────
    // Dependencies are listed, not reflected. That is what lets `ready()`
    // detect cycles and captive dependencies before a single request arrives.
    .provide(ClockToken, { factory: systemClock, lifetime: 'singleton' })
    .provide(UserRepoToken, {
      deps: [ClockToken] as never,
      factory: inMemoryUserRepo as never,
      lifetime: 'singleton',
      eager: true,
    })
    // Scoped: one per request, stored in the context's slot array rather than
    // in a Map keyed by request id.
    .provide(AuditToken, { factory: requestAudit, lifetime: 'scoped' })

    // ── plugins (§10) ──────────────────────────────────────────────────────
    // Each `.use()` returns an app whose Context type has grown. After this
    // chain, `ctx.user` exists and is a `UserRow`, with no global augmentation
    // and no `declare module`.
    .use(requestTiming, { header: 'x-response-time' })
    .use(auth, { headerName: 'x-user-id' })
    .use(adminOnly, { prefixes: ['/users'] })

  // ── around: the explicit form, and the only closure per request ──────────
  // It allocates, it says so at the call site, and in exchange it can see the
  // reply that the chain below it produced.
  app.around(async function auditTrail(ctx, next) {
    const audit = ctx.resolve(AuditToken)
    audit.record(`${ctx.method} ${ctx.path}`)
    const reply = await next()
    ctx.log.debug({ status: reply.status, trail: audit.trail }, 'request complete')
    return reply
  })

  // ── routes ───────────────────────────────────────────────────────────────

  app.get('/health', () => ({ status: 'ok', uptime: Math.round(process.uptime()) }))

  // `ctx.user` comes from the auth plugin's decoration. Hover it in an editor:
  // it is `UserRow`, inferred through the `.use()` chain with no augmentation.
  // It lives outside `/users` because the directory is admin-only and your own
  // profile is not.
  app.get('/me', { response: { 200: PublicUser } }, (ctx) => ctx.user as never)

  app.collection('/users', { name: 'users', tags: ['users'] }, (users) => {
    /**
     * `response: { 200: UserList }` is the load-bearing line.
     *
     * The handler returns database rows straight from the repository —
     * `passwordHash`, `totpSecret`, `stripeCustomerId` and all. The compiled
     * serializer emits five fields per user because five are declared, and it
     * has no key enumeration through which the rest could escape.
     *
     * Try deleting `response` and hitting the endpoint. That difference is the
     * entire argument of §13.3.
     */
    users.get('/', {
      query: ListQuery,
      response: { 200: UserList },
    }, (ctx) => {
      const repo = ctx.resolve(UserRepoToken)
      const limit = Math.min(Number(ctx.query.limit ?? 20) || 20, 100)
      const rows = repo.list({ limit, ...(ctx.query.role !== undefined ? { role: ctx.query.role } : {}) })
      return { users: rows, total: rows.length } as never
    })

    // `ctx.params.id` is `number`, typed from the path template `:id<int>`.
    // No `params` schema, no cast, and `/users/abc` never reaches the handler.
    users.get('/:id<int>', {
      response: { 200: PublicUser },
    }, (ctx) => {
      const row = ctx.resolve(UserRepoToken).find(ctx.params.id)
      if (row === undefined) throw new NotFound(`User ${ctx.params.id} not found`)
      return row as never
    })

    // A body schema is the *only* thing that causes body intake to be emitted
    // into this route's pipeline (§4.2 stage 6). Routes without one never
    // allocate a parser — unlike `app.use(express.json())`, which parses
    // everything for everyone.
    users.post('/', {
      body: NewUser,
      response: { 201: Created },
    }, (ctx) => {
      const row = ctx.resolve(UserRepoToken).create(ctx.body)
      ctx.res.status(201).header('location', `/users/${row.id}`)
      // 201 selects the `Created` contract, not the 200 one: the staged status
      // is read through the same rule egress uses (§13.3.5).
      return row as never
    })

    users.patch('/:id<int>', {
      body: PatchUser,
      response: { 200: PublicUser },
    }, (ctx) => ctx.resolve(UserRepoToken).patch(ctx.params.id, ctx.body) as never)

    users.delete('/:id<int>', (ctx) => {
      ctx.resolve(UserRepoToken).remove(ctx.params.id)
      return ctx.empty(204)
    })
  })

  return app
}
