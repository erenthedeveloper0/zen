import { Codes, docsUrl } from './codes.ts'

export interface ZenErrorInit {
  readonly status?: number | undefined
  readonly expose?: boolean | undefined
  readonly details?: unknown
  /** Internal only. Goes to logs, never to the client. */
  readonly meta?: Readonly<Record<string, unknown>> | undefined
  readonly cause?: unknown
  readonly retryable?: boolean | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  /**
   * What to *do* — rendered as `fix:` when this error becomes a boot
   * diagnostic (§12.7).
   *
   * Here rather than only on `Diagnostic` because a plugin's `setup` reports
   * problems by throwing (§10.6): `ready()` catches, and until it could read
   * these two fields off the error it rebuilt the diagnostic from the message
   * alone, so a plugin could state a message and nothing else. Every rule in
   * §12.7 applied to the framework's own diagnostics and to none of a
   * plugin's, which is the half of the ecosystem a user actually reads.
   */
  readonly hint?: string | undefined
  /** What else broke as a result — rendered as `also:`, never as a fix. */
  readonly consequence?: string | undefined
}

/**
 * The root of the taxonomy — rfcs/0001 §12.2.
 *
 * `expose` is the load-bearing field: it decides whether `message` and `details`
 * may reach a client. Nothing leaks by accident because the default for an
 * unclassified error is `expose: false`, and nothing useful is hidden by
 * accident because every deliberate HTTP error opts in.
 */
export class ZenError extends Error {
  readonly code: string
  readonly status: number
  readonly expose: boolean
  readonly details: unknown
  readonly meta: Readonly<Record<string, unknown>> | undefined
  readonly retryable: boolean
  readonly headers: Readonly<Record<string, string>> | undefined
  readonly hint: string | undefined
  readonly consequence: string | undefined

  constructor(code: string, message: string, init: ZenErrorInit = {}) {
    // One stack capture, not two. `super()` captures a stack as a side effect
    // of constructing an `Error`, and `captureStackTrace` below captured it
    // again to hide the constructor frames — so every `ZenError` paid for its
    // stack twice, which made `new NotFound()` ~3.7× the cost of a plain
    // `new Error()`. The first capture is suppressed; the second is the one
    // whose frames are worth reading.
    const limits = Error as unknown as { stackTraceLimit?: number | undefined }
    const limit = limits.stackTraceLimit
    limits.stackTraceLimit = 0
    try {
      super(message, init.cause !== undefined ? { cause: init.cause } : undefined)
    } finally {
      limits.stackTraceLimit = limit
    }
    this.name = new.target.name
    this.code = code
    this.status = init.status ?? 500
    this.expose = init.expose ?? this.status < 500
    this.details = init.details
    this.meta = init.meta
    this.retryable = init.retryable ?? false
    this.headers = init.headers
    this.hint = init.hint
    this.consequence = init.consequence
    Error.captureStackTrace?.(this, new.target)
  }

  /** The client-facing projection. Never includes `meta`, `cause`, or stack. */
  toProblem(instance: string, requestId: string): Record<string, unknown> {
    const problem: Record<string, unknown> = {
      type: docsUrl(this.code),
      title: this.expose ? this.message : defaultTitle(this.status),
      status: this.status,
      instance,
      code: this.code,
      requestId,
    }
    if (this.expose && this.details !== undefined) problem['errors'] = this.details
    return problem
  }
}

