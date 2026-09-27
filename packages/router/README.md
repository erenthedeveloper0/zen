<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/VisionPilot/Zen.js/main/.github/images/logo-with-text-white.png">
    <img alt="zen.js" src="https://raw.githubusercontent.com/VisionPilot/Zen.js/main/.github/images/logo-with-text-black.png" width="220">
  </picture>
</p>

# @visionpilot/zen-router

The router for [Zen](https://github.com/VisionPilot/Zen.js): a backtracking radix
trie with typed parameters, a generated fixed-shape params builder per route,
and boot-time conflict analysis.

> **Alpha.** Installed for you by
> [`@visionpilot/zen`](https://www.npmjs.com/package/@visionpilot/zen).

```bash
npm install @visionpilot/zen-router@alpha
```

## Path syntax

Small, statically analysable, and with no regular expressions — regex paths
defeat trie compilation, cannot be documented in OpenAPI, and have a ReDoS
history.

| Syntax | Meaning | `ctx.params` type |
| --- | --- | --- |
| `/users` | static segment | — |
| `/users/:id` | parameter | `string` |
| `/users/:id<int>` | typed parameter, enforced by the matcher | `number` |
| `/users/:id<uuid>` | typed parameter | `string` |
| `/files/*path` | wildcard, the rest of the path | `string` |
| `/posts/:slug?` | optional trailing parameter | `string \| undefined` |

Built-in types: `int`, `float`, `uuid`, `ulid`, `date`, `slug`, `hex`. A segment
that does not satisfy its type does not match, so `/users/abc` is a clean 404
rather than a handler receiving garbage. `int` also refuses values past 2⁵³ that
would silently round to a different id.

Register your own with `app.paramType()` — one declaration serves the matcher,
the parsed value and the OpenAPI document:

```ts
app.paramType('objectId', {
  test: (s) => s.length === 24 && /^[0-9a-f]+$/.test(s),
  parse: (s) => new ObjectId(s),
  jsonSchema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
})
app.get('/posts/:id<objectId>', (ctx) => posts.find(ctx.params.id))
```

## Priority and conflicts

Matching is decided left to right per segment — static, then typed parameter,
then parameter, then wildcard — never by registration order, so splitting routes
across files cannot change behaviour. At boot, duplicate routes and genuinely
ambiguous pairs (`/:a/b` against `/a/:b`) are refused with both origins named.
A wrong method on a matched path is a 405 with a correct `Allow` header.

## Documentation

[ARCHITECTURE.md §5](https://github.com/VisionPilot/Zen.js/blob/main/ARCHITECTURE.md#5-route-registry-design).

[MIT](https://github.com/VisionPilot/Zen.js/blob/main/LICENSE) © [VisionPilot](https://github.com/VisionPilot) · created by [Eren Sümer](https://github.com/ErenSumer) · [contributors](https://github.com/VisionPilot/Zen.js/blob/main/CONTRIBUTORS.md)
