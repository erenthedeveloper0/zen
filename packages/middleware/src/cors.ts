import {
  definePlugin, parseDuration, Codes, ZenError,
  type AppGraph, type Duration, type HttpMethod, type Plugin, type Reply,
} from '@erenthedeveloper0/zen-core'
import { assertCorsCorpConsistent } from './consistency.ts'
import {
  BOOLEAN, DURATION, FUNCTION, REGEXP, STRING, STRINGS, either, headerOf, isPreflight, oneOf, optionsSchema,
  type CorsRequest, type OptionField, type Staging,
} from './shared.ts'

/**
 * CORS — rfcs/0001 §19.2, §4.2 stage 5, §9.2.
 *
 * ### Why this is a hook and not middleware
 *
 * `app.use(corsMiddleware)` — the shape every other framework uses — is
 * **bypassable**, and not in a subtle way. Phase middleware lives inside a
 * route's compiled pipeline, so it runs only when a route matched. A browser's
 * preflight is `OPTIONS /api/things`, and almost no application registers an
 * `OPTIONS` route; the request matches nothing, the pipeline never exists, and
 * the middleware never runs. Measured on this codebase before the design was
 * settled: over a matched `GET`, an unmatched path and a preflight, a `.use()`
 * middleware ran **1 of 3** times and a global `onRequest` hook ran **3 of 3**.
 *
 * §9.2 already says this in the paragraph that made global `onRequest` hooks
 * run on unmatched requests — "`onRequest` is the documented home for rate
 * limiting, CORS and auth, and a rate limiter that only sees matched routes is
 * bypassed by requesting a path that does not exist". CORS is the same defect
 * with a different symptom: not a bypass, but a preflight that never gets an
 * answer, which the browser reports as a CORS failure on the *actual* request
 * and which is therefore debugged in the wrong place.
 *
 * So every member of this pack is a global `onRequest` hook, and therefore a
 * plugin: a plugin is the only registration surface that reaches global scope
 * while still carrying a manifest, a version and a config namespace (§10.1).
 *
 * ### Why it stages headers instead of writing them
 *
 * The response half of CORS is `Access-Control-Allow-Origin` on the *actual*
 * response — including the 404, the 429, the 422 and the 500. A middleware that
 * stamps the reply on the way out misses all of them: §4.6 says the error path
 * never re-enters user middleware, and an `after` middleware on a route that
 * did not match never runs at all. The classic symptom is a service whose
 * errors show up in the browser as CORS failures, so every error looks like a
 * configuration problem and nobody sees the actual status.
 *
 * `ctx.res` already solves this. Staged metadata is applied by `prepareForWire`
 * at egress (§13.6), which is downstream of *every* path — success, error,
 * timeout, and unmatched. So this hook stages, and one invariant covers all of
 * them: **CORS never writes a reply's headers.** The consequence is asserted in
 * `cors.test.ts` against a 404, a 500 and a rate-limited 429.
 *
 * ### The default is the absence of this plugin
 *
 * §19.2 says CORS is "deny all until configured", and that default is what a
 * Zen app already has: with no plugin registered, no `Access-Control-Allow-*`
 * header is ever emitted and every browser denies. Registering the plugin
 * *without* an allowlist is therefore not "the secure default" — it is a line
 * of code that asks for cross-origin access and does not say from where, which
 * is indistinguishable from a bug. It is a boot error naming the fix.
 */

export type CorsOrigin =
  | '*'
  | string
  | readonly string[]
  | RegExp
  | ((origin: string) => boolean)

