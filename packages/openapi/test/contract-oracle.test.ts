import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { JsonSchema } from '@erenthedeveloper0/zen-core'
import { diffDocuments, openapiDocument } from '@erenthedeveloper0/zen-openapi'

import { makeApp, schema } from './helpers.ts'

/**
 * The contract fingerprint and `diffDocuments` see the same edits — rfcs/0001
 * §2.4, §29.7, and a gate `0.2.0-alpha` set itself: the two agree on a
 * thousand random schema edits.
 *
 * Two independent readings of "did this route's contract change": a SHA-256
 * over the route's normalised schemas (core, `GraphRoute.contract`), and the
 * semantic diff of two OpenAPI documents (this package). Neither is derived
 * from the other — one hashes JSON Schema, the other compares OpenAPI schemas
 * rule by rule — so agreement over many random edits is evidence about both:
 * a fingerprint that changed when the diff saw nothing is a fingerprint that
 * hashes noise, and a diff that saw nothing when the fingerprint changed is a
 * diff that under-reports, which the diff's own header calls worse than no
 * tool.
 *
 * Each step applies one random edit to one of a route's schemas — a body, a
 * query and a response — and asserts: **the contract fingerprint changed if
 * and only if `diffDocuments` reports a breaking or compatible change**.
 * Documentation-only edits (a `description`, a `title`, `examples`, a response
 * `default`) must move neither. The edits are seeded, so a failure reproduces.
 *
 * What the vocabulary leaves out, on purpose: object-level keywords on a query
 * (`additionalProperties`, `minProperties`) — OpenAPI splits a query into one
 * parameter per property, so no document can carry them — and `writeOnly` on a
 * response, which refuses to boot (`ZEN_RESPONSE_WRITE_ONLY`).
 */

const EDITS = 1000
const SEED = 20261010

type Target = 'body' | 'query' | 'response'
type Node = Record<string, unknown>
interface Shapes { body: Node; query: Node; response: Node }

