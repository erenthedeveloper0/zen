# examples/config

Layered configuration, schema-validated environment, provenance and redaction —
[RFC 0001 §16](../../ARCHITECTURE.md#16-configuration-system).

```bash
npm run example:config          # the service
npm run config:explain          # the provenance table
npm test -w @visionpilot/zen-example-config
```

---

## What this replaces

The other five examples in this repo each open with a variation of the same
apology:

```ts
// examples/coercion/src/config/coercion.config.ts
//
// `defineConfig` and schema-validated environment (§16.2) do not exist yet, so
// this is a plain module and the `PORT` read below is the hand-rolled
// `process.env` access §16 is meant to replace.
export const config = {
  port: Number(process.env['PORT'] ?? 3000),
}
```

That module is free, obvious, and already written, which is why the bar for
replacing it is high. Three things change, and the third is the least
interesting:

1. **A bad value fails at boot instead of at use.** `PORT=abc` makes `Number()`
   produce `NaN`. `NaN` is a perfectly good argument to `listen`, so the failure
   surfaces four frames deep in a bind error — or, for `DATABASE_URL`, on the
   first request that touches the database, in production, at 3am. Here it is a
   diagnostic in the first few milliseconds, aggregated with every other
   configuration problem.
2. **Every value knows where it came from.** `npm run config:explain` prints
   the table. Nothing in the ecosystem can print that table, because
   `{...a, ...b}` has no memory of `a`.
3. **`ctx.config.pagination.pageSize` is a `number`** because the schema says
   so, rather than because somebody remembered to write `Number(...)`.

---

## The provenance table

```
  Environment

    DATABASE_URL  ********               ← .env.example:12  (redacted)
    LOG_LEVEL     info                   ← .env.example:18
    NODE_ENV      development            ← .env.example:7
    PAGE_SIZE     25                     ← .env.example:19
    PORT          3000                   ← .env.example:8
    SMTP_URL      smtp://localhost:1025  ← .env.example:16  (used by mailer)

  Configuration

    database.poolSize       10                                       ← zen.config
    database.url            ********                                 ← zen.config  (redacted)
    mailer.from             orders@example.com                       ← mailer
    mailer.retries          3                                        ← mailer
    mailer.timeout          3s                                       ← zen.config
    pagination.pageSize     25                                       ← zen.config
    server.port             3000                                     ← zen.config
    stripe.key              ********                                 ← zen.config  (redacted)
    …

  Sources, in precedence order (later wins)

    default   default         0 of   2 kept
    plugin    mailer          2 of   3 kept
    config    zen.config     13 of  13 kept
    dotenv    .env.example    6 of   6 kept
    env       process.env     0 of   0 kept
```

Four things in that output are worth pausing on.

**`mailer.from ← mailer` next to `mailer.timeout ← zen.config`.** The plugin
declares three defaults in its *manifest*; the application states one of them.
The merge is per field, which is the difference between a default and a
template.

**`default 0 of 2 kept`.** Zen's own `server.port` and `server.host` are a real
layer, not an `?? 3000` hiding in `listen`. They lost, because this application
states both — and the table says so rather than leaving you to infer it.

**`(used by mailer)`.** From the plugin's manifest, read *before* any plugin
runs. Unset `SMTP_URL` and the boot error names the plugin that will not work.

**`process.env 0 of 0 kept`.** The table lists the **declared** environment —
the schema's properties plus whatever plugins declared they read — not every
variable the process happens to have. The first version of this file listed
seventy rows of a laptop's environment, and that was wrong in three ways at
once: it buried the five relevant rows; it put the *name* of every variable in
the process onto the AppGraph, and a name is topology even when the value is
withheld; and with no `env` schema it would have put the values there too. That
defect is now `packages/core/test/config.test.ts`'s "the snapshot lists the
declared environment, not the process's".

---

## Failure modes, in order of how much they matter

Run each of these:

```bash
# A missing secret. Not `undefined`, not an empty signing key — a boot failure,
# before any plugin's setup() has run.
DATABASE_URL= npm run example:config

# A bound stated once, in the schema, enforced at boot rather than on the first
# slow report. Nobody wrote the `expected:` sentence — it is read back off Zod's
# own JSON Schema.
PAGE_SIZE=1000 npm run example:config
```

```
Boot failed: 1 problem

  1. ZEN_ENV_INVALID  PAGE_SIZE — "1000" was rejected: Too big: expected number
     to be <=100 (expected: integer, between 1 and 100)
     at process.env
     fix: Correct PAGE_SIZE where it is set (process.env).
     docs: https://github.com/VisionPilot/Zen.js/blob/main/docs/errors.md#zen_env_invalid
```

And the one that is a security property rather than a convenience: a secret that
is *present but wrong* is reported without being printed.

```
  1. ZEN_ENV_INVALID  DATABASE_URL — ******** was rejected: Too small: expected
     string to have >=1 characters (expected: string, min length 1)
```

`PORT="abc"` is only actionable if you can see the `"abc"`; `DATABASE_URL` is
only safe if you cannot. Both, in the same renderer, decided by the schema.

---

## Secrets: what is mechanised and what is not

Three ways a value becomes secret, and they are not equally good.

| Mechanism | Where | Notes |
| --- | --- | --- |
| `.meta({ format: 'password' })` | the env schema | OpenAPI's own "do not display". Survives into JSON Schema, so Zen reads it through the same probe the serializer and the OpenAPI generator use |
| propagation by identity | automatic | `url: env => env.DATABASE_URL` inherits the marking without restating it |
| `secrets: ['stripe.key']` | `defineConfig` | the escape hatch for a value that is a literal, so no schema exists to mark it |

§16.2 writes the marker as Zod's `.brand('secret')`, and that is the one
spelling no framework can honour: a brand is erased at runtime and leaves
nothing in the schema for anything to read. `format: 'password'` is an existing
vocabulary that survives, which is the same choice §12.6 makes about RFC 9457
and §31.4 about `application/health+json`.

**The gap, stated rather than hidden.** Propagation is by *identity*, not
similarity:

```ts
database: {
  url:         (env) => env.DATABASE_URL,             // secret — same string
  readReplica: (env) => `${env.DATABASE_URL}?replica=1`,  // NOT secret
}
```

A substring search would redact anything containing the word `localhost`, and
tainting would need a proxy around a frozen object. Both are worse than saying
so and offering `secrets: ['database.readReplica']`. There is a test asserting
the leak, so the gap cannot close or widen by accident.

**And what the redaction does not cover.** `app.config` redacts when it is
*serialised* — `toJSON` and `nodejs.util.inspect.custom` at every level, so
`console.log(app.config)`, `JSON.stringify(app.config.database)` and a
structured logger all go through it. `{...app.config}` copies enumerable own
properties and leaves both hooks behind. Closing that would mean per-property
getters that lie about their own value, and a config object whose
`database.url` is not the database URL breaks the one thing it is for. The
mechanism raises the floor; it does not seal the room.

---

## `.env` files, and why the framework does not read them

`src/config/sources.ts` is fifteen lines of *application* code:

```ts
for (const file of dotenvChain(mode)) {
  const text = read(file)
  if (text !== null) {
    sources.push({ layer: 'dotenv', name: file, entries: parseDotenv(text).entries })
  }
}
```

§3.2 assigns file reading to the CLI or the adapter, and the constraint is
concrete rather than procedural: `@visionpilot/zen-core` has no `node:` imports (§3.3 B2),
because `fs` and `process` do not exist on workerd, where the environment
arrives as an argument to the fetch handler. So core owns the **policy** —
`dotenvChain` states the precedence (`.env` → `.env.local` → `.env.<mode>` →
`.env.<mode>.local`, and no `.env.local` under `test`), `parseDotenv` states the
grammar and hands back line numbers — and the host owns the I/O.

The line numbers are the reason to parse rather than `eval`. `PORT is not a
valid integer` sends someone hunting through four files; `.env.production:3 sets
PORT to "abc"` does not.

**This example ships `.env.example` and reads it as the lowest-precedence
layer**, so it runs from a fresh clone (`.env` and `.env.*` are gitignored, as
they should be). A real service must not do that, for the reason §16.5 gives:
a placeholder secret that lets the process boot is worse than a missing one that
stops it, because the first is a security incident discovered later and the
second is a deployment that did not happen. Copy `.env.example` to `.env`, and
let the app refuse to start when you have not.

---

## Layout

```
src/
├── app.ts                       three config lines; nothing else knows about the environment
├── main.ts                      app.listen() — no arguments, the address is configured
├── inspect.ts                   the provenance table + a coverage report
├── config/
│   ├── zen.config.ts            defineConfig + the env schema
│   ├── sources.ts               the four lines §3.2 says belong to the host
│   └── types.ts                 AppConfig, *derived* from the definition
├── plugins/mailer.ts            a manifest that declares a namespace and an env need
├── features/orders/             reads ctx.config; mentions no environment variable
└── shared/zod.ts                the converter registration
```

`process.env` appears **exactly once** in this application, in `sources.ts`, and
it appears there as I/O rather than as configuration.

`features/orders/service.ts` reads nothing: the page size arrives as an
argument, so the function is correct whether the operator configures twenty-five
or one hundred, and it is testable without standing up an application. §23.4's
fourth lesson, unchanged — the test of whether a concern is *configuration* is
whether changing it means editing a feature file, and
`test/config.test.ts`'s last case runs the same code at three different page
sizes to prove it does not.

---

## What it costs

From `npm run bench:config`:

```
a route that never reads config     byte-identical pipeline AND context   (gate)
a secret in any projection          none — snapshot, explain, stringify   (gate)

a module-level const                2.29 µs
ctx.config.limits.body              2.29 µs   INSIDE NOISE

resolution, 0 env vars               6.4 µs   ← once, at boot
resolution, 256 env vars           103.6 µs
resolution, 128 leaves × 2 layers  246.4 µs
```

The per-request result is that there is no result, and that is the finding.
`ctx.config` is a getter over the shared `ContextEnv` — not a field on the
context — so it costs one property load, no constructor store, and no change to
the generated class's shape (I2, §7.6). A configuration system that cost
anything measurable in the hot path would not be worth having, because the thing
it replaces costs nothing.

What it buys is at boot and in the diagnostics.
