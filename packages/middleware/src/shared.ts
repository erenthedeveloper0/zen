import type { ReplyBuilder, Reply, LowercaseName } from '@visionpilot/zen-core'

/**
 * What this pack touches on a context, declared structurally — §10.4.
 *
 * `Registrar.hook` takes a `Function` on purpose: a plugin is written before
 * the application's decoration set exists, so pinning its hooks to
 * `Context<never, X>` would reject the pattern for an `X` the author cannot
 * know. The convention the examples already follow is to declare exactly the
 * surface the hook uses (`examples/openapi/src/plugins/request-id.ts` declares
 * `{ id: string }` and nothing else), and the point of doing it is that a
 * middleware cannot quietly start depending on `ctx.user` later.
 *
 * These are split by concern rather than merged into one context type for the
 * same reason: `securityHeaders` may not read the request, and the type says so.
 */

/** Reading the request without materialising the header record. */
export interface RawReading {
  readonly method: string
  readonly raw: { header(name: LowercaseName): string | undefined }
}

/** Staging response metadata (§13.6) — applied at egress on every path. */
export interface Staging {
  readonly res: ReplyBuilder
}

/** Producing a reply from a hook, which is how a phase short-circuits (§9.2). */
export interface Answering {
  empty(status?: 204 | 205 | 304): Reply<null>
  json<T>(body: T, init?: { status?: number }): Reply<T>
}

export type CorsRequest = RawReading & Answering

/**
 * `ctx.raw.header` rather than `ctx.headers[name]`.
 *
 * `ctx.headers` is lazy and memoised, but the first touch walks every header
 * the adapter received and builds a record (`buildHeaders`, §7.2). These hooks
 * run on *every* request in the application, including the ones whose handlers
 * never look at a header, so making them the reason that record exists would be
 * a cost the application did not ask for — §9.4's rule applied to a plugin
 * rather than to the compiler.
 */
export function headerOf(ctx: RawReading, name: LowercaseName): string | undefined {
  return ctx.raw.header(name)
}

/**
 * A CORS preflight — an `OPTIONS` carrying `Access-Control-Request-Method`.
 *
 * Both halves are required by the Fetch standard and both are load-bearing
 * here: an `OPTIONS` without the header is an ordinary request for a resource's
 * options and may well have a route, and answering it with 204 would shadow
 * that route with something the application did not write.
 */
export function isPreflight(ctx: RawReading): boolean {
  return ctx.method === 'OPTIONS' && ctx.raw.header('access-control-request-method') !== undefined
}
