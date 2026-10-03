<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/erenthedeveloper0/zen/main/.github/images/logo-with-text-white.png">
    <img alt="zen.js" src="https://raw.githubusercontent.com/erenthedeveloper0/zen/main/.github/images/logo-with-text-black.png" width="220">
  </picture>
</p>

# @erenthedeveloper0/zen-openapi

OpenAPI 3.1 for [Zen](https://github.com/erenthedeveloper0/zen), generated from the
same schemas the framework validates requests and serializes responses with —
so the document says exactly what the wire carries.

> **Alpha.**

```bash
npm install @erenthedeveloper0/zen-openapi@alpha
```

```ts
import { zen, registerSchemaConverter } from '@erenthedeveloper0/zen'
import { openapiPlugin } from '@erenthedeveloper0/zen-openapi'
import { z } from 'zod'

// Once, before the app boots: how to read a Zod schema as JSON Schema.
registerSchemaConverter('zod', (schema, io) => z.toJSONSchema(schema as z.ZodType, { io }))

const app = zen()
app.use(openapiPlugin, {
  title: 'Acme API',
  version: '2.0.0',
  json: '/openapi.json',   // the document
  ui: '/docs',             // a built-in viewer with no external requests
})
```

## Why the document cannot drift

The generator is a pure function from the frozen application graph to a
document, run once at boot — the endpoint serves a pre-encoded string with an
`ETag`, and costs nothing per request.

Response schemas are published **closed** (`additionalProperties: false`),
because Zen's serializer drops any field a response schema does not declare: a
document generated from the raw schema would promise clients fields that can
never arrive. Parameter serialization follows the route's actual coercion
settings, and a negotiated route publishes one `content` entry per media type,
in the server's preference order.

## Breaking-change detection

```ts
import { diffDocuments } from '@erenthedeveloper0/zen-openapi'

const { breaking, compatible } = diffDocuments(committedBaseline, currentDocument)
if (breaking.length > 0) process.exitCode = 1
```

Requests are contravariant and responses covariant: removing a response field,
narrowing a request type or renaming an `operationId` is breaking; adding an
optional response field is not. Run it in CI against a committed baseline and an
API change is reviewed as an API change.

What is compared is what a schema says, not how a converter spelled it: zod
4.4's `anyOf: [{ type: 'string' }, { type: 'null' }]` and 4.6's
`type: ['string', 'null']` are one schema, a field removed from inside a
nullable object is breaking, and a recursive component is compared down to
where it repeats.

## Options

`title` and `version` are required. Also: `servers`, `tags`, `security`,
`securitySchemes`, `license`, `contact`, `json` / `ui` (paths, or `false`),
`strict` (turn documentation warnings into boot errors — worth enabling once an
API is public), and `onDocument` (receives the finished document at boot).

## Documentation

[ARCHITECTURE.md §29](https://github.com/erenthedeveloper0/zen/blob/main/ARCHITECTURE.md#29-openapi--code-generation) ·
[`examples/openapi`](https://github.com/erenthedeveloper0/zen/tree/main/examples/openapi).

[MIT](https://github.com/erenthedeveloper0/zen/blob/main/LICENSE) © [Eren Sümer](https://github.com/erenthedeveloper0) · [contributors](https://github.com/erenthedeveloper0/zen/blob/main/CONTRIBUTORS.md)