/**
 * Build an error without capturing a stack — rfcs/0001 §28.8.
 *
 * For the framework's *routine refusals* only: the 404 and 405 the dispatcher
 * answers when nothing matched, the 406 negotiation answers at stage 5, the
 * 404 for a file that is not there. Their stack is always the same few frames
 * of the dispatcher, it names nothing in the application, and capturing it was
 * most of what made a 404 cost ~6× a served request and a 406 ~10× — a free
 * amplification factor on the cheapest hostile traffic there is (§32.5,
 * §13.4.6).
 *
 * That was recorded as "a decision about what a developer sees in dev mode",
 * and the decision turns out to have one answer: a developer sees nothing
 * useful in that stack in any mode, because it never leaves the dispatcher.
 * An error the *application* throws — `throw new NotFound('User 7 not found')`
 * in a handler — is built normally and keeps its stack, which is the one that
 * points somewhere worth reading.
 *
 * `Error.stackTraceLimit` is V8's (and JavaScriptCore's). Where it is not
 * honoured, setting it is harmless and the error simply keeps its stack.
 */
export function withoutStack<T>(build: () => T): T {
  const limits = Error as unknown as { stackTraceLimit?: number | undefined }
  const limit = limits.stackTraceLimit
  limits.stackTraceLimit = 0
  try {
    return build()
  } finally {
    limits.stackTraceLimit = limit
  }
}

/** Not the user's fault. Never exposed, always logged at `error` or above. */
export class FrameworkError extends ZenError {
  constructor(code: string, message: string, init: ZenErrorInit = {}) {
    super(code, message, { ...init, status: init.status ?? 500, expose: false })
  }
}

export class BootError extends FrameworkError {
  readonly diagnostics: readonly Diagnostic[]

  constructor(diagnostics: readonly Diagnostic[]) {
    super(Codes.BOOT_FAILED, renderDiagnostics(diagnostics), { meta: { count: diagnostics.length } })
    this.diagnostics = diagnostics
  }
}

/**
 * §12.7 — boot problems are *aggregated and rendered*, not thrown one at a time.
 *
 * A developer adding a feature module typically has three or four registration
 * problems at once; a fail-fast framework turns that into four restart cycles.
 * The message must therefore be self-sufficient: a `BootError` that says only
 * "1 problem" and hides the detail on a property is exactly the failure this
 * section exists to prevent.
 */
export function renderDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error')
  const lines: string[] = [
    `Boot failed: ${errors.length} problem${errors.length === 1 ? '' : 's'}`,
    '',
  ]

  diagnostics.forEach((diagnostic, index) => {
    lines.push(`  ${index + 1}. ${diagnostic.code}  ${diagnostic.message}`)
    if (diagnostic.locations !== undefined && diagnostic.locations.length > 0) {
      lines.push(`     at ${diagnostic.locations.join('   ⇄   ')}`)
    }
    if (diagnostic.hint !== undefined) {
      lines.push(`     fix: ${diagnostic.hint}`)
    }
    // A consequence is not a fix. Printing "these plugins were not registered"
    // under `fix:` tells the reader to go and do something about a list they
    // cannot act on, and buries the actual remedy.
    if (diagnostic.consequence !== undefined) {
      lines.push(`     also: ${diagnostic.consequence}`)
    }
    lines.push(`     docs: ${docsUrl(diagnostic.code)}`)
    lines.push('')
  })

  return lines.join('\n')
}

export interface Diagnostic {
  readonly severity: 'error' | 'warning'
  readonly code: string
  readonly message: string
  /** What to *do*. Rendered as `fix:`. */
  readonly hint?: string | undefined
  /** What else broke as a result. Rendered as `also:` — never as a fix. */
  readonly consequence?: string | undefined
  readonly locations?: readonly string[] | undefined
}

function defaultTitle(status: number): string {
  // A 503 says "not now", and its own code says so (`ZEN_SERVICE_UNAVAILABLE`);
  // titling it "Internal Server Error" would contradict the code beside it.
  if (status === 503) return 'Service Unavailable'
  if (status >= 500) return 'Internal Server Error'
  if (status === 404) return 'Not Found'
  if (status === 403) return 'Forbidden'
  if (status === 401) return 'Unauthorized'
  if (status >= 400) return 'Bad Request'
  return 'Error'
}

export function isZenError(value: unknown): value is ZenError {
  return value instanceof ZenError
}
