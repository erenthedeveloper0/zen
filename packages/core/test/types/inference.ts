/**
 * Type-level tests — rfcs/0001 §20.4.
 *
 * The type surface is public API and is tested like one. This file is checked
 * by `tsc --noEmit`; it is never executed. A `@ts-expect-error` that stops being
 * an error fails the build just as loudly as a new error does, which is what
 * makes the negative cases meaningful.
 */
import type { StandardSchemaV1 } from '@erenthedeveloper0/zen-core'
import { createApp, slot, token, definePlugin, defineConfig, type Context, type ExtractParams } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'

// ── helpers ─────────────────────────────────────────────────────────────────

declare function expectType<T>(value: T): void
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function expectExactly<Expected>(): <Actual>(check: Equals<Actual, Expected>) => void

function typed<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  }
}

const app = createApp({
  router: new ZenRouter(),
  pathParser: { parse: (p: string) => ({ path: parsePath(p).path, segments: parsePath(p).segments }) },
})

// ── 1. params are typed from the path template, with no schema at all ───────

app.get('/users/:id', (ctx) => {
  expectType<string>(ctx.params.id)
  return 'ok'
})

app.get('/users/:id<int>', (ctx) => {
  expectType<number>(ctx.params.id)
  return 'ok'
})

app.get('/posts/:slug/comments/:commentId<int>', (ctx) => {
  expectType<string>(ctx.params.slug)
  expectType<number>(ctx.params.commentId)
  return 'ok'
})

app.get('/files/*path', (ctx) => {
  expectType<string>(ctx.params.path)
  return 'ok'
})

// ExtractParams is the underlying machinery; assert it exactly.
expectExactly<{ id: number }>()<ExtractParams<'/users/:id<int>'>>(true)
expectExactly<{ org: string; id: number }>()<ExtractParams<'/:org/users/:id<int>'>>(true)
expectExactly<{ at: Date }>()<ExtractParams<'/events/:at<date>'>>(true)

app.get('/users/:id', (ctx) => {
  // @ts-expect-error — `nope` is not a parameter of this path
  ctx.params.nope
  return 'ok'
})

// ── 2. body is `never` unless the route declares one ────────────────────────

app.post('/no-body', (ctx) => {
  // @ts-expect-error — reading a body the route never declared is a type error,
  // not a runtime `undefined` (§7.7)
  ctx.body.anything
  return 'ok'
})

app.post('/with-body', { body: typed<{ email: string; age: number }>() }, (ctx) => {
  expectType<string>(ctx.body.email)
  expectType<number>(ctx.body.age)
  // @ts-expect-error — `missing` is not on the declared body
  ctx.body.missing
  return 'ok'
})

// ── 3. query and headers follow their schemas ───────────────────────────────

app.get('/search', { query: typed<{ page: number; q: string }>() }, (ctx) => {
  expectType<number>(ctx.query.page)
  expectType<string>(ctx.query.q)
  return 'ok'
})

// Undeclared query stays string-ish rather than becoming `any`.
app.get('/loose', (ctx) => {
  expectType<string | string[] | undefined>(ctx.query['anything'])
  return 'ok'
})

// ── 4. slots are typed at both ends ─────────────────────────────────────────

const CurrentUser = slot<{ id: number; email: string }>('types.user')

app.get('/me', (ctx) => {
  expectType<{ id: number; email: string }>(ctx.get(CurrentUser))
  expectType<{ id: number; email: string } | undefined>(ctx.find(CurrentUser))
  ctx.set(CurrentUser, { id: 1, email: 'a@b.c' })
  // @ts-expect-error — wrong shape for this slot
  ctx.set(CurrentUser, { id: 'not-a-number' })
  return 'ok'
})

// ── 5. service tokens carry their type through resolve ──────────────────────

interface Database { query(sql: string): Promise<unknown[]> }
const Db = token<Database>('types.db')

app.get('/rows', async (ctx) => {
  expectType<Database>(ctx.resolve(Db))
  const rows = await ctx.resolve(Db).query('select 1')
  expectType<unknown[]>(rows)
  return 'ok'
})

// ── 6. plugin type accumulation (§10.4) ─────────────────────────────────────

const RedisPlugin = definePlugin<void, { redis: { status: string } }>({
  name: 'redis',
  version: '1.0.0',
  setup() { return { provides: {} as { redis: { status: string } } } },
})

const AuthPlugin = definePlugin<void, { user: { id: number } }>({
  name: 'auth',
  version: '1.0.0',
  setup() { return { provides: {} as { user: { id: number } } } },
})

const extended = createApp({
  router: new ZenRouter(),
  pathParser: { parse: (p: string) => ({ path: parsePath(p).path, segments: parsePath(p).segments }) },
})
  .use(RedisPlugin)
  .use(AuthPlugin)
  .seal()

