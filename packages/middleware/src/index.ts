/**
 * `@erenthedeveloper0/zen-middleware` — the first-party pack (rfcs/0001 §24.2, §25 M4, §32).
 *
 * Four plugins, one shape: **a global `onRequest` hook that stages response
 * metadata**. Both halves of that sentence are load-bearing and both were
 * decided by measurement rather than by taste — see §32.1 and §32.2, or the
 * header comment on `cors.ts`, which carries the numbers.
 *
 * What is *not* here, named rather than left as a silent gap:
 *
 * - **`compression` and `static`.** Both need a platform: `node:zlib` and
 *   `node:fs`. §14.1 already puts compression on the adapter boundary as a
 *   capability (`compression: 'native' | 'library' | 'none'`), which is the
 *   right home for it — a middleware package that imported `node:zlib` would
 *   be a package the edge adapters cannot load. They belong to an
 *   adapter-coupled package and are recorded in §28.8.
 * - **`timeout` and `body-limit`**, which §24.2 lists here. Both are already
 *   built into core as first-class route policy — §4.4's deadlines and §19.2's
 *   body limits — and a middleware wrapping them would be a second way to say
 *   the same thing, with its own precedence rules for the case where both are
 *   set. §24.2's row predates both features.
 */

export { cors, type CorsOptions, type CorsOrigin, type CorsExports } from './cors.ts'
export {
  securityHeaders, type SecurityHeadersOptions, type ReferrerPolicy,
} from './security.ts'
export { requestId, type RequestIdOptions } from './request-id.ts'
export {
  rateLimit, type RateLimitOptions, type RateLimitContext,
} from './rate-limit.ts'
export {
  MemoryStore, ReferenceStore, type Store, type Tally, type MemoryStoreOptions,
} from './store.ts'
