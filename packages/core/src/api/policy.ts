import type { ConfigOverlay } from '../contracts/config.ts'
import type { TimeoutSpec } from '../contracts/deadline.ts'
import type { LogLevel } from '../contracts/logger.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import type { ResolvedConfigResult } from '../registry/config-store.ts'
import type { BodyOptions } from '../runtime/body.ts'
import type { RedirectOptions } from '../runtime/redirect.ts'
import { Codes } from '../errors/codes.ts'
import { BODY_DEFAULTS } from '../runtime/body.ts'

/**
 * Request policy as configuration — rfcs/0001 §16.1, §19.2.
 *
 * `timeout`, `body`, `redirect`, `trustProxy`, `maxQueryParams` and the HTTP
 * ingress limits were application options with no layer and no source, which
 * was the one reason "where did this 30-second budget come from" had no answer
 * in `explainConfig`. They are configuration now, under `policy`, with the
 * framework's defaults at layer 1; the `zen({ … })` options that set them are
 * sugar contributing at layer `config` under the source name `zen()`, so
 * nothing written against them breaks and every value gains a source:
 *
 *     policy.timeout.default        30s     ← zen()
 *     policy.redirect.allowExternal […]     ← zen.config
 *     policy.http.maxRequestsPerSocket 1000 ← profile: hardened
 *
 * Within layer `config` the configuration file wins over the `zen()` call:
 * the file is where a value computed from the environment lives, and a
 * deployment that sets `TIMEOUT` should be able to beat a literal in code.
 */

export type ResponseValidation = 'error' | 'log' | 'off' | { readonly sample: number }

/** The settings `ready()` reads from configuration, checked and resolved. */
export interface Policy {
  /** The app-wide deadline, or `undefined` when there is none. */
  readonly timeout: TimeoutSpec | undefined
  /** The inbound header that may shorten it (§4.4), lower-cased, or `undefined`. */
  readonly timeoutHeader: string | undefined
  readonly body: BodyOptions
  readonly maxQueryParams: number
  readonly trustProxy: boolean | number
  /** Whether `policy.trustProxy` was set anywhere — the hardened profile requires it. */
  readonly trustProxyExplicit: boolean
  readonly redirect: RedirectOptions
  /** Passed to the adapter at `listen()`, where an explicit adapter option still wins. */
  readonly http: { readonly maxUrlLength?: number; readonly maxRequestsPerSocket?: number; readonly maxHeaderSize?: number }
  readonly strict: boolean
  readonly responseValidation: { readonly mode: 'error' | 'log' | 'off'; readonly sample: number }
  readonly healthDetails: boolean
  readonly logging: { readonly level: LogLevel; readonly redact: readonly string[] }
}

/** What `zen()` takes and turns into configuration. */
export interface PolicyOptions {
  readonly timeout?: TimeoutSpec | { readonly default?: TimeoutSpec | undefined; readonly header?: string | undefined } | undefined
  readonly body?: Partial<BodyOptions> | undefined
  readonly redirect?: RedirectOptions | undefined
  readonly trustProxy?: boolean | number | undefined
  readonly maxQueryParams?: number | undefined
  readonly serialization?: { readonly strict?: boolean | undefined } | undefined
  readonly validation?: { readonly response?: ResponseValidation | undefined } | undefined
  readonly health?: { readonly details?: boolean | undefined } | undefined
}

export const PROFILES = ['hardened'] as const
export type Profile = (typeof PROFILES)[number]

/**
 * The defaults that depend on `dev` — layer 1, beside `CONFIG_DEFAULTS`,
 * under the same source name. A development build throws on a response that
 * does not match its schema and logs at `debug`; a production one does
 * neither unless configured to.
 */
export function devDefaults(dev: boolean): ConfigOverlay {
  return {
    layer: 'default',
    name: 'default',
    values: {
      serialization: { strict: dev },
      validation: { response: dev ? 'error' : 'off' },
      logging: { level: dev ? 'debug' : 'info' },
    },
  }
}

/**
 * The hardened profile — §19.2's table as a named source in layer 1, after
 * the framework's own defaults and before plugins. A profile is configuration,
 * not composition: it registers nothing (`securityHeaders()` is still the
 * application's line to write), and every value it sets can be beaten by any
 * later layer, which `explainConfig` shows as `← profile: hardened`.
 */
