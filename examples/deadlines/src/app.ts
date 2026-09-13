import { zen } from 'zen'
import type { Duration, ZenApp } from 'zen'
import { deadlines, type DeadlineReport } from './plugins/deadlines.ts'
import { QuoteToken, makeQuotes, quoteRoutes } from './features/quotes/index.ts'
import { reportRoutes } from './features/reports/index.ts'
import { feedRoutes } from './features/feed/index.ts'
import { config } from './config/deadlines.config.ts'

/**
 * The composition root — rfcs/0001 §23.4, §4.4.
 *
 * Read top to bottom, this file is the service's entire timeout policy. That is
 * the claim worth checking, because in most codebases the answer to "what is
 * our request timeout" is spread across a reverse proxy config, an
 * `express-timeout` call somewhere in the middleware stack, a per-client HTTP
 * agent, and a `statement_timeout` in a connection string — four places, none
 * of which knows about the others, and the effective behaviour is whichever
 * fires first.
 *
 * Here every budget is one of three lines:
 *
 *   - the app default, below;
 *   - a collection's, where a whole subtree is different;
 *   - a route's, where one endpoint is.
 *
 * All three resolve at boot onto `RouteRecord.timeout`, so `npm run
 * deadlines:explain` prints the real number for every route with the scope that
 * set it, and `/deadlines` reports how many routes are bounded at all.
 */
export interface AppOptions {
  readonly onTimeout?: ((report: DeadlineReport) => void) | undefined
  readonly quiet?: boolean
  /** Overridden by the tests so a suite does not wait real seconds. */
  readonly requestTimeout?: Duration
}

export function makeApp(options: AppOptions = {}): ZenApp {
  const app = zen({
    ...(options.quiet === true ? { logger: quiet() } : {}),
    // One default for the whole service, and an inbound header that may
    // *shorten* it. The clamp is one-way: an upstream telling us it has 300 ms
    // left is cooperative, and a client asking for an hour is not (§4.4).
    timeout: {
      default: options.requestTimeout ?? config.requestTimeout,
      header: config.timeoutHeader,
    },
  })

  app.use(deadlines, {
    headers: true,
    onTimeout: options.onTimeout ?? defaultReport,
  })

  app.provide(QuoteToken, makeQuotes)

  // ── the default budget, inherited ──────────────────────────────────────
  app.collection('/quotes', { name: 'quotes', tags: ['quotes'] }, quoteRoutes)

  // ── a subtree that is legitimately slower ──────────────────────────────
  // Declared on the collection because "reports take longer" is a property of
  // the subtree. A route inside it that needs to be *faster* still says so
  // itself — see `reports.status`.
  app.collection('/reports', { name: 'reports', tags: ['reports'], timeout: '10s' }, reportRoutes)

  // ── a subtree that must not be bounded ─────────────────────────────────
  app.collection('/feed', { name: 'feed', tags: ['feed'] }, feedRoutes)

  return app
}

function defaultReport(report: DeadlineReport): void {
  console.warn(
    `[deadline] ${report.route} blew a ${report.budgetMs}ms budget during ` +
    `${report.stage} after ${Math.round(report.elapsedMs)}ms`,
  )
}

function quiet() {
  const noop = () => {}
  return { level: 'fatal' as const, child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
}
