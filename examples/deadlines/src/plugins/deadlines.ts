import { definePlugin } from '@erenthedeveloper0/zen'
import type { AppGraph, Reply, TimeoutInfo } from '@erenthedeveloper0/zen'

/**
 * Deadline instrumentation as pure hooks — rfcs/0001 §4.4, §9.
 *
 * This plugin exists to answer three questions a service with timeouts always
 * ends up asking at three in the morning, and which most services cannot
 * answer at all:
 *
 *   1. **Which routes are even bounded?** Read once from the frozen AppGraph at
 *      boot. A route with no budget is not a mystery to be inferred from a
 *      latency histogram; it is a field on a record.
 *   2. **Where does the time go when a deadline blows?** `onTimeout` is handed
 *      the *stage* — `intake`, `validate`, `handler` — because the compiled
 *      pipeline marked it on the way past. "Slow" and "slow in validation" are
 *      different bugs with different fixes.
 *   3. **How close is normal traffic to the limit?** A budget you never come
 *      near is a budget you have not tested; one you graze weekly is an
 *      incident waiting for a slow Tuesday. `onResponse` records the headroom
 *      on every request, not just the ones that failed.
 *
 * What it does *not* do is decide anything. It observes, it stamps a header,
 * and it counts. A plugin that started answering requests would be middleware
 * wearing a hook's clothes (§9.1).
 */

export interface DeadlineReport {
  readonly route: string
  readonly stage: TimeoutInfo['stage']
  readonly budgetMs: number
  readonly elapsedMs: number
}

export interface DeadlineOptions {
  /** Where the summary is served. */
  readonly path?: string
  /** Emit `x-deadline-ms` / `x-deadline-left-ms`, which is how you see headroom in curl. */
  readonly headers?: boolean
  readonly onTimeout?: ((report: DeadlineReport) => void) | undefined
}

/** What these hooks need from the context, declared structurally (§10.2). */
interface DeadlineContext {
  readonly method: string
  readonly path: string
  readonly route: { readonly id: string; readonly path: string; readonly meta: ReadonlyMap<string, unknown> } | null
  readonly deadline: number | null
  readonly timeLeft: number
  readonly timedOut: boolean
  readonly aborted: boolean
}

interface Stats {
  bounded: number
  unbounded: number
  /** `route → { budgetMs, timeouts, abandoned, tightestLeftMs }` */
  routes: Map<string, RouteStats>
}

export interface RouteStats {
  budgetMs: number | null
  from: string | null
  served: number
  timeouts: number
  abandoned: number
  /** The least headroom ever observed. The number that predicts the next page. */
  tightestLeftMs: number | null
}

const UNMATCHED = '<unmatched>'

export const deadlines = definePlugin<DeadlineOptions, {}>({
  name: 'deadlines',
  version: '1.0.0',

  setup(app, options) {
    const path = options?.path ?? '/deadlines'
    const wantsHeaders = options?.headers ?? true
    const report = options?.onTimeout

    const stats: Stats = { bounded: 0, unbounded: 0, routes: new Map() }

    // ── boot: which routes are bounded, and by whom ────────────────────────
    //
    // The AppGraph carries `route.timeout` because the deadline was resolved
    // at boot from the scope chain, exactly like the hooks and the middleware
    // (§4.4). Nothing here has to guess, and nothing has to be kept in sync:
    // this reads the same field the pipeline compiler read.
    app.onBoot((graph) => {
      for (const route of (graph as AppGraph).routes) {
        if (route.meta.get('hidden') === true) continue
        if (route.timeout === null) stats.unbounded++
        else stats.bounded++
        stats.routes.set(route.path, {
          budgetMs: route.timeout?.ms ?? null,
          from: route.timeout?.from ?? null,
          served: 0,
          timeouts: 0,
          abandoned: 0,
          tightestLeftMs: null,
        })
      }
    })

    // ── the budget, published to the caller ────────────────────────────────
    // `onSend` rather than `onResponse`, because a header has to exist before
    // the reply leaves — this is the difference the two phases are for.
    if (wantsHeaders) {
      app.hook('onSend', (ctx: DeadlineContext, reply: Reply) => {
        if (ctx.deadline === null) {
          reply.headers.set('x-deadline', 'none')
          return
        }
        reply.headers.set('x-deadline-left-ms', Math.max(0, Math.round(ctx.timeLeft)).toString())
      }, 'deadlines.header')
    }

    // ── the phase that only exists because there is a deadline arm ─────────
    //
    // Before §4.4 landed, registering this was a boot error: `onTimeout` was in
    // `UNAVAILABLE_PHASES` precisely so that nobody could ship an app that
    // believed it had timeout instrumentation and did not (§9.7).
    app.hook('onTimeout', (ctx: DeadlineContext, info: TimeoutInfo) => {
      const key = info.route ?? UNMATCHED
      const row = stats.routes.get(key)
      if (row !== undefined) row.timeouts++
      report?.({ route: key, stage: info.stage, budgetMs: info.budgetMs, elapsedMs: info.elapsedMs })
      // Nothing returned: this hook observes. Deciding what a timed-out request
      // should answer is the feature's business, not the instrumentation's —
      // `features/quotes` does exactly that, one scope in.
      void ctx
    }, 'deadlines.report')

    // ── headroom, on every request rather than only the failures ───────────
    app.hook('onResponse', (ctx: DeadlineContext) => {
      const key = ctx.route?.path ?? UNMATCHED
      const row = stats.routes.get(key)
      if (row === undefined) return
      row.served++
      // `aborted && !timedOut` is a client that hung up; `aborted && timedOut`
      // is a deadline we blew. Counting only one of them is how "we have no
      // slow requests" and "8% of clients give up" end up on the same dashboard.
      if (ctx.aborted && !ctx.timedOut) row.abandoned++
      if (ctx.deadline !== null && !ctx.timedOut) {
        const left = ctx.timeLeft
        if (row.tightestLeftMs === null || left < row.tightestLeftMs) {
          row.tightestLeftMs = Math.round(left)
        }
      }
    }, 'deadlines.headroom')

    // ── the summary ────────────────────────────────────────────────────────
    app.route({
      method: 'GET',
      path,
      name: 'deadlines.summary',
      meta: { hidden: true },
      // The endpoint that reports on budgets should not have one of its own to
      // trip over while it is reporting that everything else tripped over
      // theirs.
      schema: { timeout: false },
      // Named, not an arrow: `explainRoute` prints the handler's name, and
      // "anonymous" on the one line a reader was looking for defeats the point
      // of printing the chain (§8.5).
      handler: function deadlineSummary(ctx: { json(v: unknown): Reply }) {
        return ctx.json({
          bounded: stats.bounded,
          unbounded: stats.unbounded,
          routes: Object.fromEntries(stats.routes),
        })
      },
    })

    return { exports: { stats } }
  },
})
