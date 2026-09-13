import type { AnySchema, StandardIssue, StandardResult } from '../contracts/standard-schema.ts'
import type { ValidationSource } from '../contracts/coercion.ts'
import type { ValidatorStep } from './pipeline-compiler.ts'
import type { Coercer } from './coercion-walk.ts'
import type { PlainContext } from '../runtime/context.ts'
import { mediaTypeOf } from '../runtime/body.ts'
import { ValidationError, type Issue } from '../errors/http-errors.ts'

export type { ValidationSource }

type Reader = (ctx: PlainContext) => unknown
type Assigner = (ctx: PlainContext, value: unknown) => void

const READERS: Readonly<Record<ValidationSource, Reader>> = {
  params: (ctx) => ctx.$params,
  query: (ctx) => ctx.query,
  headers: (ctx) => ctx.headers,
  cookies: (ctx) => ctx.cookies,
  body: (ctx) => ctx.$body,
}

/**
 * Validation output *replaces* the lazy accessor's cache rather than living in
 * a second `ctx.validated.body` object. There is nothing to keep in sync, and
 * `ctx.query.page` is a `number` from the handler's point of view.
 */
const ASSIGNERS: Readonly<Record<ValidationSource, Assigner>> = {
  params: (ctx, v) => { ctx.$params = v as Record<string, unknown> },
  query: (ctx, v) => { ctx.$query = v as never },
  headers: (ctx, v) => { ctx.$headers = v as never },
  cookies: (ctx, v) => { ctx.$cookies = v as never },
  body: (ctx, v) => { ctx.$body = v },
}

/**
 * `coerce` is §11.4's coercion step, and it lives *here* rather than as a stage
 * of its own for the reason the RFC gives: "inside the compiled validator, not
 * as a pre-pass, so it costs nothing where it is not used and it composes with
 * union/optional schemas correctly."
 *
 * Both halves of that matter. A separate pipeline stage would have to exist on
 * every route to decide per request whether it applied; here, a route with
 * nothing to coerce is handed `null` and gets back the *same closure shape it
 * had before this feature existed* — one property read, one call, no branch.
 * And running immediately before `validate` rather than at parse time is what
 * lets the schema stay the authority: coercion proposes, the schema disposes.
 */
export function compileValidator(
  schema: AnySchema,
  source: ValidationSource,
  coerce: Coercer | null = null,
): ValidatorStep {
  const validate = schema['~standard'].validate
  const read = READERS[source]
  const assign = ASSIGNERS[source]

  if (coerce === null) {
    const run = (raw: unknown): void | Promise<void> => {
      const ctx = raw as PlainContext
      const result = validate(read(ctx))
      if (isThenable(result)) {
        return result.then((settled) => { apply(ctx, settled, source, assign) })
      }
      apply(ctx, result, source, assign)
    }
    return { source, run }
  }

  // The body is the one source whose wire format is chosen per request, so it
  // is the one place the profile alone cannot decide — see `coerceBody`.
  const prepare: (ctx: PlainContext, value: unknown) => unknown =
    source === 'body' ? (ctx, value) => coerceBody(ctx, value, coerce) : (_ctx, value) => coerce(value)

  const run = (raw: unknown): void | Promise<void> => {
    const ctx = raw as PlainContext
    const result = validate(prepare(ctx, read(ctx)))
    if (isThenable(result)) {
      return result.then((settled) => { apply(ctx, settled, source, assign) })
    }
    apply(ctx, result, source, assign)
  }

  return { source, run }
}

/**
 * §11.4's table lists `body (JSON)` and `body (form)` as different rows, and
 * they are — but a coercion profile is per *source*, and which of those two a
 * request is arrives with the request.
 *
 * So the profile says whether this route coerces its body at all, and the
 * content type says whether *this* body is one where that means anything. JSON
 * is excluded: `{"age":"42"}` against `z.number()` is a client sending the wrong
 * type, and converting it would turn a bug report into a silent success — which
 * is precisely the reason the RFC gives for the JSON row being empty. Everything
 * else is excluded from *that* exclusion, rather than form-encoding being
 * specially included, so a custom parser for a string-shaped format (`text/csv`,
 * a legacy `application/x-url-encoded`) behaves the way its author would expect
 * without having to register anything here.
 *
 * The cost is one header read, on routes that opted into body coercion and no
 * others. It could be avoided by having intake record which parser ran, but that
 * means a new field on the context — and therefore on the *generated* class too,
 * in the same position (I2) — which is a permanent cost on every request in the
 * application to save a header lookup on a handful of routes.
 */
function coerceBody(ctx: PlainContext, value: unknown, coerce: Coercer): unknown {
  const contentType = ctx.raw.header('content-type')
  // Absent means JSON — the same default intake applies, so the two agree about
  // what an unlabelled body is.
  if (contentType === undefined) return value

  // `mediaTypeOf` rather than a second copy of the same three lines: which media
  // type a body *is* has to have one definition, or the parser intake selected
  // and the profile this applies could disagree about `application/json ;
  // charset=utf-8`. §3.1 puts `runtime` above `compile` and this is an upward
  // import, which `pipeline-compiler.ts` also makes for `finalize` — the rule's
  // real content is that a *subsystem* may not depend upward on another
  // subsystem's abstractions, and this is one pure string function.
  return mediaTypeOf(contentType).endsWith('json') ? value : coerce(value)
}

function apply(
  ctx: PlainContext,
  result: StandardResult<unknown>,
  source: ValidationSource,
  assign: Assigner,
): void {
  if (result.issues !== undefined) {
    throw new ValidationError(source, normaliseIssues(result.issues), source === 'body' ? 422 : 400)
  }
  assign(ctx, result.value)
}

function isThenable(value: unknown): value is Promise<StandardResult<unknown>> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function'
}

/**
 * §11.2 — normalisation is what makes I7 true. A Zod app and a Valibot app
 * emit byte-identical error envelopes, so clients can switch on `issues[].code`
 * across the entire ecosystem rather than per-library.
 */
export function normaliseIssues(issues: ReadonlyArray<StandardIssue>): Issue[] {
  const out: Issue[] = []
  for (const raw of issues) {
    const path: (string | number)[] = []
    if (raw.path) {
      for (const segment of raw.path) {
        const key = typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment
        if (typeof key === 'string' || typeof key === 'number') path.push(key)
        else path.push(String(key))
      }
    }
    out.push({ path, code: inferCode(raw.message), message: raw.message })
  }
  return out
}

/**
 * Best-effort mapping until per-vendor issue adapters land in M2. The vendor's
 * own code is richer; this keeps the *shape* stable in the meantime rather than
 * leaking a different structure per library.
 */
function inferCode(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('required') || m.includes('undefined')) return 'required'
  if (m.includes('expected') || m.includes('must be a')) return 'type'
  if (m.includes('email') || m.includes('url') || m.includes('uuid') || m.includes('format')) return 'format'
  if (m.includes('at least') || m.includes('greater') || m.includes('min')) return 'min'
  if (m.includes('at most') || m.includes('less') || m.includes('max')) return 'max'
  return 'invalid'
}