export function profileDefaults(profile: Profile, dev: boolean): ConfigOverlay {
  return {
    layer: 'default',
    name: `profile: ${profile}`,
    values: {
      policy: {
        timeout: { default: '30s' },
        http: { maxUrlLength: 8192, maxRequestsPerSocket: 1000 },
        redirect: { allowExternal: false },
      },
      health: { details: false },
      // §13.3.4 — strict serialization throws on a wrong value; in production
      // the hardened answer is to log it (response validation) and serve.
      ...(dev ? {} : { serialization: { strict: false }, validation: { response: 'log' } }),
    },
  }
}

/** `zen({ timeout, body, … })` as a layer-`config` source named `zen()`. */
export function optionsOverlay(options: PolicyOptions): ConfigOverlay | null {
  const policy: Record<string, unknown> = {}
  const values: Record<string, unknown> = {}
  if (options.timeout !== undefined) {
    const timeout = options.timeout
    if (typeof timeout === 'object' && timeout !== null) {
      const spec: Record<string, unknown> = {}
      if (timeout.default !== undefined) spec['default'] = timeout.default
      if (timeout.header !== undefined) spec['header'] = timeout.header
      policy['timeout'] = spec
    } else {
      policy['timeout'] = { default: timeout }
    }
  }
  if (options.body !== undefined) {
    const body: Record<string, unknown> = {}
    for (const key of ['maxSize', 'maxDepth', 'maxFields'] as const) {
      if (options.body[key] !== undefined) body[key] = options.body[key]
    }
    policy['body'] = body
  }
  if (options.redirect?.allowExternal !== undefined) policy['redirect'] = { allowExternal: options.redirect.allowExternal }
  if (options.trustProxy !== undefined) policy['trustProxy'] = options.trustProxy
  if (options.maxQueryParams !== undefined) policy['maxQueryParams'] = options.maxQueryParams
  if (Object.keys(policy).length > 0) values['policy'] = policy
  if (options.serialization?.strict !== undefined) values['serialization'] = { strict: options.serialization.strict }
  if (options.validation?.response !== undefined) values['validation'] = { response: options.validation.response }
  if (options.health?.details !== undefined) values['health'] = { details: options.health.details }
  return Object.keys(values).length === 0 ? null : { layer: 'config', name: 'zen()', values }
}

/**
 * Read the policy off the resolved configuration, refusing what cannot be
 * honoured — each refusal a `ZEN_CONFIG_INVALID` naming the path, the value
 * and the source that set it, so the fix is one look away.
 */
