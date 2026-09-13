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

export const BadRequest = http(400, Codes.BODY_INVALID, 'Bad Request')
export const Unauthorized = http(401, Codes.UNAUTHORIZED, 'Unauthorized')
export const Forbidden = http(403, Codes.FORBIDDEN, 'Forbidden')
export const NotFound = http(404, Codes.NOT_FOUND, 'Not Found')
export const MethodNotAllowed = http(405, Codes.METHOD_NOT_ALLOWED, 'Method Not Allowed')
export const NotAcceptable = http(406, Codes.NOT_ACCEPTABLE, 'Not Acceptable')
export const RequestTimeout = http(408, Codes.TIMEOUT, 'Request Timeout')
export const Conflict = http(409, Codes.CONFLICT, 'Conflict')
export const PayloadTooLarge = http(413, Codes.BODY_TOO_LARGE, 'Payload Too Large')
export const UnsupportedMediaType = http(415, Codes.UNSUPPORTED_MEDIA_TYPE, 'Unsupported Media Type')
export const TooManyRequests = http(429, Codes.RATE_LIMITED, 'Too Many Requests')
export const Internal = http(500, Codes.INTERNAL, 'Internal Server Error')
export const ServiceUnavailable = http(503, Codes.INTERNAL, 'Service Unavailable')
/** A deadline blown after intake — §4.4. 408 is for the client being slow; this
 *  one says the time was ours, which is a different alert and a different fix. */
export const GatewayTimeout = http(504, Codes.TIMEOUT, 'Gateway Timeout')

export interface Issue {
  readonly path: readonly (string | number)[]
  readonly code: string
  readonly message: string
  readonly expected?: string | undefined
  readonly received?: string | undefined
}

/**
 * Normalised across schema libraries (§11.2) — a Zod app and a Valibot app
 * produce byte-identical error envelopes, so clients and generated SDKs can
 * rely on `issues[].code` across the whole ecosystem.
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
