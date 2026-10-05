import type { Plugin } from '../contracts/plugin.ts'
import type { JsonSchema } from '../contracts/json-schema.ts'
import type { StandardResult } from '../contracts/standard-schema.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { closest } from '../primitives/nearest.ts'
import { toJsonSchema } from './json-schema.ts'
import { normaliseIssues } from './validation.ts'

/**
 * A plugin's options, checked before any plugin runs — rfcs/0001 §10.5 step 2.
 *
 * §8.6's motivating sentence is "`rateLimit({ limt: 100 })` fails at startup
 * with a spelling suggestion, not at 3 a.m. under load", and until
 * `0.1.0-alpha.4` it did not: `Plugin.options` was declared, documented and read
 * by nothing, so `{ limt: 100 }` reached `setup`, which read `options.limit` as
 * `undefined` and fell back to a default. The misconfiguration was not merely
 * unreported — it became a *different, working* configuration, which is the
 * failure §9.7 exists to forbid.
 *
 * Two checks, because each catches what the other cannot:
 *
 *   1. **The schema's own verdict**, from `~standard.validate` — awaited when it
 *      returns a promise, since boot is async. Its issues are normalised the way
 *      a request's are (§11.2).
 *   2. **Keys the schema does not declare**, read off the schema's JSON Schema
 *      (`input` direction). A Zod object strips an unknown key and *accepts* the
 *      rest, so `{ limt: 100 }` against `{ limit: z.number().default(60) }` is
 *      valid to the library and a typo to everybody else. Every such key is
 *      named, with the declared key it was probably meant to be. An options
 *      object is a closed vocabulary, so an absent `additionalProperties` reads
 *      as closed here — the same inversion §13.3.1 makes for a response, and for
 *      the same reason: the permissive reading is the one that hides mistakes.
 *      A schema that says `additionalProperties: true`, or gives one a schema,
 *      has said its keys are open and is believed.
 *
 * What `setup` receives is the validated **output** — defaults applied, values
 * transformed — rather than what was written. That is a behaviour change from
 * the releases before it, and the CHANGELOG says so.
 *
 * A refusal names keys, never values: options are where API keys and DSNs are
 * passed, and a boot diagnostic is a log line (the rule `url()` and the header
 * check follow).
 */
export interface OptionsVerdict {
  /** What `setup` is handed: the schema's output, or what was given when there is no schema. */
  readonly value: unknown
  readonly diagnostic: Diagnostic | null
}

export async function validatePluginOptions(
  plugin: Pick<Plugin<never, object>, 'name' | 'version' | 'options'>,
  given: unknown,
): Promise<OptionsVerdict> {
  const schema = plugin.options
  if (schema === undefined) return { value: given, diagnostic: null }

  const label = `${plugin.name}@${plugin.version}`

  let result: StandardResult<unknown>
  try {
    const verdict = schema['~standard'].validate(given)
    result = isThenable(verdict) ? await verdict : verdict
  } catch (error) {
    return {
      value: undefined,
      diagnostic: {
        severity: 'error',
        code: Codes.PLUGIN_OPTIONS,
        message:
          `Plugin "${label}"'s options schema threw while checking its options: ` +
          (error instanceof Error ? error.message : String(error)),
        hint: 'A schema reports a bad value through `issues`; this one threw instead. Fix the schema.',
      },
    }
  }

  const unknown = unknownKeys(schema, given)
  if (result.issues === undefined && unknown.length === 0) return { value: result.value, diagnostic: null }
  const issues = result.issues === undefined ? [] : normaliseIssues(result.issues)

  const problems = [
    ...unknown.map(({ key }) => `"${key}" is not an option`),
    ...issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`)),
  ]

  const suggestions = unknown
    .filter((entry) => entry.suggestion !== null)
    .map(({ key, suggestion }) => `"${key}" is not an option of ${plugin.name} — did you mean "${suggestion}"?`)

  return {
    value: undefined,
    diagnostic: {
      severity: 'error',
      code: Codes.PLUGIN_OPTIONS,
      message: `Plugin "${label}" was given options it does not accept: ${problems.join('; ')}.`,
      hint: suggestions.length > 0
        ? suggestions.join(' ')
        : `Correct the options passed to ${plugin.name} — in app.use(plugin, options), or in the call that built it.`,
      consequence:
        'Booting anyway would run the plugin on a configuration nobody wrote: an option it does not read ' +
        'is not merely ignored, it leaves the default in its place.',
    },
  }
}

/**
 * Keys of `given` its schema does not declare, each with the declared key
 * within two edits of it (`closest`, the "did you mean" every diagnostic uses).
 *
 * Empty when the schema has no readable shape: a schema the converter cannot
 * describe has nothing to compare against, and the library's own verdict
 * stands alone — the honest answer, rather than a guess at its keys.
 */
function unknownKeys(
  schema: NonNullable<Plugin<never, object>['options']>,
  given: unknown,
): Array<{ key: string; suggestion: string | null }> {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return []
  const shape: JsonSchema | null = toJsonSchema(schema, 'input')
  const properties = shape?.properties
  if (shape === null || properties === undefined) return []
  const open = shape.additionalProperties
  if (open === true || (typeof open === 'object' && open !== null)) return []

  const declared = Object.keys(properties)
  const out: Array<{ key: string; suggestion: string | null }> = []
  for (const key of Object.keys(given)) {
    if (Object.hasOwn(properties, key)) continue
    out.push({ key, suggestion: closest(key, declared) })
  }
  return out
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<T>).then === 'function'
}
