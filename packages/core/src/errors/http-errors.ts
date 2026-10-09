import { Codes } from './codes.ts'
import { ZenError, type ZenErrorInit } from './zen-error.ts'

/** 4xx/5xx with named constructors — rfcs/0001 §12.2. */
export class HttpError extends ZenError {}

function http(status: number, code: string, defaultMessage: string) {
  return class extends HttpError {
    constructor(message: string = defaultMessage, init: ZenErrorInit = {}) {
      super(code, message, { ...init, status, expose: init.expose ?? status < 500 })
    }
  }
}

/**
 * A malformed request — `ZEN_BAD_REQUEST`.
 *
 * It carried `ZEN_BODY_INVALID` until `0.1.0-alpha.4`, so an invalid `Host`
 * header, which has nothing to do with a body, reported itself as one (I7: a
 * code has to mean something). A body that does not parse is `BodyInvalid`.
 */
export const BadRequest = http(400, Codes.BAD_REQUEST, 'Bad Request')
/** The body did not parse as its content type, or nests past `body.maxDepth`. */
export const BodyInvalid = http(400, Codes.BODY_INVALID, 'Bad Request')
export const Unauthorized = http(401, Codes.UNAUTHORIZED, 'Unauthorized')
export const Forbidden = http(403, Codes.FORBIDDEN, 'Forbidden')
export const NotFound = http(404, Codes.NOT_FOUND, 'Not Found')
export const MethodNotAllowed = http(405, Codes.METHOD_NOT_ALLOWED, 'Method Not Allowed')
export const NotAcceptable = http(406, Codes.NOT_ACCEPTABLE, 'Not Acceptable')
export const RequestTimeout = http(408, Codes.TIMEOUT, 'Request Timeout')
export const Conflict = http(409, Codes.CONFLICT, 'Conflict')
export const PayloadTooLarge = http(413, Codes.BODY_TOO_LARGE, 'Payload Too Large')
export const UnsupportedMediaType = http(415, Codes.UNSUPPORTED_MEDIA_TYPE, 'Unsupported Media Type')
/**
 * Well-formed and understood, and refused on its meaning — §12.2's taxonomy.
 * A schema failure is `ValidationError` (`ZEN_VALIDATION`), which carries the
 * issues; this is the one a handler throws itself.
 */
export const UnprocessableEntity = http(422, Codes.UNPROCESSABLE_ENTITY, 'Unprocessable Entity')
export const TooManyRequests = http(429, Codes.RATE_LIMITED, 'Too Many Requests')
export const Internal = http(500, Codes.INTERNAL, 'Internal Server Error')
/**
 * `ZEN_SERVICE_UNAVAILABLE`. It reached clients as `ZEN_INTERNAL` — the code
 * for an *unclassified* error — until `0.1.0-alpha.4`, so a 503 a handler
 * threw on purpose was indistinguishable from a bug (I7).
 */
export const ServiceUnavailable = http(503, Codes.SERVICE_UNAVAILABLE, 'Service Unavailable')
/** A deadline blown after intake — §4.4. 408 is for the client being slow; this
 *  one says the time was ours, which is a different alert and a different fix. */
export const GatewayTimeout = http(504, Codes.TIMEOUT, 'Gateway Timeout')

export interface Issue {
  /**
   * Which part of the request the issue is in — `params`, `query`, `headers`,
   * `cookies` or `body`. Present on every issue a route's schemas produce, so a
   * client can tell `query.page` from `body.page` when one response reports
   * both (§4.2 stage 7).
   */
  readonly source?: string | undefined
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly message: string
  readonly expected?: string | undefined
  readonly received?: string | undefined
}

/**
 * Normalised across schema libraries (§11.2) — a Zod app and a Valibot app
 * produce envelopes of the same shape. The `code` of each issue is inferred
 * from the library's message text for now, so it is not yet the same across
 * libraries, and a client should not switch on it across them (§28.8).
 */
export class ValidationError extends HttpError {
  readonly issues: readonly Issue[]
  readonly source: string

  constructor(source: string, issues: readonly Issue[], status: 400 | 422 = 422) {
    super(Codes.VALIDATION, `Validation failed for ${source}`, {
      status,
      expose: true,
      details: issues,
    })
    this.issues = issues
    this.source = source
  }
}

export function issue(
  path: string | readonly (string | number)[],
  code: string,
  message: string,
  extra?: { expected?: string; received?: string },
): Issue {
  return {
    path: typeof path === 'string' ? [path] : path,
    code,
    message,
    expected: extra?.expected,
    received: extra?.received,
  }
}
