/**
 * The single source for Annex B of rfcs/0001.
 *
 * Error codes are public API and are covered by semver. Clients switch on
 * codes; humans read messages. Messages may change; codes may not.
 */
export const Codes = {
  // ── Boot / registration ───────────────────────────────────────────────────
  ROUTE_DUPLICATE: 'ZEN_ROUTE_DUPLICATE',
  ROUTE_AMBIGUOUS: 'ZEN_ROUTE_AMBIGUOUS',
  ROUTE_INVALID_PATH: 'ZEN_ROUTE_INVALID_PATH',
  /** `app.url()` named a route nothing registered — §5.7. */
  ROUTE_UNKNOWN: 'ZEN_ROUTE_UNKNOWN',
  /**
   * Parameters that disagree with a route's path template — §5.2, §5.7.
   * Produced at boot when a `params` schema requires a key its path does not
   * supply, and by `app.url()` when its parameters cannot build a URL the route
   * answers.
   */
  PARAM_MISMATCH: 'ZEN_PARAM_MISMATCH',
  PARAM_TYPE_UNKNOWN: 'ZEN_PARAM_TYPE_UNKNOWN',
  PLUGIN_MISSING: 'ZEN_PLUGIN_MISSING',
  PLUGIN_VERSION: 'ZEN_PLUGIN_VERSION',
  PLUGIN_CONFLICT: 'ZEN_PLUGIN_CONFLICT',
  PLUGIN_DUPLICATE: 'ZEN_PLUGIN_DUPLICATE',
  PLUGIN_CYCLE: 'ZEN_PLUGIN_CYCLE',
  PLUGIN_OPTIONS: 'ZEN_PLUGIN_OPTIONS',
  DECORATOR_CONFLICT: 'ZEN_DECORATOR_CONFLICT',
  SLOT_CONFLICT: 'ZEN_SLOT_CONFLICT',
  HOOK_PHASE_UNKNOWN: 'ZEN_HOOK_PHASE_UNKNOWN',
  HOOK_PHASE_UNAVAILABLE: 'ZEN_HOOK_PHASE_UNAVAILABLE',
  TIMEOUT_INVALID: 'ZEN_TIMEOUT_INVALID',
  HEALTH_CHECK_INVALID: 'ZEN_HEALTH_CHECK_INVALID',
  HEALTH_CHECK_DUPLICATE: 'ZEN_HEALTH_CHECK_DUPLICATE',
  HEALTH_CHECK_MISSING: 'ZEN_HEALTH_CHECK_MISSING',
  DI_MISSING: 'ZEN_DI_MISSING',
  DI_CYCLE: 'ZEN_DI_CYCLE',
  DI_LIFETIME: 'ZEN_DI_LIFETIME',
  SCHEMA_UNCONVERTIBLE: 'ZEN_SCHEMA_UNCONVERTIBLE',
  /** A declared response media type is not `type/subtype`, carries a
   *  parameter, is a wildcard, or is declared twice — §13.4. */
  MEDIA_TYPE_INVALID: 'ZEN_MEDIA_TYPE_INVALID',
  /** A declared response media type has no encoder. Registering one is the fix;
   *  booting anyway would send a JSON body under someone else's Content-Type. */
  MEDIA_TYPE_UNSUPPORTED: 'ZEN_MEDIA_TYPE_UNSUPPORTED',
  /** Two statuses on one route offer different media types. `Accept` is matched
   *  once, before the status exists, so the offer list cannot depend on it. */
  NEGOTIATION_INCONSISTENT: 'ZEN_NEGOTIATION_INCONSISTENT',
  /**
   * A response schema declares a property `writeOnly: true` — JSON Schema's
   * "may be sent, never returned" — so the serializer would return it. §13.3,
   * §16.2: the configuration store already reads the same keyword as a secret.
   */
  RESPONSE_WRITE_ONLY: 'ZEN_RESPONSE_WRITE_ONLY',
  /** A regular expression that can backtrack without bound — §19.3. A warning. */
  REGEX_UNSAFE: 'ZEN_REGEX_UNSAFE',
  CONFIG_INVALID: 'ZEN_CONFIG_INVALID',
  ENV_INVALID: 'ZEN_ENV_INVALID',
  CAPABILITY_UNAVAILABLE: 'ZEN_CAPABILITY_UNAVAILABLE',
  APP_FROZEN: 'ZEN_APP_FROZEN',
  APP_NOT_READY: 'ZEN_APP_NOT_READY',
  /** `generatedSource()` on an app built without `inspect` or `dev`, which
   *  keeps no generated source after boot — §3.4. */
  INSPECT_DISABLED: 'ZEN_INSPECT_DISABLED',
  BOOT_FAILED: 'ZEN_BOOT_FAILED',

  // ── Request-time ──────────────────────────────────────────────────────────
  VALIDATION: 'ZEN_VALIDATION',
  /** A malformed request that is not a body problem — an invalid `Host`, say. */
  BAD_REQUEST: 'ZEN_BAD_REQUEST',
  BODY_TOO_LARGE: 'ZEN_BODY_TOO_LARGE',
  /** The request target is longer than the adapter accepts — answered at
   *  ingress, before dispatch (§4.2 stage 2, §19.2). */
  URI_TOO_LONG: 'ZEN_URI_TOO_LONG',
  /** The body did not parse as its content type, or nests past the limit. */
  BODY_INVALID: 'ZEN_BODY_INVALID',
  /** Well-formed, and refused on its meaning — `UnprocessableEntity`. */
  UNPROCESSABLE_ENTITY: 'ZEN_UNPROCESSABLE_ENTITY',
  UNSUPPORTED_MEDIA_TYPE: 'ZEN_UNSUPPORTED_MEDIA_TYPE',
  NOT_ACCEPTABLE: 'ZEN_NOT_ACCEPTABLE',
  METHOD_NOT_ALLOWED: 'ZEN_METHOD_NOT_ALLOWED',
  NOT_FOUND: 'ZEN_NOT_FOUND',
  TIMEOUT: 'ZEN_TIMEOUT',
  RATE_LIMITED: 'ZEN_RATE_LIMITED',
  CSRF: 'ZEN_CSRF',
  UNAUTHORIZED: 'ZEN_UNAUTHORIZED',
  FORBIDDEN: 'ZEN_FORBIDDEN',
  CONFLICT: 'ZEN_CONFLICT',
  SLOT_EMPTY: 'ZEN_SLOT_EMPTY',
  SERIALIZATION: 'ZEN_SERIALIZATION',
  HEADER_INVALID: 'ZEN_HEADER_INVALID',
  /** `ctx.html()` was given something other than `SafeHtml`, or an `html`
   *  template put a value where escaping cannot make it safe — §19.5. */
  HTML_UNSAFE: 'ZEN_HTML_UNSAFE',
  /** `ctx.redirect()` would have sent the client off this origin, to an origin
   *  `redirect.allowExternal` does not name — the open redirect, refused. §19.5. */
  REDIRECT_EXTERNAL: 'ZEN_REDIRECT_EXTERNAL',
  /** `ctx.res` was written after the reply had gone to egress — §7.3. */
  REPLY_SENT: 'ZEN_REPLY_SENT',
  CONTEXT_ESCAPED: 'ZEN_CONTEXT_ESCAPED',
  HANDLER_NO_RETURN: 'ZEN_HANDLER_NO_RETURN',
  /**
   * The service cannot answer now — `ServiceUnavailable`, or an upstream call
   * that gave up on its own timeout (`AbortSignal.timeout`). Not `ZEN_INTERNAL`:
   * a 503 somebody threw on purpose is not an unclassified error.
   */
  SERVICE_UNAVAILABLE: 'ZEN_SERVICE_UNAVAILABLE',
  INTERNAL: 'ZEN_INTERNAL',
} as const

export type ZenCode = (typeof Codes)[keyof typeof Codes]

/**
 * Where every code is documented — one section per code, in the repository.
 *
 * This is also the `type` URI of every RFC 9457 problem document Zen writes, so
 * it is part of the error contract (I7) and has to be a URL the project
 * controls. It used to be `https://zenjs.dev/errors/`, a domain nobody had
 * registered: every error response from every Zen application pointed at an
 * address the first person to buy it would decide the content of.
 * `docs/errors.md` has a heading per code, and a test asserts it stays complete.
 */
export const DOCS_BASE = 'https://github.com/erenthedeveloper0/zen/blob/main/docs/errors.md#'

/** The documentation link for a code — GitHub's anchor for its heading. */
export function docsUrl(code: string): string {
  return DOCS_BASE + code.toLowerCase()
}
