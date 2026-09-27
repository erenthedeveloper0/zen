<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/erenthedeveloper0/zen/main/.github/images/logo-with-text-white.png">
    <img alt="zen.js" src="https://raw.githubusercontent.com/erenthedeveloper0/zen/main/.github/images/logo-with-text-black.png" width="220">
  </picture>
</p>

# @erenthedeveloper0/zen-adapter-node

The Node.js adapter for [Zen](https://github.com/erenthedeveloper0/zen): runs a Zen
application on `node:http`.

> **Alpha.** Installed and configured for you by
> [`@erenthedeveloper0/zen`](https://www.npmjs.com/package/@erenthedeveloper0/zen); install it
> directly only to pass options.

```bash
npm install @erenthedeveloper0/zen-adapter-node@alpha
```

```ts
import { zen, nodeAdapter } from '@erenthedeveloper0/zen'

const app = zen({
  adapter: nodeAdapter({
    drainDelay: 10_000,      // keep answering after readiness goes red
    shutdownTimeout: 30_000, // then give in-flight requests this long
  }),
})
```

## What it does

- **The fast path.** The request is wrapped, not converted: no WHATWG `Request`
  is constructed, headers are not materialised until something reads them, and
  the body is not touched unless the route declares one.
- **Disconnects reach `ctx.signal`.** When a client goes away — before the
  response, or in the middle of a streamed one — the request's `AbortSignal`
  aborts, so the database query or upstream `fetch` you passed it to stops too.
  A client leaving mid-stream is the ordinary end of a stream nobody is reading;
  it is not logged as an error.
- **File responses.** `ctx.file(path, { root })` answers a missing file with a
  404 before any byte is written, refuses any path that resolves outside `root`
  (including through a symlink), sets `Content-Type`, `Content-Length`,
  `ETag` and `Last-Modified`, answers conditional requests with 304, and
  serves a single `Range` with 206.
- **Server-sent events.** `ctx.sse()` streams with backpressure, and on shutdown
  each open stream receives a final `shutdown` event and closes cleanly.
- **Graceful shutdown**, in RFC 0001 §4.5's order: after `drainDelay` the server
  stops accepting, every response still in flight is its connection's last
  (`Connection: close`), and nothing waits on an idle keep-alive connection.

## Options

| Option | Default | |
| --- | --- | --- |
| `drainDelay` | `0` | ms to keep accepting after readiness fails. Set it longer than your orchestrator's readiness period × failure threshold. |
| `shutdownTimeout` | `30000` | ms in-flight requests get before their sockets are destroyed. |
| `headersTimeout` | `20000` | Slowloris defence. |
| `requestTimeout` | `30000` | |
| `keepAliveTimeout` | `65000` | Longer than common load balancer idle timeouts. |
| `maxHeadersCount` | `64` | |

## Documentation

[ARCHITECTURE.md §14](https://github.com/erenthedeveloper0/zen/blob/main/ARCHITECTURE.md#14-adapter-abstraction).

[MIT](https://github.com/erenthedeveloper0/zen/blob/main/LICENSE) © [Eren Sümer](https://github.com/erenthedeveloper0) · [contributors](https://github.com/erenthedeveloper0/zen/blob/main/CONTRIBUTORS.md)
