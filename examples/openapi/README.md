# examples/openapi

**The documentation is a projection of the application, not a description of it.**

```bash
npm run example:openapi          # start it
open http://localhost:3000/docs  # the reference
```

Two features, ten routes, Zod schemas, and an OpenAPI 3.1 document that nobody
wrote. The generator is a pure function `AppGraph → OpenAPIDocument`
([§29](../../ARCHITECTURE.md#29-openapi--code-generation)) — there is nothing to
keep in sync because there is nothing duplicated.

This is also the first example laid out the way
[§23.4](../../ARCHITECTURE.md#234-recommended-application-structure) recommends,
so it doubles as the answer to "how should I structure a Zen app".

---

## What to look at first

### 1. The document cannot describe a field the wire will not send

`UserRow` has ten columns. Five of them — `passwordHash`, `totpSecret`,
`stripeCustomerId`, `internalNotes`, `deletedAt` — must never leave the process,
and the handlers return the row **unmodified**:

```ts
users.get('/:id<int>', { response: { 200: PublicUser } }, (ctx) => {
  const row = ctx.resolve(UserRepoToken).find(ctx.params.id)
  if (row === undefined) throw new NotFound(`User ${ctx.params.id} not found`)
  return row                                    // ← all ten columns
})
```

```
handler returned : {"id":1,…,"passwordHash":"$2b$12$…","totpSecret":"JBSWY3DPEHPK3PXP",…}
wire             : {"id":1,"email":"ada@example.com","name":"Ada Lovelace","role":"admin","createdAt":"…"}
document says    : properties: id, email, name, role, createdAt   additionalProperties: false
```

All three agree, and `test/document.test.ts` proves it the only way worth
trusting: it makes a **real request** for every documented response and asserts
the keys that come back are exactly the keys the document promised.

That `additionalProperties: false` is the load-bearing detail. JSON Schema says
an absent `additionalProperties` *permits* extra keys; Zen's serializer drops
them ([§13.3.1](../../ARCHITECTURE.md#1331-the-one-deliberate-deviation-from-json-schema)).
A document generated from the raw schema would therefore promise fields that can
never arrive — so response schemas are projected **closed**, mirroring the
serializer IR node for node.

### 2. Zod, in four lines, and neither package has heard of it

```ts
// src/shared/zod.ts — the entire integration
registerSchemaConverter('zod', (schema, io) => z.toJSONSchema(schema as z.ZodType, { io }))
```

`@zenjs/core` and `@zenjs/openapi` ask a Standard Schema for `~standard.vendor`
and look up a converter that userland registered. Swapping to Valibot or ArkType
changes this file and nothing else.

`io` is not decoration. `role: Role.default('member')` is **optional on input**
and **guaranteed on output**, so:

| | `POST /users` body | `GET /users/{id}` response |
| --- | --- | --- |
| `required` | `email`, `name` | `id`, `email`, `name`, `role`, `createdAt` |

One schema, two correct descriptions. A generator that ignored the direction
would tell client authors that `role` is required in a request that does not
require it.

### 3. One component per concept

`PublicUser` reaches the generator by two different routes — inline when it is a
response schema, and hoisted into `$defs` by Zod when it is nested inside
`UserList` — and comes out as **one** component that `Order.customer` and
`UserList.users[]` both `$ref`.

`OrderLine` genuinely is two schemas: the request form tolerates extra keys, the
response form cannot emit them. So it is two components, named `OrderLine` and
`OrderLineInput` rather than `OrderLine` and `OrderLine2`.

### 4. Breaking changes are caught before they ship

```bash
npm run check-api            # diffs against api/openapi.json
```

Delete a field from `PublicUser` and run it:

```
  BREAKING (7)
    GET /users/{id} → response 200 (application/json).email
      Response field "email" was removed.  [OAS_RESPONSE_FIELD_REMOVED]
    GET /orders → response 200 (application/json)[].customer.email
      …
```

Seven locations, because seven operations return a `PublicUser`. Reporting per
*use* rather than per component is deliberate: `$ref` reuse should not hide the
blast radius from a reviewer. Add an *optional* field instead and it passes.

---

## Layout — [§23.4](../../ARCHITECTURE.md#234-recommended-application-structure) made real

Feature-first, because layer-first (`controllers/`, `services/`, `models/`)
makes every feature a diff across four directories.

```
src/
├── main.ts                    entry: build().listen()
├── app.ts                     composition root — plugins, services, features
├── config/
│   └── zen.config.ts          options and env (§16 will land here)
├── features/
│   ├── users/
│   │   ├── routes.ts          the collection
│   │   ├── schemas.ts         one declaration → validator, serializer, type, component
│   │   ├── service.ts         the repository and its token
│   │   ├── users.test.ts      colocated
│   │   └── index.ts           what the feature exports
│   └── orders/
├── shared/
│   ├── zod.ts                 the converter registration
│   ├── clock.ts               tokens and providers
│   └── schemas/pagination.ts  schemas more than one feature uses
└── plugins/
    └── request-id.ts          app-local plugin
scripts/
├── emit.ts                    writes api/openapi.json
└── check-api.ts               the compatibility gate
api/openapi.json               the committed baseline
test/document.test.ts          end-to-end document assertions
```

Nothing is discovered by scanning the filesystem. `src/app.ts` reads top to
bottom — config, plugins, services, features — and the whole application is
available as data through `app.graph()`, which is exactly what the OpenAPI
plugin reads.

---

## Endpoints

| | |
| --- | --- |
| `GET /docs` | the reference viewer |
| `GET /openapi.json` | the document, with an `ETag` and `304` support |
| `GET /users` `POST /users` | list (paged, filterable) and create |
| `GET /users/:id<int>` `PATCH` `DELETE` | fetch, update, delete |
| `GET /orders` `POST /orders` | list and place |
| `GET /orders/:id<int>` | fetch |

```bash
curl localhost:3000/users/1
curl localhost:3000/orders/1              # returns marginCents and fraudScore — watch the wire
curl -i localhost:3000/openapi.json
curl -X POST localhost:3000/users -H 'content-type: application/json' \
     -d '{"email":"not-an-email","name":""}'      # 422, one issue per field
```

### The viewer makes no external requests

Scalar, Swagger UI and Redoc are all better-looking, and all three are normally
wired in with a `<script src="https://cdn…">`. That is a fine default for a
public docs site and a bad one for a framework: it makes an internal endpoint
phone a third party on every page load, and it breaks behind a strict CSP, in an
air-gapped deployment, and on a plane. The built-in viewer inlines the document
at boot and ships HTML, CSS and ~90 lines of script.

If you want Scalar anyway, `ui: false` plus one route does it:

```ts
app.get('/docs', (ctx) => ctx.html(`
  <!doctype html><html><body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body></html>`))
```

---

## Things worth trying

1. **Delete a `response` schema.** Boot fails: `strict: true` in
   `src/config/zen.config.ts` turns a documentation hole into a startup error,
   because a route with no response schema is *also* unfiltered on the way out.
2. **Add a field to `UserRow` but not to `PublicUser`.** It never reaches the
   wire and never appears in the document. There is no `Object.keys` in the
   generated serializer for it to escape through.
3. **Use `z.transform()` in a response schema.** Zod cannot represent it as JSON
   Schema and throws; Zen degrades to an honest boot warning rather than
   silently emitting `{}` — which the serializer would read as "anything may be
   emitted". `src/shared/zod.ts` explains why `unrepresentable` is left alone.
4. **`npm run emit` then edit a schema and `npm run check-api`.** Watch the
   classification: removed response field breaking, added optional field
   compatible, changed summary documentation-only.
