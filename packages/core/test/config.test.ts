import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, REDACTED, defineConfig, definePlugin, explainConfig, parseDotenv, dotenvChain,
  resolveConfig, foldEnv, describeConstraint, toJsonSchema,
  type EnvSource, type Plugin,
} from '@visionpilot/zen-core'
import { makeApp } from './helpers.ts'

/**
 * Configuration — rfcs/0001 §16.
 *
 * A config system is easy to write and hard to write *honestly*, and the four
 * things under test here are the four places the honest version differs from
 * the easy one:
 *
 *   1. **Provenance survives resolution.** The easy implementation spreads each
 *      layer over the last, which produces the right value and destroys the only
 *      other thing anyone wants during an incident — which layer produced it.
 *      §16.1 makes that a requirement, so every assertion about a value here is
 *      paired with one about where it came from.
 *   2. **Validation happens before anything else boots** (§16.2), and "before"
 *      is checked by watching a plugin's `setup` *not* run — not by reading the
 *      order of two lines in `ready()`.
 *   3. **A secret does not appear in any projection.** Not in the snapshot, not
 *      in `explainConfig`, not in a boot diagnostic, and not in
 *      `JSON.stringify(app.config)`. The last one is the interesting case,
 *      because it is the one that happens by accident in production.
 *   4. **The frozen object is genuinely frozen** (§16.4), and reading it is
 *      free — `ctx.config` is a getter over a shared object, so it must not
 *      change a single byte of any generated pipeline.
 *
 * There is deliberately **no compiled/interpreted differential suite** for this
 * subsystem, and the absence is not an oversight: config compiles nothing. It
 * resolves a tree at boot and hands back a frozen object, so there is no second
 * implementation for a fuzzer to disagree with. The property suite in
 * `config-properties.test.ts` covers what a differential suite would have —
 * that the fold is total, deterministic, and never leaks a secret — over random
 * layer stacks. Health is the other subsystem with no twin, for the same reason.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A schema that validates *and* exposes its shape — see `helpers.shaped`
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>

/**
 * The env-schema shape, hand-written: convert per the declared type, then check.
 *
 * `@visionpilot/zen-core` has no runtime dependencies and its tests keep that honest
 * (§19.8), so real Zod lives in `examples/config`. What this needs to be is
 * *representative* rather than complete: an object schema that coerces strings
 * the way `z.coerce.number()` does, applies defaults, reports issues with a
 * path, and can describe itself as JSON Schema — because the `expected:` line
 * of §16.2 and the secret markers both come from the description, not from the
 * validator.
 */
function envSchema(json: Json) {
  const properties = (json['properties'] ?? {}) as Record<string, Json>
  const required = (json['required'] ?? []) as string[]

  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-test-env',
      validate(value: unknown) {
        const input = value as Record<string, unknown>
        const out: Record<string, unknown> = {}
        const issues: Array<{ message: string; path: PropertyKey[] }> = []

        for (const [key, node] of Object.entries(properties)) {
          const raw = input[key]
          if (raw === undefined) {
            if (node['default'] !== undefined) out[key] = node['default']
            else if (required.includes(key)) issues.push({ message: 'required', path: [key] })
            continue
          }

          const type = node['type'] as string | undefined
          const text = String(raw)
          if (type === 'integer' || type === 'number') {
            const n = Number(text)
            if (!Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) {
              issues.push({ message: `expected ${type}, received "${text}"`, path: [key] })
              continue
            }
            const min = node['minimum'] as number | undefined
            const max = node['maximum'] as number | undefined
            if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
              issues.push({ message: `out of range`, path: [key] })
              continue
            }
            out[key] = n
          } else if (type === 'boolean') {
            out[key] = text === 'true' || text === '1'
          } else {
            const min = node['minLength'] as number | undefined
            const values = node['enum'] as string[] | undefined
            if (min !== undefined && text.length < min) {
              issues.push({ message: `too short`, path: [key] })
              continue
            }
            if (values !== undefined && !values.includes(text)) {
              issues.push({ message: `expected one of ${values.join(', ')}`, path: [key] })
              continue
            }
            out[key] = text
          }
        }

        return issues.length > 0 ? { issues } : { value: out }
      },
    },
    toJSONSchema: () => json,
  } as never
}

/** One `env`-layer source, in the array form `ZenOptions.env` takes. */
const env = (values: Record<string, string>, name = 'process.env'): readonly EnvSource[] => [{
  layer: 'env',
  name,
  entries: Object.entries(values).map(([key, value]) => ({ key, value })),
}]

