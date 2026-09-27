import { defineConfig } from '@erenthedeveloper0/zen'
import { z } from '../shared/zod.ts'

/**
 * The configuration — rfcs/0001 §16.2.
 *
 * This is the file the other five examples have been writing a note about. Each
 * of them says the same thing in a comment at the top of `src/config/`:
 * "`defineConfig` and schema-validated environment do not exist yet, so this is
 * a plain module and the `process.env` read below is the hand-rolled access §16
 * is meant to replace." This is that replacement, and the shape of the
 * conversion is worth seeing next to what it replaced:
 *
 * ```ts
 * // before
 * export const config = { port: Number(process.env['PORT'] ?? 3000) }
 * ```
 *
 * Three things change, and only the third is about types.
 *
 *   1. **A bad value fails at boot instead of at use.** `PORT=abc` makes
 *      `Number()` produce `NaN`, which `listen` accepts and which surfaces as
 *      a bind error four frames deep. Here it is a diagnostic in the first few
 *      milliseconds, next to every other configuration problem.
 *   2. **Every value knows where it came from.** `npm run explain -w
 *      @erenthedeveloper0/zen-example-config` prints the table.
 *   3. **`ctx.config.pagination.pageSize` is a `number`** because the schema
 *      says so, not because someone remembered to write `Number(...)`.
 */

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * `format: 'password'` is the secret marker, and it is an existing one.
   *
   * §16.2 writes this as Zod's `.brand('secret')`, and that is the one spelling
   * no framework can honour: a brand is erased at runtime and leaves nothing in
   * the schema to read. `format: 'password'` is OpenAPI's own "do not display
   * this", it survives into JSON Schema, and Zen reads it through the same
   * probe the serializer and the OpenAPI generator use. Reaching for a
   * vocabulary that already exists rather than inventing a Zen-specific one is
   * the same choice §12.6 makes about RFC 9457 and §31.4 about
   * `application/health+json`.
   *
   * Everything downstream follows from this one word: the value is redacted in
   * `explainConfig`, on the AppGraph, in the boot diagnostic that reports it as
   * too short, and in `JSON.stringify(app.config)` — and it is *not* redacted
   * when the code that opens the connection asks for it by name.
   */
  DATABASE_URL: z.string().min(1).meta({ format: 'password' }),

  /** Read by the mailer plugin, which declares that in its manifest. */
  SMTP_URL: z.string().optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  /**
   * Deliberately an integer with a range rather than a `number`.
   *
   * `PAGE_SIZE=1000` is the kind of value that is not *wrong* until the day a
   * report times out, and a bound stated here is a bound stated once. §16.2's
   * `expected:` line reads it back off the schema, so the error a colleague
   * sees is `expected: integer, between 1 and 100` without anyone writing that
   * sentence.
   */
  PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(25),
})

export default defineConfig({
  env: EnvSchema,

  /**
   * `server` is the one namespace the framework itself reads.
   *
   * `app.listen()` with no arguments binds this, which is what makes it the
   * correct call in a deployed service rather than a placeholder somebody has
   * to remember to replace with `app.listen({ port: Number(process.env.PORT) })`.
   */
  server: {
    port: (env) => env.PORT,
    host: (env) => (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  },

  /**
   * A thunk is a function *of the environment*, so a derived value is written
   * once, here, where it is typed — rather than in whichever module happened to
   * need it first.
   */
  mode: (env) => env.NODE_ENV,
  debug: (env) => env.NODE_ENV !== 'production',

  database: {
    // Carries `DATABASE_URL` verbatim, so it inherits the secret marking
    // without restating it. A *derived* value would not — see the README.
    url: (env) => env.DATABASE_URL,
    poolSize: 10,
  },

  pagination: {
    pageSize: (env) => env.PAGE_SIZE,
    maxPageSize: 100,
  },

  logging: {
    level: (env) => env.LOG_LEVEL,
    redact: ['req.headers.authorization', '*.password'],
  },

  /**
   * The escape hatch, and a deliberate demonstration of the gap it exists for.
   *
   * `database.url` needs no entry here — it is marked by its schema. `stripe.key`
   * is a literal in this file rather than an environment variable, so nothing
   * about the schema can know it is sensitive, and saying so by hand is the
   * only mechanism left.
   */
  secrets: ['stripe.key'],

  stripe: { key: 'sk_test_example_not_a_real_key', apiVersion: '2024-06-20' },

  /**
   * One field of a namespace a *plugin* owns.
   *
   * The mailer plugin's manifest supplies `from`, `retries` and `timeout` at
   * layer 2; this replaces one of them and leaves the other two alone. That the
   * merge is per field rather than per namespace is the whole difference
   * between a default and a template — `npm run explain` prints all three rows
   * with two different layers next to them.
   */
  mailer: { timeout: '3s' },
})
