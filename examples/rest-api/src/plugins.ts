import { definePlugin, Unauthorized, Forbidden } from '@erenthedeveloper0/zen'
import type { Slot, Token } from '@erenthedeveloper0/zen'
import type { UserRow } from './domain.ts'
import { UserRepoToken } from './services.ts'

/**
 * Plugins — rfcs/0001 §10.
 *
 * A plugin is a **manifest plus a setup function**: data before it is
 * behaviour. That ordering is what lets Zen resolve dependencies, detect
 * conflicts and version mismatches, and print the plugin graph *before*
 * executing any of it — so a plugin tree that fails to boot is still
 * inspectable.
 *
 * `setup` receives a `Registrar`, not the application. It enumerates exactly
 * what a plugin may do; mutating another plugin's registrations, patching
 * `Context.prototype`, or reaching into the global registry are absent by
 * construction rather than discouraged by documentation.
 */

/**
 * What a plugin's hooks need from the context.
 *
 * Plugins are compiled before the application's own decoration set exists, so
 * hook parameters are typed structurally against what they actually touch.
 * That is a feature, not a workaround: a plugin that declares it needs `path`
 * and `resolve` cannot quietly start depending on `ctx.user` later.
 */
interface PluginContext {
  readonly path: string
  readonly headers: Record<string, string | undefined>
  readonly startTime: number
  resolve<T>(token: Token<T>): T
  set<T>(slot: Slot<T>, value: T): void
  find<T>(slot: Slot<T>): T | undefined
}

// ─── requestTiming: no dependencies, contributes no types ────────────────────

export const requestTiming = definePlugin<{ header?: string }, {}>({
  name: 'request-timing',
  version: '1.0.0',
  setup(app, options) {
    const header = options?.header ?? 'x-response-time'

    // `after` receives the finished Reply as an argument. No monkey-patching
    // `res.end`, because there is no `res` — the response is a value.
    app.after((ctx, reply) => {
      const elapsed = performance.now() - (ctx as unknown as PluginContext).startTime
      reply.headers.set(header, `${elapsed.toFixed(1)}ms`)
      return reply
    }, { name: 'timing' })

    // Exports are readable by plugins that `dependsOn` this one.
    return { exports: { header } }
  },
})

// ─── auth: decorates ctx.user, and says so in the type ───────────────────────

export interface AuthOptions {
  /** Demo only. A real plugin would verify a signature, not trust a header. */
  readonly headerName?: string
}

/**
 * The second type parameter is the plugin's *contribution to `Context`*, and it
 * is what makes `ctx.user` exist and be typed downstream:
 *
 *     const app = zen().use(auth)
 *     app.get('/me', ctx => ctx.user.email)   // ← typed, no global augmentation
 *
 * It is deliberately a flat object type. Intersections of flat object types are
 * cheap for `tsc`; conditional or mapped accumulation over other plugins'
 * output is what makes type-heavy frameworks slow to check (§10.4, §28.2).
 */
export const auth = definePlugin<AuthOptions, { user: UserRow }>({
  name: 'auth',
  version: '1.0.0',
  // Ordering is declared, not achieved by registering in a lucky order.
  after: ['request-timing'],

  setup(app, options) {
    const headerName = options?.headerName ?? 'x-user-id'

    // Slot names are namespaced by plugin, so two plugins can both call their
    // slot "user" without either knowing the other exists.
    const currentUser = app.slot<UserRow>('user')
    app.decorate('user', currentUser)

    app.hook('onRequest', (ctx: PluginContext) => {
      if (PUBLIC_PREFIXES.some((prefix) => ctx.path.startsWith(prefix))) return

      const raw = ctx.headers[headerName]
      if (raw === undefined) {
        throw new Unauthorized(`Missing ${headerName} header`, {
          headers: { 'www-authenticate': 'Bearer realm="rest-api"' },
        })
      }

      const user = ctx.resolve(UserRepoToken).find(Number(raw))
      if (user === undefined) throw new Unauthorized('Unknown user')

      ctx.set(currentUser, user)
    }, 'authenticate')

    return { provides: {} as { user: UserRow }, exports: { headerName, currentUser } }
  },
})

const PUBLIC_PREFIXES = ['/health'] as const

// ─── adminOnly: depends on auth, by name and semver range ────────────────────

/**
 * `dependsOn` is checked at boot. Registering this without `auth`, or against
 * an incompatible version of it, is a boot error naming both plugins — not a
 * `TypeError: cannot read properties of undefined (reading 'role')` on the
 * first request that happens to hit an admin route in production.
 */
export const adminOnly = definePlugin<{ prefixes: readonly string[] }, {}>({
  name: 'admin-only',
  version: '1.0.0',
  dependsOn: { auth: '^1.0.0' },

  setup(app, options) {
    // Reading the dependency's exports rather than re-deriving its slot: the
    // two plugins agree because one of them published the answer.
    const exported = app.exportsOf('auth')
    const currentUser = exported?.['currentUser'] as Slot<UserRow> | undefined

    app.use((ctx) => {
      const context = ctx as unknown as PluginContext
      if (!options.prefixes.some((prefix) => context.path.startsWith(prefix))) return
      if (currentUser === undefined) return
      if (context.find(currentUser)?.role !== 'admin') {
        throw new Forbidden('This endpoint requires the admin role')
      }
    }, { name: 'require-admin' })
  },
})
