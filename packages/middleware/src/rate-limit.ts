import {
  definePlugin, parseDuration, Codes, TooManyRequests, ZenError,
  type Duration, type Plugin, type Reply,
} from '@visionpilot/zen-core'
import { MemoryStore, type Store, type Tally } from './store.ts'
import type { Answering, RawReading, Staging } from './shared.ts'

/**
 * Rate limiting — rfcs/0001 §9.2, §19.2, §19.4, Annex B `ZEN_RATE_LIMITED`.
 *
 * ### Why it is a hook, and why that is the whole feature
 *
 * §9.2 states the defect this design exists to avoid, in the paragraph that
 * made global `onRequest` hooks run on unmatched requests: *"a rate limiter
 * that only sees matched routes is bypassed by requesting a path that does not
 * exist."* Every framework whose rate limiter is route middleware has that
 * hole, and it is not theoretical — `GET /aaaa` is unmatched, so the limiter
 * never runs, so a 404 flood is free. A global `onRequest` hook counts it.
 *
 * §4.2 stage 5 puts it before body intake as well, so a request that is going
 * to be refused is refused **without its body being read**. A limiter that
 * counted after parsing would have already paid the expensive part.
 *
 * ### `Codes.RATE_LIMITED` was already here
 *
 * `TooManyRequests` and `ZEN_RATE_LIMITED` have been exported from
 * `@visionpilot/zen-core` since 0.1 and read by nothing — the same state `COERCION_DEFAULTS`
 * and `Codes.CONFIG_INVALID` were in before the two features that needed them.
 * Using it rather than inventing a 429 means the refusal is an ordinary
 * `HttpError`: it goes through the error engine, the RFC 9457 envelope, the
 * registered `onError` hooks and `onSend`, and it appears in the same error
 * dashboards as everything else. A rate limiter that answers with its own
 * hand-built response is one whose refusals no error rate counts.
 *
 * ### What it does not do
 *
 * It is a **fixed-window counter**, and `store.ts` explains what that costs at
 * the boundary. It is not distributed unless the `Store` is (§3.5). It does not
 * read `X-Forwarded-For` — that is `ctx.ip`, and §19.4 makes it a deliberate
 * `trustProxy` decision — but it *does* notice when the combination is the one
 * §19.4 warns about, once, at the moment it is provably real. See {@link warnProxy}.
 */

export interface RateLimitOptions {
  /** Requests per window, per key. */
  readonly limit?: number | undefined
  /** Window length. Fixed, not sliding — see `store.ts`. */
  readonly window?: Duration | undefined
  /**
   * What to count by. Defaults to `ctx.ip`.
   *
   * Return `null` to exempt a request entirely — that is how an authenticated
   * service account or an internal health poller opts out, and it is a
   * deliberate hole rather than a second allowlist option nobody would find.
   */
  readonly key?: ((ctx: RateLimitContext) => string | null) | undefined
  /** Where counters live. Defaults to an in-process {@link MemoryStore}. */
  readonly store?: Store | undefined
  /** Also emit `X-RateLimit-*`. Off by default: they were never standardised and they double the header cost. */
  readonly legacyHeaders?: boolean | undefined
  /** Emit `RateLimit` / `RateLimit-Policy` (IETF draft). On by default. */
  readonly standardHeaders?: boolean | undefined
  /** Message on the 429. The status, code and envelope are not configurable. */
  readonly message?: string | undefined
}

export interface RateLimitContext {
  readonly ip: string
  readonly method: string
  readonly path: string
  readonly id: string
  readonly raw: { header(name: never): string | undefined }
}

const DEFAULTS = { limit: 100, window: '1m' } as const

