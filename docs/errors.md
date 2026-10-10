# Error codes

Every error Zen reports carries a stable `code`. Codes are public API and are
covered by semver (RFC 0001, I7): clients switch on codes, humans read messages,
and messages may change while codes may not.

Each code below is also a link target. A problem document's `type` and a boot
diagnostic's `docs:` line both point here —
`https://github.com/erenthedeveloper0/zen/blob/main/docs/errors.md#zen_not_found` —
and a test asserts that every code the framework can produce has an entry.

- [Boot and registration](#boot-and-registration) — reported by `ready()`, aggregated, before any traffic
- [Request time](#request-time) — the `code` of a problem document (RFC 9457)
- [OpenAPI](#openapi) — `@erenthedeveloper0/zen-openapi`'s document diagnostics
- [Router warnings](#router-warnings)

Boot problems are **aggregated**: an application with four registration problems
is told about all four in one run (§12.7). Each diagnostic prints `fix:` — what
to do — and, where something else broke as a result, `also:`.

---

## Boot and registration

## ZEN_ROUTE_DUPLICATE

Two routes have the same method and path, or the same `name`. Remove one
registration, give them different paths, or give each its own name. Both are
reported.

A name is a route's identity — to the compiled route table, to URL generation,
to the OpenAPI `operationId` and to metrics labels — so two routes cannot share
one. Before this was checked, two routes with one name booted cleanly and then
answered each other's requests.

## ZEN_ROUTE_AMBIGUOUS

Two routes can match the same request and no priority rule separates them —
`GET /:a/b` and `GET /a/:b` both match `/a/b` (§5.5). Make one segment static,
or constrain a parameter with a type (`/:org<slug>/settings`).

Two *different* parameter types in the same position are ambiguous whenever one
value satisfies both: `/items/:id<int>` and `/items/:key<slug>` both accept
`42`. The message names such a value. Registration order never decides which
route answers (§5.6), so this is refused rather than resolved by whichever file
was imported first.

## ZEN_ROUTE_INVALID_PATH

A path does not parse: a wildcard that is not the last segment, a parameter
mixed with literal text in one segment (`/v:version`), an empty or duplicate
parameter name. Also raised for a handler that is not a function, and for a
`paramType` name that could not appear in a path.

## ZEN_PARAM_TYPE_UNKNOWN

A path uses a parameter type nobody registered — `/:id<objectId>`. The message
lists the known types. Register it with `app.paramType('objectId', { test, parse, jsonSchema })`.

## ZEN_PLUGIN_MISSING

A plugin's `dependsOn` names a plugin that is not registered. Register the
dependency with `app.use()`.

## ZEN_PLUGIN_VERSION

A dependency is registered, but at a version outside the range `dependsOn` asks for.

## ZEN_PLUGIN_CONFLICT

A plugin lists another registered plugin in `conflictsWith`. Remove one of them.

## ZEN_PLUGIN_DUPLICATE

A plugin is registered twice and does not declare `multiple: true`.

## ZEN_PLUGIN_CYCLE

Plugins depend on each other in a cycle. The cycle is printed; break it with an
interface plugin both can depend on.

## ZEN_PLUGIN_OPTIONS

A plugin's options were rejected, or its `setup` threw.

Options are checked against the plugin's `options` schema before any plugin's
`setup` runs (§10.5 step 2), every plugin in one boot. Two things refuse them:
the schema's own verdict, and a key the schema does not declare — named, with
the declared key it was probably meant to be:

```
ZEN_PLUGIN_OPTIONS  Plugin "rate-limit@0.1.0" was given options it does not accept: "limt" is not an option.
  fix: "limt" is not an option of rate-limit — did you mean "limit"?
```

A schema whose keys are open — `additionalProperties: true`, or a schema for
them — is believed; otherwise an options object is read as a closed vocabulary,
because the permissive reading is the one that turns a typo into a default.
`setup` receives the schema's *output*, defaults applied. A factory plugin
(`cors({ … })`) states what it was built with as `boundOptions`, and is checked
the same way. Values are never quoted: options are where keys and DSNs go.

When `setup` throws, the plugin's own `hint` and `consequence`, when it
supplies them, are printed as `fix:` and `also:`; plugins that depend on it are
named as skipped.

## ZEN_DECORATOR_CONFLICT

Two plugins decorate the same context property, or a decoration uses a name the
context already owns (`json`, `params`, `res`, …) or a name that is not a
JavaScript identifier. Rename the decoration.

## ZEN_SLOT_CONFLICT

A slot or service token name is declared twice with incompatible options, or as
both a slot and a service. Names are process-global; namespace them
(`billing.invoice`).

## ZEN_HOOK_PHASE_UNKNOWN

A hook is registered for a phase that does not exist — a typo like `onReqest`
(the diagnostic suggests the phase you meant) — or an application phase such as
`onReady` is declared in a route's or collection's `hooks: { … }`, where it could
never fire. Register application phases with `app.hook()`.

## ZEN_HOOK_PHASE_UNAVAILABLE

A hook is registered for a phase this build cannot fire (§9.7). Today that is
only `onRegister`: plugin order is resolved before any hook exists, so the hook
would always be too late. Refused rather than silently ignored.

## ZEN_TIMEOUT_INVALID

A `timeout` is not a duration (`'30s'`, `'250ms'`, a number of milliseconds), or
is zero. To refuse an inherited deadline, use `timeout: false`.

## ZEN_HEALTH_CHECK_INVALID

A health check has an unusable name (empty, or containing whitespace), a probe
that is not a function, or a non-positive budget. There is deliberately no
unbounded probe.

## ZEN_HEALTH_CHECK_DUPLICATE

Two health checks share a name. Both owners are named; namespace one of them.

## ZEN_HEALTH_CHECK_MISSING

`healthPlugin({ checks: ['db'] })` requires a check nothing registered. The list
is an assertion, not a filter: a dependency nobody probes must not look healthy.

## ZEN_DI_MISSING

A service is resolved, or depended on, with no provider registered. The
diagnostic suggests a similarly named token.

## ZEN_DI_CYCLE

Services depend on each other in a cycle. The path is printed.

## ZEN_DI_LIFETIME

A singleton depends on a request-scoped service — the captive-dependency bug,
where the singleton keeps the first request's instance forever. Make the
singleton scoped, or resolve the scoped service per request.

## ZEN_SCHEMA_UNCONVERTIBLE

A schema could not be converted to JSON Schema, so the parts of Zen that read
shape — the response serializer, coercion, OpenAPI — cannot. As an error: a
`jsonSchema()` shape was used to *validate* a request source. As a warning:
request schemas coercion could not read. Register a converter with
`registerSchemaConverter(vendor, fn)`.

## ZEN_MEDIA_TYPE_INVALID

A response media type in a variant declaration is not `type/subtype`, carries a
parameter, is a wildcard, or is declared twice (§13.4.4). Each case has its own `fix:`.

## ZEN_MEDIA_TYPE_UNSUPPORTED

A declared response media type has no encoder, or its encoder refused the schema.
Register one before `ready()`: `registerMediaEncoder('text/csv', factory)`.

## ZEN_NEGOTIATION_INCONSISTENT

Two statuses on one route offer different media types, or the same ones in a
different order (§13.4.2). `Accept` is matched once, before the status exists,
so the offer list belongs to the route.

## ZEN_CONFIG_INVALID

A configuration value is unusable: a `defineConfig` thunk threw while computing
from the environment, a plugin's configuration has the wrong shape, an option
such as `trustProxy` is out of range — or a collection's `when` (§6.2) threw, or
answered with something other than a boolean. A promise is always truthy and so
is the string `'false'`, so either would turn on a subtree its author meant to
turn off; `when` must decide synchronously, with a boolean.

## ZEN_RESPONSE_WRITE_ONLY

A response schema declares a property `writeOnly: true` — JSON Schema's "may be
sent, never returned" — so the compiled serializer would return it (§13.3). The
configuration store reads the same keyword as a secret marker (§16.2); a
response cannot treat it as an ordinary field. The message names the route, the
status, the media type and the JSON path. Remove the property from the response
schema, or use a separate request schema: `writeOnly` belongs on what a client
*sends*.

`format: 'password'` in a response schema is the same report as a warning,
under this code: it is OpenAPI's "do not display", which is weaker than "never
returned", and a hash field might legitimately carry it. The check covers
negotiated representations too, so a CSV export cannot carry either.

## ZEN_REGEX_UNSAFE

A warning, in development: a regular expression in an application parameter
type's `test` can backtrack without bound — a quantified group that contains
another quantifier (`(a+)+`, `(a*)*`), or alternatives under a quantifier that
can match the same character (`(a|aa)+`) — so a crafted path segment makes the
matcher spend exponential time (§19.3). `test` runs on every request that
reaches the segment. Rewrite it so each repetition starts with a character the
repeated part cannot match (`[a-z0-9]+(?:-[a-z0-9]+)*`), or bound the length
before the expression runs. The framework's own sources are held to the same
rule in CI (`scripts/check-regex.ts`).

## ZEN_ENV_INVALID

An environment variable is missing or was rejected by the `env` schema (§16.2).
One diagnostic per variable, naming the constraint, the `.env` file and line the
value came from, and the plugins that read it. A secret's value is never printed.

## ZEN_CAPABILITY_UNAVAILABLE

Something needs a capability the runtime lacks — a plugin's `requires`, or
`listen()` with no adapter configured. `requires` is checked against the
adapter's own `caps` (an explicit `zen({ caps })` wins): `{ fs: true }` asks for
a capability, and a string asks for that exact one — `{ websocket: 'native' }`.

## ZEN_APP_FROZEN

A route, hook or plugin was registered after `ready()` or `listen()`. Everything
is registered first; the request path is compiled once.

## ZEN_APP_NOT_READY

`dispatch` or `graph()` was used before `ready()`.

## ZEN_INSPECT_DISABLED

`app.generatedSource()` was called on an app that keeps no generated source.
Build it with `inspect: true`, or `dev: true`, where the source is wanted — a
test, a benchmark, a script that prints it. Since `0.1.0-alpha.5` an app keeps
its compiled units only when asked: they used to be held for the life of the
process, which at 10,000 routes is megabytes of strings nothing reads after
boot. Refused rather than answered with an empty list, because an empty list is
also what "nothing was compiled for this" looks like.

## ZEN_BOOT_FAILED

The aggregate: `ready()` found one or more problems and did not start. The
message lists every one of them.

---

## Request time

## ZEN_BAD_REQUEST

**400.** The request is malformed in a way that is not about its body — an
invalid `Host` header, so `ctx.url` cannot be built (RFC 9112 §3.2). Thrown as
`BadRequest`, which carried `ZEN_BODY_INVALID` until `0.1.0-alpha.4`.

## ZEN_VALIDATION

**400 or 422.** The request failed its schemas. `errors` lists every issue across
every source that failed — params, query, headers, cookies, body — each with its
`source`, `path` and `message`, so one round trip tells the client everything
that is wrong (§4.2 stage 7). 422 when only the body failed (well-formed, but
invalid); 400 when anything in the URL or headers did.

## ZEN_BODY_TOO_LARGE

**413.** The body exceeded the route's limit (1 MB by default), or a form body had
more fields than `body.maxFields` (1000). Enforced while reading, not after
buffering.

## ZEN_URI_TOO_LONG

**414.** The request target is longer than the Node adapter's `maxUrlLength`
(8 KB by default). Answered by the adapter before dispatch, so no hook runs and
nothing is logged, and the connection is closed. The document carries `type`,
`title`, `status` and `code` only: no `instance`, which would repeat the target
being refused, and no `requestId`, because no request was ever made of it.

The target also counts toward `maxHeaderSize` (8 KB), and a request past that is
refused by Node itself, with 431 and no body. So with both defaults a target
long enough for this is a 431 first; this is the limit that still holds once
`maxHeaderSize` is raised for large cookies.

## ZEN_BODY_INVALID

**400.** The body could not be parsed — invalid JSON — or nests deeper than
`body.maxDepth` (32). Thrown as `BodyInvalid`.

## ZEN_UNPROCESSABLE_ENTITY

**422.** Thrown as `UnprocessableEntity`: the request was well-formed and
understood, and refused on its meaning. A schema failure is `ZEN_VALIDATION`,
which carries the issues; this is the one a handler throws itself.

## ZEN_UNSUPPORTED_MEDIA_TYPE

**415.** No parser is registered for the request's `Content-Type`. `errors.available`
lists the ones that are.

## ZEN_NOT_ACCEPTABLE

**406.** No representation the route declares matches `Accept` (§13.4).
`errors.available` lists what the route can produce.

## ZEN_METHOD_NOT_ALLOWED

**405.** The path matched and the method did not. The `Allow` header lists the
methods that would.

## ZEN_NOT_FOUND

**404.** No route matched — or a handler threw `NotFound`, or a file response
named a file that does not exist or escapes its `root`.

## ZEN_TIMEOUT

**408 or 504.** The request's deadline expired (§4.4). 408 when it expired during
body intake (the client was slow), 504 after it (the time was the server's).
A request abandoned because the client disconnected is answered **499** with no
body, and has no code: there is nobody left to read one.

An `AbortError` a handler lets escape is a 408 only when it is the request's
*own* abort — its error *is* `ctx.signal.reason`, or carries it as its `cause`,
as `fetch(url, { signal: ctx.signal })` does. Any other abort was the
application's: `ZEN_INTERNAL`, or `ZEN_SERVICE_UNAVAILABLE` when it was an
upstream timing out (`AbortSignal.timeout`).

## ZEN_RATE_LIMITED

**429.** The rate limit was exceeded. `Retry-After` and the `RateLimit` headers
say when to try again.

## ZEN_CSRF

**403.** Reserved for CSRF verification (§19.7). Not produced yet.

## ZEN_UNAUTHORIZED

**401.** Authentication is missing or invalid — thrown as `Unauthorized`.

## ZEN_FORBIDDEN

**403.** Authenticated, not permitted — thrown as `Forbidden`.

## ZEN_CONFLICT

**409.** Thrown as `Conflict` — the request conflicts with the current state.

## ZEN_SLOT_EMPTY

**500.** A slot was read before anything set it. The message names the slot and
the route. Set it in a middleware or hook that runs earlier, or declare it
`{ optional: true }` or `{ default: … }`.

## ZEN_SERIALIZATION

**500.** A response did not satisfy its declared schema — a required field was
missing, or (in strict mode) a value had the wrong type. Never exposed: the
client sees a generic 500, and the path is in the logs and, in development, in
`debug`.

## ZEN_HEADER_INVALID

**500.** A header could not be written: its name is not a token, or its value
holds a character no header can carry — a line break, another control character,
anything past U+00FF — or a cookie's name, `Domain` or `Path` holds a `;`, or an
SSE `event`/`id` a line break. Refused rather than silently stripped (§19.5), and
refused where it was set: `ctx.res.header()` and `ctx.res.cookie()` throw, so the
failure is an ordinary error in the handler that staged it.

Encode a value for the header it goes in — a URL with `encodeURI()`, a download
name as `filename*=UTF-8''${encodeURIComponent(name)}`. A redirect target past
ASCII is percent-encoded for you.

## ZEN_HTML_UNSAFE

**500.** HTML the framework could not vouch for (§19.5), for one of these reasons:

- `ctx.html()` was given something other than `SafeHtml` — a string, say.
  Build the page with the `html` template tag, which escapes what it
  interpolates — ``ctx.html(html`<p>${text}</p>`)`` — or mark markup that is
  already safe, such as a template engine's output, with `unsafeHtml(markup)`.
- An `html` template put a hole where no escaping makes a value safe: inside
  `<script>` or `<style>`, in an `on*` event handler, in `srcdoc`, in a tag or
  attribute name, in an unquoted attribute value, in a comment, in an SVG
  animation's `to`/`values`, in a `<meta http-equiv="refresh">`, or where it
  could choose the host a `<script src>`, `<base href>` or `<form action>`
  loads from or posts to. The message names the hole and the text before it.
  The template is refused on its first render, whatever the values.
- `html` was called as a function rather than as a tagged template, or an
  `html` template ends inside a tag, a comment or a `<script>`, or leaves a
  `<textarea>`, a `<title>`, a `<noscript>`, an `<svg>` or a `<math>` open.
- The template means one thing to HTML and another to SVG (§19.5.1): a text
  element's end tag — `</noscript`, `</title`, `</textarea`… — inside an
  attribute value, a comment or a tag, where HTML still ends the element; a
  `<style>`, or a `<script>` inside `<svg>` or `<math>`, whose text holds a `<`
  that SVG reads as markup; a CDATA section holding a `>` before its `]]>`.
- A fragment was refused where it was nested: inside a text element, one that
  holds the element's end tag or ends part-way into it; inside `<svg>` or
  `<math>`, one holding a `<script>` whose code only HTML reads as code. Pass the
  value as a string, which is escaped, or keep that script out of the SVG.

Never exposed: the client sees a generic 500, and the message is in the logs.

## ZEN_REDIRECT_EXTERNAL

**500.** `ctx.redirect()` would have sent the client off this origin, to an
origin the application did not allow (§19.5) — the open redirect, refused.
A path, a query or a fragment is always allowed; anything with a scheme or an
authority (`https://…`, `//…`, and the spellings browsers treat the same way,
such as `/\evil.example`) must have its origin listed in
`zen({ redirect: { allowExternal: ['https://accounts.example'] } })`.

When the target came from the request, validate it and fall back:
`ctx.redirect(isLocalUrl(next) ? next : '/')`. For a target the application
built entirely itself, `ctx.redirect(url, { allowExternal: true })` skips the
check for that one call. Never exposed, and no `Location` header is sent.

A link to one of the application's own routes needs neither: `app.url()`
always returns a path on this origin.

## ZEN_ROUTE_UNKNOWN

**500.** `app.url()` — or a collection's or a plugin's `url()` — named a route
that nothing registered under that name (§5.7). The message suggests the name
you probably meant. Only named routes can be linked to: give the route a name —
`app.get('/notes/:id<int>', { name: 'notes.show' }, …)` — and pass the name, not
the path. Never exposed.

## ZEN_PARAM_MISMATCH

**500.** The parameters given to `app.url()` cannot build a URL the named route
answers (§5.7):

- a parameter the path needs was not given, or one it does not have was — query
  values go in the third argument, `url(name, params, query)`;
- a value its parameter's type refuses (`'4.2'` for `:id<int>`), or one no URL
  can carry: an empty value, `.` or `..` (a browser resolves those, percent-encoded
  or not, before it sends the request), an object, `NaN`, an invalid `Date`, or a
  string that is not well-formed Unicode;
- a wildcard with an empty segment — a leading, trailing or doubled `/` — or a
  piece of its list form that holds a `/`;
- an optional parameter given while one before it was left out;
- a path another route outranks: `/users/:id` given `me`, beside a
  `GET /users/me` (§5.6). The message names the route that would have answered;
- a query the parser would drop or reshape: a `__proto__`, `constructor` or
  `prototype` key, a nested object, a comma-list element that holds a comma or
  starts or ends with a space, or more pairs than `maxQueryParams` lets a
  request carry.

Thrown where `url()` is called, so a bad link fails in the handler that built
it — in the first test that renders it — rather than for whoever clicks it.
The message names the parameter, its type and the length of what it was given,
never the value itself: a link is where a reset token or a signed id lives, and
this message is logged. Never exposed.

The same code is a **boot error** for a `params` schema that disagrees with its
path template (§5.2) — `params: z.object({ userId })` on `/users/:id`, which
would have answered every request 400 — with the parameter it was probably
meant to be. Also an error: a path parameter the schema refuses
(`additionalProperties: false`), and a required key only an optional segment
supplies. A path parameter the schema does not declare is a warning (the schema
drops it), and an integer schema reading an untyped segment is reported once,
at boot, as information: `:id<int>` would refuse a non-number at the matcher.
The check reads the schema through its JSON Schema; one that cannot be
converted is not checked here.

## ZEN_REPLY_SENT

**500.** `ctx.res` was written after the reply went to egress (§7.3) — from an
`onResponse` hook, from a stream's producer, or from a handler still running
behind a deadline that has already answered. Staged metadata is applied once, at
egress, and a header written after that could never reach the client; it used to
be accepted and discarded without a word. Stage it before the handler returns;
work that belongs after the response is an `onResponse` hook, which observes the
reply and cannot change it. Never exposed.

## ZEN_CONTEXT_ESCAPED

Reserved (§18.5): a pooled context used after release. Context pooling is not built.

## ZEN_HANDLER_NO_RETURN

**500.** A handler returned `undefined`. Return a value, a reply, or
`ctx.empty()` for a 204.

## ZEN_SERVICE_UNAVAILABLE

**503.** The service cannot answer now. Thrown as `ServiceUnavailable` — which
carried `ZEN_INTERNAL` until `0.1.0-alpha.4`, so a 503 thrown on purpose looked
like a bug — and produced for an upstream call that gave up on its own timeout:
a `TimeoutError` (`AbortSignal.timeout`), or an `AbortError` caused by one.
That one is `retryable`, so it carries `Retry-After`. Never exposed.

## ZEN_INTERNAL

**500.** An unclassified error — anything thrown that is not a `ZenError`,
including an `AbortError` the application caused that is neither the request's
own abort nor a timeout. Its message is never exposed; the `requestId` in the
problem document is how to find the full error in the logs.

---

## OpenAPI

Reported by `@erenthedeveloper0/zen-openapi` while building the document at boot. They
are warnings unless the plugin runs with `strict: true`, which turns them into
boot errors.

## ZEN_OAS_RESPONSE_UNDECLARED

A route declares no response schema, so its payload is undocumented — and also
unfiltered on the way out. Add `response: { 200: Schema }`.

## ZEN_OAS_SCHEMA_UNCONVERTIBLE

A request body schema could not be converted to JSON Schema, so the document
describes it as unconstrained. Register a converter.

## ZEN_OAS_PARAMS_NOT_OBJECT

A query, header or cookie schema is not a plain object at its root — a `$ref` or
a union — so it cannot be split into parameters.

## ZEN_OAS_PARAM_TYPE_UNDOCUMENTED

A path parameter's type has no `jsonSchema`, so it is documented as a plain
string. Add a `jsonSchema` to the `paramType`.

## ZEN_OAS_METHOD_UNMAPPED

A route's method has no OpenAPI equivalent and was omitted from the document.

## ZEN_OAS_OPERATION_COLLISION

Two routes produce the same method and path — usually an optional parameter
expanding onto a path another route owns. The second was dropped.

## ZEN_OAS_OPERATION_ID_COLLISION

Two operations would share an `operationId`; the second was renamed. Give the
route an explicit `name` — generated clients name their methods after it.

## ZEN_OAS_ANONYMOUS_SHARED

An unnamed schema is used by several operations and was named automatically.
Give it a `title` or `$id` so client type names stay stable across releases.

## ZEN_OAS_TITLE_COLLISION

Two different schemas share a title; one was published under another name.

## ZEN_OAS_REF_UNRESOLVED

A `$ref` could not be resolved. Only same-document references
(`#/$defs/Name`, `#/definitions/Name`) are supported.

## ZEN_OAS_REF_CYCLE

A circular `$ref` outside `$defs`. Move the recursive schema into `$defs` so it
can be hoisted into `components.schemas`.

## ZEN_OAS_ALLOF_UNMERGED

An `allOf` member is not an object schema, so the document keeps the `allOf`
rather than merging it.

## ZEN_OAS_META_INVALID

A plugin's `openapi.*` metadata could not be used. A plugin declares security
schemes with `app.meta('openapi.securitySchemes', { name: scheme })`, and the
generator merges them into `components.securitySchemes`. This is reported for
an `openapi.` field the generator does not read (with the one it probably
meant), for a value that is not a record of schemes, and for a scheme name two
plugins declare differently, where the first declaration is kept. The
application's own `securitySchemes` option wins any name it declares.

---

## Router warnings

## ZEN_ROUTE_SHADOWED_BY_WILDCARD

A route is more specific than a wildcard route on the same prefix, and wins over
it. Usually what you want; reported so a wildcard that never matches some paths
is not a surprise.

## ZEN_ROUTE_TYPES_UNDECIDED

Two routes differ only in the parameter types at one position, and boot cannot
establish whether a value satisfies both — typically two application types
registered with `app.paramType()` and no `jsonSchema.examples`. A value both
accept is served by the type whose name sorts first, the same on every boot.
Add `examples` to each type's `jsonSchema` (the OpenAPI document publishes them
too) so the overlap can be checked, or make a segment static.
