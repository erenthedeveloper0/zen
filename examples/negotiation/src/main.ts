import { makeApp } from './app.ts'

/**
 * `npm run example:negotiation`
 *
 * Then, in another terminal. The sequence is the demonstration; commands 2, 5
 * and 6 are the ones that are wrong in most services that hand-roll this.
 *
 *   # 1. No Accept header. curl sends none, so this is the server's preference
 *   #    — the media type the route declared first.
 *   curl -si localhost:3000/api/sales | head -8
 *
 *   # 2. Vary: Accept is on that response, even though the request never
 *   #    mentioned Accept. A shared cache that stored it without the header
 *   #    would serve it to the next client, whatever that client asked for.
 *   curl -si localhost:3000/api/sales | grep -i vary
 *
 *   # 3. CSV. One route, one handler, a different writer and a different
 *   #    Content-Type — and the columns come from the same schema the JSON
 *   #    fields come from.
 *   curl -s localhost:3000/api/sales -H 'Accept: text/csv'
 *
 *   # 4. API versioning with no /v2/ prefix and no router entry. A client
 *   #    pinned to v1 keeps getting v1 from this URL forever.
 *   curl -s localhost:3000/api/sales -H 'Accept: application/vnd.acme.sales.v1+json' | head -3
 *   curl -s localhost:3000/api/sales -H 'Accept: application/vnd.acme.sales.v2+json' | head -3
 *
 *   # 5. "Anything except CSV" — the case implementations get backwards.
 *   #    A q of 0 on a specific type beats a wildcard that allows everything,
 *   #    because RFC 9110 says the *most specific* range decides.
 *   curl -si localhost:3000/api/sales -H 'Accept: text/csv;q=0, * / *' | grep -i content-type
 *
 *   # 6. Something the route cannot produce: 406, listing what it can. And the
 *   #    406 carries Vary: Accept too.
 *   curl -si localhost:3000/api/sales -H 'Accept: application/pdf' | head -12
 *
 *   # 7. A status that is NOT negotiated. Ask for CSV, get a 404, and the body
 *   #    is a problem document under application/json — not a CSV file with one
 *   #    row, and not a CSV parse error at line 1.
 *   curl -si localhost:3000/api/sales/999 -H 'Accept: text/csv' | head -10
 *
 *   # 8. A route that declares one representation is not negotiated at all:
 *   #    no Vary, no 406, and Accept is disregarded (RFC 9110 §12.5.1 allows it).
 *   curl -si localhost:3000/api/sales/regions -H 'Accept: text/csv' | head -8
 *
 *   # 9. What actually runs, and where negotiation sits in the chain.
 *   npm run explain -w @zenjs-example/negotiation
 */
const { app } = makeApp()
const handle = await app.listen({ port: 3000 })

console.log(`
  listening on ${handle.url}

    GET /api/sales             three representations: v2 json, v1 json, csv
    GET /api/sales/:id         the same three, plus a 404 that is not negotiated
    GET /api/sales/regions     one representation — not negotiated, pays nothing

  Two things this example is really about.

  First, **API versioning by media type costs nothing extra**. Two of the three
  representations above are JSON, so both are written by the compiled
  serializer of §13.3 — the same one, with the same guarantee that an undeclared
  field cannot be emitted. A '+json' vendor type needs no encoder, and it is the
  most common real reason to negotiate.

  Second, **a route that declares one representation is not negotiated**, and
  that is the whole zero-cost story. /api/sales/regions reads no Accept header,
  stages no Vary and emits no negotiation code; its compiled pipeline is
  byte-identical to the one an app with no negotiation at all would produce, and
  benchmarks/negotiation gates on exactly that.

  Every row this service holds carries an 'internalMargin' field. It is in
  neither representation, and nothing in the handler removes it.
`)
