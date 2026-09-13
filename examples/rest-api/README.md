# rest-api

A small user-directory API that exercises everything Zen currently implements:
**response contracts, plugins, dependency injection, validation, collections,
slots, all three middleware forms, error mapping,** and the **interpreted twins**.

```bash
node examples/rest-api/src/main.ts        # run it
node examples/rest-api/src/inspect.ts     # read what it compiled to
node --test "examples/rest-api/test/**/*.test.ts"
```

---

## The point of the example

`UserRow` is what the database returns. It carries five columns that must never
leave the process:

```ts
interface UserRow {
  id: number; email: string; name: string; role: 'admin' | 'member'; createdAt: string
  passwordHash: string      // ← never
  totpSecret: string | null // ← never
  stripeCustomerId: string  // ← never
  internalNotes: string     // ← never
  deletedAt: string | null  // ← never
}
```

The handler returns the row **unmodified**:

```ts
users.get('/:id<int>', { response: { 200: PublicUser } }, (ctx) => {
  const row = ctx.resolve(UserRepoToken).find(ctx.params.id)
  if (row === undefined) throw new NotFound(`User ${ctx.params.id} not found`)
  return row                                    // ← all ten fields
})
```

What ships:

```
handler returned:
  {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin",
   "createdAt":"2024-03-01T12:00:00.000Z","passwordHash":"$2b$12$seeded.hash.for.Ada Lovelace",
   "totpSecret":"JBSWY3DPEHPK3PXP","stripeCustomerId":"cus_1xxxxxxxxxx",
   "internalNotes":"founder account — do not suspend","deletedAt":null}

wire:
  {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin","createdAt":"2024-03-01T12:00:00.000Z"}
```

Not because the handler was careful. Because `response: { 200: PublicUser }`
compiled to a function that has no way to emit anything else —
`node examples/rest-api/src/inspect.ts` prints it:

```js
function f$0(v) {
  let t0, t1, t2, t3, t4
  if (v === null || typeof v !== 'object') return $notObject(v, "$")
  let s = '{'
  t0 = v.id
  if (t0 === undefined) $missing("$.id")
  s += "\"id\":" + (typeof t0 === 'number' && (t0 | 0) === t0 ? '' + t0 : $int(t0, "$.id"))
  …
  return s + '}'
}
```

No `Object.keys`. No `for…in`. There is nothing in that function through which
`passwordHash` could reach the wire. That is the difference between a convention
and a guarantee — see [§13.3](../../ARCHITECTURE.md#133-the-compiled-json-serializer).

**Try deleting the `response` line** and hitting the endpoint again.

---

## What each file demonstrates

| File | Shows |
| --- | --- |
| `src/schema.ts` | Zen's core depends on [Standard Schema](https://standardschema.dev) and nothing else — so this 150-line schema library, which the framework has never heard of, works for validation *and* drives the serializer via `toJsonSchema()` |
| `src/domain.ts` | One declaration per contract. `PublicUser` is used as a response contract; `NewUser` as a request contract |
| `src/services.ts` | DI with typed tokens — no decorators, no `reflect-metadata`, interfaces injectable. Three lifetimes: singleton, eager singleton, request-scoped |
| `src/plugins.ts` | Plugin manifests, `dependsOn` with semver, declared ordering, a context decoration that becomes a typed `ctx.user`, and plugin exports |
| `src/app.ts` | The whole application as one readable function: services, plugins, routes |
| `src/inspect.ts` | The generated serializer, the generated pipeline, and the AppGraph — every claim is checkable |
| `test/api.test.ts` | `inject()` testing: no socket, no supertest, and a compiled-≡-interpreted probe |

---

## Try it

```bash
node examples/rest-api/src/main.ts
```

`x-user-id` stands in for authentication. User 1 is an admin, users 2 and 3 are
members.

```bash
# your own profile — any authenticated user
curl -H 'x-user-id: 2' localhost:3000/me

# the directory — admin only
curl -H 'x-user-id: 1' localhost:3000/users/
curl -H 'x-user-id: 2' localhost:3000/users/     # 403, from a plugin that
                                                 # dependsOn: { auth: '^1.0.0' }

# no credential at all
curl -i localhost:3000/users/1                   # 401 + WWW-Authenticate

# validation: a normalised issue envelope, one entry per field
curl -X POST localhost:3000/users/ -H 'x-user-id: 1' \
     -H 'content-type: application/json' \
     -d '{"email":"nope","name":"","password":"short"}'

# 201 selects the 201 contract, not the 200 one
curl -i -X POST localhost:3000/users/ -H 'x-user-id: 1' \
     -H 'content-type: application/json' \
     -d '{"email":"alan@example.com","name":"Alan Turing","password":"enigma-1936"}'

# a typed path param that does not parse never reaches the handler
curl -i -H 'x-user-id: 1' localhost:3000/users/abc     # 404

# free, correct 405 with an Allow header
curl -i -X PUT -H 'x-user-id: 1' localhost:3000/users/1

# health is public
curl localhost:3000/health
```

---

## Using a real schema library

`src/schema.ts` exists to prove the framework needs no integration work. In a
real application you would delete it and write:

```ts
import { z } from 'zod'
import { registerSchemaConverter } from 'zen'

registerSchemaConverter('zod', (schema) => z.toJSONSchema(schema as never, { io: 'output' }))

const PublicUser = z.object({
  id: z.int(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['admin', 'member']),
  createdAt: z.iso.datetime(),
})
```

Nothing else in this example would change. `@zenjs/core` still has zero runtime
dependencies, and swapping Zod for Valibot or ArkType is a userland decision
rather than a framework release.
