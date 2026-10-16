import type { AnySchema, StandardResult } from '../contracts/standard-schema.ts'
import type { Logger } from '../contracts/logger.ts'
import type { Reply } from '../contracts/reply.ts'
import type { Representation } from '../contracts/negotiation.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import type { SerializerMode } from '../compile/serializer.ts'
import { normaliseIssues } from '../compile/validation.ts'
import { isDescribeOnly, toJsonSchema } from '../compile/json-schema.ts'
import { isVariantRecord } from '../compile/media-type.ts'
import { buildProgram } from '../compile/serializer-ir.ts'
import { projector, stringifiedView } from '../compile/serializer-project.ts'
import { effectiveStatus } from './response-engine.ts'

/**
 * Response validation — rfcs/0001 §11.5, T8.
 *
 * The compiled serializer already guarantees that an undeclared field cannot
 * leave the process (§13.3), at negative cost, so that guarantee is always
 * on. What it does not catch is a *wrong value*: a `string` where the schema
 * says `number`, an enum member that is not one, a `minLength` the value is
 * short of. This is the bug-detection half, run with the schema library's own
 * `validate` against the schema the response's status declares, last in the
 * epilogue — after `after` middleware, `onSerialize` and `onSend`, so it judges
 * what is actually sent.
 *
 * What it judges is the value as the serializer will write it, not the one
 * the handler returned: the fields the schema does not declare are dropped and
 * a `Date` or `bigint` is written the serializer's way first
 * (`compile/serializer-project.ts`). A handler may return a whole row and rely
 * on the serializer to send only the declared part — that is §13.3's promise —
 * and a validator that refused the undeclared part judged bytes nobody sends.
 *
 * Three modes: `'error'` refuses the response with `ZEN_RESPONSE_INVALID`, a
 * 500 that is never exposed and whose issues reach the developer through the
 * log and the dev problem document's `debug`; `'log'` reports it and serves the
 * response; `{ sample: n }` reports one response in `n`. `'off'` builds
 * nothing, and the pipeline compiler emits nothing for it — a route compiles
 * byte for byte as it did before the feature existed.
 */

export type ResponseValidator = (ctx: ValidationTarget, reply: Reply) => void | Promise<void>

/** What the validator reads off the context: the staged status and the negotiated representation. */
export interface ValidationTarget {
  readonly $resStatus: number
  readonly $negotiated: Representation | null
}

export interface ResponseValidatorOptions {
  readonly mode: 'error' | 'log'
  /** Validate one response in `sample`. `1` is every response. */
  readonly sample: number
  /** `GET /users/:id` — what a refusal names. */
  readonly routeId: string
  readonly log: Logger
  /**
   * How JSON responses are written (`serialization.mode`). `'off'` sends
   * `JSON.stringify`'s view of the value, undeclared fields included, so that
   * is what is judged; every other mode sends the serializer's.
   */
  readonly serialization?: SerializerMode | undefined
}

/** One declared schema, and how to see a value as it will be sent under it. */
interface Check {
  readonly schema: AnySchema
  readonly view: (value: unknown) => unknown
}

/**
 * The validator for one route, or `null` when nothing it declares can
 * validate: no response schemas, only `null` statuses, or only `jsonSchema()`
 * shapes, which describe and cannot validate.
 */
export function compileResponseValidator(
  response: Readonly<Record<number, unknown>> | undefined,
  options: ResponseValidatorOptions,
): ResponseValidator | null {
  if (response === undefined) return null
  const serialization = options.serialization ?? 'compiled'
  const table = new Map<number, Check | ReadonlyMap<string, Check>>()
  for (const key of Object.keys(response)) {
    const status = Number(key)
    if (!Number.isInteger(status)) continue
    const declared = (response as Record<string, unknown>)[key]
    if (declared === null || declared === undefined) continue
    if (isVariantRecord(declared)) {
      const byMedia = new Map<string, Check>()
      for (const media of Object.keys(declared as object)) {
        const schema = (declared as Record<string, unknown>)[media]
        if (validates(schema)) byMedia.set(media, checkFor(schema as AnySchema, serialization, media))
      }
      if (byMedia.size > 0) table.set(status, byMedia)
      continue
    }
    if (validates(declared)) table.set(status, checkFor(declared as AnySchema, serialization, 'application/json'))
  }
  if (table.size === 0) return null

  const { mode, sample, routeId, log } = options
  let seen = 0

  const verdict = (result: StandardResult<unknown>, status: number): void => {
    if (result.issues === undefined) return
    const issues = normaliseIssues(result.issues, 'response')
    const shown = issues.slice(0, 3).map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
    const message =
      `The ${status} response of ${routeId} does not match its declared schema — ${shown.join('; ')}` +
      (issues.length > 3 ? `; and ${issues.length - 3} more` : '')
    if (mode === 'log') {
      log.error({ code: Codes.RESPONSE_INVALID, route: routeId, status, issues }, message)
      return
    }
    throw new ZenError(Codes.RESPONSE_INVALID, message, {
      status: 500,
      expose: false,
      meta: { route: routeId, status, issues },
      hint: 'Return what the schema declares, or declare what the route returns. The serializer keeps undeclared fields off the wire either way; this is the value being wrong.',
    })
  }

  return function validateResponse(ctx: ValidationTarget, reply: Reply): void | Promise<void> {
    const body = reply.body
    if (body.kind !== 'json') return
    if (sample > 1 && ++seen % sample !== 0) return
    const status = effectiveStatus(ctx, reply)
    const entry = table.get(status)
    if (entry === undefined) return
    const check = entry instanceof Map ? entry.get(ctx.$negotiated?.media ?? '') : entry as Check
    if (check === undefined) return
    const result = check.schema['~standard'].validate(check.view(body.value))
    if (isThenable(result)) return result.then((settled) => verdict(settled, status))
    verdict(result, status)
  }
}

/**
 * How a value is seen under one schema. A JSON representation is written by the
 * compiled serializer unless serialization is off or the schema has no JSON
 * Schema form, when `JSON.stringify` writes it; any other media type is written
 * by its encoder from the same schema, which keeps the declared fields too.
 */
function checkFor(schema: AnySchema, serialization: SerializerMode, media: string): Check {
  const json = media === 'application/json' || media.endsWith('+json')
  if (json && serialization === 'off') return { schema, view: stringifiedView }
  const shape = toJsonSchema(schema)
  const program = shape === null ? null : buildProgram(shape, false).program
  if (program === null) return { schema, view: json ? stringifiedView : identity }
  return { schema, view: projector(program) }
}

const identity = (value: unknown): unknown => value

function validates(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && '~standard' in schema && !isDescribeOnly(schema)
}

function isThenable(value: unknown): value is Promise<StandardResult<unknown>> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function'
}
