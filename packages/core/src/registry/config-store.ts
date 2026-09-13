import type { JsonSchema, JsonSchemaNode, SchemaIo } from '../contracts/json-schema.ts'
import type { AnySchema, StandardIssue, StandardResult } from '../contracts/standard-schema.ts'
import type {
  ConfigDefinition, ConfigLayer, ConfigOverlay, ConfigSnapshot, ConfigSourceRecord,
  ConfigValue, EnvSource, EnvValue,
} from '../contracts/config.ts'
import type { Diagnostic } from '../errors/zen-error.ts'
import { CONFIG_DEFAULTS, LAYER_RANK, REDACTED } from '../contracts/config.ts'
import { Codes } from '../errors/codes.ts'

/**
 * The Config Store — rfcs/0001 §16, subsystem 11 in §3.2.
 *
 * Stratum 2. It resolves, validates, records provenance, marks secrets and
 * freezes; it does **not** read files, and that boundary is §3.2's, not a
 * preference. `parseDotenv` (stratum 0) gives a host the parser; the host
 * supplies the text.
 *
 * ### Why this is a fold over records rather than `Object.assign`
 *
 * The obvious implementation of a layered config is to spread each layer over
 * the last. It produces the right value and destroys the only other thing
 * anybody wants, which is *which layer produced it* — the result of
 * `{...a, ...b}` has no memory of `a`. §16.1 makes provenance a first-class
 * requirement precisely because "where did this value come from" is the
 * question production incidents turn on and almost no framework can answer it.
 *
 * So the fold here carries a `{ value, layer, source }` triple per leaf, and
 * the plain object handed to the application is a *projection* of that map —
 * built last, from records that already know where they came from. The
 * provenance is not a debugging feature bolted on beside the resolution; it is
 * the resolution, and the config object is the summary.
 *
 * ### The two-phase shape
 *
 * §16.1's eight layers are two different kinds of thing (see `contracts/config`),
 * and the order between the kinds is fixed: **the environment resolves and
 * validates first, and the configuration tree is then computed as a function of
 * it.** That is what `port: env => env.PORT` means read literally, and it is
 * what makes §16.4's freeze cost nothing — a configuration that is a pure
 * function of a validated environment has nothing left to decide at runtime.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveConfigInput {
  readonly definition: ConfigDefinition<unknown, unknown> | undefined
  /** Layers 5–7, in the order they were supplied. */
  readonly envSources: readonly EnvSource[]
  /** Layers 1, 2, 4 and 8. Layer 3 is `definition.shape`. */
  readonly overlays: readonly ConfigOverlay[]
  /** plugin name → the env keys it declared. Populates §16.2's `used by:`. */
  readonly usedBy?: ReadonlyMap<string, readonly string[]> | undefined
  /**
   * The JSON Schema probe, injected rather than imported.
   *
   * `toJsonSchema` lives in `compile/` (stratum 3) and this module is stratum 2,
   * so importing it would be an upward import — and unlike the two the codebase
   * already makes for pure functions, this one is avoidable at the cost of a
   * single parameter. The caller that has both in scope is `api/zen.ts`, which
   * is above them both. It is optional because everything here still works
   * without it: the schema's own messages carry the verdict, and the probe only
   * adds the `expected:` line and reads the secret markers.
   */
  readonly describe?: ((schema: AnySchema, io: SchemaIo) => JsonSchema | null) | undefined
}

export interface ResolvedConfigResult {
  /** Frozen, redacting on serialisation. What `app.config` and `ctx.config` are. */
  readonly config: Readonly<Record<string, unknown>>
  /** The validated environment — the argument every thunk was called with. */
  readonly env: Readonly<Record<string, unknown>>
  /** The redacted projection carried on the AppGraph. */
  readonly snapshot: ConfigSnapshot
  /** Aggregated, never thrown from here — §12.7. */
  readonly diagnostics: readonly Diagnostic[]
  /** Warnings the caller logs once, aggregated the same way (§12.7). */
  readonly warnings: readonly string[]
}

interface Won {
  readonly value: unknown
  readonly layer: ConfigLayer
  readonly source: string
}

/**
 * A layer and a source name, as one map key.
 *
 * `JSON.stringify` rather than `layer + ':' + name`, because a source name is
 * often a filename and a Windows filename contains a colon. A separator that
 * can occur inside the thing it separates is a bug waiting for one contributor
 * with a different operating system.
 */
