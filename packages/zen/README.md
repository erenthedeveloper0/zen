<p align="center">
  <img alt="zen.js — a compiler-first web framework" src="https://raw.githubusercontent.com/VisionPilot/Zen.js/main/.github/images/banner-dark.png" width="100%">
</p>

# @visionpilot/zen

**A compiler-first web framework for Node.js.** Express-simple, Fastify-fast,
typed end to end.

> **Alpha.** The API will change before `1.0`. Do not put this in production yet — see
> [the status section](https://github.com/VisionPilot/Zen.js#status).

```bash
npm install @visionpilot/zen@alpha
```

```ts
import { zen } from '@visionpilot/zen'

const app = zen()

app.get('/', () => 'Hello world')

await app.listen(3000)
```

Two concepts: `app.METHOD(path, handler)`, and **the handler returns the
response**. There is no response object to learn.

## What you get

Registration is a source language: `ready()` freezes the application and
compiles the router, every route's pipeline, its validators and response
serializers, and the request context's own memory layout into generated
JavaScript. Stages a route does not use are not emitted at all.

- **Typed routes** from the path template and your schemas — Zod, Valibot and
  ArkType work through [Standard Schema](https://standardschema.dev) with no
  adapter.
- **Response contracts**: a route that declares `response: { 200: User }`
  compiles a serializer that *cannot* emit a field `User` does not declare.
- **Deadlines**, **health and readiness endpoints**, **validated configuration**,
  **content negotiation**, **server-sent events**, **file responses** with
  `ETag`/`Range`, and **graceful shutdown** that drains before it refuses.
- **Boot-time diagnostics**, aggregated: every registration problem in one run,
  each with a fix.

```ts
import { zen } from '@visionpilot/zen'
import { z } from 'zod'

const app = zen({ timeout: '30s' })

app.get('/users/:id<int>', {
  response: { 200: z.object({ id: z.number(), name: z.string() }) },
}, async (ctx) => {
  const user = await db.users.find(ctx.params.id)   // ctx.params.id is a number
  return user                                       // a passwordHash on it never reaches the wire
})

await app.listen()                                  // address from config.server
```

## This package

`@visionpilot/zen` wires together:

| Package | Role |
| --- | --- |
| [`@visionpilot/zen-core`](https://www.npmjs.com/package/@visionpilot/zen-core) | registries, compilers, runtime, errors — zero dependencies |
| [`@visionpilot/zen-router`](https://www.npmjs.com/package/@visionpilot/zen-router) | the compiled radix router |
| [`@visionpilot/zen-adapter-node`](https://www.npmjs.com/package/@visionpilot/zen-adapter-node) | Node's `http` server |
| [`@visionpilot/zen-middleware`](https://www.npmjs.com/package/@visionpilot/zen-middleware) | CORS, security headers, request ids, rate limiting |

and re-exports all of them, so one import is enough. It also supplies the two
things only a Node process has: `process.env` as the configuration environment,
and signal handling — `SIGTERM`/`SIGINT` run the graceful shutdown and exit, and
an uncaught exception is logged and does the same with exit code 1. Pass
`lifecycle: false` if something else manages the process.

OpenAPI generation is a separate install:
[`@visionpilot/zen-openapi`](https://www.npmjs.com/package/@visionpilot/zen-openapi).

## Requirements

- Node.js **≥ 22.6**
- TypeScript **≥ 5.0**, if you use TypeScript

## Documentation

- [README](https://github.com/VisionPilot/Zen.js#readme) — the tour
- [ARCHITECTURE.md](https://github.com/VisionPilot/Zen.js/blob/main/ARCHITECTURE.md) — the design, and the arguments that lost
- [Error codes](https://github.com/VisionPilot/Zen.js/blob/main/docs/errors.md)
- [Examples](https://github.com/VisionPilot/Zen.js/tree/main/examples)

[MIT](https://github.com/VisionPilot/Zen.js/blob/main/LICENSE) © [VisionPilot](https://github.com/VisionPilot) · created by [Eren Sümer](https://github.com/ErenSumer) · [contributors](https://github.com/VisionPilot/Zen.js/blob/main/CONTRIBUTORS.md)
