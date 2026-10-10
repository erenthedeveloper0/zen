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
  const { validate, vendor } = schema['~standard']
  const read = READERS[source]
  const assign = ASSIGNERS[source]

  if (coerce === null) {
    const run = (raw: unknown): void | Promise<void> => {
      const ctx = raw as PlainContext
      const input = read(ctx)
      const result = validate(input)
      if (isThenable(result)) {
        return result.then((settled) => { apply(ctx, settled, source, assign, vendor, input) })
      }
      apply(ctx, result, source, assign, vendor, input)
    }
    return { source, run }
  }

  // The body is the one source whose wire format is chosen per request, so it
  // is the one place the profile alone cannot decide — see `coerceBody`.
  const prepare: (ctx: PlainContext, value: unknown) => unknown =
    source === 'body' ? (ctx, value) => coerceBody(ctx, value, coerce) : (_ctx, value) => coerce(value)

  const run = (raw: unknown): void | Promise<void> => {
    const ctx = raw as PlainContext
    const input = prepare(ctx, read(ctx))
    const result = validate(input)
    if (isThenable(result)) {
      return result.then((settled) => { apply(ctx, settled, source, assign, vendor, input) })
    }
    apply(ctx, result, source, assign, vendor, input)
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
  vendor: string,
  input: unknown,
): void {
  if (result.issues !== undefined) {
    // The mapper is looked up here, on the failure path, rather than when the
    // route compiled: one map read per refused request, and a mapper registered
    // after `ready()` is not silently ignored on the routes that booted first.
    const issues = normaliseIssues(result.issues, source, mappers.get(vendor), { input })
    throw new ValidationError(source, issues, source === 'body' ? 422 : 400)
  }
  assign(ctx, result.value)
}

/**
 * One validation stage for a route that validates several sources — §4.2
 * stage 7: *"All source failures are collected into one `ValidationError` with
 * per-source issues rather than failing on the first — one round trip should
 * tell a client everything that is wrong."*
 *
 * That sentence was in the RFC and not in the code: each source threw on its
 * own, so a request with a bad query and a bad body was told about the query,
 * fixed it, and only then learned about the body. Every source now runs; the
 * failures are merged in the fixed order of §4.2, each issue tagged with its
 * source. The status is 422 only when every failure was in the body — anything
 * wrong in the URL or headers makes the request malformed, which is 400.
 *
 * Used only where a route validates two or more sources. A route with one is
 * compiled exactly as before, so this costs nothing where there is nothing to
 * collect, and the compiled pipeline and its interpreted twin both see one
 * ordinary validator step — neither had to learn anything.
 */
export function combineValidators(steps: readonly ValidatorStep[]): ValidatorStep {
  const runs = steps.map((step) => step.run)

  const settle = (failures: ValidationError[]): void => {
    if (failures.length === 0) return
    if (failures.length === 1) throw failures[0]
    const issues = failures.flatMap((failure) => failure.issues)
    const status = failures.every((failure) => failure.status === 422) ? 422 : 400
    throw new ValidationError(failures.map((failure) => failure.source).join(', '), issues, status)
  }

  const collect = (error: unknown, failures: ValidationError[]): void => {
    if (error instanceof ValidationError) failures.push(error)
    else throw error
  }

  // Finishes the stage asynchronously once one validator has returned a
  // promise; the sources before it already ran synchronously.
  const rest = async (ctx: unknown, from: number, pending: Promise<void>, failures: ValidationError[]): Promise<void> => {
    try { await pending } catch (error) { collect(error, failures) }
    for (let i = from + 1; i < runs.length; i++) {
      try { await (runs[i] as ValidatorStep['run'])(ctx) } catch (error) { collect(error, failures) }
    }
    settle(failures)
  }

  const run = (ctx: unknown): void | Promise<void> => {
    const failures: ValidationError[] = []
    for (let i = 0; i < runs.length; i++) {
      let result: void | Promise<void>
      try {
        result = (runs[i] as ValidatorStep['run'])(ctx)
      } catch (error) {
        collect(error, failures)
        continue
      }
      if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
        return rest(ctx, i, result as Promise<void>, failures)
      }
    }
    settle(failures)
  }

  return { source: steps.map((step) => step.source).join(', '), run }
}

function isThenable(value: unknown): value is Promise<StandardResult<unknown>> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function'
}

