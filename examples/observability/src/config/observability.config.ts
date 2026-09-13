/**
 * Configuration — a plain module until §16 lands.
 *
 * `examples/openapi` established the convention and the reason: putting it in
 * `src/config/` now means that when `defineConfig` and env validation arrive,
 * this file gains a schema and its importers do not move.
 */
export const config = {
  metricsPath: process.env['METRICS_PATH'] ?? '/metrics',
  serverTiming: process.env['SERVER_TIMING'] !== '0',
  release: process.env['RELEASE'] ?? 'dev',
  adminKey: process.env['ADMIN_KEY'] ?? 'let-me-in',
  port: Number(process.env['PORT'] ?? 3000),
} as const
