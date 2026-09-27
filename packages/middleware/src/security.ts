import { definePlugin, type Plugin } from '@erenthedeveloper0/zen-core'
import { assertCorsCorpConsistent } from './consistency.ts'
import type { CorsExports } from './cors.ts'
import type { Staging } from './shared.ts'

/**
 * Security response headers — rfcs/0001 §19.2.
 *
 * The header set is §19.2's table, and the table is the specification: every
 * default here appears there with the sentence explaining why it is not looser.
 * Nothing is invented in this file.
 *
 * ### Staged, so failures carry them too
 *
 * Same reason as `cors.ts`: an `after` middleware never runs on the error path
 * (§4.6) or on an unmatched request, so a service that stamps `nosniff` in
 * middleware does not have it on its 404s, its 500s or its validation errors —
 * which are precisely the responses most likely to contain reflected input.
 * `ctx.res` stages, and `prepareForWire` applies at egress on every path.
 *
 * ### It runs first, and that is a correctness requirement
 *
 * Staging is only half the answer. `cors` answers a preflight by returning a
 * `Reply`, and `rate-limit` refuses by throwing — both short-circuit the
 * `onRequest` chain, so a hook registered after them does not run at all on the
 * responses that need it most. The first draft of this pack ordered
 * `securityHeaders` last and every preflight and every 429 went out without
 * `nosniff`; the manual end-to-end check found it before any test did, which is
 * convention #2 again. Hence `before:` on all three siblings.
 *
 * ### The contradiction it can catch that a library cannot
 *
 * See `consistency.ts`. Both this plugin and `cors` call the same check with
 * whatever the other has published, so whichever is registered second finds
 * both halves — the ordering above means that is normally `cors`.
 */

export type ReferrerPolicy =
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'origin'
  | 'origin-when-cross-origin'
  | 'same-origin'
  | 'strict-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url'

export interface SecurityHeadersOptions {
  /** `X-Content-Type-Options: nosniff`. Off is not a supported configuration; the flag exists for tests. */
  readonly noSniff?: boolean | undefined
  /** `X-Frame-Options`. `false` omits it — do that only when a CSP `frame-ancestors` replaces it. */
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false | undefined
  readonly referrerPolicy?: ReferrerPolicy | false | undefined
  /** `Cross-Origin-Opener-Policy`. */
  readonly crossOriginOpener?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false | undefined
  /**
   * `Cross-Origin-Resource-Policy`. Defaults to `same-site` rather than
   * `same-origin`: `same-origin` is the stricter reading of §19.2's
   * "conservative", and it is also the value that silently breaks a CDN
   * subdomain serving the same site's assets. `same-site` blocks the
   * cross-*site* read that CORP exists to prevent and leaves the arrangement
   * every real deployment has intact.
   */
  readonly crossOriginResource?: 'same-origin' | 'same-site' | 'cross-origin' | false | undefined
  /**
   * `Strict-Transport-Security`. **Off by default**, and this is the one
   * default in the table that looks wrong until you have been bitten by it.
   *
   * §19.2 says "HSTS on when `secure: true`". A framework cannot tell whether
   * it is behind TLS — `ctx.secure` reads `X-Forwarded-Proto`, which §19.4
   * refuses to trust unless `trustProxy` is configured — so "on when secure"
   * resolves to "on when a header we do not trust says so". And HSTS is not a
   * header you can take back: a browser that has seen `max-age=31536000`
   * refuses plain HTTP to that host for a year, including on the developer's
   * own machine if it ever reached one. So it is opt-in, one line, in the file
   * that already knows it is behind a load balancer.
   */
  readonly hsts?: { readonly maxAge?: number; readonly includeSubDomains?: boolean; readonly preload?: boolean } | false | undefined
  /**
   * `Content-Security-Policy`, verbatim. **Not set by default** — §19.2: "a
   * wrong CSP is worse than none; we prompt instead of guessing." There is no
   * builder here for the same reason: a policy assembled from options reads as
   * if the framework vouched for it.
   */
  readonly contentSecurityPolicy?: string | false | undefined
  /** Extra headers, staged with the rest. */
  readonly headers?: Readonly<Record<string, string>> | undefined
}

/** One resolved header, so the set is data and the hook is a loop over it. */
type Pair = readonly [name: string, value: string]

export function securityHeaders(options: SecurityHeadersOptions = {}): Plugin<void, {}> {
  return definePlugin<void, {}>({
    name: 'security-headers',
    version: '0.1.0',
    // Before everything that can short-circuit. `cors` answers preflights and
    // `rate-limit` throws 429s; a hook that runs after either is absent from
    // exactly the responses §19.2 most wants these headers on. Hints on
    // unregistered plugins are ignored (§10.5 step 4), so this costs nothing
    // when the siblings are not installed.
    before: ['cors', 'rate-limit'],
    config: { namespace: 'security' },

    setup(app) {
      const pairs = resolve(options)
      const corp = options.crossOriginResource ?? 'same-site'
      assertCorsCorpConsistent(corp, app.exportsOf('cors') as CorsExports | undefined, app.pluginName)

      // Unrolled at boot into a fixed array; the hook is one loop over a frozen
      // list of string pairs, with no option reads and no branches per request.
      app.hook('onRequest', function securityHeaders(ctx: Staging): undefined {
        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i] as Pair
          ctx.res.header(pair[0], pair[1])
        }
        return undefined
      }, 'security-headers')

      return { exports: { headers: pairs.map(([name]) => name), crossOriginResource: corp } }
    },
  })
}

function resolve(options: SecurityHeadersOptions): readonly Pair[] {
  const out: Pair[] = []

  if (options.noSniff !== false) out.push(['x-content-type-options', 'nosniff'])

  const frame = options.frameOptions ?? 'DENY'
  if (frame !== false) out.push(['x-frame-options', frame])

  const referrer = options.referrerPolicy ?? 'no-referrer'
  if (referrer !== false) out.push(['referrer-policy', referrer])

  const coop = options.crossOriginOpener ?? 'same-origin'
  if (coop !== false) out.push(['cross-origin-opener-policy', coop])

  const corp = options.crossOriginResource ?? 'same-site'
  if (corp !== false) out.push(['cross-origin-resource-policy', corp])

  const hsts = options.hsts
  if (hsts !== undefined && hsts !== false) {
    const maxAge = hsts.maxAge ?? 15_552_000 // 180 days
    out.push([
      'strict-transport-security',
      `max-age=${maxAge}` +
        (hsts.includeSubDomains === true ? '; includeSubDomains' : '') +
        (hsts.preload === true ? '; preload' : ''),
    ])
  }

  const csp = options.contentSecurityPolicy
  if (typeof csp === 'string' && csp.length > 0) out.push(['content-security-policy', csp])

  for (const [name, value] of Object.entries(options.headers ?? {})) {
    out.push([name.toLowerCase(), value])
  }

  return Object.freeze(out)
}
