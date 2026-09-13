import { defineConfig } from 'zen'
import { z } from '../shared/zod.ts'

/**
 * Configuration — rfcs/0001 §16.2.
 *
 * The interesting line is `cors.origin`. An allowlist is exactly the kind of
 * value that differs per deployment and must never be a literal in the source:
 * staging allows `https://staging.notes.example`, production does not, and
 * getting that wrong in either direction is a security incident or an outage.
 *
 * So it comes from the environment, through a schema, and lands on the config
 * tree with a **layer and a named source behind it** — which means
 * `npm run explain -w @zenjs-example/middleware` can answer "why is this origin
 * allowed?" with a file and a line rather than with a grep. That question gets
 * asked during incidents, and this is the pass in which it became answerable
 * for a middleware rather than only for the application's own values:
 * `Registrar.config` did not exist until the CORS plugin needed to read this.
 *
 * `CORS_ORIGINS` is a comma-separated list because that is what a container
 * environment can carry. The split happens *here*, in the thunk, so what
 * reaches `config.cors.origin` is a `string[]` and the plugin never sees the
 * transport format.
 */
export default defineConfig({
  env: z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),

    /**
     * The allowlist. Required in production and defaulted for local work —
     * `z.url()` on each entry is what turns a typo into a boot error with the
     * `.env` line number instead of a browser console message three days later.
     */
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),

    /** Requests per minute, per client. */
    RATE_LIMIT: z.coerce.number().int().min(1).default(60),

    /** Marked `password` so §16.2 redacts it in every projection of config. */
    ADMIN_TOKEN: z.string().min(16).meta({ format: 'password' }).default('local-development-token'),
  }),

  cors: {
    origin: (env) => env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter((o) => o.length > 0),
    credentials: true,
  },

  rateLimit: {
    limit: (env) => env.RATE_LIMIT,
    window: '1m',
  },

  admin: {
    token: (env) => env.ADMIN_TOKEN,
  },

  server: {
    port: (env) => env.PORT,
  },

  mode: (env) => env.NODE_ENV,
})
