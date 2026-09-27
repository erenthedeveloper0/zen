<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/erenthedeveloper0/zen/main/.github/images/logo-with-text-white.png">
    <img alt="zen.js" src="https://raw.githubusercontent.com/erenthedeveloper0/zen/main/.github/images/logo-with-text-black.png" width="220">
  </picture>
</p>

# @erenthedeveloper0/zen-core

The core of [Zen](https://github.com/erenthedeveloper0/zen): registries, the
compilers, the request runtime, the context, errors and the response engine.

> **Alpha.** Most applications should install
> [`@erenthedeveloper0/zen`](https://www.npmjs.com/package/@erenthedeveloper0/zen), which
> wires this package to a router and the Node adapter.

```bash
npm install @erenthedeveloper0/zen-core@alpha
```

## What is in here

- **The compilers.** At `ready()`, the frozen application graph is compiled into
  one generated function per route — middleware unrolled, hook phases you do not
  use absent from the source — plus a context class with a fixed shape, schema
  coercers, and response serializers that cannot emit an undeclared field. Each
  compiler has an interpreted twin, used where `new Function` is unavailable.
- **The runtime.** Deadlines with a real `AbortSignal`, body intake with limits
  enforced during the read, content negotiation, server-sent events, RFC 9457
  problem documents, health and readiness.
- **Configuration.** Layered resolution with per-value provenance, a
  schema-validated environment checked before any plugin runs, and secrets that
  redact themselves when serialised.
- **The contracts.** Every interface between subsystems, importable on their
  own from `@erenthedeveloper0/zen-core/contracts`.

## Zero dependencies, and no platform

This package has **no runtime dependencies** and imports **nothing from
`node:`**. Both are CI checks. It does not read `process` or open files: the
router, the adapter and the host environment are supplied to it. That is what
lets the same core run under any adapter.

Use it directly when you are building something Zen is made of — an adapter, a
router, a host integration:

```ts
import { createApp } from '@erenthedeveloper0/zen-core'
import { ZenRouter, parsePath } from '@erenthedeveloper0/zen-router'
import { nodeAdapter } from '@erenthedeveloper0/zen-adapter-node'

const app = createApp({
  router: new ZenRouter(),
  pathParser: { parse: (p) => parsePath(p) },
  adapter: nodeAdapter(),
})
```

## Requirements

Node.js ≥ 22.6. TypeScript ≥ 5.0 for the published types.

## Documentation

[ARCHITECTURE.md](https://github.com/erenthedeveloper0/zen/blob/main/ARCHITECTURE.md)
is the specification this package implements; §3 describes its internal strata.
[Error codes](https://github.com/erenthedeveloper0/zen/blob/main/docs/errors.md).

[MIT](https://github.com/erenthedeveloper0/zen/blob/main/LICENSE) © [Eren Sümer](https://github.com/erenthedeveloper0) · [contributors](https://github.com/erenthedeveloper0/zen/blob/main/CONTRIBUTORS.md)
