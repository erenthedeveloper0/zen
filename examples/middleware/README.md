# `examples/middleware` — a browser-facing API

The example that could not be written before the first-party pack landed. A
small notes API with the four things a public, browser-called service needs —
CORS, security headers, a request id and a rate limit — and six lines that
supply all of them.

```bash
npm run example:middleware
npm run explain -w @erenthedeveloper0/zen-example-middleware
npm test -w @erenthedeveloper0/zen-example-middleware
```

---

## The six lines

```ts
app.use(securityHeaders())
app.use(cors())
app.use(rateLimit())
app.use(requestId({ trustHeader: false }))
```

`cors()` takes no argument. It reads `config.cors.origin`, which
`src/config/zen.config.ts` derives from `CORS_ORIGINS` — so "which origins can
talk to production?" is answered by an environment variable with a layer and a
named source behind it, and `npm run explain` prints the file and the line.

That is new this pass, and it is new because this example needed it. §16.2 has
always resolved and validated the environment *before* any plugin's `setup`
runs; there was simply no seam to read the result through. `Registrar.config`
is that seam, and it is three lines in `packages/core/src/api/zen.ts`.

---

## Six things worth running

### 1. The preflight, including the one to a path that does not exist

```bash
curl -si -X OPTIONS localhost:3000/api/nothing-here \
     -H 'Origin: http://localhost:5173' \
     -H 'Access-Control-Request-Method: POST' | head -6
```

`204`, with the allow headers. A browser sends `OPTIONS /api/notes` before any
cross-origin `POST`, and almost no application registers an `OPTIONS` route — so
the request matches nothing, and in every framework where CORS is `app.use()`-ed
middleware the pipeline does not exist and the middleware never runs.

Measured on this codebase, over a matched `GET`, an unmatched path and a
preflight: a `.use()` middleware ran **1 of 3** times; a global `onRequest` hook
ran **3 of 3**. That is why every member of this pack is a plugin registering a
hook, and `packages/middleware/test/pack.test.ts` asserts the counts rather than
describing them.

### 2. The failures

```bash
curl -si localhost:3000/api/notes/999 -H 'Origin: http://localhost:5173' | head -12
```

The 404 carries `Access-Control-Allow-Origin`, `X-Content-Type-Options` and
`X-Request-Id`. So do the 422, the 401 and the 429.

This is the half that middleware cannot do. §4.6 says the error path never
re-enters user middleware, and an unmatched request has no middleware chain at
all — so an `after` middleware fills in the 200 and leaves every failure bare.
A browser then reports each of them as a *CORS* error rather than as the status
it actually is, which is why "our API works in Postman but not in the browser"
is usually a 500 nobody can see.

The pack stages through `ctx.res` instead (§13.6). Staged metadata is applied by
`prepareForWire` at egress, which is downstream of success, error, timeout and
unmatched alike, so one rule covers all of them: **the pack never writes a
reply's headers.**

### 3. The rate limiter seeing what the router does not

```bash
for i in $(seq 1 65); do curl -s -o /dev/null -w '%{http_code} ' localhost:3000/nope; done; echo
```

404s until the budget runs out, then 429s. §9.2: *"a rate limiter that only sees
matched routes is bypassed by requesting a path that does not exist."*

Two details are deliberate and both are tested. The 429 carries the CORS
headers, because a browser shown a 429 without them reports a CORS failure and
the investigation starts in the file that is correct. And a preflight is **not**
counted, because a browser sends one per request until its cache warms, and
charging for them would silently halve the budget in the documentation.

### 4. Where the allowlist came from

```bash
npm run explain -w @erenthedeveloper0/zen-example-middleware
```

Five sections. The first prints the resolved chain for `GET /api/notes` —
registered in `app.ts` as security, CORS, limit, id, and running as id,
security, CORS, limit, because the pack orders itself through §10.5's
`before`/`after` hints rather than trusting the call site. The fourth prints a
matrix of which responses carry which headers, which is the table this whole
design exists to fill in.

### 5. Pages that print what users wrote, and a `?next=` that stays home

