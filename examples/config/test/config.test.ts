import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { BootError, REDACTED, explainConfig, parseDotenv, type EnvSource } from '@erenthedeveloper0/zen'
import { makeApp } from '../src/app.ts'
import config from '../src/config/zen.config.ts'
import type { AppConfig, AppEnv } from '../src/config/types.ts'
import { z } from '../src/shared/zod.ts'

/**
 * The configuration example — rfcs/0001 §16.
 *
 * This suite exists for two reasons the core suite cannot serve.
 *
 * **Real Zod.** `@erenthedeveloper0/zen-core` has no runtime dependencies and its tests keep
 * that honest, so the core suite validates against a hand-written schema. The
 * claims §16.2 makes are about what a *real* schema library produces:
 * `z.coerce.number().int().min(1).max(100)` converting `'25'` to `25` and
 * reporting a range, and `.meta({ format: 'password' })` surviving into JSON
 * Schema so the secret marker is visible. Neither is true by construction; both
 * are true because Zod emits what Zen reads, and only this file can check that.
 *
 * **Types.** Package tests are not type-checked and example tests are, so a
 * claim about types belongs here (HANDOFF §2). `ctx.config.pagination.pageSize`
 * being a `number` is the entire content of "config is typed", and a test that
 * only asserted the runtime value would pass against a `ctx.config: any`.
 */

const env = (values: Record<string, string>): readonly EnvSource[] => [{
  layer: 'env',
  name: 'test',
  entries: Object.entries(values).map(([key, value]) => ({ key, value })),
}]

