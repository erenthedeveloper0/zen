import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dotenvChain, parseDotenv, type EnvSource } from '@erenthedeveloper0/zen'

/**
 * The fifteen lines §3.2 assigns to the host rather than to the framework.
 *
 * Identical in shape to `examples/config/src/config/sources.ts`, and repeated
 * rather than shared for the reason §23.4 gives: an example is read on its own.
 * `@erenthedeveloper0/zen-core` has no `node:` imports because `fs` and `process` do not exist
 * on workerd, so core owns the *policy* — `dotenvChain` states the precedence,
 * `parseDotenv` states the grammar and hands back line numbers — and this file
 * owns the I/O.
 */

const ROOT = join(import.meta.dirname, '..', '..')

function read(file: string): string | null {
  try {
    return readFileSync(join(ROOT, file), 'utf8')
  } catch {
    return null
  }
}

export function envSources(
  mode = process.env['NODE_ENV'] ?? 'development',
): readonly EnvSource[] {
  const sources: EnvSource[] = []

  // `.env.example` at the bottom so the example runs from a fresh clone. A
  // real service must not do this — see the long note in `examples/config`,
  // which is the same warning and applies here for the same reason.
  const example = read('.env.example')
  if (example !== null) {
    sources.push({ layer: 'dotenv', name: '.env.example', entries: parseDotenv(example).entries })
  }

  for (const file of dotenvChain(mode)) {
    const text = read(file)
    if (text !== null) {
      sources.push({ layer: 'dotenv', name: file, entries: parseDotenv(text).entries })
    }
  }

  sources.push({
    layer: 'env',
    name: 'process.env',
    entries: Object.entries(process.env)
      .filter((pair): pair is [string, string] => pair[1] !== undefined)
      .map(([key, value]) => ({ key, value })),
  })

  return sources
}
