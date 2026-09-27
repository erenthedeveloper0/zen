import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dotenvChain, parseDotenv, type EnvSource } from '@erenthedeveloper0/zen'

/**
 * The four lines §3.2 says belong here rather than in the framework.
 *
 * `@erenthedeveloper0/zen-core` has no `node:` imports — a hard rule, and not a bureaucratic
 * one: `process` and `fs` do not exist on workerd, where the environment
 * arrives as an argument to the fetch handler. So core owns the *policy*
 * (`dotenvChain` states the precedence, `parseDotenv` states the grammar and
 * hands back line numbers) and the host owns the I/O. This file is the host.
 *
 * The split is worth noticing rather than skimming, because it is the thing
 * that makes `.env` support portable. Nothing below is framework code; it is
 * fifteen lines of application code that a Deno or Bun or Lambda deployment
 * would write differently and get the same layering from.
 */

const ROOT = join(import.meta.dirname, '..', '..')

function read(file: string): string | null {
  try {
    return readFileSync(join(ROOT, file), 'utf8')
  } catch {
    // A missing `.env` is the normal case in production, where the environment
    // comes from the orchestrator. It is not a warning.
    return null
  }
}

export function envSources(
  mode = process.env['NODE_ENV'] ?? 'development',
): readonly EnvSource[] {
  const sources: EnvSource[] = []

  /**
   * `.env.example` at the bottom of the stack, and **a real service must not
   * do this.**
   *
   * It is here so the example runs from a fresh clone: `.env` and `.env.*` are
   * gitignored, as they should be, so without this there would be no
   * `DATABASE_URL` and the app would — correctly — refuse to boot. Shipping the
   * placeholder as the lowest-precedence layer keeps the demonstration
   * self-contained.
   *
   * The reason not to do it in production is the whole subject of §16.5: a
   * placeholder secret that lets the process boot is worse than a missing one
   * that stops it, because the first failure is a security incident discovered
   * later and the second is a deployment that did not happen. Copy
   * `.env.example` to `.env`, and let the app refuse to start when you have
   * not.
   */
  const example = read('.env.example')
  if (example !== null) {
    sources.push({ layer: 'dotenv', name: '.env.example', entries: parseDotenv(example).entries })
  }

  // `.env` → `.env.local` → `.env.<mode>` → `.env.<mode>.local`. The ordering
  // is `dotenvChain`'s, stated once in the framework so no host has to
  // remember it — a host that got it backwards would put a committed `.env`
  // above a developer's uncommitted `.env.local` and no test would notice.
  for (const file of dotenvChain(mode)) {
    const text = read(file)
    if (text !== null) {
      sources.push({ layer: 'dotenv', name: file, entries: parseDotenv(text).entries })
    }
  }

  // Layer 6. Last, so a container platform's environment beats every file.
  sources.push({
    layer: 'env',
    name: 'process.env',
    entries: Object.entries(process.env)
      .filter((pair): pair is [string, string] => pair[1] !== undefined)
      .map(([key, value]) => ({ key, value })),
  })

  return sources
}
