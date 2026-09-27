import { definePlugin } from '@visionpilot/zen'
import type { AppGraph, Reply, RouteInfo, Slot } from '@visionpilot/zen'
import { Counter, Gauge, Histogram, Registry } from '../shared/metrics.ts'

/**
 * Observability as pure hooks — rfcs/0001 §9.8, §31.
 *
 * This is the plugin §9.8 sketches, built. It touches ten of the twelve phases
 * and it is worth reading for what is *absent*: no global patched, no
 * `http.Server` monkey-patched, no `res.end` wrapped, no `AsyncLocalStorage`, no
 * context mutated. Every piece of per-request state lives in one declared slot,
 * and every measurement comes from a phase that exists for the purpose.
 *
 * Three things it demonstrates that middleware structurally cannot:
 *
 *   1. **Real timing.** `onResponse` runs after the last byte is flushed, so
 *      the number it records includes serialization and egress. A response-time
 *      middleware stops the clock before either and reports a smaller number
 *      than the client experienced — which is the whole reason `onResponse`
 *      exists as a phase rather than as "the last middleware".
 *   2. **Bounded cardinality by construction.** `onRoute` hands over the
 *      matched route, and the label is `route.path` — the *template*. So
 *      `/products/1` and `/products/999` are one series. Getting this wrong is
 *      the most common way a Node service takes down its own metrics backend,
 *      and it is normally a documentation problem; here the raw URL is simply
 *      not what the hook is given.
 *   3. **Per-stage attribution.** The guard phases bracket parsing, validation,
 *      the handler and the epilogue, so "this endpoint is slow" becomes
 *      "validation is 60% of this endpoint" without a profiler — and it is
 *      published to the browser as `Server-Timing`, which devtools renders.
 *
 * What it costs, stated because I9 requires it: one small object per request
 * (the timing record), ten hook calls, and one `performance.now()` per stage.
 * On the benchmark harness a hook call is well under a nanosecond after the
 * first, so the honest number here is dominated by the `performance.now()`
 * calls, not by the hook system.
 */

export interface ObservabilityOptions {
  /** Where the scrape endpoint is mounted. */
  readonly path?: string
  /** Emit a `Server-Timing` header. Cheap, but it is a header on every response. */
  readonly serverTiming?: boolean
  /** Log a line per request. */
  readonly log?: ((line: RequestLine) => void) | undefined
}

export interface RequestLine {
  readonly requestId: string
  readonly method: string
  /** The route *template*, never the concrete URL (§31.1). */
  readonly route: string
  readonly status: number
  readonly durationMs: number
  readonly stages: Readonly<Record<Stage, number>>
  readonly aborted: boolean
}

export type Stage = 'parse' | 'validate' | 'handler' | 'epilogue'

/** Fixed shape, one per request. Monomorphic on purpose (§7.6). */
interface Timing {
  start: number
  mark: number
  route: string
  parse: number
  validate: number
  handler: number
  epilogue: number
  hidden: boolean
  stages: StageMask
}

/**
 * Which stages a route actually has, read off the AppGraph at boot.
 *
 * This is the part that only a compiled framework can offer. A hook fires at a
 * lifecycle position, but "did validation happen on this route" is not
 * something the hook can see — the pipeline either contains validators or does
 * not, and by the time `postValidation` runs the difference is a sub-microsecond
 * gap that looks exactly like a fast validator. Reading `route.schema` once, at
 * boot, means `Server-Timing` never reports a stage that does not exist instead
 * of reporting it as suspiciously quick.
 */
interface StageMask {
  readonly parse: boolean
  readonly validate: boolean
}

const NO_STAGES: StageMask = { parse: false, validate: false }
const VALIDATED_SOURCES = ['params', 'query', 'headers', 'cookies', 'body'] as const

/**
 * What these hooks need from the context.
 *
 * Structural rather than `Context<…>` because a plugin is compiled before the
 * application's decoration set exists — and because it is a useful constraint
 * in its own right: a plugin that declares it needs `id`, `method` and the slot
 * accessors cannot quietly start depending on `ctx.user` later.
 */