const VALID = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://zen:hunter2@localhost:5432/zen',
  SMTP_URL: 'smtp://localhost:1025',
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the environment is validated by a real schema (§16.2)', () => {
  test('a missing secret is a boot failure, and the message does not contain it', async () => {
    const app = makeApp({ quiet: true, env: env({ NODE_ENV: 'test' }) })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const issue = error.diagnostics.find((d) => d.code === 'ZEN_ENV_INVALID')
    assert.match(issue?.message ?? '', /DATABASE_URL/)
    assert.match(issue?.message ?? '', /required, but not set/)
  })

  test('the `expected:` line is read off Zod\'s own JSON Schema', async () => {
    const app = makeApp({ quiet: true, env: env({ ...VALID, PAGE_SIZE: '1000' }) })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    // Nobody wrote this sentence. `z.coerce.number().int().min(1).max(100)`
    // converts to `{ type: 'integer', minimum: 1, maximum: 100 }`, and the
    // diagnostic reads it through the same probe the serializer and the OpenAPI
    // generator use — so it cannot describe a constraint the schema does not
    // have, and it cannot go stale when someone changes `.max()`.
    assert.match(error.message, /expected: integer, between 1 and 100/)
    assert.match(error.message, /"1000"/)
  })

  test('a bad value from a .env line names the file and the line', async () => {
    const app = makeApp({
      quiet: true,
      env: [{
        layer: 'dotenv',
        name: '.env.production',
        entries: parseDotenv([
          '# a comment, so the line numbers below are not the obvious ones',
          `DATABASE_URL=${VALID.DATABASE_URL}`,
          'PORT=not-a-port',
        ].join('\n')).entries,
      }],
    })

    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    assert.match(error.message, /\.env\.production:3/)
  })

  test('`.meta({ format: \'password\' })` is what marks the secret', () => {
    // The mechanism, checked directly rather than inferred from the redaction
    // working. §16.2 writes this marker as Zod's `.brand('secret')`, and that
    // is the one spelling no framework can honour — a brand is erased at
    // runtime and leaves nothing in the schema for anything to read.
    const shape = z.toJSONSchema(config.env as z.ZodType, { io: 'input' })
    const properties = shape['properties'] as Record<string, { format?: string }>
    assert.equal(properties['DATABASE_URL']?.format, 'password')
    assert.equal(properties['SMTP_URL']?.format, undefined)
  })

  test('a valid environment produces converted values', async () => {
    const app = makeApp({ quiet: true, env: env({ ...VALID, PAGE_SIZE: '10', PORT: '4000' }) })
    await app.ready()

    // The schema's *output*. `'10'` on the wire, `10` here, and `number` at the
    // type level — which is the claim `Number(process.env.PAGE_SIZE)` makes and
    // does not keep, because nothing stops it producing `NaN`.
    assert.equal(app.config.pagination.pageSize, 10)
    assert.equal(app.config.server.port, 4000)
    assert.equal(app.config.mode, 'test')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('types (§16.3)', () => {
  test('ctx.config is typed on the app object with no cast', async () => {
    const app = makeApp({ quiet: true, env: env(VALID) })
    await app.ready()

    const res = await app.inject('GET', '/_typed')
    assert.equal(res.status, 200)
    assert.deepEqual(res.json(), { pageSize: 25, mode: 'test', poolSize: 10 })
  })

  test('the resolved types are exact', async () => {
    const app = makeApp({ quiet: true, env: env(VALID) })
    await app.ready()

    // These four lines are the test. They are annotations, so they are checked
    // by `tsc --noEmit -p examples/config` in CI, and a `defineConfig` that
    // resolved its thunks to `unknown` would fail the build rather than a
    // runtime assertion.
    const port: number = app.config.server.port
    const mode: 'development' | 'test' | 'production' = app.config.mode
    const debug: boolean = app.config.debug
    const redact: readonly string[] = app.config.logging.redact

    assert.equal(typeof port, 'number')
    assert.equal(mode, 'test')
    assert.equal(debug, true)
    assert.deepEqual(redact, ['req.headers.authorization', '*.password'])

    // …and the alias in `src/config/types.ts` is the same type, not a second
    // description of it. If it were written by hand and drifted, this fails.
    const viaAlias: AppConfig = app.config
    const fromApp: typeof app.config = viaAlias
    assert.equal(fromApp.server.port, port)

    // The environment type is derived the same way.
    const level: AppEnv['LOG_LEVEL'] = 'debug'
    assert.equal(level, 'debug')
  })

  test('an undeclared namespace is a type error, not `any`', async () => {
    const app = makeApp({ quiet: true, env: env(VALID) })
    await app.ready()
    // @ts-expect-error — nothing declares `config.kafka`
    assert.equal(app.config.kafka, undefined)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('secrets (§16.2)', () => {
  test('readable by name, redacted on serialisation, at every level', async () => {
    const app = makeApp({ quiet: true, env: env(VALID) })
    await app.ready()

    assert.equal(app.config.database.url, VALID.DATABASE_URL)
    assert.ok(!JSON.stringify(app.config).includes('hunter2'))
    assert.ok(!JSON.stringify(app.config.database).includes('hunter2'))
    assert.ok(!explainConfig(app.graph().config).includes('hunter2'))
    assert.ok(!JSON.stringify(app.graph().config).includes('hunter2'))
  })

  test('`secrets: [...]` covers what a schema cannot say', async () => {
    const app = makeApp({ quiet: true, env: env(VALID) })
    await app.ready()

    // `stripe.key` is a literal in `zen.config.ts`, not an environment
    // variable, so no schema exists to mark it and the by-hand list is the only
    // mechanism left. Worth having a case for, because it is the shape most
    // applications' worst secret actually has.
    assert.equal(app.config.stripe.key, 'sk_test_example_not_a_real_key')
    assert.equal(
      app.graph().config.values.find((v) => v.path === 'stripe.key')?.value,
      REDACTED,
    )
    assert.equal(
      app.graph().config.values.find((v) => v.path === 'stripe.apiVersion')?.value,
      '2024-06-20',
    )
  })

  test('the /_config endpoint cannot leak, and is off outside development', async () => {
    const dev = makeApp({ quiet: true, env: env(VALID) })
    await dev.ready()
    const shown = await dev.inject('GET', '/_config')
    assert.equal(shown.status, 200)
    assert.ok(!shown.text().includes('hunter2'))
    assert.match(shown.text(), /database\.url\s+\*{8}/)

    const prod = makeApp({
      quiet: true,
      env: env({ ...VALID, NODE_ENV: 'production' }),
    })
    await prod.ready()
    // Provenance is topology: telling an anonymous caller that DATABASE_URL
    // came from `.env.production:4` says something about the deployment even
    // when it does not say the value.
    assert.equal((await prod.inject('GET', '/_config')).status, 404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('layers (§16.1)', () => {
  test('process.env beats a .env file', async () => {
    const app = makeApp({
      quiet: true,
      env: [
        { layer: 'dotenv', name: '.env', entries: parseDotenv(`DATABASE_URL=${VALID.DATABASE_URL}\nPAGE_SIZE=5`).entries },
        { layer: 'env', name: 'process.env', entries: [{ key: 'PAGE_SIZE', value: '40' }, { key: 'NODE_ENV', value: 'test' }] },
      ],
    })
    await app.ready()

    assert.equal(app.config.pagination.pageSize, 40)
    const row = app.graph().config.env.find((e) => e.key === 'PAGE_SIZE')
    assert.equal(row?.layer, 'env')
    // The shadowed file still reports what it tried to contribute, which is how
    // you find out the `.env` you have been editing has not been read.
    const dotfile = app.graph().config.sources.find((s) => s.name === '.env')
    assert.equal(dotfile?.supplied, 2)
    assert.equal(dotfile?.won, 1)
  })

  test('a plugin default is overridden field by field, not namespace by namespace', async () => {
    const app = makeApp({ quiet: true, env: env(VALID) })
    await app.ready()

    const at = (path: string) => app.graph().config.values.find((v) => v.path === path)
    // `zen.config.ts` states `mailer.timeout` and nothing else about mail; the
    // plugin's other two defaults survive. That is the difference between a
    // default and a template.
    assert.equal(at('mailer.timeout')?.layer, 'config')
    assert.equal(at('mailer.from')?.layer, 'plugin')
    assert.equal(at('mailer.from')?.source, 'mailer')
    assert.equal(at('mailer.retries')?.value, 3)
  })

  test('a test states its own environment, and overrides beat all of it', async () => {
    const app = makeApp({
      quiet: true,
      env: env({ ...VALID, PAGE_SIZE: '10' }),
      overrides: { pagination: { pageSize: 3 } },
    })
    await app.ready()

    // Layer 8 is last precisely so this works: a test that cannot beat the
    // developer's own `.env.local` is a test that passes on one machine.
    assert.equal(app.config.pagination.pageSize, 3)
    assert.equal(app.graph().config.values.find((v) => v.path === 'pagination.pageSize')?.layer, 'override')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the feature reads configuration, and nothing else does (§23.4)', () => {
  test('the page size comes from config and the ceiling is enforced', async () => {
    const app = makeApp({
      quiet: true,
      env: env(VALID),
      overrides: { pagination: { pageSize: 4, maxPageSize: 6 } },
    })
    await app.ready()

    const page = (await app.inject('GET', '/orders')).json<{ pageSize: number; items: unknown[] }>()
    assert.equal(page.pageSize, 4)
    assert.equal(page.items.length, 4)

    // The client may ask for more, up to the operator's ceiling and no further.
    const asked = (await app.inject('GET', '/orders?pageSize=50')).json<{ pageSize: number }>()
    assert.equal(asked.pageSize, 6)
  })

  test('`?page=2` arrives as a number — §11.4 and §16 compose without knowing about each other', async () => {
    const app = makeApp({ quiet: true, env: env(VALID), overrides: { pagination: { pageSize: 5 } } })
    await app.ready()

    const second = (await app.inject('GET', '/orders?page=2')).json<{ page: number; items: { id: number }[] }>()
    // Coercion read `z.number()` and converted the query string; configuration
    // supplied the page size. Neither subsystem mentions the other, and the
    // schema in `schemas.ts` says `z.number()` rather than `z.coerce.number()`.
    assert.equal(second.page, 2)
    assert.equal(second.items[0]?.id, 6)
  })

  test('changing the page size touches no feature file', async () => {
    // The test of whether a concern is *configuration*: if changing it means
    // editing a feature file, it was not (§23.4's fourth lesson). Two apps,
    // same code, different numbers, and the only difference between them is
    // this object.
    for (const size of [1, 7, 25]) {
      const app = makeApp({ quiet: true, env: env(VALID), overrides: { pagination: { pageSize: size } } })
      await app.ready()
      assert.equal((await app.inject('GET', '/orders')).json<{ items: unknown[] }>().items.length, size)
    }
  })
})
