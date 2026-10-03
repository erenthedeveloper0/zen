/**
 * URL generation — rfcs/0001 §5.7.
 *
 * What `app.url(name, params, query)` takes. The route is named; the values
 * are whatever the application has to hand — an id from a row, a `Date`, a
 * list of tags — and each becomes text the way the route will read it back.
 */

/**
 * What a path segment or a query value is built from.
 *
 * Deliberately not "anything with a `toString`": every object has one, and a
 * plain object's is `[object Object]`, which an untyped `:slug` would accept
 * and a link would carry. A `Date` is written as `toISOString()`, which the
 * `<date>` type reads back as the same instant; a `bigint` as its digits,
 * which is how a 64-bit id reaches an untyped `:id`. A value with an identity
 * of its own — an `ObjectId` — is passed as the string its route's type
 * accepts, which is one call and says which string is meant.
 */
export type UrlValue = string | number | bigint | boolean | Date

/**
 * A route's path parameters, by name — `{ id: 42 }` for `/users/:id<int>`.
 *
 * A wildcard takes the rest of the path as a string (`'docs/intro.md'`) or as
 * its segments (`['docs', 'intro.md']`). An optional parameter may be left out,
 * or `undefined`, from the end.
 */
export type UrlParams = Readonly<Record<string, UrlValue | readonly UrlValue[] | undefined>>

/**
 * The query string, by key, in the order given.
 *
 * `null` and `undefined` leave a key out. A list is written the way the route
 * reads lists (§11.4): repeated — `?tag=a&tag=b` — unless its coercion profile
 * says `comma` (`?tag=a,b`) or `bracket` (`?tag[]=a&tag[]=b`).
 */
export type UrlQuery = Readonly<Record<string, UrlValue | readonly UrlValue[] | null | undefined>>
