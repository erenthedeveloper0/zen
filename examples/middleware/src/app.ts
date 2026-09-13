import { zen, healthPlugin, type EnvSource } from 'zen'
import { cors, rateLimit, requestId, securityHeaders } from '@zenjs/middleware'
import './shared/zod.ts'
import config from './config/zen.config.ts'
import { envSources } from './config/sources.ts'
import { NoteService, noteRoutes } from './features/notes/index.ts'

/**
 * The composition root — rfcs/0001 §23.4, §32.
 *
 * **This is the file that could not be written before this pass.** A
 * browser-facing service needs CORS, and a public one needs rate limiting and
 * security headers; until now each of those was an afternoon of application
 * code that every service wrote slightly differently and one service in five
 * got subtly wrong. M4's exit criterion is "a public app with zero third-party
 * middleware", and these six lines are what it looks like.
 *
 * Three things are worth reading closely, because each is a decision the pack
 * makes for you and each is visible here.
 *
 * ### 1. The allowlist is configuration, not a literal
 *
 * `cors()` takes no argument. It reads `config.cors.origin`, which
 * `zen.config.ts` derives from `CORS_ORIGINS` — so the answer to "which origins
 * can talk to production?" is an environment variable with a layer and a source
 * behind it, and `npm run explain` prints the file and line. That is only
 * possible because `Registrar.config` exists, and `Registrar.config` exists
 * because this example needed it: §16.2 has always resolved the environment
 * before any plugin's `setup` runs, and until this pass there was no seam to
 * read the result through.
 *
 * ### 2. The order below does not matter, and that is deliberate
 *
 * They are registered here in the order a person would write them. They *run*
 * in the order the pack declares — request id, security headers, CORS, rate
 * limit — because getting it wrong is a real failure mode with a confusing
 * symptom: a 429 without CORS headers arrives at a browser as a CORS error, so
 * the investigation starts in the file that is correct. §10.5's `before`/`after`
 * hints make that a property of the pack rather than of this call site, and
 * `pack.test.ts` registers them backwards to prove it.
 *
 * ### 3. There is no `app.use(corsMiddleware)`
 *
 * Every member is a plugin registering a global `onRequest` hook, because phase
 * middleware only runs on matched routes. Measured on this codebase: over a
 * matched GET, an unmatched path and a preflight, a `.use()` middleware ran
 * **1 of 3** times. A CORS middleware that cannot answer `OPTIONS /api/notes`
 * — and no application registers an `OPTIONS` route — is a CORS middleware that
 * does not work, and it fails on the *next* request, which is why it is
 * normally debugged in the wrong place (§32.1).
 */

export interface AppOptions {
  readonly quiet?: boolean
  /** Layer 8's sibling: a test states the environment instead of inheriting the machine's. */
  readonly env?: readonly EnvSource[]
  readonly overrides?: Readonly<Record<string, unknown>>
}

export function makeApp(options: AppOptions = {}) {
  const service = new NoteService()

  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    config,
    env: options.env ?? envSources(),
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    // §19.2. A deadline is the one hardened default that is off unless asked
    // for, and a public service should ask.
    timeout: '10s',
  })

  // ── the pack ──────────────────────────────────────────────────────────────
  // Written the way a person thinks about it: lock the response down, decide
  // who may read it, bound how often, and stamp an id on the way out. That is
  // *not* the order they run in — see point 2 above, and `npm run explain`,
  // which prints the resolved chain.
  app.use(securityHeaders())
  app.use(cors())
  app.use(rateLimit())
  app.use(requestId({ trustHeader: false }))

  // ── everything else ───────────────────────────────────────────────────────
  app.use(healthPlugin, { path: '/healthz', readiness: '/readyz' })

  app.collection('/api/notes', { name: 'notes', tags: ['notes'] }, (notes) => {
    noteRoutes(notes, service)
  })

  /**
   * A route that exists to be refused, so the README's `curl` sequence has
   * something to demonstrate against without hammering a real endpoint.
   */
  app.get('/api/ping', { name: 'ping' }, function ping(ctx) {
    return { pong: true, id: ctx.id }
  })

  return { app, service }
}

function quiet() {
  const noop = () => {}
  return {
    level: 'fatal' as const, child() { return this },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
}