/**
 * `issues[].code` — §11.2's vocabulary: one word for one kind of failure,
 * whichever library found it and in whatever language it said so (I7).
 *
 * - `required` — no value where the schema needs one
 * - `type` — a value of the wrong type
 * - `format` — a string that is not in its format: an email, a URL, a pattern
 * - `min` / `max` — past a bound: a number's, a string's length, an array's size
 * - `custom` — a refinement the application wrote
 * - `invalid` — anything else: a value outside an enum, a union nothing matched
 */
export type IssueCode = 'required' | 'type' | 'format' | 'min' | 'max' | 'custom' | 'invalid'

/**
 * Names the {@link IssueCode} of one library's issue — §11.2.
 *
 * A Standard Schema issue is the library's own object, so a mapper reads the
 * fields that library documents (Zod's `code`, Valibot's `type`, ArkType's
 * `code`) instead of its message, which a locale rewrites. `undefined` leaves
 * the issue to the message. It is never asked about a missing value: that is
 * `required` whatever the library calls it — see {@link normaliseIssues}.
 */
export type IssueMapper = (issue: StandardIssue & Readonly<Record<string, unknown>>) => IssueCode | undefined

const mappers = new Map<string, IssueMapper>()

/**
 * Teach Zen one vendor's issue codes — the seam `registerSchemaConverter` is
 * for its schemas, and for the same reason: core imports no library, so the
 * four lines that know Zod live in the application.
 *
 * ```ts
 * const ZOD = new Map<unknown, IssueCode>([
 *   ['invalid_type', 'type'], ['too_small', 'min'], ['too_big', 'max'],
 *   ['invalid_format', 'format'], ['custom', 'custom'],
 * ])
 * registerIssueMapper('zod', (issue) => ZOD.get(issue['code']) ?? 'invalid')
 * ```
 *
 * The vendor string is `schema['~standard'].vendor`, which the spec requires.
 */
export function registerIssueMapper(vendor: string, map: IssueMapper): void {
  mappers.set(vendor, map)
}

export function issueMapperFor(vendor: string): IssueMapper | undefined {
  return mappers.get(vendor)
}

/** Test-only. Registrations are process-global, like schema converters. */
export function __resetIssueMappers(): void {
  mappers.clear()
}

/**
 * §11.2 — normalisation is what gives I7 its shape: a Zod app and a Valibot
 * app emit envelopes with the same fields in the same places, and with the
 * same `code` wherever the vendor has a mapper.
 *
 * Each code is decided in this order:
 *
 * 1. **`required`, when what the schema was given has nothing at the issue's
 *    path.** Decided here rather than by any mapper, because a library cannot
 *    always say so: Zod reports a missing key as `invalid_type`, and its
 *    Standard Schema result leaves out the input that would tell the two
 *    apart. The message did, until a locale translated it. Only with `given`:
 *    a caller that has no input (`plugin-options`) gets steps 2 and 3. An
 *    object, so that `{ input: undefined }` — a body that was never sent — is
 *    something a caller can say.
 * 2. **The vendor's mapper**, reading the issue's own fields.
 * 3. **The message**, for a vendor with no mapper — English only, and a guess:
 *    Zod 4's `"Too small: expected number to be >=1"` reads as `type`.
 */
export function normaliseIssues(
  issues: ReadonlyArray<StandardIssue>,
  source?: string,
  mapper?: IssueMapper,
  given?: { readonly input: unknown },
): Issue[] {
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
    const code = given !== undefined && valueAt(given.input, path) === undefined ? 'required'
      : (mapper === undefined ? undefined : mapper(raw as StandardIssue & Readonly<Record<string, unknown>>)) ??
        inferCode(raw.message)
    out.push(source === undefined
      ? { path, code, message: raw.message }
      : { source, path, code, message: raw.message })
  }
  return out
}

/**
 * What the request held at an issue's path, or `undefined` for nothing there.
 * Own properties only: a path is the schema's, but a key such as `constructor`
 * must not find something on a prototype and call a missing value present.
 */
function valueAt(input: unknown, path: readonly (string | number)[]): unknown {
  let at = input
  for (const key of path) {
    if (typeof at !== 'object' || at === null || !Object.hasOwn(at, key)) return undefined
    at = (at as Record<string | number, unknown>)[key]
  }
  return at
}

/**
 * The fallback for a vendor with no mapper: a guess from English message text.
 * It keeps the envelope's *shape* stable, and its codes are what a client
 * cannot rely on across libraries — or across locales of one.
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
