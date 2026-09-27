import type { OpenApiPluginOptions } from '@visionpilot/zen-openapi'

/**
 * Configuration lives in `src/config/` — rfcs/0001 §23.4, §16.
 *
 * §16's layered config system is not built yet, so this is a plain module. It
 * is still in the place §16 will occupy, which is the point of following the
 * layout: when `defineConfig` arrives, this file changes and nothing that
 * imports it does.
 */

export const SEEDED_AT = '2024-03-01T12:00:00.000Z'

export interface AppConfig {
  readonly port: number
  readonly dev: boolean
  /** Fix the clock so two boots produce the same document *and* the same rows. */
  readonly seededAt: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    port: Number(env['PORT'] ?? 3000),
    dev: env['NODE_ENV'] !== 'production',
    seededAt: env['SEEDED_AT'] ?? SEEDED_AT,
  }
}

export const openapiOptions: OpenApiPluginOptions = {
  title: 'Zen Commerce API',
  version: '1.0.0',
  summary: 'A two-feature example generated entirely from the application graph.',
  description:
    'Every path, parameter, schema and status below is a projection of the ' +
    'AppGraph — nothing here is written twice, so nothing here can drift.',
  servers: [{ url: 'http://localhost:3000', description: 'Local' }],
  securitySchemes: {
    bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  },
  json: '/openapi.json',
  ui: '/docs',
  // Turn documentation holes into boot failures. A route with no response
  // schema is both undocumented *and* unfiltered on the way out (§13.3), so it
  // is worth refusing to start over.
  strict: true,
}
