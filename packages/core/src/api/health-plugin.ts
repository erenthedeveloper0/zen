import type { AppGraph } from '../contracts/graph.ts'
import type { Plugin } from '../contracts/plugin.ts'
import type { Reply } from '../contracts/reply.ts'
import type { HealthReport, ProbeKind } from '../contracts/health.ts'
import { HEALTH_MEDIA_TYPE, HEALTH_STATUS } from '../contracts/health.ts'
import { BootError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { definePlugin } from './zen.ts'

/**
 * The health endpoints — rfcs/0001 §31.4.
 *
 *     app.use(healthPlugin, { path: '/healthz', readiness: '/readyz', checks: ['db', 'redis'] })
 *
 * Written against `Registrar` and nothing else, for the reason §31 gives about
 * the observability example: a first-party plugin that reaches past the public
 * surface proves nothing about whether the surface is sufficient. This one
 * needed two additions — `health()` to register a check and `probe()` to run
 * them — and read everything else off the frozen graph, which is the answer
 * that was wanted.
 *
 * Both endpoints are `meta: { hidden: true }`. A generated client should not
 * grow a `getHealthz()` method, and the document should describe the API rather
 * than the deployment.
 */

export interface HealthPluginOptions {
  /** The liveness endpoint. `false` disables it. */
  readonly path?: string | false | undefined
  /** The readiness endpoint. `false` disables it. */
  readonly readiness?: string | false | undefined
  /**
   * Checks this service's readiness is *required* to depend on.
   *
   * Not a filter — an assertion, verified against the frozen graph at boot. If
   * nothing registered a check by this name the app refuses to start, naming
   * the one that is missing. The failure being prevented is the silent one:
   * somebody deletes the plugin that registered `redis`, `/readyz` keeps
   * returning 200, and the service stays in the load balancer through the next
   * Redis outage. Same principle as §9.7 — a check that can never run must not
   * be indistinguishable from one that passed.
   */
  readonly checks?: readonly string[] | undefined
  /**
   * Constant fields merged into every report: version, revision, region.
   *
   * Worth setting. "Which build is answering?" is the first question of most
   * incidents, and the health endpoint is the one thing already being polled.
   */
  readonly info?: Readonly<Record<string, unknown>> | undefined
}

/** Only what the handlers touch, declared structurally (§10.2). */
interface HealthContext {
  json<T>(body: T, init?: { status?: number; headers?: Record<string, string> }): Reply<T>
}

interface HealthDocument {
  readonly status: HealthReport['status']
  readonly state: HealthReport['state']
  readonly probe: ProbeKind
  readonly durationMs: number
  readonly checks: Readonly<Record<string, unknown>>
  readonly [extra: string]: unknown
}

export const healthPlugin: Plugin<HealthPluginOptions, {}> = definePlugin<HealthPluginOptions, {}>({
  name: 'health',
  version: '0.1.0',

  setup(app, options) {
    // `app.use(healthPlugin)` with no second argument hands `undefined` through,
    // and every option here has a default — so the zero-configuration form has
    // to work, since it is the one most services will use.
    const opts: HealthPluginOptions = options ?? {}
    const livenessPath = opts.path === undefined ? '/healthz' : opts.path
    const readinessPath = opts.readiness === undefined ? '/readyz' : opts.readiness
    const info = opts.info

    const serve = async (ctx: HealthContext, kind: ProbeKind): Promise<Reply<HealthDocument>> => {
      const report = await app.probe(kind)
      return ctx.json(document(report, info), {
        status: HEALTH_STATUS[report.status],
        headers: {
          'content-type': `${HEALTH_MEDIA_TYPE}; charset=utf-8`,
          // A cached health document is a health document about the past, and
          // the orchestrator must never be served one by a proxy nobody knew
          // was in the path.
          'cache-control': 'no-store',
        },
      })
    }

    if (livenessPath !== false) {
      app.route({
        method: 'GET',
        path: livenessPath,
        name: 'health.live',
        meta: { hidden: true },
        // These endpoints must not be bounded by the service's own request
        // budget: an app-wide 500 ms deadline would make readiness fail during
        // exactly the incident it exists to describe, and a 504 with no body
        // tells an operator nothing about which dependency is down. Each check
        // carries its own budget instead — stricter *and* more informative.
        schema: { timeout: false },
        handler: function liveness(ctx: HealthContext) { return serve(ctx, 'liveness') },
      })
    }

    if (readinessPath !== false) {
      app.route({
        method: 'GET',
        path: readinessPath,
        name: 'health.ready',
        meta: { hidden: true },
        schema: { timeout: false },
        handler: function readiness(ctx: HealthContext) { return serve(ctx, 'readiness') },
      })
    }

    // Read from the frozen graph rather than checked at registration time, so
    // the order in which plugins register their checks cannot matter (§10.5).
    // The graph carries `checks` for the same reason it carries routes: one
    // canonical structure that every tool reads (§2.4).
    const required = opts.checks
    if (required !== undefined && required.length > 0) {
      app.onBoot((graph) => {
        const present = new Set((graph as AppGraph).checks.map((check) => check.name))
        const missing = required.filter((name) => !present.has(name))
        if (missing.length === 0) return
        throw new BootError([{
          severity: 'error',
          code: Codes.HEALTH_CHECK_MISSING,
          message:
            `Readiness was configured to require ${missing.map((m) => `"${m}"`).join(', ')}, ` +
            `but ${missing.length === 1 ? 'no check was' : 'no checks were'} registered under ` +
            `${missing.length === 1 ? 'that name' : 'those names'}.`,
          hint: 'Register it with app.health(name, probe), or remove it from the plugin\'s `checks` list.',
          consequence:
            'Left unchecked, /readyz would answer 200 for a dependency nothing is actually probing.',
        }])
      })
    }

    return {
      exports: {
        /** For tests, and for a metrics plugin exporting the state as a gauge. */
        probe: (kind: ProbeKind = 'readiness'): Promise<HealthReport> => app.probe(kind),
      },
    }
  },
})

/**
 * The wire shape — draft-inadarei-api-health-check.
 *
 * `checks` is an object keyed by component name rather than the array the
 * registry holds, because that is what the draft specifies and what dashboards
 * index on: `checks.redis.status` is a stable path, `checks[3].status` is not.
 */
function document(
  report: HealthReport,
  info: Readonly<Record<string, unknown>> | undefined,
): HealthDocument {
  const checks: Record<string, unknown> = {}
  for (const check of report.checks) {
    checks[check.name] = {
      status: check.status,
      time: new Date(check.observedAt).toISOString(),
      observedValue: Number(check.durationMs.toFixed(3)),
      observedUnit: 'ms',
      cached: check.cached,
      ...(check.critical ? {} : { critical: false }),
      ...(check.message === undefined ? {} : { output: check.message }),
      ...(check.data === undefined ? {} : { data: check.data }),
    }
  }
  return {
    status: report.status,
    state: report.state,
    probe: report.kind,
    durationMs: Number(report.durationMs.toFixed(3)),
    checks,
    ...info,
  }
}
