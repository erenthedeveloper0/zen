import { makeApp } from './app.ts'
import { config } from './config/coercion.config.ts'

/**
 * `npm run example:coercion`
 *
 * Then, in another terminal. The sequence is the demonstration, and the third
 * command is the one worth pausing on:
 *
 *   # numbers, booleans and lists, from a query string, with no z.coerce
 *   curl -s 'localhost:3000/catalog?page=1&limit=3&inStock=true&tags=sale' | jq '.applied, .page'
 *
 *   # one tag, not two — and it is still an array. This is the bug the
 *   # single-value case causes in every framework that does not do this.
 *   curl -s 'localhost:3000/catalog?tags=sale'     | jq '.applied.tags'
 *   curl -s 'localhost:3000/catalog?tags=sale&tags=new' | jq '.applied.tags'
 *
 *   # the one that must NOT be converted. `00713` is a SKU, declared as a
 *   # string, and it comes back as a string — where a framework that guessed
 *   # from the value would have looked up product 713.
 *   curl -s 'localhost:3000/catalog?sku=00713' | jq '.applied.sku, .items[0].name'
 *
 *   # what happens when something will not convert: the *schema* answers, with
 *   # its own message and its own path. Coercion has no error channel at all.
 *   curl -s 'localhost:3000/catalog?page=banana' | jq '.code, .errors'
 *
 *   # a bigint-shaped id is refused rather than silently rounded to …992
 *   curl -s 'localhost:3000/catalog?page=9007199254740993' | jq '.errors[0].message'
 *
 *   # one route, one line of configuration, a different list convention
 *   curl -s 'localhost:3000/catalog/by-ids?ids=0,1,2' | jq '[.[].name]'
 *
 *   # a form body — coerced, because a form IS a query string. The empty note
 *   # arrives as absent rather than as '', so `.optional()` means what it says.
 *   curl -s -X POST localhost:3000/catalog/00713/order \
 *        -d 'quantity=2&giftWrap=on&note=' | jq
 *
 *   # a JSON body — never coerced, because JSON has real types and "42" here
 *   # is a client bug worth reporting rather than papering over.
 *   curl -s -X POST localhost:3000/catalog/00713/order \
 *        -H 'content-type: application/json' \
 *        -d '{"quantity":"2"}' | jq '.status, .errors'
 *
 *   # two headers, folded into one by Node, recovered as a list by the profile
 *   curl -s localhost:3000/features -H 'x-feature: a' -H 'x-feature: b' | jq
 *
 * And the part that is not a curl command:
 *
 *   npm run explain -w @zenjs-example/coercion
 *
 * which prints the plan the boot compiler derived, per route, from the same
 * structure the coercers were generated from — including which routes got no
 * coercer at all.
 */
const app = makeApp()
const handle = await app.listen({ port: config.port })

console.log(`
  listening on ${handle.url}

    GET  /catalog                 page · limit · inStock · tags · sku · q · sort
    GET  /catalog/by-ids          ?ids=0,1,2      (arrays: 'comma', on this route only)
    POST /catalog/:sku/order      form body, coerced; JSON body, not
    GET  /features                X-Feature: a, b

  Not coerced, on purpose:  sku (declared string) · q (union with string)

  npm run explain -w @zenjs-example/coercion   — the derived plan, per route
`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(signal).then(() => process.exit(0)) })
}
