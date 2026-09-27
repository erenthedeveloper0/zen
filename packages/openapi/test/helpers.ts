import { createApp, type JsonSchema, type Logger, type ZenApp, type ZenOptions } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'

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
 * A Standard Schema that accepts anything and exposes JSON Schema.
 *
 * Validation is not what these tests are about — the document generator only
 * ever asks a schema for its *shape*, through the `toJsonSchema()` probe. Using
 * a hand-written one keeps this package's tests free of a schema library, the
 * same way core's are.
 */
export function schema<T = unknown>(json: JsonSchema): {
  '~standard': { version: 1; vendor: string; validate: (value: unknown) => { value: T } }
  toJsonSchema: () => JsonSchema
} {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'zen-openapi-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
    toJsonSchema: () => json,
  }
}

/** Follows `#/components/schemas/*` so assertions can talk about shapes. */
export function deref(document: unknown, schema: unknown): Record<string, unknown> {
  let current = schema as Record<string, unknown>
  for (let hop = 0; hop < 16; hop++) {
    const ref = current['$ref']
    if (typeof ref !== 'string') return current
    const name = ref.slice('#/components/schemas/'.length)
    const schemas = ((document as Record<string, Record<string, Record<string, unknown>>>)['components']?.['schemas'] ?? {})
    const target = schemas[name]
    if (target === undefined) throw new Error(`dangling $ref: ${ref}`)
    current = target
  }
  throw new Error('$ref chain too deep')
}

export function operation(document: unknown, path: string, method: string): Record<string, unknown> {
  const paths = (document as Record<string, Record<string, Record<string, unknown>>>)['paths'] as
    Record<string, Record<string, Record<string, unknown>>>
  const item = paths[path]
  if (item === undefined) throw new Error(`no path ${path} in ${Object.keys(paths).join(', ')}`)
  const op = item[method]
  if (op === undefined) throw new Error(`no ${method} on ${path}`)
  return op
}

/** The response schema for one status, dereferenced. */
export function responseSchema(document: unknown, path: string, method: string, status: string): Record<string, unknown> {
  const op = operation(document, path, method)
  const responses = op['responses'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>
  const response = responses[status]
  if (response === undefined) throw new Error(`no ${status} response on ${method} ${path}`)
  const content = response['content']
  if (content === undefined) throw new Error(`${status} on ${method} ${path} has no content`)
  const media = content['application/json'] as Record<string, unknown> | undefined
  if (media === undefined) throw new Error(`${status} on ${method} ${path} has no JSON content`)
  return deref(document, media['schema'])
}

/** Every `$ref` in the document, wherever it appears. */
export function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') out.push(value)
    else collectRefs(value, out)
  }
  return out
}