export function readPolicy(config: ResolvedConfigResult): { readonly policy: Policy; readonly diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const tree = config.config
  const sources = new Map(config.snapshot.values.map((v) => [v.path, v]))
  const at = (path: string): unknown => {
    let node: unknown = tree
    for (const key of path.split('.')) {
      if (typeof node !== 'object' || node === null) return undefined
      node = (node as Record<string, unknown>)[key]
    }
    return node
  }
  const refuse = (path: string, expected: string, hint: string): void => {
    const row = sources.get(path)
    diagnostics.push({
      severity: 'error',
      code: Codes.CONFIG_INVALID,
      message: `${path} is ${JSON.stringify(at(path)) ?? String(at(path))}, which is not ${expected}.`,
      hint,
      ...(row === undefined ? {} : { locations: [`${path} ← ${row.source}`] }),
    })
  }
  const whole = (path: string, fallback: number, floor: number, unit: string): number => {
    const value = at(path)
    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isInteger(value) && value >= floor) return value
    refuse(path, `a whole number of ${unit}, at least ${floor}`, `Set ${path} to a number — or leave it out for the default, ${fallback}.`)
    return fallback
  }
  const optionalWhole = (path: string, floor: number): number | undefined => {
    const value = at(path)
    if (value === undefined) return undefined
    if (typeof value === 'number' && Number.isInteger(value) && value >= floor) return value
    refuse(path, `a whole number, at least ${floor}`, `Set ${path} to a number, or leave it out to keep the adapter's default.`)
    return undefined
  }
  const flag = (path: string, fallback: boolean): boolean => {
    const value = at(path)
    if (value === undefined) return fallback
    if (typeof value === 'boolean') return value
    refuse(path, 'true or false', `Set ${path} to a boolean.`)
    return fallback
  }

  // §4.4 — the deadline: a duration, or `false` for none. A string that does
  // not parse is passed through, so the route loop reports it as it always
  // has — `ZEN_TIMEOUT_INVALID`, naming every route that inherits it.
  let timeout: TimeoutSpec | undefined
  const declared = at('policy.timeout.default')
  if (declared === undefined || declared === false) timeout = undefined
  else if (typeof declared === 'number' || typeof declared === 'string') timeout = declared as TimeoutSpec
  else refuse('policy.timeout.default', 'a duration', 'Use "30s", 30000, or false for no deadline.')

  const headerValue = at('policy.timeout.header')
  let timeoutHeader: string | undefined
  if (headerValue === undefined || headerValue === false) timeoutHeader = undefined
  else if (typeof headerValue === 'string' && headerValue !== '') timeoutHeader = headerValue.toLowerCase()
  else refuse('policy.timeout.header', 'a header name', 'Name the inbound header that may shorten the deadline, e.g. "x-request-timeout", or false.')

  // §19.4 — how many proxies to believe.
  const trustValue = at('policy.trustProxy')
  let trustProxy: boolean | number = false
  if (typeof trustValue === 'boolean') trustProxy = trustValue
  else if (typeof trustValue === 'number' && Number.isInteger(trustValue) && trustValue >= 0) trustProxy = trustValue
  else if (trustValue !== undefined) {
    refuse('policy.trustProxy', 'true, false, or the number of proxies in front of the app', 'Set it to how many proxies there are — 1 for one load balancer.')
  }
  const trustRow = sources.get('policy.trustProxy')
  const trustProxyExplicit = trustRow !== undefined && trustRow.layer !== 'default'

  const response = at('validation.response')
  let responseValidation: Policy['responseValidation'] = { mode: 'off', sample: 1 }
  if (response === 'error' || response === 'log' || response === 'off') responseValidation = { mode: response, sample: 1 }
  else if (typeof response === 'object' && response !== null && 'sample' in response) {
    const sample = (response as { sample: unknown }).sample
    if (typeof sample === 'number' && Number.isInteger(sample) && sample >= 1) responseValidation = { mode: 'log', sample }
    else refuse('validation.response', "'error', 'log', 'off', or { sample: n } with n a whole number of at least 1", 'Sample one response in n — { sample: 100 } — or choose a mode.')
  } else if (response !== undefined) {
    refuse('validation.response', "'error', 'log', 'off' or { sample: n }", "Choose 'error' (throw), 'log' (report and serve), or 'off'.")
  }

  const level = at('logging.level')
  const levels: readonly string[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
  let logLevel: LogLevel = 'info'
  if (typeof level === 'string' && levels.includes(level)) logLevel = level as LogLevel
  else if (level !== undefined) refuse('logging.level', `one of ${levels.join(', ')}`, 'Choose a level.')

  const redactValue = at('logging.redact')
  let redact: readonly string[] = []
  if (Array.isArray(redactValue) && redactValue.every((p) => typeof p === 'string' && p !== '')) redact = redactValue as string[]
  else if (redactValue !== undefined) refuse('logging.redact', 'a list of paths', "List what to hide: ['**.password', 'req.headers.authorization'].")

  const allow = at('policy.redirect.allowExternal')
  const policy: Policy = {
    timeout,
    timeoutHeader,
    body: {
      maxSize: whole('policy.body.maxSize', BODY_DEFAULTS.maxSize, 1, 'bytes'),
      maxDepth: whole('policy.body.maxDepth', BODY_DEFAULTS.maxDepth, 0, 'levels'),
      maxFields: whole('policy.body.maxFields', BODY_DEFAULTS.maxFields, 1, 'fields'),
    },
    maxQueryParams: whole('policy.maxQueryParams', 100, 1, 'parameters'),
    trustProxy,
    trustProxyExplicit,
    redirect: { allowExternal: allow as RedirectOptions['allowExternal'] },
    http: definedOnly({
      maxUrlLength: optionalWhole('policy.http.maxUrlLength', 1),
      maxRequestsPerSocket: optionalWhole('policy.http.maxRequestsPerSocket', 0),
      maxHeaderSize: optionalWhole('policy.http.maxHeaderSize', 1),
    }),
    strict: flag('serialization.strict', false),
    responseValidation,
    healthDetails: flag('health.details', false),
    logging: { level: logLevel, redact },
  }
  return { policy, diagnostics }
}

function definedOnly<T extends Record<string, number | undefined>>(record: T): { [K in keyof T]?: number } {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
  return out as { [K in keyof T]?: number }
}