// ─────────────────────────────────────────────────────────────────────────────

describe('layering and provenance (§16.1)', () => {
  test('later layers win, and every value knows which one won it', async () => {
    const app = makeApp({
      config: defineConfig({ server: { port: 8080 }, logging: { level: 'info' } }),
      overrides: { logging: { level: 'debug' } },
    })
    await app.ready()

    assert.equal(app.config.server.port, 8080)
    assert.equal(app.config.logging.level, 'debug')

    const snapshot = app.graph().config
    const port = snapshot.values.find((v) => v.path === 'server.port')
    const level = snapshot.values.find((v) => v.path === 'logging.level')

    // The value alone is what every framework gives you. The layer is the half
    // that answers "why is this not what my config file says".
    assert.equal(port?.layer, 'config')
    assert.equal(level?.layer, 'override')
    assert.equal(level?.source, 'overrides')
  })

  test('a framework default is a real layer, not a fallback in the reader', async () => {
    const app = makeApp()
    await app.ready()

    // §16.1's first layer. It matters that this is a *layer* rather than an
    // `?? 3000` somewhere: a value with no provenance is a value nobody can
    // explain, and `server.port` is the one every deployment argues about.
    const port = app.graph().config.values.find((v) => v.path === 'server.port')
    assert.equal(port?.value, 3000)
    assert.equal(port?.layer, 'default')
    assert.equal(port?.source, 'default')
  })

  test('the eight layers resolve in the documented order', () => {
    const layers = ['default', 'plugin', 'config', 'overlay', 'override'] as const
    for (let i = 0; i < layers.length - 1; i++) {
      const lower = layers[i] as 'default'
      const upper = layers[i + 1] as 'plugin'
      const result = resolveConfig({
        definition: undefined,
        envSources: [],
        // Supplied in the *wrong* order on purpose: precedence must come from
        // the layer, not from the order somebody happened to push them.
        overlays: [
          { layer: upper, name: `${upper}-src`, values: { x: upper } },
          { layer: lower, name: `${lower}-src`, values: { x: lower } },
        ],
      })
      assert.equal(result.config['x'], upper, `${upper} must beat ${lower}`)
    }
  })

  test('env sources layer among themselves, keeping the file and the line', () => {
    const dotenv = (name: string, text: string): EnvSource => ({
      layer: 'dotenv',
      name,
      entries: parseDotenv(text).entries,
    })

    const folded = foldEnv([
      ...env({ PORT: '9999' }),
      dotenv('.env', 'HOST=example.com\nPORT=1111'),
      dotenv('.env.local', '# a comment\nPORT=2222'),
    ])

    // `process.env` is layer 6 and `.env` files are layer 5, so the environment
    // wins — which is the ordering a container platform depends on.
    assert.equal(folded.values.get('PORT')?.value, '9999')
    assert.equal(folded.values.get('HOST')?.value, 'example.com')
    assert.equal(folded.values.get('HOST')?.source, '.env:1')

    // And the shadowed sources say so, which is how you find out that the
    // `.env` you have been editing has not been read for a month.
    const first = folded.sources.find((s) => s.name === '.env')
    assert.equal(first?.supplied, 2)
    assert.equal(first?.won, 1)
  })

  test('a value overwritten inside one source is counted once, not twice', () => {
    // The tally is recomputed from the final ownership map rather than
    // incremented as the fold walks, because a `.env` that sets PORT twice
    // would otherwise report two wins for one key.
    const folded = foldEnv([{
      layer: 'dotenv',
      name: '.env',
      entries: [{ key: 'PORT', value: '1', line: 1 }, { key: 'PORT', value: '2', line: 2 }],
    }])
    assert.equal(folded.values.get('PORT')?.value, '2')
    assert.equal(folded.sources[0]?.won, 1)
    assert.equal(folded.sources[0]?.supplied, 2)
  })

  test('the snapshot lists the *declared* environment, not the process\'s', async () => {
    const Schema = envSchema({
      type: 'object',
      properties: { PORT: { type: 'integer', default: 3000 } },
    })

    const app = makeApp({
      config: defineConfig({ env: Schema }),
      env: env({ PORT: '8080', HOME: '/home/ada', AWS_SESSION_TOKEN: 'FQoGZXIvYXdzE' }),
    })
    await app.ready()

    // Found by writing the reader: `examples/config`'s provenance table listed
    // seventy rows of a laptop's environment before this. Three things were
    // wrong at once and only the first is cosmetic — it buried the five
    // relevant rows; it put the *name* of every variable in the process onto
    // the AppGraph, and a name is topology even when the value is withheld; and
    // with no `env` schema the values would have gone there too.
    //
    // The declared environment is the application's contract with its
    // deployment. What else happens to be set is not configuration.
    assert.deepEqual(app.graph().config.env.map((e) => e.key), ['PORT'])
    assert.ok(!JSON.stringify(app.graph().config).includes('FQoGZXIvYXdzE'))
    assert.ok(!JSON.stringify(app.graph().config).includes('AWS_SESSION_TOKEN'))

    // …and a thunk still sees everything, because a config with no schema reads
    // raw keys and must be able to.
    const loose = makeApp({
      config: defineConfig({ home: (e) => e['HOME'] }),
      env: env({ HOME: '/home/ada' }),
    })
    await loose.ready()
    assert.equal(loose.config.home, '/home/ada')
    assert.deepEqual(loose.graph().config.env, [])
  })

  test('a plugin\'s declared variable joins the declared environment', async () => {
    const Redis: Plugin<void, {}> = definePlugin<void, {}>({
      name: 'redis',
      version: '1.0.0',
      config: { env: ['REDIS_URL'] },
      setup() {},
    })

    const app = makeApp({ env: env({ REDIS_URL: 'redis://localhost', HOME: '/home/ada' }) })
    app.use(Redis)
    await app.ready()

    // No `env` schema anywhere, and the table still has exactly the right row:
    // "declared" means *someone* declared it, and a plugin manifest is a
    // declaration.
    assert.deepEqual(app.graph().config.env.map((e) => e.key), ['REDIS_URL'])
    assert.deepEqual(app.graph().config.env[0]?.usedBy, ['redis'])
  })

  test('a .env file naming something nothing reads is reported; the process environment is not', async () => {
    const app = makeApp({
      config: defineConfig({
        env: envSchema({ type: 'object', properties: { PORT: { type: 'integer', default: 3000 } } }),
      }),
      env: [
        { layer: 'dotenv', name: '.env', entries: parseDotenv('PORT=8080\nSTIRPE_KEY=sk_typo').entries },
        ...env({ HOME: '/home/ada', PATH: '/usr/bin' }),
      ],
    })
    await app.ready()

    const dotfile = app.graph().config.sources.find((s) => s.name === '.env')
    const process = app.graph().config.sources.find((s) => s.name === 'process.env')
    // A `.env` file is a statement of intent, so a misspelled key in one is
    // almost always a typo and is worth a line. The process environment is
    // ambient, and "your laptop has 64 variables this service does not read" is
    // noise that trains people to ignore the report.
    assert.equal(dotfile?.undeclared, 1)
    assert.equal(process?.undeclared, 0)
  })

  test('arrays replace, they never concatenate', async () => {
    const app = makeApp({
      config: defineConfig({ logging: { redact: ['a', 'b'] } }),
      overrides: { logging: { redact: ['c'] } },
    })
    await app.ready()
    // Concatenating would make "remove a path from the redaction set"
    // inexpressible, which is exactly the operation an incident calls for.
    assert.deepEqual(app.config.logging.redact, ['c'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('environment validation (§16.2)', () => {
  const Schema = envSchema({
    type: 'object',
    properties: {
      NODE_ENV: { type: 'string', enum: ['development', 'test', 'production'], default: 'development' },
      PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 3000 },
      JWT_SECRET: { type: 'string', minLength: 32, format: 'password' },
    },
    required: ['JWT_SECRET'],
  })

  test('a missing variable is a boot error naming the constraint', async () => {
    const app = makeApp({ config: defineConfig({ env: Schema }), env: env({}) })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const issue = error.diagnostics.find((d) => d.code === 'ZEN_ENV_INVALID')
    assert.ok(issue !== undefined)
    assert.match(issue.message, /JWT_SECRET/)
    assert.match(issue.message, /required, but not set/)
    // The `expected:` line of §16.2, read off the same JSON Schema probe the
    // serializer and the OpenAPI generator use — so it cannot describe a
    // constraint the schema does not have.
    assert.match(issue.message, /min length 32/)
    assert.match(issue.hint ?? '', /\.env\.local/)
  })

  test('several bad variables are reported in one run, not one per restart', async () => {
    const app = makeApp({
      config: defineConfig({ env: Schema }),
      env: env({ NODE_ENV: 'staging', PORT: 'abc' }),
    })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    // NODE_ENV, PORT and the missing JWT_SECRET. A developer setting up a
    // service for the first time has all three at once and a fail-fast check
    // turns that into three runs (§12.7).
    assert.equal(error.diagnostics.filter((d) => d.code === 'ZEN_ENV_INVALID').length, 3)
  })

  test('the message names the file and line the bad value came from', async () => {
    const app = makeApp({
      config: defineConfig({ env: Schema }),
      env: [
        { layer: 'dotenv', name: '.env', entries: parseDotenv('JWT_SECRET=0123456789012345678901234567890123\nPORT=abc').entries },
      ],
    })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const port = error.diagnostics.find((d) => d.message.startsWith('PORT'))
    assert.deepEqual(port?.locations, ['.env:2'])
    // "PORT is not a valid integer" sends someone hunting through four files.
    assert.match(error.message, /\.env:2/)
  })

  test('a secret is never printed, even when it is the thing that failed', async () => {
    const app = makeApp({
      config: defineConfig({ env: Schema }),
      env: env({ JWT_SECRET: 'too-short-to-be-a-key' }),
    })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    // The value is what makes a `PORT="abc"` message actionable and what makes
    // a `JWT_SECRET` message a leak into whatever collects boot logs.
    assert.ok(!error.message.includes('too-short-to-be-a-key'))
    assert.match(error.message, new RegExp(REDACTED.replace(/\*/g, '\\*')))
  })

  test('a non-secret bad value IS printed, because that is what makes it fixable', async () => {
    const app = makeApp({
      config: defineConfig({ env: Schema }),
      env: env({ JWT_SECRET: '0123456789012345678901234567890123', PORT: 'abc' }),
    })
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /"abc"/)
  })

  test('`used by` comes from the plugin manifest, before any plugin has run', async () => {
    const Jwt: Plugin<void, {}> = definePlugin<void, {}>({
      name: 'jwt',
      version: '1.0.0',
      config: { env: ['JWT_SECRET'] },
      setup() {},
    })

    const app = makeApp({ config: defineConfig({ env: Schema }), env: env({}) })
    app.use(Jwt)

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const issue = error.diagnostics.find((d) => d.message.startsWith('JWT_SECRET'))
    // A manifest field rather than a `Registrar` call precisely so this works:
    // the declaration has to be readable before the plugin runs, because the
    // whole point is that the plugin does *not* run.
    assert.match(issue?.consequence ?? '', /jwt/)
  })

  test('validation runs before anything else boots — no plugin setup happens', async () => {
    let ran = false
    const Redis: Plugin<void, {}> = definePlugin<void, {}>({
      name: 'redis',
      version: '1.0.0',
      setup() { ran = true },
    })

    const app = makeApp({ config: defineConfig({ env: Schema }), env: env({}) })
    app.use(Redis)
    await app.ready().then(() => null, () => null)

    // §16.2's sentence, checked by observation rather than by reading the order
    // of two lines. A plugin that opened a connection pool against a database
    // whose URL failed validation is the failure this ordering prevents.
    assert.equal(ran, false)
  })

  test('an asynchronous env schema is refused rather than quietly awaited', async () => {
    const Async = {
      '~standard': {
        version: 1 as const,
        vendor: 'test-async',
        validate: async () => ({ value: {} }),
      },
    } as never

    const app = makeApp({ config: defineConfig({ env: Async }) })
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /asynchronously/)
  })

  test('a valid environment reaches the thunks already converted', async () => {
    const app = makeApp({
      config: defineConfig({
        env: Schema,
        server: { port: (e) => e.PORT },
        mode: (e) => e.NODE_ENV,
      }),
      env: env({ PORT: '8080', JWT_SECRET: '0123456789012345678901234567890123' }),
    })
    await app.ready()

    // The schema's *output*, not the wire string. This is the whole content of
    // "validation happens first": a thunk is a function of a validated value.
    assert.equal(app.config.server.port, 8080)
    assert.equal(app.config.mode, 'development')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('thunks', () => {
  test('without an env schema, a thunk receives the raw strings', async () => {
    const app = makeApp({
      config: defineConfig({ port: (e) => Number(e['PORT'] ?? 3000) }),
      env: env({ PORT: '4000' }),
    })
    await app.ready()
    assert.equal(app.config.port, 4000)
  })

  test('a thunk that throws is a diagnostic, not a crash', async () => {
    const app = makeApp({
      config: defineConfig({
        broken: () => { throw new Error('no filesystem here') },
      }),
    })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const issue = error.diagnostics.find((d) => d.code === 'ZEN_CONFIG_INVALID')
    assert.match(issue?.message ?? '', /config\.broken threw/)
    assert.match(issue?.message ?? '', /no filesystem here/)
    // It names the remedy rather than the stack: a thunk is a pure function of
    // the environment, and anything that can throw belongs somewhere with an
    // error channel.
    assert.match(issue?.hint ?? '', /pure function/)
  })

  test('a thunk returning an object merges exactly like a literal one', async () => {
    const thunked = makeApp({
      config: defineConfig({ limits: () => ({ body: '1mb', headers: '4kb' }) }),
      overrides: { limits: { headers: '8kb' } },
    })
    const literal = makeApp({
      config: defineConfig({ limits: { body: '1mb', headers: '4kb' } }),
      overrides: { limits: { headers: '8kb' } },
    })
    await thunked.ready()
    await literal.ready()

    // The two declarations read as the same thing, so a fold in which one
    // merges and the other replaces is a rule nobody can hold in their head.
    assert.deepEqual(thunked.config.limits, { body: '1mb', headers: '8kb' })
    assert.deepEqual(thunked.config.limits, literal.config.limits)

    // And the snapshot lists real leaves, not a path that does not exist on
    // `app.config` — `limits` and `limits.headers` cannot both be paths.
    const paths = thunked.graph().config.values.map((v) => v.path)
    assert.ok(paths.includes('limits.body'))
    assert.ok(!paths.includes('limits'))
  })

  test('a later scalar replaces the subtree it shadows, and a later branch replaces a scalar', async () => {
    const collapsed = makeApp({
      config: defineConfig({ limits: { body: '1mb', headers: '4kb' } }),
      overrides: { limits: 'off' },
    })
    const grown = makeApp({
      config: defineConfig({ limits: 'off' }),
      overrides: { limits: { body: '1mb' } },
    })
    await collapsed.ready()
    await grown.ready()

    // Later wins in both directions. Without this the flat leaf map can hold
    // `limits` and `limits.body` at once, which is not a shape any object has.
    assert.equal(collapsed.config.limits, 'off')
    assert.deepEqual(grown.config.limits, { body: '1mb' })

    // Both directions asserted against the *snapshot*, not only against the
    // object. The object alone is not enough, and this line is here because the
    // negative control proved it: deleting the ancestor-removal half of the
    // rule left `grown.config.limits` correct — `assign` overwrites a scalar
    // parent on its way down — while the snapshot listed `limits` *and*
    // `limits.body`, a path pair no object can have. The property suite caught
    // it and this test did not, which is the definition of a test that passes
    // against the bug (§20.7).
    const paths = (app: typeof grown): string[] =>
      app.graph().config.values.map((v) => v.path).filter((p) => p.startsWith('limits'))
    assert.deepEqual(paths(collapsed), ['limits'])
    assert.deepEqual(paths(grown), ['limits.body'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('freeze and redaction (§16.2, §16.4)', () => {
  const Secrets = envSchema({
    type: 'object',
    properties: {
      DATABASE_URL: { type: 'string', format: 'password' },
      PUBLIC_URL: { type: 'string' },
    },
    required: ['DATABASE_URL', 'PUBLIC_URL'],
  })

  const build = () => makeApp({
    config: defineConfig({
      env: Secrets,
      database: { url: (e) => e.DATABASE_URL, pool: 10 },
      site: { url: (e) => e.PUBLIC_URL },
    }),
    env: env({ DATABASE_URL: 'postgres://user:hunter2@db/app', PUBLIC_URL: 'https://acme.com' }),
  })

  test('mutating config throws', async () => {
    const app = build()
    await app.ready()
    assert.throws(() => { (app.config.database as { pool: number }).pool = 20 }, TypeError)
    assert.throws(() => { (app.config as { database: unknown }).database = {} }, TypeError)
  })

  test('the value is readable by name and redacted on serialisation', async () => {
    const app = build()
    await app.ready()

    // Reachable, because a driver needs it.
    assert.equal(app.config.database.url, 'postgres://user:hunter2@db/app')

    // Not reachable by accident, because a log line does not ask by name. This
    // is the case that happens in production: somebody logs the config object.
    const printed = JSON.stringify(app.config)
    assert.ok(!printed.includes('hunter2'))
    assert.ok(printed.includes(REDACTED))
    // And at every level, not only at the root — `JSON.stringify(cfg.database)`
    // is just as easy to write.
    assert.ok(!JSON.stringify(app.config.database).includes('hunter2'))

    // A non-secret keeps its value: redaction that hides everything hides
    // nothing, because people turn it off.
    assert.ok(printed.includes('https://acme.com'))
  })

  test('secrecy propagates from the environment to a leaf that carries it verbatim', async () => {
    const app = build()
    await app.ready()
    const snapshot = app.graph().config

    // `url: env => env.DATABASE_URL` inherits the marking without restating it.
    const url = snapshot.values.find((v) => v.path === 'database.url')
    assert.equal(url?.secret, true)
    assert.equal(url?.value, REDACTED)

    const site = snapshot.values.find((v) => v.path === 'site.url')
    assert.equal(site?.secret, false)
    assert.equal(site?.value, 'https://acme.com')
  })

  test('a *derived* value is not marked — the gap, asserted so it cannot move silently', async () => {
    const app = makeApp({
      config: defineConfig({
        env: Secrets,
        database: { readReplica: (e) => `${e.DATABASE_URL}?replica=1` },
      }),
      env: env({ DATABASE_URL: 'postgres://user:hunter2@db/app', PUBLIC_URL: 'https://acme.com' }),
    })
    await app.ready()

    // Propagation is by *identity*, not similarity. A substring search would
    // redact anything containing the word `localhost`, and a taint-tracking
    // scheme would need a proxy around a frozen object. Both are worse than
    // documenting this and offering `secrets: ['database.readReplica']`.
    const leaked = app.graph().config.values.find((v) => v.path === 'database.readReplica')
    assert.equal(leaked?.secret, false)
    assert.ok(String(leaked?.value).includes('hunter2'))
  })

  test('`secrets: [...]` marks an env key or a config path by hand', async () => {
    const app = makeApp({
      config: defineConfig({
        env: envSchema({ type: 'object', properties: { TOKEN: { type: 'string' } }, required: ['TOKEN'] }),
        secrets: ['TOKEN', 'api.key'],
        api: { key: 'literal-key', name: 'public' },
      }),
      env: env({ TOKEN: 'abcdef' }),
    })
    await app.ready()

    const snapshot = app.graph().config
    assert.equal(snapshot.env.find((e) => e.key === 'TOKEN')?.value, REDACTED)
    assert.equal(snapshot.values.find((v) => v.path === 'api.key')?.value, REDACTED)
    assert.equal(snapshot.values.find((v) => v.path === 'api.name')?.value, 'public')
    // Still the real value where it is used.
    assert.equal(app.config.api.key, 'literal-key')
  })

  test('the snapshot on the graph is redacted at the source, not by each printer', async () => {
    const app = build()
    await app.ready()

    // Nothing that reads the graph has a `secret` branch to forget, because the
    // secret is not in the graph. That is as close to a security property as a
    // projection can get.
    assert.ok(!JSON.stringify(app.graph().config).includes('hunter2'))
    assert.ok(!explainConfig(app.graph().config).includes('hunter2'))
  })

  test('an unreadable env schema warns once about the markers it could not read', async () => {
    const warnings: string[] = []
    const logger = {
      level: 'warn' as const,
      child() { return logger },
      trace() {}, debug() {}, info() {}, error() {}, fatal() {},
      warn(_meta: unknown, message?: string) { warnings.push(message ?? '') },
    }

    // A Standard Schema with no shape channel at all: it validates, and no
    // probe can describe it.
    const Opaque = {
      '~standard': {
        version: 1 as const,
        vendor: 'test-opaque',
        validate: (v: unknown) => ({ value: v }),
      },
    } as never

    const app = makeApp({ config: defineConfig({ env: Opaque }), logger: logger as never })
    await app.ready()

    assert.equal(warnings.length, 1)
    // The honest failure: without a shape, `format: 'password'` is invisible,
    // so a value the author marked will be printed. Naming that is the whole
    // job of the warning.
    assert.match(warnings[0] as string, /secret markers/)
    assert.match(warnings[0] as string, /registerSchemaConverter/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('ctx.config (§16.3)', () => {
  test('is the same frozen object the app holds, on every request', async () => {
    const app = makeApp({ config: defineConfig({ feature: { enabled: true } }) })
    app.get('/x', (ctx) => ({ same: (ctx as never as { config: unknown }).config === app.config }))
    await app.ready()

    const res = await app.inject('GET', '/x')
    assert.deepEqual(res.json(), { same: true })
  })

  test('is present on the interpreted twin too', async () => {
    // `caps.eval === false` is production for workerd, so `ctx.config` has to
    // exist in both context implementations or the feature is Node-only.
    const app = makeApp({
      config: defineConfig({ feature: { enabled: true } }),
      caps: { eval: false, fs: false, timers: true, crypto: true, workers: false, streams: true } as never,
    })
    app.get('/x', (ctx) => (ctx as never as { config: { feature: { enabled: boolean } } }).config.feature)
    await app.ready()

    assert.deepEqual((await app.inject('GET', '/x')).json(), { enabled: true })
  })

  test('reading it changes no generated pipeline', async () => {
    const source = (configured: boolean): string => {
      const app = makeApp(configured ? { config: defineConfig({ a: { b: 1 } }) } : {})
      app.get('/x', () => 'ok')
      return app as never as string
    }
    void source

    const plain = makeApp()
    plain.get('/x', () => 'ok')
    const configured = makeApp({ config: defineConfig({ a: { b: 1 } }), overrides: { a: { b: 2 } } })
    configured.get('/x', () => 'ok')
    await plain.ready()
    await configured.ready()

    const pipeline = (app: typeof plain): string =>
      app.generatedSource().find((u) => u.name.startsWith('pipeline:'))?.source ?? ''

    // §16.3's cost claim, asserted the way §9.4 and §4.4 assert theirs: against
    // the emitted bytes, because a timing result inside the noise is also what
    // a real small cost looks like. `ctx.config` is a getter over a shared
    // object, so there is nothing for a pipeline to carry.
    assert.equal(pipeline(plain), pipeline(configured))
    assert.ok(pipeline(plain).length > 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('plugin configuration (§16.1 layer 2)', () => {
  const Cache: Plugin<void, {}> = definePlugin<void, {}>({
    name: 'cache',
    version: '1.0.0',
    config: { namespace: 'cache', defaults: { ttl: '5m', store: 'memory' } },
    setup() {},
  })

  test('a plugin default lands under its namespace', async () => {
    const app = makeApp()
    app.use(Cache)
    await app.ready()

    assert.deepEqual(app.config.cache, { ttl: '5m', store: 'memory' })
    const ttl = app.graph().config.values.find((v) => v.path === 'cache.ttl')
    assert.equal(ttl?.layer, 'plugin')
    assert.equal(ttl?.source, 'cache')
  })

  test('the application beats the plugin, field by field', async () => {
    const app = makeApp({ config: defineConfig({ cache: { ttl: '30s' } }) })
    app.use(Cache)
    await app.ready()

    // A default is a default. Overriding one field must not delete the others,
    // which is the difference between merging the layer and replacing it.
    assert.deepEqual(app.config.cache, { ttl: '30s', store: 'memory' })
    assert.equal(app.graph().config.values.find((v) => v.path === 'cache.store')?.layer, 'plugin')
  })

  test('registering a plugin after reading config still contributes its defaults', async () => {
    const app = makeApp()
    // Reading first is the trap: a snapshot cached here would be one layer out
    // of date for the rest of the process.
    assert.equal((app.config as Record<string, unknown>)['cache'], undefined)
    app.use(Cache)
    await app.ready()
    assert.deepEqual(app.config.cache, { ttl: '5m', store: 'memory' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('listen() reads the configured address (§16.1, §21.2)', () => {
  test('an explicit port wins; otherwise config decides', async () => {
    const seen: Array<{ port?: number | undefined; host?: string | undefined }> = []
    const adapter = {
      name: 'test',
      caps: { eval: true, fs: false, timers: true, crypto: true, workers: false, streams: true },
      listen: async (_dispatch: unknown, opts: { port?: number; host?: string }) => {
        seen.push({ port: opts.port, host: opts.host })
        return { address: null, url: 'http://test', close: async () => {} }
      },
    } as never

    const app = makeApp({
      adapter,
      config: defineConfig({ server: { port: 8080, host: '0.0.0.0' } }),
    })
    await app.listen()
    assert.deepEqual(seen[0], { port: 8080, host: '0.0.0.0' })

    const explicit = makeApp({ adapter, config: defineConfig({ server: { port: 8080 } }) })
    await explicit.listen({ port: 1234 })
    // `app.listen()` should be the correct call in a deployed service, and an
    // explicit argument should still win — both, not one.
    assert.equal(seen[1]?.port, 1234)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the .env parser (§16.1 layer 5)', () => {
  test('the grammar, one case at a time', () => {
    const { entries } = parseDotenv([
      '# a comment',
      '',
      'PLAIN=value',
      '  SPACED   =   trimmed   ',
      'export EXPORTED=shell-compatible',
      'QUOTED="  kept  "',
      "SINGLE='literal \\n stays'",
      'ESCAPED="line\\nbreak"',
      'PASSWORD=hunter#2',
      'COMMENTED=value # trailing',
      'WINDOWS=C:\\Users\\me',
      'EMPTY=',
    ].join('\n'))

    const value = (key: string) => entries.find((e) => e.key === key)?.value
    assert.equal(value('PLAIN'), 'value')
    assert.equal(value('SPACED'), 'trimmed')
    assert.equal(value('EXPORTED'), 'shell-compatible')
    // Quotes are how you say "the whitespace is mine".
    assert.equal(value('QUOTED'), '  kept  ')
    assert.equal(value('SINGLE'), 'literal \\n stays')
    assert.equal(value('ESCAPED'), 'line\nbreak')
    // The one that matters: truncating a password at a `#` would be the worst
    // possible failure mode for this parser, and it is silent.
    assert.equal(value('PASSWORD'), 'hunter#2')
    assert.equal(value('COMMENTED'), 'value')
    assert.equal(value('WINDOWS'), 'C:\\Users\\me')
    assert.equal(value('EMPTY'), '')
  })

  test('lines carry their number, which is the whole reason to parse rather than eval', () => {
    const { entries } = parseDotenv('A=1\n\n# skip\nB=2')
    assert.equal(entries.find((e) => e.key === 'A')?.line, 1)
    assert.equal(entries.find((e) => e.key === 'B')?.line, 4)
  })

  test('CRLF and a BOM do not end up inside a key', () => {
    const { entries } = parseDotenv('\uFEFFPORT=3000\r\nHOST=x\r\n')
    assert.equal(entries[0]?.key, 'PORT')
    assert.equal(entries[0]?.value, '3000')
    assert.equal(entries[1]?.value, 'x')
  })

  test('a malformed line is reported, not fatal', () => {
    const { entries, problems } = parseDotenv('GOOD=1\nthis is not a setting\n=novalue')
    assert.equal(entries.length, 1)
    assert.equal(problems.length, 2)
    assert.equal(problems[0]?.line, 2)
  })

  test('the file chain skips .env.local under test', () => {
    assert.deepEqual(dotenvChain('development'), ['.env', '.env.local', '.env.development', '.env.development.local'])
    // A test run has to produce the same result on a laptop and in CI, and
    // `.env.local` is by definition the file that differs between them.
    assert.deepEqual(dotenvChain('test'), ['.env', '.env.test'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('explainConfig (§16.1)', () => {
  test('prints the value, the source, and what each layer contributed', async () => {
    const app = makeApp({
      config: defineConfig({
        env: envSchema({ type: 'object', properties: { PORT: { type: 'integer' } }, required: ['PORT'] }),
        server: { port: (e) => e.PORT },
      }),
      env: [{ layer: 'dotenv', name: '.env.development', entries: parseDotenv('X=1\nPORT=8080').entries }],
    })
    await app.ready()

    const text = explainConfig(app.graph().config)
    assert.match(text, /server\.port\s+8080\s+← zen\.config/)
    assert.match(text, /PORT\s+8080\s+← \.env\.development:2/)
    // The layer table is the half people do not think to ask for: a source that
    // supplied two variables and won one is either redundant or shadowed.
    assert.match(text, /precedence order/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('describeConstraint', () => {
  test('renders what a schema actually declares, and nothing it does not', () => {
    assert.equal(describeConstraint({ type: 'string', minLength: 32 }), 'string, min length 32')
    assert.equal(describeConstraint({ type: 'integer', minimum: 1, maximum: 65535 }), 'integer, between 1 and 65535')
    assert.equal(describeConstraint({ enum: ['a', 'b'] }), 'one of a | b')
    assert.equal(describeConstraint({ type: ['string', 'null'] }), 'string | null')
    assert.equal(describeConstraint({}), null)
    // `format: 'password'` is a *marker*, not a constraint; echoing it into the
    // error message would print the word "password" next to a redacted value.
    assert.equal(describeConstraint({ type: 'string', format: 'password' }), 'string')
    assert.equal(describeConstraint({ type: 'string', format: 'uri' }), 'string, uri')
  })

  test('reads the same probe every other subsystem reads', () => {
    const schema = envSchema({ type: 'object', properties: { A: { type: 'string', minLength: 3 } } })
    const shape = toJsonSchema(schema, 'input')
    assert.equal(describeConstraint(shape?.properties?.['A']), 'string, min length 3')
  })
})