extended.get('/dashboard', (ctx) => {
  expectType<string>(ctx.redis.status)
  expectType<number>(ctx.user.id)
  // @ts-expect-error — no plugin provides `stripe`
  ctx.stripe
  return 'ok'
})

// A plugin's contribution must not leak onto an app that did not register it.
app.get('/plain', (ctx) => {
  // @ts-expect-error — `redis` was never registered on this app
  ctx.redis
  return 'ok'
})

// ── 7. Context is usable as a standalone annotation ─────────────────────────

function handler(ctx: Context<{ body: StandardSchemaV1<unknown, { n: number }> }>): number {
  return ctx.body.n
}
expectType<(ctx: Context<{ body: StandardSchemaV1<unknown, { n: number }> }>) => number>(handler)

// ── 8. reply builders keep their payload type ───────────────────────────────

app.get('/typed-reply', (ctx) => {
  const reply = ctx.json({ ok: true as const })
  expectType<boolean>(reply.status === 200)
  return reply
})

// ── 9. hooks are typed per phase, and against the app's decorations (§9.1) ───

app.hook('onRequest', (ctx) => {
  // No annotation needed: the phase picks the signature.
  expectType<string>(ctx.path)
  expectType<string | null>(ctx.route === null ? null : ctx.route.path)
})

app.hook('onRoute', (ctx, route) => {
  expectType<string>(route.path)
  // The *template*, which is what makes metric and span labels bounded (§31.2).
  expectType<string | undefined>(route.name)
  return ctx.json({ blocked: true }, { status: 403 })
})

app.hook('onSend', (_ctx, reply) => {
  reply.headers.set('x-phase', 'onSend')
  // Transform phases may return nothing: "no change" (§9.2).
})

app.hook('onResponse', (_ctx, reply) => {
  expectType<number>(reply.status)
})

// @ts-expect-error — `onRoute` takes (ctx, route); this reads a second param the
// phase does not have, so the phase's signature is really being applied.
app.hook('onRequest', (_ctx, route: { path: string }) => { void route })

// @ts-expect-error — a hook cannot return an arbitrary value; guard phases
// return void or a Reply, and a stray return is how a short-circuit happens by
// accident.
app.hook('preHandler', () => 42)

// Hooks see plugin decorations, exactly like handlers do.
extended.hook('preHandler', (ctx) => {
  expectType<number>(ctx.user.id)
  expectType<string>(ctx.redis.status)
})

// …but not a route's schema: a hook runs on every route in its scope, so there
// is no single schema to type it against (§9.1). Needing `ctx.body` typed is the
// signal that the concern is middleware, not a hook.
app.hook('postValidation', (ctx) => {
  expectExactly<never>()<typeof ctx.body>(true)
})

// Route-scoped hooks are checked through the route spec.
app.get('/hooked', {
  hooks: {
    onRequest: (ctx) => { expectType<string>(ctx.path) },
    onSend: [(_ctx, reply) => { reply.headers.set('x-a', 'b') }],
  },
}, () => 'ok')

app.get('/mistyped', {
  // @ts-expect-error — a misspelled phase is caught, which is the whole reason
  // `RouteSpec` declares `hooks` rather than letting it ride as an excess
  // property on an inferred object literal.
  hooks: { onRequst: () => {} },
}, () => 'ok')

// ── 10. deadlines (§4.4) ────────────────────────────────────────────────────

const bounded = createApp({
  router: new ZenRouter(),
  pathParser: { parse: (p: string) => ({ path: parsePath(p).path, segments: parsePath(p).segments }) },
  timeout: { default: '30s', header: 'x-request-timeout' },
})

// Durations are a template literal type, so a typo is caught at the call site
// rather than at boot. The boot diagnostic exists for the values a type cannot
// reach — a `Duration` read from config or an environment variable.
bounded.get('/report', { timeout: '2m' }, () => 'ok')
bounded.get('/quick', { timeout: 250 }, () => 'ok')
bounded.get('/stream', { timeout: false }, () => 'ok')
bounded.collection('/api', { timeout: '5s' }, (api) => api.get('/x', () => 'ok'))

// @ts-expect-error — "2 minutes" is not a duration; the unit set is closed.
bounded.get('/typo', { timeout: '2 minutes' }, () => 'ok')

// @ts-expect-error — `true` is not a duration either. Turning a deadline *on*
// requires saying how long, which is the whole content of the decision.
bounded.get('/vague', { timeout: true }, () => 'ok')

// The budget is a value a handler can pass downstream, and it is a number
// whether or not a deadline exists (`Infinity` when it does not), so arithmetic
// on it never needs a null check.
bounded.get('/fanout', async (ctx) => {
  expectType<number>(ctx.timeLeft)
  expectType<number | null>(ctx.deadline)
  expectType<boolean>(ctx.timedOut)
  await fetch('https://upstream.invalid', { signal: AbortSignal.timeout(Math.min(ctx.timeLeft, 2000)) })
  return 'ok'
})