export interface CorsOptions {
  /**
   * Who may read the response. **Required** — see the note above on why the
   * secure default is not registering this plugin at all.
   *
   * A string or list is matched by exact, case-sensitive comparison against the
   * whole `Origin` header (`https://app.acme.com`), because that is what the
   * header contains: a scheme, a host and an optional port, with no path and no
   * trailing slash. A trailing slash is the single most common way an allowlist
   * silently matches nothing, so it is a boot error rather than a mystery.
   */
  readonly origin?: CorsOrigin | undefined
  /**
   * Methods advertised on a preflight.
   *
   * Defaults to **the methods this application actually serves**, read off the
   * frozen `AppGraph` at boot. Every other framework hardcodes the same six
   * verbs, which advertises `DELETE` on a read-only API and `PUT` on a service
   * that has never had one — a small thing, but it is free here and it is the
   * kind of answer only a framework with a graph can give (§2.4).
   */
  readonly methods?: readonly HttpMethod[] | undefined
  /**
   * Request headers a cross-origin caller may send. `'reflect'` (the default)
   * echoes `Access-Control-Request-Headers`.
   *
   * Reflecting is safe and is not the same as trusting: the browser only asks
   * for headers the page itself set, and the server still validates every one
   * of them. What it costs is a `Vary`, which is why an explicit list is the
   * better answer for a cacheable API and why the two differ in what they emit.
   */
  readonly allowedHeaders?: readonly string[] | 'reflect' | undefined
  /** Response headers JavaScript may read. `Content-Type` and the other CORS-safelisted ones are always readable. */
  readonly exposedHeaders?: readonly string[] | undefined
  /** Allow cookies and `Authorization`. Cannot be combined with `origin: '*'`. */
  readonly credentials?: boolean | undefined
  /**
   * How long a browser may cache a preflight.
   *
   * Defaults to **10 minutes**, which is a deliberate non-zero. With no
   * `Access-Control-Max-Age` a browser re-preflights every few seconds, and
   * "my API is twice as slow from the browser" is the most common CORS
   * complaint that is not a misconfiguration. Ten minutes bounds how long a
   * revoked origin stays cached in one browser; Chrome caps the value at two
   * hours regardless.
   */
  readonly maxAge?: Duration | undefined
  /** `204` by default. Some legacy XHR stacks require `200` with a body. */
  readonly preflightStatus?: 200 | 204 | undefined
}

const DEFAULT_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']

/** What `cors` publishes for other plugins to read — see `security.ts`. */
export interface CorsExports {
  readonly origins: readonly string[] | 'any' | 'dynamic'
  readonly credentials: boolean
}

/**
 * Everything decided at boot, so the request path is comparisons and string
 * writes. `matcher` is the only branch that can be user code.
 */
interface Compiled {
  readonly anyOrigin: boolean
  readonly matcher: (origin: string) => boolean
  readonly credentials: boolean
  readonly allowHeaders: string | 'reflect' | null
  readonly exposeHeaders: string | null
  readonly maxAge: string | null
  readonly preflightStatus: 200 | 204
  /**
   * What the allowlist is, after configuration has been merged in — the shape
   * `consistency.ts` reads, and it lives here rather than being re-derived from
   * the written options because those are only half the answer once
   * `config.cors.origin` exists.
   */
  readonly origins: readonly string[] | 'any' | 'dynamic'
  /** True when the method set was named rather than left to the graph. */
  readonly methodsPinned: boolean
  /** Filled from the frozen graph in `onBoot` unless `methodsPinned`. */
  allowMethods: string
}

/** §10.5 step 2 — checked at boot, so `cors({ credential: true })` is refused with "did you mean "credentials"?". */
const OPTIONS = optionsSchema('cors', {
  origin: either(STRING, STRINGS, REGEXP, FUNCTION),
  methods: STRINGS,
  allowedHeaders: either(oneOf('reflect'), STRINGS),
  exposedHeaders: STRINGS,
  credentials: BOOLEAN,
  maxAge: DURATION,
  preflightStatus: oneOf(200, 204),
} satisfies Record<keyof CorsOptions, OptionField>)