The notes are user content — whatever somebody `POST`ed — so the page that
renders one is the textbook stored-XSS case, and `/login?next=…` is the
textbook open redirect. `src/features/pages/routes.ts` has both, and neither
needs the application to remember anything
([§19.5](../../ARCHITECTURE.md#195-injection-and-pollution-defences)):

```bash
curl -s -X POST localhost:3000/api/notes -H 'content-type: application/json' \
     -d '{"title":"<script>alert(1)</script>","body":"hi"}'
curl -s localhost:3000/notes/4 | grep '<h1>'                    # <h1>&lt;script&gt;…</h1>
curl -s 'localhost:3000/notes/1?from=javascript:alert(1)' | grep Back   # href="about:invalid#zen-unsafe-url"
curl -si 'localhost:3000/login?next=//evil.example' | grep -i location # /notes/1 — the fallback
curl -si localhost:3000/login/sso | grep -i location            # https://id.notes.example/…
```

The page is an `html` template, so the title and body are escaped for where
they sit, and the back link — a URL from the query string in an `href` — has its
`javascript:` replaced rather than escaped, because escaping it changes nothing.
`/login` checks `next` with `isLocalUrl` and falls back to a page; if it had not,
`ctx.redirect()` would have refused `//evil.example` itself, with a 500 and no
`Location`. And `/login/sso` reaches the identity provider only because `app.ts`
says `redirect: { allowExternal: ['https://id.notes.example'] }` — one line, in
the file a reviewer reads.

The page also carries `nosniff` and the rest of `securityHeaders()`: the pack
stages its headers on every response, and a page is one more response.

### 6. Links the application makes itself

```bash
curl -si -X POST localhost:3000/api/notes -H 'content-type: application/json' \
     -d '{"title":"linked","body":"here"}' | grep -i location   # /api/notes/5
curl -s localhost:3000/notes/1 | grep 'As JSON'                     # href="/api/notes/1"
```

The `201` says where the note now lives, and the page links to its JSON — and
neither path is written out: both are `notes.url('notes.get', { id })`, asked
of the route that serves it ([§5.7](../../ARCHITECTURE.md#57-url-generation)).
The value is encoded as one segment, checked by `:id<int>`, and matched by the
router before it is returned, so a link that would 404 or reach another route
fails here, in the handler. It is a path on this origin by construction, which
is also why it is the `/login` fallback: `ctx.redirect()` sends it without
consulting the allowlist.

---

## What the example does not do, and why

- **It rate-limits its own health probes.** The limit is per client IP and the
  orchestrator is a client. A real deployment passes `rateLimit({ key })` and
  returns `null` for the prober — that is the documented exemption, and it is
  one line. It is left in here because a test asserting what actually happens is
  worth more than an example that quietly avoids the question.
- **It does not trust an inbound `X-Request-Id`.** `trustHeader: false` is the
  default and is written explicitly so the decision is visible. Turning it on
  is a §19.4-shaped trust decision: the value lands in every log line for the
  request, so even when trusted it must survive an 8–128 character
  `[A-Za-z0-9._-]` check.
- **It reads `.env.example` as its lowest layer**, and a real service must not.
  `.env` and `.env.*` are gitignored, as they should be, so this is what keeps
  the example runnable from a fresh clone. `src/config/sources.ts` says so.
- **No compression, no static files.** Both need a platform — `node:zlib`,
  `node:fs` — so they are not in `@erenthedeveloper0/zen-middleware` at all. §14.1 already puts
  compression on the adapter boundary as a capability, which is the right home
  for it.

---

## Layout

```
src/
  app.ts                  the composition root — the six lines, and why
  main.ts                 `npm run example:middleware`, with the curl sequence
  inspect.ts              `npm run explain` — five questions, answered off the graph
  config/
    zen.config.ts         CORS_ORIGINS → config.cors.origin, with a schema
    sources.ts            the fifteen host lines that read .env files (§3.2)
    types.ts              AppConfig, derived from the definition
  features/notes/         routes, schemas, service — none of which mention CORS; a 201 with its Location
  features/pages/         the same notes as HTML, with html`…` and links from url(); the ?next= redirect
  shared/zod.ts           one schema converter, read by four subsystems
test/
  middleware.test.ts      the composition, plus the type-level claims
```