function sourceId(layer: ConfigLayer, name: string): string {
  return JSON.stringify([layer, name])
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Layers 5–7 folded into one record, later winning, provenance kept.
 *
 * Sources within the same layer are decided by the order they were supplied,
 * which is how the four `.env` files of §16.1 order among themselves —
 * `dotenvChain` states that order once so no host has to remember it.
 *
 * `declared` restricts the **accounting**, never the values. Every key a source
 * supplied stays in `values`, because a configuration with no `env` schema
 * hands the raw record to its thunks and they may read anything; but the
 * `sources` tally — and, through `resolveConfig`, the whole environment section
 * of the snapshot — counts only what the application declared. The process
 * environment of a developer's laptop has seventy entries in it and none of
 * them are this service's configuration.
 */
export function foldEnv(sources: readonly EnvSource[], declared?: ReadonlySet<string>): {
  readonly values: ReadonlyMap<string, Won>
  /** key → source id, so a caller can re-tally over any subset of keys. */
  readonly owners: ReadonlyMap<string, string>
  readonly sources: readonly ConfigSourceRecord[]
} {
  const ordered = [...sources].sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer])

  const values = new Map<string, Won>()
  /** Which source id currently owns each key. Recomputed, never decremented. */
  const owner = new Map<string, string>()

  for (const source of ordered) {
    const id = sourceId(source.layer, source.name)
    for (const entry of source.entries) {
      values.set(entry.key, {
        value: entry.value,
        layer: source.layer,
        source: entry.line === undefined ? source.name : `${source.name}:${entry.line}`,
      })
      owner.set(entry.key, id)
    }
  }

  return { values, owners: owner, sources: tally(ordered, owner, declared) }
}

/**
 * Per-source accounting: how many declared keys it supplied, kept, and named
 * that nobody declared.
 *
 * The third number is the one worth having and the one that needed a rule.
 * `undeclared` is counted for `.env` files and CLI flags and **not** for the
 * process environment, because the two are different kinds of thing: a `.env`
 * file is a statement of intent, so `STIRPE_KEY=…` sitting in one that nothing
 * reads is almost always a typo worth reporting; the process environment is
 * ambient, and reporting that a developer's laptop has sixty-four variables
 * this service does not read is noise that would train people to ignore the
 * line.
 */