export function cors(options: CorsOptions = {}): Plugin<void, {}> {
  return definePlugin<void, {}>({
    name: 'cors',
    version: '0.1.0',
    options: OPTIONS,
    boundOptions: options,
    // The pack orders itself (§10.5 step 4). A 429 or a 404 must carry
    // `Access-Control-Allow-Origin` or the browser reports a rate limit as a
    // CORS failure, so this hook has to be staged before the limiter can
    // short-circuit — whichever order the two `use()` calls appear in.
    before: ['rate-limit'],
    config: { namespace: 'cors', env: ['CORS_ORIGINS'] },

    setup(app) {
      const compiled = compile(options, app.config, app.pluginName)
      const exports: CorsExports = {
        origins: compiled.origins,
        credentials: compiled.credentials,
      }
      // The reciprocal half of the check in `consistency.ts`: whichever of the
      // two plugins is registered second sees both sides. `securityHeaders`
      // declares `before: ['cors']`, so in practice that is this one.
      const security = app.exportsOf('security-headers') as { crossOriginResource?: string | false } | undefined
      if (security !== undefined) {
        assertCorsCorpConsistent(security.crossOriginResource ?? 'same-site', exports, app.pluginName)
      }

      app.hook('onRequest', function cors(ctx: CorsRequest & Staging): Reply | undefined {
        // `Vary: Origin` first, and **before** the early return.
        //
        // The tempting shape is to read `Origin`, bail when it is absent, and
        // only then vary — every CORS library does it that way and it is
        // wrong for caching. A request with no `Origin` produces a response
        // with no `Access-Control-Allow-Origin`, which is a *different*
        // response; a shared cache that stored it without `Vary` would replay
        // it to a browser request that needed the header, and the browser
        // would deny a caller that is on the allowlist. The failure only
        // appears behind a CDN, only for some users, and never in a test.
        //
        // So the cost is one array push on every request in the application,
        // paid for a correctness property, and §32.3 measures it rather than
        // asserting it is small. The one configuration that skips it is a
        // literal `*` with no credentials, where the answer genuinely does not
        // depend on the origin.
        if (!compiled.anyOrigin) ctx.res.appendHeader('vary', 'origin')

        // Read through `raw` rather than `ctx.headers`, which materialises a
        // record of every header on first touch (§7.2). This hook runs on every
        // request in the application and must not be the reason that exists.
        const origin = headerOf(ctx, 'origin')
        if (origin === undefined) return undefined

        const preflight = isPreflight(ctx)
        const allowed = compiled.matcher(origin)

        if (allowed) {
          ctx.res.header('access-control-allow-origin', compiled.anyOrigin ? '*' : origin)
          if (compiled.credentials) ctx.res.header('access-control-allow-credentials', 'true')
          if (!preflight && compiled.exposeHeaders !== null) {
            ctx.res.header('access-control-expose-headers', compiled.exposeHeaders)
          }
        }

        if (!preflight) return undefined

        // ── preflight ───────────────────────────────────────────────────────
        // Answered here, before routing, body intake, validation and the
        // handler — which is the point of §4.2 stage 5. A preflight that
        // reached a route would have to be a route somebody wrote.
        ctx.res.appendHeader('vary', 'access-control-request-method')

        if (allowed) {
          ctx.res.header('access-control-allow-methods', compiled.allowMethods)
          if (compiled.allowHeaders === 'reflect') {
            const asked = headerOf(ctx, 'access-control-request-headers')
            ctx.res.appendHeader('vary', 'access-control-request-headers')
            if (asked !== undefined) ctx.res.header('access-control-allow-headers', asked)
          } else if (compiled.allowHeaders !== null) {
            ctx.res.header('access-control-allow-headers', compiled.allowHeaders)
          }
          if (compiled.maxAge !== null) ctx.res.header('access-control-max-age', compiled.maxAge)
        }

        // A disallowed origin still gets a well-formed 204 with no CORS
        // headers, which is what makes the browser deny. A 403 would say
        // "this origin is not on the list", and an allowlist that reports its
        // own contents is an allowlist you can enumerate.
        return ctx.empty(compiled.preflightStatus as 204)
      }, 'cors')

      // §2.4 — the graph is the one structure everything reads. The advertised
      // method set is a projection of it, computed once, so it cannot claim a
      // verb the router would answer 405 for.
      app.onBoot((graph) => {
        if (compiled.methodsPinned) return
        compiled.allowMethods = servedMethods(graph as AppGraph).join(', ')
      })

      // Spread rather than passed by reference: `PluginResult.exports` is a
      // `Record<string, unknown>`, and a named interface has no index signature.
      return { exports: { ...exports } }
    },
  })
}

