# examples/coercion

`?page=2` is a number — [RFC 0001 §11.4](../../ARCHITECTURE.md#114-coercion-profiles).

```bash
npm run example:coercion                      # start it
npm run explain -w @visionpilot/zen-example-coercion    # the plan the compiler derived, per route
```

A product catalogue whose query string carries numbers, booleans, lists and a
zero-padded SKU — which is to say, every case that makes this problem
interesting, in one endpoint.

---

## The papercut

A query string is text. `?page=2` has no way to say *the number two*; it can
only say the character `2`. Every framework deals with this differently and all
of the answers are bad:

| | what happens | why it hurts |
| --- | --- | --- |
| Express | you get `'2'` | it reaches your database as a string |
| Fastify | JSON Schema `type: integer` coerces | but only via JSON Schema, and only for bodies you declared |
| Zod on anything | you write `z.coerce.number()` | on every numeric field of every query schema, forever |

Zen's answer is that **the schema already contains the answer**. A field
declared `z.number()` wants a number. A field declared `z.string()` wants the
string it was given. So the coercion plan is derived at boot from the declared
type, compiled into the route's validator, and there is nothing to remember.

```ts
// before
page: z.coerce.number().int().min(1).default(1)

// now
page: z.number().int().min(1).default(1)
```

Three tokens, which is not the point. The point is what the first line does when
somebody forgets it: **nothing visible**. `?page=2` arrives as `'2'`, `'2' > 1`
is `true`, validation passes, and the string reaches the driver.

---

## Watch it work

```bash
curl -s 'localhost:3000/catalog?page=1&limit=3&inStock=true&tags=sale' | jq '.applied'
```

```json
{ "inStock": true, "tags": ["sale"], "sku": null, "sort": "name" }
```

`inStock` is a boolean. `tags` is an array **from a single value** — the case
every query parser in every language gets wrong, and the one that turns into a
production bug the first time a user filters on one tag rather than two.

### The one that must not be converted

```bash
curl -s 'localhost:3000/catalog?sku=00713' | jq '.applied.sku, .items[0].name'
```

```json
"00713"
"Aeron chair"
```

`00713` is a SKU. It looks exactly like a number and it is not one. A framework
that guesses from the *value* returns product 713; this one reads the schema,
sees `z.string()`, and does nothing. The same protection covers `?q=2024`, whose
schema is `z.union([z.string(), z.number()])` — the value already satisfies the
schema, so there is nothing to convert it *to*.

### When something will not convert

```bash
curl -s 'localhost:3000/catalog?page=banana' | jq '.errors'
```

```json
[{ "path": ["page"], "code": "type", "message": "Invalid input: expected number, received string" }]
```

That message is **Zod's**, not Zen's. Coercion has no error channel at all: a
value it will not convert is passed through unchanged and the schema — which is
the authority on what a valid request is — reports it, with its own path and its
own issue code. There is exactly one thing in this system that decides whether a
request is acceptable, and it is not the coercer.

The same rule produces this, which is the one people are surprised by:

```bash
curl -s 'localhost:3000/catalog?page=9007199254740993' | jq '.errors[0].message'
```

`Number()` would return `9007199254740992` and the request would page the wrong
rows — or, on a route where that id is a primary key, update the wrong record.
An integer-typed value that does not survive the round trip is left as a string
so the schema rejects it. A visible 400 beats a silent off-by-one.

---

## Per-route conventions

How a list is spelled is a property of the *client*, not of the schema, so it is
a profile rather than something you write into `z.array(...)`:

```ts
c.get('/by-ids', {
  query: LegacyQuery,                      // z.array(z.number().int())
  coercion: { query: { arrays: 'comma' } },
}, …)
```

```bash
curl -s 'localhost:3000/catalog/by-ids?ids=0,1,2' | jq '[.[].name]'
curl -s 'localhost:3000/catalog?tags=sale,new'    | jq '.applied.tags'   # ["sale,new"] — repeat, not comma
```

That one line also reaches the generated OpenAPI document as `style: form,
explode: false`, from the same plan the coercer was built from — so an SDK
generated against the document sends what the server actually parses. Nobody
wrote that mapping twice; it is [§29.1](../../ARCHITECTURE.md#291-why-this-is-architecture-not-a-plugin-concern)'s
guarantee applied to request parameters.

## Bodies

```bash
# a form — coerced, because a form IS a query string
curl -s -X POST localhost:3000/catalog/00713/order -d 'quantity=2&giftWrap=on&note=' | jq

# JSON — never coerced, on the same route
curl -s -X POST localhost:3000/catalog/00713/order \
     -H 'content-type: application/json' -d '{"quantity":"2"}' | jq '.status'
```

The first returns a 200 with `quantity: 2`, `giftWrap: true` and `note: null` —
the blank input is *absent* rather than `''`, which is what
`emptyStringAsUndefined` is for and why an HTML form needs it.

The second returns 422. `{"quantity": "2"}` in JSON is a client sending the
wrong type, and reporting it is more useful than papering over it. The profile
is per source; the content type decides which of §11.4's two body rows applies.

---

## The reader

```bash
npm run explain -w @visionpilot/zen-example-coercion
```

```
  GET /catalog                          → catalog.search

    coerce      query: page → integer, limit → integer, inStock → boolean, tags → array of string (repeat)
    validate    query
    handler     searchCatalog
    serialize   200 (compiled)
```

It prints the **plan**, not the profile. `numbers: true` tells you a policy;
this tells you an outcome, which is what people actually want to know — never
"is numeric coercion on" but "why did `?sku=00713` survive and `?page=2` not".
It comes from the same structure the coercer was generated from, so it cannot
describe a conversion that will not happen.

It also prints every generated unit, which is where you can see the zero-cost
rule rather than take it on faith: a route whose schema declares only strings
has **no `coercer:` entry at all**. Not an empty function — no function.
`benchmarks/coercion/run.ts` fails the build if that stops being true.

---

## `src/app.ts` builds the app twice

`makeApp()` is the service as written above. `makeLegacyApp()` is the same
service with `coercion: false` and `z.coerce` written back in — including the
`z.preprocess` you need for the single-value-array problem, which `z.coerce` has
no answer for at all.

`test/coercion.test.ts` asserts the two answer **identically** on the same
requests. That is a stronger claim than "the feature works": it says this is a
refactor of something people already hand-write, so adopting it cannot change
behaviour. A convenience should have to clear that bar before it earns a
default.

---

## What this example does not show

- **Dates.** `dates` is in the profile and is `false` everywhere. No shape
  language can express "this position wants a `Date`" — `z.toJSONSchema(z.date())`
  throws `Date cannot be represented in JSON Schema` — so the only thing left to
  guess at is `format: 'date-time'`, which is the one case where the validator
  provably wants a *string*. Use `z.coerce.date()`; it is one call and it is
  checked by the library that owns the type.
- **Nested query strings.** `?a[b]=1` is not parsed into `{ a: { b: 1 } }`, by
  design — it is a prototype-pollution and algorithmic-complexity surface
  ([§19.5](../../ARCHITECTURE.md#195-injection-and-pollution-defences)) and
  almost nobody needs it. `arrays: 'bracket'` handles `?a[]=1`, which is the
  half people actually use.
- **A `$ref` or union at the root of a query schema.** Only top-level properties
  of a plain object are planned. The same limitation the OpenAPI generator has,
  for the same reason, and it is reported there rather than warned about twice.
