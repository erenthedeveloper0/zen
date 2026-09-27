import { createApp, type Logger, type ZenApp, type ZenOptions } from '@visionpilot/zen-core'
import { ZenRouter, parsePath } from '@visionpilot/zen-router'

export const pathParser = {
  parse(path: string) {
    const parsed = parsePath(path)
    return { path: parsed.path, segments: parsed.segments }
  },
}

export function silentLogger(): Logger {
  const noop = () => {}
  const logger = {
    level: 'fatal' as const,
    child() { return logger },
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  }
  return logger
}

export function makeApp<X = {}>(opts: Partial<ZenOptions> = {}): ZenApp<X> {
  return createApp<X>({
    router: new ZenRouter(),
    pathParser,
    logger: silentLogger(),
    ...opts,
  })
}

/**
 * Every value of a repeated header.
 *
 * `InjectedResponse.headers` is `Object.fromEntries(entries())`, which keeps
 * only the last value of a repeated name — and `Vary` is repeated here more
 * often than not. A test reading `res.headers.vary` would have quietly asserted
 * against one third of what a preflight actually emits; the first manual run of
 * this pack printed exactly that and it looked like a missing header.
 */
export function headerValues(res: { reply: { headers: { getAll(name: string): readonly string[] } } }, name: string): readonly string[] {
  return res.reply.headers.getAll(name)
}

/** Every `Vary` token across every `Vary` header, lowercased and flattened. */
export function varyTokens(res: { reply: { headers: { getAll(name: string): readonly string[] } } }): string[] {
  return headerValues(res, 'vary')
    .flatMap((value) => value.split(','))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
}

/** The boot error a `ready()` is expected to produce, as rendered text. */
export async function bootFailure(app: { ready(): Promise<unknown> }): Promise<string> {
  try {
    await app.ready()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected ready() to fail, and it did not')
}

/**
 * A deterministic clock, because a fixed window is defined against wall time.
 *
 * Tests that call `Date.now()` for real are tests that fail at :59.9 — the
 * window rolls between the third request and the fourth and the limit appears
 * not to work. Every rate-limit test drives the store directly or pins `now`.
 */
export function frozenClock(start: number): { now(): number; advance(ms: number): void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}