interface ObservabilityContext {
  readonly id: string
  readonly method: string
  readonly path: string
  readonly route: RouteInfo | null
  readonly aborted: boolean
  get<T>(slot: Slot<T>): T
  find<T>(slot: Slot<T>): T | undefined
  set<T>(slot: Slot<T>, value: T): void
}

const UNMATCHED = '<unmatched>'

export const observability = definePlugin<ObservabilityOptions, {}>({
  name: 'observability',
  version: '1.0.0',

  setup(app, options) {
    const path = options?.path ?? '/metrics'
    const wantsServerTiming = options?.serverTiming ?? true
    const log = options?.log

    const registry = new Registry()
    const requests = registry.register(new Counter(
      'http_requests_total', 'Requests by method, route template and status.',
      ['method', 'route', 'status'],
    ))
    const duration = registry.register(new Histogram(
      'http_request_duration_seconds', 'Wall-clock time to the last flushed byte.',
      ['method', 'route'],
    ))
    // Reads 1 on an idle process, because the scrape that renders it is itself
    // in flight. True rather than wrong, and the same in every other client
    // library — worth knowing before someone alerts on it.
    const inFlight = registry.register(new Gauge(
      'http_requests_in_flight', 'Requests currently being served.',
    ))
    const errors = registry.register(new Counter(
      'http_request_errors_total', 'Errors by stable Zen error code (§I7).',
      ['route', 'code'],
    ))
    const stages = registry.register(new Counter(
      'http_request_stage_seconds_total', 'Cumulative time per pipeline stage.',
      ['route', 'stage'],
    ))

    const timing = app.slot<Timing>('timing')

    // The frozen graph, once, before the first request — §10.2. Every fact this
    // plugin needs about a route is already in it, so nothing has to be
    // discovered per request (I1).
    const stageMasks = new Map<string, StageMask>()
    app.onBoot((graph) => {
      for (const route of (graph as AppGraph).routes) {
        stageMasks.set(route.id, {
          parse: route.schema.body !== undefined,
          validate: VALIDATED_SOURCES.some((source) => route.schema[source] !== undefined),
        })
      }
    })

    // ── stage 5 — the clock starts before the body is read ─────────────────
    app.hook('onRequest', (ctx: ObservabilityContext) => {
      const now = performance.now()
      ctx.set(timing, {
        start: now, mark: now, route: UNMATCHED,
        parse: 0, validate: 0, handler: 0, epilogue: 0,
        hidden: false, stages: NO_STAGES,
      })
      inFlight.inc()
    }, 'metrics.start')

    // The route *template*, from the AppGraph. This is the line that makes the
    // cardinality claim true rather than aspirational.
    app.hook('onRoute', (ctx: ObservabilityContext, route: RouteInfo) => {
      const t = ctx.get(timing)
      t.route = route.path
      t.stages = stageMasks.get(route.id) ?? NO_STAGES
      // The scrape endpoint measuring itself is a feedback loop, not data.
      t.hidden = route.meta.get('hidden') === true
    }, 'metrics.route')

    // ── stage 6 — observing intake without consuming it ────────────────────
    // Returning nothing means "I am not the parser"; the registry still runs.
    // The phase exists on this route only because the route declares a body.
    app.hook('onParse', (ctx: ObservabilityContext) => {
      ctx.get(timing).mark = performance.now()
      return undefined
    }, 'metrics.parse')

    // ── stage 7 — validation, bracketed ────────────────────────────────────
    app.hook('preValidation', (ctx: ObservabilityContext) => {
      const t = ctx.get(timing)
      const now = performance.now()
      if (t.stages.parse) t.parse = now - t.mark
      t.mark = now
    }, 'metrics.preValidation')

    app.hook('postValidation', (ctx: ObservabilityContext) => {
      const t = ctx.get(timing)
      const now = performance.now()
      if (t.stages.validate) t.validate = now - t.mark
      t.mark = now
    }, 'metrics.postValidation')

    // ── stage 8 — the handler, bracketed ───────────────────────────────────
    app.hook('preHandler', (ctx: ObservabilityContext) => {
      ctx.get(timing).mark = performance.now()
    }, 'metrics.preHandler')

    app.hook('postHandler', (ctx: ObservabilityContext) => {
      const t = ctx.get(timing)
      const now = performance.now()
      t.handler = now - t.mark
      t.mark = now
    }, 'metrics.postHandler')

    // ── stage 9 — the epilogue, and the header the browser will render ─────
    if (wantsServerTiming) {
      app.hook('onSend', (ctx: ObservabilityContext, reply: Reply) => {
        const t = ctx.find(timing)
        if (t === undefined) return
        t.epilogue = performance.now() - t.mark
        reply.headers.set('server-timing', serverTiming(t))
      }, 'metrics.serverTiming')
    }

    // ── error accounting, by stable code rather than by message ────────────
    app.hook('onError', (ctx: ObservabilityContext, error: unknown) => {
      const code = (error as { code?: string }).code ?? 'ZEN_INTERNAL'
      errors.inc({ route: ctx.find(timing)?.route ?? UNMATCHED, code })
      // Returning nothing: this hook observes, it does not handle.
    }, 'metrics.error')

    // ── stage 10 — after the last byte, which is the only honest total ─────
    app.hook('onResponse', (ctx: ObservabilityContext, reply: Reply) => {
      const t = ctx.find(timing)
      inFlight.dec()
      if (t === undefined || t.hidden) return

      const durationMs = performance.now() - t.start
      const labels = { method: ctx.method, route: t.route }

      requests.inc({ ...labels, status: String(reply.status) })
      duration.observe(labels, durationMs / 1000)
      for (const stage of ['parse', 'validate', 'handler', 'epilogue'] as const) {
        if (t[stage] > 0) stages.inc({ route: t.route, stage }, t[stage] / 1000)
      }

      log?.({
        requestId: ctx.id,
        method: ctx.method,
        route: t.route,
        status: reply.status,
        durationMs,
        stages: { parse: t.parse, validate: t.validate, handler: t.handler, epilogue: t.epilogue },
        aborted: ctx.aborted,
      })
    }, 'metrics.finish')

    // ── the scrape endpoint ────────────────────────────────────────────────
    // A plugin route goes through the same registry as `app.get`, so a
    // collision with an application route is a boot error naming both rather
    // than a silent shadowing (§10.2). `hidden` keeps it out of its own
    // numbers and out of the OpenAPI document.
    app.route({
      method: 'GET',
      path,
      name: 'observability.metrics',
      meta: { hidden: true },
      handler: (ctx: { text(body: string, init?: { headers?: Record<string, string> }): Reply }) =>
        ctx.text(registry.expose(), {
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
        }),
    })

    return { exports: { registry, requests, duration, errors, stages, inFlight } }
  },
})

/**
 * `Server-Timing` — the per-stage numbers, delivered to the client.
 *
 * Chrome and Firefox render this in the network panel, so the pipeline
 * breakdown that §31.3 describes as a tracing feature is available with no
 * tracing backend at all. Stages that did not run are omitted rather than
 * reported as zero: a GET has no parse stage, and a `parse;dur=0` would be a
 * claim that parsing took no time rather than that it did not happen.
 */
function serverTiming(t: Timing): string {
  const parts: string[] = []
  if (t.parse > 0) parts.push(`parse;dur=${round(t.parse)}`)
  if (t.validate > 0) parts.push(`validate;dur=${round(t.validate)}`)
  if (t.handler > 0) parts.push(`handler;dur=${round(t.handler)}`)
  if (t.epilogue > 0) parts.push(`epilogue;dur=${round(t.epilogue)}`)
  parts.push(`total;dur=${round(performance.now() - t.start)}`)
  return parts.join(', ')
}

function round(ms: number): string {
  return ms.toFixed(3)
}