/** mulberry32 — small, seeded, good enough to shuffle schemas. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function freshProperty(random: () => number, allowObject: boolean): Node {
  const pick = Math.floor(random() * (allowObject ? 6 : 5))
  switch (pick) {
    case 0: return { type: 'string' }
    case 1: return { type: 'integer' }
    case 2: return { type: 'number' }
    case 3: return { type: 'boolean' }
    case 4: return { type: 'array', items: { type: 'string' } }
    default: return { type: 'object', properties: { inner: { type: 'string' } } }
  }
}

function initial(): Shapes {
  return {
    body: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        role: { type: 'string', enum: ['admin', 'member'] },
      },
      required: ['name'],
    },
    query: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1 },
        q: { type: 'string', maxLength: 20 },
      },
    },
    response: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string', maxLength: 50 },
        status: { type: 'string', enum: ['active', 'closed'] },
        createdAt: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'name'],
    },
  }
}

/** One random edit, in place. Returns what it did, for the failure message. */
function edit(shapes: Shapes, random: () => number): string {
  const targets: Target[] = ['body', 'query', 'response']
  const target = targets[Math.floor(random() * targets.length)] as Target
  const root = shapes[target]
  const properties = root['properties'] as Record<string, Node>
  const names = Object.keys(properties)
  const required = (root['required'] as string[] | undefined) ?? []
  const pickName = (): string | undefined => names[Math.floor(random() * names.length)]
  const kind = Math.floor(random() * 17)
  const tag = (what: string) => `${target}: ${what}`

  switch (kind) {
    case 0: {
      const name = `p${Math.floor(random() * 1000)}`
      properties[name] = freshProperty(random, target !== 'query')
      return tag(`add optional property ${name}`)
    }
    case 1: {
      const name = `r${Math.floor(random() * 1000)}`
      properties[name] = freshProperty(random, target !== 'query')
      root['required'] = [...required, name]
      return tag(`add required property ${name}`)
    }
    case 2: {
      const name = pickName()
      if (name === undefined || names.length <= 1) return tag('remove property (none to remove)')
      delete properties[name]
      root['required'] = required.filter((r) => r !== name)
      return tag(`remove property ${name}`)
    }
    case 3: {
      const name = pickName()
      if (name === undefined) return tag('toggle required (none)')
      root['required'] = required.includes(name) ? required.filter((r) => r !== name) : [...required, name]
      return tag(`toggle required ${name}`)
    }
    case 4: {
      const name = pickName()
      if (name === undefined) return tag('replace property (none)')
      properties[name] = freshProperty(random, target !== 'query')
      return tag(`replace property ${name}`)
    }
    case 5: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined) return tag('bound (none)')
      const type = node['type']
      const keywords = type === 'string' ? ['minLength', 'maxLength']
        : type === 'integer' || type === 'number' ? ['minimum', 'maximum', 'exclusiveMinimum', 'multipleOf']
        : type === 'array' ? ['minItems', 'maxItems']
        : []
      if (keywords.length === 0) return tag(`bound on ${String(type)} (n/a)`)
      const keyword = keywords[Math.floor(random() * keywords.length)] as string
      node[keyword] = keyword === 'multipleOf' ? 1 + Math.floor(random() * 4) : Math.floor(random() * 10)
      return tag(`set ${name}.${keyword} = ${String(node[keyword])}`)
    }
    case 6: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined) return tag('unbound (none)')
      const present = ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'multipleOf', 'minItems', 'maxItems', 'pattern', 'format', 'uniqueItems']
        .filter((k) => node[k] !== undefined)
      const keyword = present[Math.floor(random() * present.length)]
      if (keyword === undefined) return tag(`remove a bound of ${name} (none)`)
      delete node[keyword]
      return tag(`remove ${name}.${keyword}`)
    }
    case 7: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined || node['type'] !== 'string' || node['enum'] !== undefined) return tag('pattern (n/a)')
      node['pattern'] = ['^[a-z]+$', '^[A-Z][a-z]*$', '^\\d{3}$'][Math.floor(random() * 3)]
      return tag(`set ${name}.pattern`)
    }
    case 8: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined || node['type'] !== 'string' || node['enum'] !== undefined) return tag('format (n/a)')
      node['format'] = ['email', 'uri', 'uuid', 'date', 'date-time'][Math.floor(random() * 5)]
      return tag(`set ${name}.format = ${String(node['format'])}`)
    }
    case 9: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined || node['type'] !== 'string') return tag('enum (n/a)')
      const values = (node['enum'] as string[] | undefined) ?? []
      const value = ['a', 'b', 'c', 'admin', 'member'][Math.floor(random() * 5)] as string
      const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
      if (next.length === 0) delete node['enum']
      else {
        node['enum'] = next
        delete node['pattern']
        delete node['format']
      }
      return tag(`enum of ${name} → ${JSON.stringify(node['enum'])}`)
    }
    case 10: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined || typeof node['type'] !== 'string' && !Array.isArray(node['type'])) return tag('nullable (n/a)')
      const type = node['type']
      node['type'] = Array.isArray(type) ? (type as string[]).filter((t) => t !== 'null')[0] : [type, 'null']
      return tag(`toggle nullable ${name}`)
    }
    case 11: {
      // Documentation only, at the root or on a property.
      const where = random() < 0.3 ? root : (properties[pickName() ?? ''] ?? root)
      const keyword = ['description', 'title', 'examples', '$comment', 'deprecated'][Math.floor(random() * 5)] as string
      where[keyword] = keyword === 'examples' ? [`e${Math.floor(random() * 100)}`]
        : keyword === 'deprecated' ? random() < 0.5
        : keyword === 'title' ? `T${Math.floor(random() * 4)}`
        : `text ${Math.floor(random() * 1000)}`
      return tag(`document: ${keyword}`)
    }
    case 12: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined) return tag('default (none)')
      const type = node['type']
      node['default'] = type === 'integer' || type === 'number' ? Math.floor(random() * 5)
        : type === 'boolean' ? random() < 0.5
        : type === 'string' ? `d${Math.floor(random() * 5)}`
        : undefined
      if (node['default'] === undefined) delete node['default']
      return tag(`set default of ${name}`)
    }
    case 13: {
      if (target === 'query') return tag('additionalProperties (not documentable on a query)')
      const current = root['additionalProperties']
      const choices: unknown[] = target === 'response' ? [undefined, false, true] : [undefined, false, true]
      const next = choices[Math.floor(random() * choices.length)]
      if (next === undefined) delete root['additionalProperties']
      else root['additionalProperties'] = next
      return tag(`additionalProperties ${String(current)} → ${String(next)}`)
    }
    case 14: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined || node['type'] !== 'array') return tag('uniqueItems (n/a)')
      node['uniqueItems'] = node['uniqueItems'] !== true
      return tag(`toggle ${name}.uniqueItems`)
    }
    case 15: {
      // Key order is not a contract.
      const entries = Object.entries(properties).reverse()
      root['properties'] = Object.fromEntries(entries)
      return tag('reorder properties')
    }
    default: {
      const name = pickName()
      const node = name === undefined ? undefined : properties[name]
      if (node === undefined || node['type'] !== 'array') return tag('items (n/a)')
      const items = node['items'] as Node | undefined
      if (items === undefined) node['items'] = { type: 'string' }
      else if (random() < 0.5) delete node['items']
      else node['items'] = { type: items['type'] === 'string' ? 'integer' : 'string' }
      return tag(`change ${name}.items`)
    }
  }
}