function tally(
  sources: readonly EnvSource[],
  owner: ReadonlyMap<string, string>,
  declared: ReadonlySet<string> | undefined,
): ConfigSourceRecord[] {
  // Counted from the final ownership map rather than tallied as we go. A source
  // can lose a key to a *later entry within itself* — a `.env` that sets PORT
  // twice — and a running tally that only knows about cross-source shadowing
  // reports that source as having won twice.
  const won = new Map<string, number>()
  for (const [key, id] of owner) {
    if (declared !== undefined && !declared.has(key)) continue
    won.set(id, (won.get(id) ?? 0) + 1)
  }

  return sources.map((source) => {
    // Entries, not distinct keys: a `.env` that sets PORT twice supplied two
    // and kept one, and `2 of 1 kept` is the line that says so.
    const relevant = declared === undefined
      ? source.entries.length
      : source.entries.filter((e) => declared.has(e.key)).length
    const undeclared = declared === undefined || source.layer === 'env'
      ? 0
      : new Set(source.entries.filter((e) => !declared.has(e.key)).map((e) => e.key)).size
    return {
      layer: source.layer,
      name: source.name,
      won: won.get(sourceId(source.layer, source.name)) ?? 0,
      supplied: relevant,
      undeclared,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

export function resolveConfig(input: ResolveConfigInput): ResolvedConfigResult {
  const diagnostics: Diagnostic[] = []
  const warnings: string[] = []
  const definition = input.definition

  // ── 1. the environment ────────────────────────────────────────────────────
  const envSchema = definition?.env
  const envShape = envSchema !== undefined && input.describe !== undefined
    ? input.describe(envSchema, 'input')
    : null

  /**
   * **The declared environment** — the schema's properties, plus every key a
   * plugin said it reads, plus every key `secrets:` names.
   *
   * This set exists because building the environment section of the snapshot
   * out of "every variable the process has" is wrong in three ways at once, and
   * the config example's provenance table made all three visible the first time
   * it ran: it buried five relevant rows under seventy irrelevant ones; it put
   * the *name* of every variable in the process onto the AppGraph, and a name
   * is topology even when the value is withheld; and with no `env` schema it
   * would have put the values there too.
   *
   * The declared environment is the application's contract with its
   * deployment. What else happens to be set is not configuration.
   */
  const declared = new Set<string>([
    ...Object.keys(envShape?.properties ?? {}),
    ...(definition?.secrets ?? []).filter((s) => !s.includes('.')),
  ])
  for (const [, keys] of input.usedBy ?? []) for (const key of keys) declared.add(key)
  const hasDeclaration = envSchema !== undefined || declared.size > 0

  const folded = foldEnv(input.envSources, hasDeclaration ? declared : undefined)
  const raw: Record<string, string> = {}
  for (const [key, won] of folded.values) raw[key] = won.value as string

  const secretKeys = secretEnvKeys(envShape, definition?.secrets ?? [])
  const mask = (key: string, value: unknown): unknown => (secretKeys.has(key) ? REDACTED : value)

  if (envSchema !== undefined && envShape === null && (definition?.secrets ?? []).length === 0) {
    // The same honesty the coercion subsystem owes when it cannot read a
    // schema (§11.4), and here it is sharper: without the shape, `writeOnly`
    // and `format: 'password'` are invisible, so a value the author *did* mark
    // as a secret will be printed by every projection. One warning, naming the
    // remedy, rather than silence.
    warnings.push(
      'The environment schema could not be converted to JSON Schema, so secret markers ' +
      '(format: "password", writeOnly) were not read, no constraint can be shown in ' +
      'validation errors, and the declared environment is unknown. ' +
      'fix: register a converter — registerSchemaConverter("zod", (s, io) => z.toJSONSchema(s, { io })) — ' +
      'or list the sensitive keys explicitly with defineConfig({ secrets: [...] }). ' +
      'also: the environment section of `explainConfig` will be empty, and a config value ' +
      'carrying a secret will be printed rather than redacted.',
    )
  }

  let envValues: Record<string, unknown> = raw
  if (envSchema !== undefined) {
    const result = envSchema['~standard'].validate(raw)
    if (isThenable(result)) {
      // Async validation would make `ready()`'s "before anything else boots"
      // ordering depend on a microtask, and every schema library's env-shaped
      // schemas are synchronous. Refused loudly rather than awaited quietly.
      diagnostics.push({
        severity: 'error',
        code: Codes.ENV_INVALID,
        message: 'The environment schema validates asynchronously, and environment validation runs before anything else boots (§16.2).',
        hint: 'Use a synchronous schema for `env`. Asynchronous checks belong in an onReady hook or a health probe.',
      })
    } else if (result.issues !== undefined) {
      diagnostics.push(...envDiagnostics(result.issues, folded.values, envShape, secretKeys, input.usedBy))
    } else {
      envValues = result.value as Record<string, unknown>
    }
  }

  // ── 2. the tree ───────────────────────────────────────────────────────────
  const layers: ConfigOverlay[] = [
    { layer: 'default', name: 'default', values: CONFIG_DEFAULTS },
    ...input.overlays,
  ]
  if (definition !== undefined) {
    layers.push({ layer: 'config', name: 'zen.config', values: definition.shape })
  }
  layers.sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer])

  const leaves = new Map<string, Won>()
  const contributions = new Map<string, { won: number; supplied: number }>()

  /**
   * Record a leaf, and keep the leaf set a *tree* rather than a bag of paths.
   *
   * Two deletions, and both exist because without them the flat map can hold
   * `limits` and `limits.headers` at once — which is not a shape any object
   * has, so `assign` below would have to invent a resolution and the snapshot
   * would list a path that does not exist on `app.config`.
   *
   *   - Setting `limits` removes everything under `limits.` — a later scalar
   *     replaces the subtree it shadows.
   *   - Setting `limits.headers` removes a scalar sitting at `limits` — a later
   *     branch replaces the scalar it grows out of.
   *
   * Later wins in both directions, which is the only rule §16.1 states.
   */
  const setLeaf = (path: string, won: Won): void => {
    const prefix = `${path}.`
    for (const existing of leaves.keys()) {
      if (existing.startsWith(prefix)) leaves.delete(existing)
    }
    for (let dot = path.lastIndexOf('.'); dot !== -1; dot = path.lastIndexOf('.', dot - 1)) {
      leaves.delete(path.slice(0, dot))
    }
    leaves.set(path, won)
  }

  for (const layer of layers) {
    const id = sourceId(layer.layer, layer.name)
    const seen = contributions.get(id) ?? { won: 0, supplied: 0 }
    contributions.set(id, seen)

    walk(layer.values, '', (path, node) => {
      seen.supplied++
      let value: unknown
      if (typeof node === 'function') {
        try {
          value = (node as (env: unknown) => unknown)(envValues)
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: Codes.CONFIG_INVALID,
            message:
              `config.${path} threw while being computed from the environment: ` +
              (error instanceof Error ? error.message : String(error)),
            hint: 'A config thunk must be a pure function of the validated environment. Move I/O to a plugin or an onReady hook.',
            locations: [layer.name],
          })
          return
        }

        // A thunk that returns an object is expanded into leaves, so that
        // `limits: env => ({ body: '1mb' })` and `limits: { body: '1mb' }`
        // behave identically. They read as the same declaration and a fold in
        // which one of them merges and the other replaces is a rule nobody can
        // hold in their head.
        if (isPlainObject(value)) {
          walk(value, path, (inner, leaf) => {
            setLeaf(inner, { value: leaf, layer: layer.layer, source: layer.name })
          })
          return
        }
      } else {
        value = node
      }
      setLeaf(path, { value, layer: layer.layer, source: layer.name })
    })
  }

  for (const won of leaves.values()) {
    const seen = contributions.get(sourceId(won.layer, won.source))
    if (seen !== undefined) seen.won++
  }

  // ── 3. secrets ────────────────────────────────────────────────────────────
  const secretValues = new Set<string>()
  for (const key of secretKeys) {
    const value = envValues[key]
    if (typeof value === 'string' && value !== '') secretValues.add(value)
  }
  const explicitPaths = new Set((definition?.secrets ?? []).filter((s) => s.includes('.')))

  const secretPaths = new Set<string>()
  for (const [path, won] of leaves) {
    // A leaf marked by hand, or one carrying a secret env value *verbatim*.
    // Identity, not similarity: `url: env => env.DATABASE_URL` inherits the
    // marking without restating it, and a derived value
    // (`${env.DATABASE_URL}/db`) does not — which is a real gap and is named in
    // the docs rather than papered over with a substring search that would
    // redact anything containing the word `localhost`.
    if (explicitPaths.has(path) || (typeof won.value === 'string' && secretValues.has(won.value))) {
      secretPaths.add(path)
    }
  }

  // ── 4. the object, and the snapshot ───────────────────────────────────────
  const tree: Record<string, unknown> = {}
  for (const [path, won] of leaves) assign(tree, path, won.value)

  const config = seal(tree, secretPaths, '')
  const env = Object.freeze({ ...envValues })

  // The *declared* environment, not the process's. See `declared` above for
  // why this is a filter and not a listing.
  const envRows: EnvValue[] = []
  for (const key of [...(hasDeclaration ? declared : [])].sort()) {
    const won = folded.values.get(key)
    const secret = secretKeys.has(key)
    envRows.push({
      key,
      raw: won === undefined ? undefined : secret ? REDACTED : (won.value as string),
      value: mask(key, envValues[key]),
      layer: won?.layer ?? 'default',
      source: won?.source ?? 'not set',
      secret,
      usedBy: readersOf(key, input.usedBy),
    })
  }

  const valueRows: ConfigValue[] = [...leaves]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, won]) => ({
      path,
      value: secretPaths.has(path) ? REDACTED : won.value,
      layer: won.layer,
      source: won.source,
      secret: secretPaths.has(path),
    }))

  const sourceRows: ConfigSourceRecord[] = [
    ...[...contributions].map(([id, counts]) => {
      const [layer, name] = JSON.parse(id) as [ConfigLayer, string]
      return { layer, name, won: counts.won, supplied: counts.supplied, undeclared: 0 }
    }),
    ...folded.sources,
  ].sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer])

  const snapshot: ConfigSnapshot = Object.freeze({
    env: Object.freeze(envRows) as readonly EnvValue[],
    values: Object.freeze(valueRows) as readonly ConfigValue[],
    sources: Object.freeze(sourceRows) as readonly ConfigSourceRecord[],
    secrets: Object.freeze([...secretKeys, ...secretPaths].sort()) as readonly string[],
  })

  return { config, env, snapshot, diagnostics, warnings }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree walking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Visit every leaf of a partial config tree.
 *
 * A leaf is anything that is not a plain object: primitives, arrays, thunks,
 * class instances, `null`. Arrays in particular are leaves and therefore
 * **replace** rather than concatenate, which is the behaviour anyone changing
 * `logging.redact` in a production overlay means — an overlay that silently
 * appended to the default list would make "remove a path from the redaction
 * set" impossible to express.
 */