/**
 * The verbs this application answers, `OPTIONS` excluded.
 *
 * `HEAD` is added whenever any `GET` exists, because §4.2 gives every `GET`
 * route a free `HEAD` that never appears as a `RouteRecord` — advertising the
 * declared set alone would omit a method the server demonstrably serves.
 */
function servedMethods(graph: AppGraph): HttpMethod[] {
  const seen = new Set<string>()
  for (const route of graph.routes) seen.add(route.method)
  if (seen.has('GET')) seen.add('HEAD')
  seen.delete('OPTIONS')
  const order: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']
  const out = order.filter((m) => seen.has(m))
  return out.length === 0 ? [...DEFAULT_METHODS] : out
}

/**
 * Options → the decided form, with everything that can be wrong reported here.
 *
 * Thrown rather than collected, because §12.7's aggregation is the *app's*
 * list and a plugin reaches it by throwing from `setup` — `ready()` wraps it
 * into a `ZEN_PLUGIN_OPTIONS` diagnostic that names the plugin and everything
 * that will now not load.
 */
function compile(
  written: CorsOptions,
  config: Readonly<Record<string, unknown>>,
  pluginName: string,
): Compiled {
  const options = merge(written, config, pluginName)
  const origin = options.origin

  if (origin === undefined) {
    throw new ZenError(
      Codes.CONFIG_INVALID,
      `${pluginName} needs an origin allowlist, and refuses to guess one.`,
      {
        status: 500,
        expose: false,
        hint:
          "Pass one — cors({ origin: ['https://app.example.com'] }) — or set `cors.origin` in " +
          'configuration so a deployment can supply it from CORS_ORIGINS.',
        consequence:
          'Not registering this plugin at all is the deny-everything default (§19.2): with no ' +
          'Access-Control-Allow-Origin header, every browser already denies. Registering it ' +
          'without a list is a request for cross-origin access that does not say from where.',
      },
    )
  }

  const anyOrigin = origin === '*'
  const credentials = options.credentials === true

  if (anyOrigin && credentials) {
    throw new ZenError(
      Codes.CONFIG_INVALID,
      `${pluginName} cannot combine origin: '*' with credentials: true.`,
      {
        status: 500,
        expose: false,
        hint: 'Name the origins that may send credentials, or drop credentials.',
        consequence:
          'Browsers reject the pair outright. The usual library "fix" is to reflect whatever ' +
          'Origin arrives, which turns an allowlist into allow-everyone while still reading ' +
          "like an allowlist — so this is refused rather than quietly repaired.",
      },
    )
  }

  const list = typeof origin === 'string' && !anyOrigin ? [origin]
    : Array.isArray(origin) ? (origin as readonly string[])
    : null

  if (list !== null) {
    for (const entry of list) {
      if (entry.endsWith('/') || entry.includes('/', 8)) {
        throw new ZenError(
          Codes.CONFIG_INVALID,
          `${pluginName}: "${entry}" is not an origin — an Origin header carries a scheme, host and optional port, and no path.`,
          {
            status: 500,
            expose: false,
            hint: `Use "${entry.replace(/\/+$/, '').replace(/^(\w+:\/\/[^/]+).*$/, '$1')}".`,
            consequence: 'A trailing slash matches no origin, so the allowlist would silently allow nothing.',
          },
        )
      }
    }
  }

  const matcher: (o: string) => boolean =
    anyOrigin ? () => true
    : list !== null
      ? list.length === 1
        // One origin is the common case and deserves a comparison rather than
        // a Set lookup; more than one, and the Set wins from about four.
        ? ((only) => (o) => o === only)(list[0] as string)
        : ((set) => (o) => set.has(o))(new Set(list))
    : origin instanceof RegExp
      // A fresh test each call: a global regex carries `lastIndex` between
      // calls and would match every other request. §19.3 forbids unbounded
      // backtracking in framework source; a user's own pattern is their
      // choice, and it is named in `explainRoute` as `cors`.
      ? ((re) => (o) => new RegExp(re.source, re.flags.replace('g', '')).test(o))(origin)
      : (origin as (o: string) => boolean)

  return {
    anyOrigin,
    matcher,
    credentials,
    allowHeaders:
      options.allowedHeaders === undefined ? 'reflect'
      : options.allowedHeaders === 'reflect' ? 'reflect'
      : options.allowedHeaders.length === 0 ? null
      : options.allowedHeaders.join(', '),
    exposeHeaders:
      options.exposedHeaders === undefined || options.exposedHeaders.length === 0
        ? null
        : options.exposedHeaders.join(', '),
    maxAge: maxAgeOf(options.maxAge),
    preflightStatus: options.preflightStatus ?? 204,
    origins:
      anyOrigin ? 'any'
      : list !== null ? [...list]
      : 'dynamic',
    methodsPinned: options.methods !== undefined,
    allowMethods: (options.methods ?? DEFAULT_METHODS).join(', '),
  }
}

