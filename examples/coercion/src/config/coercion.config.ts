/**
 * One place for the wire conventions this service accepts — rfcs/0001 §16.
 *
 * `defineConfig` and schema-validated environment (§16.2) do not exist yet, so
 * this is a plain module and the `PORT` read below is the hand-rolled
 * `process.env` access §16 is meant to replace. Recorded here rather than
 * hidden, because it is the fourth example to write these three lines and that
 * is the evidence TASKS.md ranks config at #3 on.
 */
export const config = {
  port: Number(process.env['PORT'] ?? 3000),

  /**
   * The app-wide profiles.
   *
   * Every value here is already the default (§11.4's table), and it is written
   * out anyway because this file is the example's answer to "where would I
   * change this?". A real service deletes the whole block and inherits it.
   */
  coercion: {
    query: { numbers: true, booleans: true, arrays: 'repeat' },
    headers: { arrays: 'comma' },
  },
} as const