function walk(
  node: unknown,
  prefix: string,
  visit: (path: string, leaf: unknown) => void,
): void {
  if (!isPlainObject(node)) {
    if (prefix !== '') visit(prefix, node)
    return
  }
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key]
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (isPlainObject(value)) walk(value, path, visit)
    else visit(path, value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assign(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string
    const next = node[key]
    if (!isPlainObject(next)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[parts[parts.length - 1] as string] = value
}

// ─────────────────────────────────────────────────────────────────────────────
// Freeze and redaction
// ─────────────────────────────────────────────────────────────────────────────

const INSPECT: unique symbol = Symbol.for('nodejs.util.inspect.custom') as never

/**
 * Freeze the tree, and make every level redact when it is *serialised* — §16.4.
 *
 * Two mechanisms, both non-enumerable, attached at every object level rather
 * than only at the root (so `JSON.stringify(config.database)` is covered too):
 *
 *   - `toJSON`, which every structured logger and every `JSON.stringify` call
 *     goes through.
 *   - `nodejs.util.inspect.custom`, which is what `console.log(app.config)`
 *     goes through. Reached via `Symbol.for`, so no `node:` import (§3.3 B2)
 *     and no effect on any runtime that does not look for it.
 *
 * §16.2 says redaction should be "applied by the logger's serializer rather
 * than by hoping nobody logs the config object". This is the same intent
 * without requiring a particular logger: the object redacts *itself*, so the
 * property holds for `console.log`, for pino, for an error report, and for a
 * crash dump that JSON-encodes whatever it was holding.
 *
 * **What it does not cover, stated plainly:** `{...app.config}` copies
 * enumerable own properties and leaves both hooks behind, so a spread of the
 * config object serialises unredacted. Closing that would mean per-property
 * getters that lie about their own value, which is worse — a config object
 * whose `database.url` is not the database URL breaks the one thing it is for.
 * The mechanism raises the floor; it does not seal the room.
 */
function seal(
  node: Record<string, unknown>,
  secrets: ReadonlySet<string>,
  prefix: string,
): Readonly<Record<string, unknown>> {
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (isPlainObject(value)) {
      node[key] = seal(value, secrets, prefix === '' ? key : `${prefix}.${key}`)
    } else if (Array.isArray(value)) {
      Object.freeze(value)
    }
  }

  const redacted = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      out[key] = secrets.has(path) ? REDACTED : node[key]
    }
    return out
  }

  Object.defineProperty(node, 'toJSON', { value: redacted, enumerable: false, configurable: false })
  Object.defineProperty(node, INSPECT, { value: redacted, enumerable: false, configurable: false })
  return Object.freeze(node)
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which environment keys are secret.
 *
 * §16.2 writes the marker as Zod's `.brand('secret')`, and that is the one
 * spelling this cannot see: a brand is erased at runtime and leaves nothing in
 * the schema for any framework to read. So the markers honoured here are the
 * ones that survive into JSON Schema and are already standard:
 *
 *   - `format: 'password'` — OpenAPI's own "do not display this" (`z.string().meta({ format: 'password' })`)
 *   - `writeOnly: true`    — JSON Schema's "may be sent, never returned"
 *   - `secret: true`       — an explicit keyword, for schemas that carry metadata
 *
 * plus whatever `defineConfig({ secrets: [...] })` names by hand, which is the
 * escape hatch for a schema library that cannot express any of the above. Using
 * an existing vocabulary rather than inventing a Zen-specific one is the same
 * choice §12.6 makes about RFC 9457 and §31.4 about `application/health+json`.
 */