export function rateLimit(options: RateLimitOptions = {}): Plugin<void, {}> {
  return definePlugin<void, {}>({
    name: 'rate-limit',
    version: '0.1.0',
    config: { namespace: 'rateLimit', defaults: { limit: DEFAULTS.limit, window: DEFAULTS.window } },

    setup(app) {
      // §16.1 layer order: an explicit option beats the plugin's own layer-2
      // defaults, which a deployment can beat from configuration. Readable at
      // setup because §16.2 resolved the environment before any plugin ran.
      const namespace = (app.config['rateLimit'] ?? {}) as { limit?: unknown; window?: unknown }
      const limit = options.limit ?? numberOr(namespace.limit, DEFAULTS.limit)
      const windowMs = parseDuration(options.window ?? (namespace.window as Duration | undefined) ?? DEFAULTS.window)

      if (!Number.isInteger(limit) || limit < 1) {
        throw new ZenError(
          Codes.CONFIG_INVALID,
          `rateLimit needs a positive whole limit; got ${JSON.stringify(limit)}.`,
          {
            status: 500,
            expose: false,
            hint: 'Pass rateLimit({ limit: 100, window: "1m" }), or set rateLimit.limit in configuration.',
            consequence: 'A limit below one refuses every request, including the health probes an orchestrator uses to decide the pod is broken.',
          },
        )
      }

      // Annotated `Store`, not inferred: the inferred union of the supplied
      // store and `MemoryStore` drops the optional members, so `store.close?.()`
      // below would stop type-checking the moment the default is in play — for
      // an interface whose whole point is that the two are interchangeable.
      const store: Store = options.store ?? new MemoryStore({ windowMs })
      const keyOf = options.key ?? ((ctx: RateLimitContext) => ctx.ip)
      const standard = options.standardHeaders !== false
      const legacy = options.legacyHeaders === true
      const policy = `${limit};w=${Math.floor(windowMs / 1000)}`
      const message = options.message ?? `Rate limit exceeded: ${limit} requests per ${options.window ?? namespace.window ?? DEFAULTS.window}.`

      // One warning per process, not per request — §12.7's rule applied to a
      // runtime condition. See `warnProxy`.
      let warned = false

      app.hook('onRequest', function rateLimit(
        ctx: RateLimitContext & RawReading & Staging & Answering,
      ): Reply | undefined | Promise<Reply | undefined> {
        const key = keyOf(ctx)
        if (key === null) return undefined

        if (!warned && options.key === undefined) warned = warnProxy(ctx)

        const tally = store.hit(key, Date.now())
        // The in-memory store is synchronous and must stay on §8.4's fast path;
        // a Redis store is a round trip. Branching on the *value* rather than
        // declaring the hook async is what lets one implementation serve both
        // without making every app that uses the default await a resolved
        // promise per request.
        return isThenable(tally)
          ? tally.then((settled) => verdict(ctx, settled))
          : verdict(ctx, tally)
      }, 'rate-limit')

      app.hook('onClose', async () => { await store.close?.() })

      function verdict(ctx: Staging & Answering, tally: Tally): Reply | undefined {
        const remaining = Math.max(0, limit - tally.count)
        const resetSeconds = Math.max(0, Math.ceil((tally.resetAt - Date.now()) / 1000))

        // Staged, not stamped: the headers have to be on the 429 *and* on the
        // 200, and the 429 leaves through the error engine rather than through
        // this hook's return value. `ctx.res` is downstream of both (§13.6).
        if (standard) {
          ctx.res.header('ratelimit', `limit=${limit}, remaining=${remaining}, reset=${resetSeconds}`)
          ctx.res.header('ratelimit-policy', policy)
        }
        if (legacy) {
          ctx.res.header('x-ratelimit-limit', String(limit))
          ctx.res.header('x-ratelimit-remaining', String(remaining))
          ctx.res.header('x-ratelimit-reset', String(Math.ceil(tally.resetAt / 1000)))
        }

        if (tally.count <= limit) return undefined

        ctx.res.header('retry-after', String(resetSeconds))
        // Thrown, not returned. A returned `Reply` would leave the error engine,
        // the problem-details envelope and every registered `onError` hook out
        // of the one response class an operator most wants counted.
        throw new TooManyRequests(message, { retryable: true })
      }

      return { exports: { limit, windowMs, store } }
    },
  })
}

/**
 * §19.4's detection, without the traffic sampling.
 *
 * The dangerous combination is: rate limiting keyed on the client IP,
 * `trustProxy` off, and a proxy in front adding `X-Forwarded-For`. Then
 * `ctx.ip` is the load balancer for every request, every caller shares one
 * counter, and the limiter is globally throttling the service instead of
 * limiting anybody — which looks exactly like the service being slow.
 *
 * §19.4 assigns this to `zen doctor` "with traffic samples", and that is the
 * right home for the general check. But the specific one costs a header read on
 * the first request that could possibly exhibit it, and it fires only when the
 * misconfiguration is **already real**: a forwarding header is present and is
 * being ignored. A boot-time version could not do that — at boot, "trustProxy
 * is off" is also the correct configuration for a directly-exposed server, so a
 * warning then would fire on every correct app until people turned it off.
 *
 * Returns `true` so the caller latches it: one line per process, naming the fix.
 */
function warnProxy(ctx: RateLimitContext & RawReading): boolean {
  const forwarded = ctx.raw.header('x-forwarded-for')
  if (forwarded === undefined) return false
  // `ctx.ip` falls back to the socket address when trustProxy is off (§19.4),
  // so the two disagreeing *is* the condition — no need to read the option.
  const claimed = forwarded.split(',')[0]?.trim()
  if (claimed === undefined || claimed === ctx.ip) return false

  console.warn(
    `[zen] ${Codes.RATE_LIMITED}: rate limiting is keyed on ctx.ip, this request carried ` +
      `X-Forwarded-For: ${claimed}, and trustProxy is off — so it was counted as ${ctx.ip}. ` +
      'fix: set trustProxy to the number of proxies in front of the app — trustProxy: 1 for one ' +
      'load balancer — so ctx.ip is the address your proxy saw; not `true`, which reads the ' +
      'leftmost entry, and a client that writes its own X-Forwarded-For then gets a fresh budget ' +
      'per request. Or pass rateLimit({ key }) to count by something you control. ' +
      'also: until then every caller behind the proxy shares one counter, which throttles the ' +
      'whole service at the configured limit instead of limiting anyone. Reported once per process.',
  )
  return true
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function isThenable(value: unknown): value is Promise<Tally> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}