async function build(shapes: Shapes) {
  const app = makeApp()
  app.post('/items/:id', {
    name: 'items.update',
    body: schema(clone(shapes.body) as JsonSchema),
    query: schema(clone(shapes.query) as JsonSchema),
    response: { 200: schema(clone(shapes.response) as JsonSchema) },
  }, () => ({ id: 1, name: 'x' }))
  await app.ready()
  const document = await app.graphDocument()
  const route = document.routes.find((r) => r.id === 'items.update')
  assert.ok(route !== undefined)
  return { contract: route.contract, openapi: openapiDocument(app.graph(), { title: 'oracle', version: '1' }).document }
}

describe('contract fingerprint ⇔ diffDocuments (§2.4, §29.7)', () => {
  it(`agree on ${EDITS} random schema edits`, async () => {
    const random = rng(SEED)
    const shapes = initial()
    let previous = await build(shapes)
    const tally = { changed: 0, unchanged: 0, documentation: 0 }

    for (let step = 1; step <= EDITS; step++) {
      const before = clone(shapes)
      const what = edit(shapes, random)
      const current = await build(shapes)
      const fingerprintMoved = current.contract !== previous.contract
      const diff = diffDocuments(previous.openapi, current.openapi)
      const diffMoved = diff.breaking.length + diff.compatible.length > 0

      if (fingerprintMoved !== diffMoved) {
        assert.fail(
          `step ${step} (seed ${SEED}): ${what}\n` +
          `  fingerprint ${fingerprintMoved ? 'changed' : 'unchanged'}, diff ${diffMoved ? 'reported' : 'reported nothing'}\n` +
          `  changes: ${JSON.stringify(diff.changes.map((c) => `${c.kind} ${c.code} @ ${c.location}`))}\n` +
          `  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(shapes)}`,
        )
      }
      if (fingerprintMoved) tally.changed++
      else if (diff.documentation.length > 0) tally.documentation++
      else tally.unchanged++
      previous = current
    }

    if (process.env["ORACLE_TALLY"] === "1") console.log(JSON.stringify(tally))
    // The run proves something only if it exercised both answers.
    assert.ok(tally.changed > EDITS / 4, `only ${tally.changed} edits changed the contract`)
    assert.ok(tally.unchanged + tally.documentation > EDITS / 10, `only ${tally.unchanged + tally.documentation} edits left it alone`)
  })

  it('a documentation edit moves neither; a constraint edit moves both', async () => {
    const shapes = initial()
    const base = await build(shapes)
    ;(shapes.body['properties'] as Record<string, Node>)['name']!['description'] = 'The display name.'
    const described = await build(shapes)
    assert.equal(described.contract, base.contract)
    assert.equal(diffDocuments(base.openapi, described.openapi).breaking.length, 0)
    ;(shapes.body['properties'] as Record<string, Node>)['name']!['maxLength'] = 10
    const bounded = await build(shapes)
    assert.notEqual(bounded.contract, described.contract)
    assert.deepEqual(diffDocuments(described.openapi, bounded.openapi).breaking.map((c) => c.code), ['OAS_CONSTRAINT_TIGHTENED'])
  })
})