export function secretEnvKeys(
  shape: JsonSchema | null,
  declared: readonly string[],
): ReadonlySet<string> {
  const keys = new Set<string>(declared.filter((name) => !name.includes('.')))
  const properties = shape?.properties
  if (properties === undefined) return keys

  for (const [key, node] of Object.entries(properties)) {
    if (isSecretNode(node)) keys.add(key)
  }
  return keys
}

function isSecretNode(node: JsonSchemaNode): boolean {
  if (typeof node !== 'object' || node === null) return false
  if (node['secret'] === true) return true
  if (node.format === 'password') return true
  if (node['writeOnly'] === true) return true
  // A branded/piped schema converts to a wrapper; look one level in rather than
  // missing the marker on `z.string().min(32).meta({ format: 'password' })`
  // where the library emits `allOf`.
  for (const branch of [node.allOf, node.anyOf, node.oneOf]) {
    if (branch !== undefined && branch.some(isSecretNode)) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §16.2's error, one diagnostic per invalid key.
 *
 * Per key rather than per application, because a developer setting up a service
 * for the first time is typically missing three variables at once and a
 * fail-fast environment check turns that into three runs (§12.7). The health
 * registry reports five bad checks the same way, for the same reason.
 *
 * Two properties this function exists to hold, both worth stating because both
 * are easy to lose in a refactor:
 *
 *   1. **A secret's value never appears.** The message shows `********` for a
 *      key marked secret, and shows the offending value for one that is not —
 *      because `PORT="abc"` is only actionable if you can see the `"abc"`.
 *   2. **The provenance is in the message.** "PORT is not a valid integer" sends
 *      someone hunting through four files; "`.env:3` sets PORT to `"abc"`" does
 *      not.
 */
export function envDiagnostics(
  issues: ReadonlyArray<StandardIssue>,
  folded: ReadonlyMap<string, Won>,
  shape: JsonSchema | null,
  secrets: ReadonlySet<string>,
  usedBy: ReadonlyMap<string, readonly string[]> | undefined,
): Diagnostic[] {
  const byKey = new Map<string, string[]>()
  for (const issue of issues) {
    const first = issue.path?.[0]
    const key = first === undefined
      ? '(environment)'
      : String(typeof first === 'object' && first !== null && 'key' in first ? first.key : first)
    const list = byKey.get(key)
    if (list === undefined) byKey.set(key, [issue.message])
    else list.push(issue.message)
  }

  const out: Diagnostic[] = []
  for (const [key, messages] of byKey) {
    const won = folded.get(key)
    const secret = secrets.has(key)
    const shown = won === undefined
      ? undefined
      : secret ? REDACTED : JSON.stringify(won.value)

    const constraint = describeConstraint(shape?.properties?.[key])
    const readers = readersOf(key, usedBy)

    out.push({
      severity: 'error',
      code: Codes.ENV_INVALID,
      message:
        `${key} — ${won === undefined ? 'required, but not set' : `${shown} was rejected`}: ` +
        messages.join('; ') +
        (constraint === null ? '' : ` (expected: ${constraint})`),
      hint: won === undefined
        ? `Set ${key} in .env.local, or in your deployment secrets.`
        : `Correct ${key} where it is set${won.source === '' ? '' : ` (${won.source})`}.`,
      consequence: readers.length > 0
        ? `Read by ${readers.join(', ')}, which will not work without it.`
        : undefined,
      locations: won === undefined ? undefined : [won.source],
    })
  }
  return out
}

function readersOf(key: string, usedBy: ReadonlyMap<string, readonly string[]> | undefined): readonly string[] {
  if (usedBy === undefined) return []
  const out: string[] = []
  for (const [plugin, keys] of usedBy) {
    if (keys.includes(key)) out.push(plugin)
  }
  return out
}

/**
 * `string, minLength 32` — the `expected:` line of §16.2.
 *
 * Read off the same JSON Schema probe the serializer, the OpenAPI generator and
 * the coercion planner use, so it cannot describe a constraint the schema does
 * not have. A hand-maintained mapping from schema to prose would drift the
 * first time somebody added `.max()`.
 */
export function describeConstraint(node: JsonSchemaNode | undefined): string | null {
  if (typeof node !== 'object' || node === null) return null

  const parts: string[] = []
  if (node.enum !== undefined) parts.push(`one of ${node.enum.map((v) => String(v)).join(' | ')}`)
  else if (node.const !== undefined) parts.push(`exactly ${String(node.const)}`)
  else if (node.type !== undefined) parts.push([node.type].flat().join(' | '))

  if (node.format !== undefined && node.format !== 'password') parts.push(node.format)

  const min = node['minLength']
  const max = node['maxLength']
  if (typeof min === 'number') parts.push(`min length ${min}`)
  if (typeof max === 'number') parts.push(`max length ${max}`)

  const low = node['minimum'] ?? node['exclusiveMinimum']
  const high = node['maximum'] ?? node['exclusiveMaximum']
  if (typeof low === 'number' && typeof high === 'number') parts.push(`between ${low} and ${high}`)
  else if (typeof low === 'number') parts.push(`at least ${low}`)
  else if (typeof high === 'number') parts.push(`at most ${high}`)

  const pattern = node['pattern']
  if (typeof pattern === 'string') parts.push(`matching /${pattern}/`)

  return parts.length === 0 ? null : parts.join(', ')
}

function isThenable(value: unknown): value is Promise<StandardResult<unknown>> {
  return typeof value === 'object' && value !== null
    && typeof (value as Promise<unknown>).then === 'function'
}
