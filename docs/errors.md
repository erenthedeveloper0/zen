# Error codes

Every error Zen reports carries a stable `code`. Codes are public API and are
covered by semver (RFC 0001, I7): clients switch on codes, humans read messages,
and messages may change while codes may not.

Each code below is also a link target. A problem document's `type` and a boot
diagnostic's `docs:` line both point here —
`https://github.com/VisionPilot/Zen.js/blob/main/docs/errors.md#zen_not_found` —
and a test asserts that every code the framework can produce has an entry.

- [Boot and registration](#boot-and-registration) — reported by `ready()`, aggregated, before any traffic
- [Request time](#request-time) — the `code` of a problem document (RFC 9457)
- [OpenAPI](#openapi) — `@visionpilot/zen-openapi`'s document diagnostics
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

## ZEN_PARAM_MISMATCH

Reserved (§5.2): a `params` schema whose keys disagree with the path template.
Not produced yet.

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

A plugin's options were rejected, or its `setup` threw. The plugin's own `hint`
and `consequence`, when it supplies them, are printed as `fix:` and `also:`;
plugins that depend on it are named as skipped.

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
from the environment, a plugin's configuration has the wrong shape, or an option
such as `trustProxy` is out of range.

## ZEN_ENV_INVALID

An environment variable is missing or was rejected by the `env` schema (§16.2).
One diagnostic per variable, naming the constraint, the `.env` file and line the
value came from, and the plugins that read it. A secret's value is never printed.

## ZEN_CAPABILITY_UNAVAILABLE

Something needs a capability the runtime lacks — a plugin's `requires`, or
`listen()` with no adapter configured.

## ZEN_APP_FROZEN

A route, hook or plugin was registered after `ready()` or `listen()`. Everything
is registered first; the request path is compiled once.

## ZEN_APP_NOT_READY

`dispatch` or `graph()` was used before `ready()`.

## ZEN_BOOT_FAILED

The aggregate: `ready()` found one or more problems and did not start. The
message lists every one of them.

---

## Request time

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

## ZEN_BODY_INVALID

**400.** The body could not be parsed — invalid JSON — or nests deeper than
`body.maxDepth` (32).

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

**500.** A response header, a cookie attribute, or an SSE `event`/`id` contained
a character that would end it early — CR, LF, NUL, or `;` in a cookie attribute.
Refused rather than silently stripped (§19.5).

## ZEN_REPLY_SENT

Reserved (§7.3): modifying staged response metadata after egress. Not produced yet.

## ZEN_CONTEXT_ESCAPED

Reserved (§18.5): a pooled context used after release. Context pooling is not built.

## ZEN_HANDLER_NO_RETURN

**500.** A handler returned `undefined`. Return a value, a reply, or
`ctx.empty()` for a 204.

## ZEN_INTERNAL

**500.** An unclassified error — anything thrown that is not a `ZenError`. Its
message is never exposed; the `requestId` in the problem document is how to
find the full error in the logs.

---

## OpenAPI

Reported by `@visionpilot/zen-openapi` while building the document at boot. They
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