function maxAgeOf(value: Duration | undefined): string | null {
  const ms = parseDuration(value ?? '10m')
  return ms <= 0 ? null : String(Math.floor(ms / 1000))
}

/**
 * `config.cors.*` under what the call site wrote — §16.1's precedence, applied
 * field by field.
 *
 * The first draft read only `origin` from configuration, and the example caught
 * it immediately: `zen.config.ts` declared `cors.credentials: true`, `cors()`
 * was called with no arguments, and the header was silently absent. Half a
 * feature is worse than none here, because "configuration is ignored" is
 * indistinguishable from "the browser is wrong" from the outside.
 *
 * Field by field rather than a spread for the same reason plugin defaults merge
 * that way (§16.1 layer 2): `cors({ credentials: true })` next to a config that
 * names the origins should end up with both, not with whichever object was
 * spread last.
 *
 * A config value of the wrong *shape* is a boot error rather than something
 * quietly dropped. `cors.origin: 42` is a mistake somebody made, and the two
 * ways to not report it — ignore it, or coerce it — are how an allowlist ends
 * up meaning something nobody wrote.
 */
function merge(
  written: CorsOptions,
  config: Readonly<Record<string, unknown>>,
  pluginName: string,
): CorsOptions {
  const namespace = config['cors']
  if (namespace === undefined || namespace === null) return written
  if (typeof namespace !== 'object' || Array.isArray(namespace)) {
    throw new ZenError(
      Codes.CONFIG_INVALID,
      `${pluginName}: config.cors must be an object of options, and is ${describe(namespace)}.`,
      {
        status: 500,
        expose: false,
        hint: 'Give it a namespace: `cors: { origin: env => env.CORS_ORIGINS.split(",") }`.',
        consequence: 'Nothing under config.cors can be read while it is not an object.',
      },
    )
  }

  const from = namespace as Record<string, unknown>
  const take = <K extends keyof CorsOptions>(key: K, ok: (value: unknown) => boolean): CorsOptions[K] | undefined => {
    const value = from[key]
    if (value === undefined) return undefined
    if (!ok(value)) {
      throw new ZenError(
        Codes.CONFIG_INVALID,
        `${pluginName}: config.cors.${key} is ${describe(value)}, which is not a valid ${key}.`,
        {
          status: 500,
          expose: false,
          hint: `Fix the value in the configuration file, or pass ${key} to cors() directly.`,
          consequence: 'Ignoring it would make the running configuration differ from the written one.',
        },
      )
    }
    return value as CorsOptions[K]
  }

  const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((e) => typeof e === 'string')

  return {
    origin: written.origin ?? take('origin', (v) =>
      typeof v === 'string' || isStringList(v) || v instanceof RegExp || typeof v === 'function'),
    methods: written.methods ?? take('methods', isStringList),
    allowedHeaders: written.allowedHeaders ?? take('allowedHeaders', (v) => v === 'reflect' || isStringList(v)),
    exposedHeaders: written.exposedHeaders ?? take('exposedHeaders', isStringList),
    credentials: written.credentials ?? take('credentials', (v) => typeof v === 'boolean'),
    maxAge: written.maxAge ?? take('maxAge', (v) => typeof v === 'number' || typeof v === 'string'),
    preflightStatus: written.preflightStatus ?? take('preflightStatus', (v) => v === 200 || v === 204),
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array (${JSON.stringify(value).slice(0, 40)})`
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${JSON.stringify(value)}`
}
