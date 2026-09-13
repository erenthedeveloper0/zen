import type { Duration } from 'zen'

/**
 * Configuration — a plain module until §16 lands.
 *
 * `examples/openapi` established the convention and the reason: putting it in
 * `src/config/` now means that when `defineConfig` and env validation arrive,
 * this file gains a schema and its importers do not move.
 *
 * The cast on `requestTimeout` below is worth reading rather than skipping. A
 * `Duration` is a template literal type, so `'2 seconds'` is a compile error
 * where it is *written* — but nothing can make that true of a string that
 * arrived from the environment at runtime. That gap is exactly why a bad
 * duration is also a **boot diagnostic** (`ZEN_TIMEOUT_INVALID`) rather than
 * only a type error: `REQUEST_TIMEOUT=2 seconds npm start` fails at boot,
 * naming the scope, before a single request is served. Two mechanisms for one
 * mistake, because the type can only reach half of it.
 */
export const config = {
  port: Number(process.env['PORT'] ?? 3000),

  /**
   * The default budget for every route that does not declare its own.
   *
   * This is the line the whole example is about. Without it a handler that
   * never returns holds its connection, its socket and its place in the event
   * loop until the process is restarted — and nothing in the framework, the
   * logs or the metrics says so.
   */
  requestTimeout: (process.env['REQUEST_TIMEOUT'] ?? '2s') as Duration,

  /**
   * The header a caller may use to say how long *it* is willing to wait.
   *
   * Only ever shortens our budget (see §4.4). A gateway with 300 ms left before
   * its own client gives up should not have us spend two seconds producing an
   * answer that will be thrown away at the door.
   */
  timeoutHeader: 'x-request-timeout',

  /**
   * Time reserved out of every fan-out budget for our own epilogue.
   *
   * If three providers are each given the *entire* remaining budget, the last
   * one to answer leaves nothing for serialization and the write, and the
   * request times out having done all of the work. Reserving a slice is what
   * turns "we called everything in parallel" into "we answered".
   */
  egressReserveMs: 60,

  /** Simulated provider latencies, in ms. `slow` deliberately exceeds the budget. */
  providers: {
    fast: 20,
    steady: 90,
    slow: 5_000,
  },
} as const

export type ProviderName = keyof typeof config.providers
