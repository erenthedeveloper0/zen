# `examples/negotiation` — one resource, three representations

A small sales-report API that speaks three media types from one route: two
versions of JSON and a CSV export. No `/v2/` prefix, no second route, no
`if (accept.includes('csv'))`, and no `Vary` header written by hand.

```bash
npm run example:negotiation
npm run explain -w @zenjs-example/negotiation
npm test -w @zenjs-example/negotiation
```

---

## The whole feature, in one declaration

```ts
reports.get('/', {
  query: SalesQuery,
  response: {
    200: {
      'application/vnd.acme.sales.v2+json': SalesV2,
      'application/vnd.acme.sales.v1+json': SalesV1,
      'text/csv':                            SalesCsv,
    },
  },
}, function listSales(ctx) {
  const sales = service.list(ctx.query.region, ctx.query.limit)
  return sales.map((sale) => project(sale, ctx.negotiated))
})
```

That is it. The `Accept` header is matched against those three at stage 5 —
before validation, before the handler, before anything touches a database — and
the chosen representation decides which compiled writer runs and what
`Content-Type` goes out. `Vary: Accept` is staged on every response, including
the 406 and including a request that sent no `Accept` at all.

**The form is the opt-in.** `200: SalesV2` is not negotiated and emits no
negotiation code; `200: { 'application/json': SalesV2 }` is, even with one media
type in it. There is no `negotiate: true` option, because an option would let
the declaration and the flag disagree.

---

## The two cases that are actually the point

### 1. API versioning by media type is free

Two of the three representations above are JSON, so both are written by the
**same compiled serializer** §13.3 already had — with the same guarantee that an
undeclared field cannot be emitted. A `+json` vendor type needs no encoder at
all.

```bash
curl -s localhost:3000/api/sales -H 'Accept: application/vnd.acme.sales.v1+json' | head -3
curl -s localhost:3000/api/sales -H 'Accept: application/vnd.acme.sales.v2+json' | head -3
```

v1 has `owner: "Ada Lovelace"`. v2 has `owner: { id, name }` and a `currency`.
A client pinned to v1 keeps getting v1 from this URL forever, with no router
entry, no duplicated handler and no dead code path to delete in a year.

This is the most common real reason to negotiate, and it is the cheapest.

### 2. `text/csv;q=0, */*` means *anything except CSV*

```bash
curl -si localhost:3000/api/sales -H 'Accept: text/csv;q=0, */*' | grep -i content-type
```

`application/vnd.acme.sales.v2+json`. RFC 9110 §12.5.1 says the **most specific**
matching range decides an offer's quality — so `text/csv;q=0` overrides the
wildcard that would otherwise allow it.

Implementations that score by "the highest `q` among matching ranges" get this
backwards and serve the client the one format it named and refused. It is a
deliberate header: somebody wrote it to *exclude* something. `benchmarks/negotiation`
has it as a CI gate, over five shapes of offer list and eight hostile headers,
for the same reason the CORS reflection gate exists — "serve the first thing we
have" is the fastest possible negotiation and it is the shortcut an optimisation
reaches for first.

---

## The encoder seam

`text/csv` is not something `@zenjs/core` can ship: it has zero runtime
dependencies (§19.8), and there is no single right answer about `\r\n`, about
`sep=`, or about whether a `null` is an empty cell. So it is registered, the
same way a schema converter is:

```ts
registerMediaEncoder('text/csv', (schema) => {
  const columns = columnsOf(schema)          // once, at boot
  return (value) => /* per request: appends strings */
})
```

It is a **factory**, and that is the interesting part. It receives the response
schema — already converted to JSON Schema by the same probe the compiled
serializer uses — and returns a writer. Everything schema-shaped happens at
boot; what runs per request appends strings. Same shape as §13.3's serializer
compiler, deliberately.

Two things fall out of that, and `src/media/csv.ts` exists to show them.

**The security property is inherited, not re-implemented.** The columns come
from the schema, so a field the schema does not declare cannot appear in the
CSV — exactly as it cannot appear in the JSON. Every row this service holds
carries `internalMargin`; it is in neither format, and nothing in the handler
removes it.

**A missing encoder is a boot error, not a runtime surprise.** Forget the
`import './media/csv.ts'` in `app.ts` and the app refuses to start, naming the
route, the status, the media type, and the call to make. The alternative would
be to boot fine and send a JSON body under `Content-Type: text/csv`, which is
discovered by whoever opens the file rather than by whoever deployed it.

---

## The status that is *not* negotiated

```bash
curl -si localhost:3000/api/sales/999 -H 'Accept: text/csv' | head -10
```

`404`, `Content-Type: application/problem+json`. The route declares its 200 in
the variant form and its 404 in the plain form, so the 404 is not one of this
resource's representations — it is RFC 9457's problem document, which is what
§12.1 means by *one envelope*.

Getting this wrong is not cosmetic. A CSV parser handed a JSON object reports a
parse error at line 1, and the bug report that arrives says "the export is
corrupt" rather than "the id does not exist".

---

## What the un-negotiated route paid

`GET /api/sales/regions` declares one representation. It reads no `Accept`,
stages no `Vary`, and its compiled pipeline contains no negotiation code —
byte-identical to what an app with no negotiated route at all would produce.
`npm run explain` prints both pipelines' sizes side by side, and
`benchmarks/negotiation` fails the build if they ever diverge.

```bash
curl -si localhost:3000/api/sales/regions -H 'Accept: text/csv' | head -8
```

`200`, with JSON. RFC 9110 §12.5.1 explicitly permits disregarding `Accept`, and
the alternative — every route in every application parsing a header to discover
it has nothing to decide — is the per-request cost this framework exists to
refuse. A route that wants the strict answer opts in by writing the variant
form.

---

## Files

| File | What |
| --- | --- |
| `src/features/reports/schemas.ts` | Three representations of one resource, and why the 404 is declared plainly |
| `src/features/reports/routes.ts` | The declaration, and the one place `ctx.negotiated` is read |
| `src/media/csv.ts` | The encoder seam — a boot-time factory, RFC 4180 quoting, and the CSV-injection guard |
| `src/app.ts` | Two side-effecting imports, and why their order matters in the safe direction |
| `src/inspect.ts` | Six questions answered off the frozen graph |
| `test/negotiation.test.ts` | Type-checked in CI, so the type-level claim lives here |

---

## What this example does not do

- **It does not negotiate the request body.** `Content-Type` on the way in is
  §4.2 stage 6's business and is decided by the body parser registry; `Accept`
  on the way out is this. They are different questions with different answers.
- **It does not negotiate language or encoding.** `Accept-Language` and
  `Accept-Encoding` use the same grammar and the parser in
  `compile/media-type.ts` would read them, but nothing consumes them yet.
  Compression is modelled as an *adapter* capability (§14.1), which is where
  `Accept-Encoding` belongs.
- **It does not stream the CSV.** A real export of a million rows should be
  `ctx.stream()` with the compiled row serializer reused per row (§13.5); this
  builds a string, because the point here is the negotiation and an example that
  demonstrates two things demonstrates neither.