// `onTimeout` is typed like every other phase: the second parameter is the
// report, not a bare string, and it is the phase that picks the signature.
bounded.hook('onTimeout', (ctx, info) => {
  expectExactly<'pre' | 'intake' | 'validate' | 'handler'>()<typeof info.stage>(true)
  expectType<number>(info.budgetMs)
  expectType<number>(info.elapsedMs)
  expectType<string | null>(info.route)
  return ctx.json({ degraded: true }, { status: 503 })
})

// @ts-expect-error — `onTimeout` takes (ctx, info); there is no third argument.
bounded.hook('onTimeout', (_ctx, _info, _extra: number) => {})

// ── 11. configuration (§16) ─────────────────────────────────────────────────

const EnvOut = typed<{
  PORT: number
  NODE_ENV: 'development' | 'test' | 'production'
  LOG_LEVEL: 'debug' | 'info'
}>()

const configured = createApp({
  router: new ZenRouter(),
  pathParser: { parse: (p: string) => ({ path: parsePath(p).path, segments: parsePath(p).segments }) },
  config: defineConfig({
    env: EnvOut,
    server: { port: (env) => env.PORT, keepAliveTimeout: '65s' },
    logging: { level: (env) => env.LOG_LEVEL, redact: ['a.password'] },
    debug: (env) => env.NODE_ENV !== 'production',
  }),
})

// The thunk's parameter is contextually typed from the *sibling* `env` schema
// in the same object literal, which is what makes §16.2's shape work at all.
// If that inference ever breaks, `env` degrades to `any` and these lines start
// passing for the wrong reason — so the exact assertions below matter more than
// the `expectType` ones.
expectExactly<number>()<typeof configured.config.server.port>(true)
expectExactly<'65s'>()<typeof configured.config.server.keepAliveTimeout>(true)
expectExactly<'debug' | 'info'>()<typeof configured.config.logging.level>(true)
expectExactly<boolean>()<typeof configured.config.debug>(true)

// @ts-expect-error — nothing declares a `redis` namespace.
configured.config.redis

// @ts-expect-error — config is deeply readonly; §16.4 says mutating it throws,
// and the type says so before the runtime does.
configured.config.server.port = 1

// `ctx.config` is the same type, reached through the app's extension channel
// rather than through a fourth type parameter on `BaseContext`.
configured.get('/x', (ctx) => {
  expectType<number>(ctx.config.server.port)
  expectExactly<'debug' | 'info'>()<typeof ctx.config.logging.level>(true)
  // @ts-expect-error — same absence, on the context.
  ctx.config.redis
  return 'ok'
})

// An app with no `config` option still has `ctx.config`; it is simply empty,
// so every property access is an error rather than `any`.
app.get('/unconfigured', (ctx) => {
  // @ts-expect-error — this app declared no configuration.
  ctx.config.server
  return 'ok'
})

// ── 0.1.0-alpha.4: the surfaces "Nothing silent" added or corrected ─────────

// §9.2 — an application phase hook is typed by its phase, not as a request
// hook with a context it never receives.
app.hook('onBoot', (graph) => {
  expectType<readonly unknown[]>(graph.routes)
  expectType<ReadonlyMap<string, unknown>>(graph.meta)
})
app.hook('onListen', (handle) => { expectType<string>(handle.url) })
app.hook('onClose', (reason) => { expectType<string>(reason) })
app.hook('onReady', () => {})
// @ts-expect-error — onReady is called with nothing; there is no context to read.
app.hook('onReady', (ctx: { id: string }) => ctx.id)

// §7.2 — the forwarding chain and the scheme, as getters on every context.
app.get('/whoami', (ctx) => {
  expectExactly<readonly string[]>()<typeof ctx.ips>(true)
  expectExactly<'http' | 'https'>()<typeof ctx.protocol>(true)
  return 'ok'
})

// §8.3 — route-scoped middleware, the innermost of the three scopes.
app.get('/owned/:id', { use: [(ctx) => { expectType<string>(ctx.id) }] }, () => 'ok')

// §19.4 — inject() can say where the request came from.
void app.inject('GET', '/whoami', { remote: { address: '203.0.113.7', port: 4000, family: 'IPv4' } })

// Options nothing read are gone from the router contract, so passing
// one is a compile error rather than a setting that silently does nothing.
import type { RouterOptions } from '@erenthedeveloper0/zen-core'
// @ts-expect-error — matching is always case-sensitive (§5.3).
const caseless: RouterOptions = { caseSensitive: false }
void caseless

export {}
