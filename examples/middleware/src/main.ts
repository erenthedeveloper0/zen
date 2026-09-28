import { makeApp } from './app.ts'

/**
 * `npm run example:middleware`
 *
 * Then, in another terminal. The sequence is the demonstration, and the first
 * two commands are the ones that do not work in any framework where CORS is
 * `app.use()`-ed middleware.
 *
 *   # 1. The preflight a browser sends before a cross-origin POST. Answered
 *   #    before routing, before intake, before the handler.
 *   curl -si -X OPTIONS localhost:3000/api/notes \
 *        -H 'Origin: http://localhost:5173' \
 *        -H 'Access-Control-Request-Method: POST' | head -12
 *
 *   # 2. The same preflight to a path that does not exist. Still answered —
 *   #    the request matched no route, so there is no pipeline and there would
 *   #    have been no middleware to run.
 *   curl -si -X OPTIONS localhost:3000/api/nothing-here \
 *        -H 'Origin: http://localhost:5173' \
 *        -H 'Access-Control-Request-Method: POST' | head -6
 *
 *   # 3. An origin that is not on the list gets a well-formed 204 and no CORS
 *   #    headers, so the browser denies. It is not told why: an allowlist that
 *   #    reports its contents is an allowlist you can enumerate.
 *   curl -si -X OPTIONS localhost:3000/api/notes \
 *        -H 'Origin: https://evil.example' \
 *        -H 'Access-Control-Request-Method: POST' | head -6
 *
 *   # 4. The headers are on the responses that fail, too — the ones an `after`
 *   #    middleware never sees (§4.6). Watch a 404 and a 422.
 *   curl -si localhost:3000/api/notes/999 -H 'Origin: http://localhost:5173' | head -12
 *   curl -si -X POST localhost:3000/api/notes -H 'Origin: http://localhost:5173' \
 *        -H 'Content-Type: application/json' -d '{"title":""}' | head -12
 *
 *   # 5. Rate limiting sees requests that match nothing, which is the whole
 *   #    point of §9.2: a limiter that only sees matched routes is bypassed by
 *   #    asking for a path that does not exist.
 *   for i in $(seq 1 65); do curl -s -o /dev/null -w '%{http_code} ' localhost:3000/nope; done; echo
 *
 *   # 6. …and the 429 carries CORS headers, so a browser reports it as a rate
 *   #    limit rather than as a CORS failure. That ordering is the pack's, not
 *   #    the order the plugins are registered in.
 *   curl -si localhost:3000/api/ping -H 'Origin: http://localhost:5173' | head -14
 *
 *   # 7. Where did the allowlist come from? Not a grep — a table.
 *   npm run explain -w @erenthedeveloper0/zen-example-middleware
 */
const { app } = makeApp()
const handle = await app.listen()

console.log(`
  listening on ${handle.url}

    GET    /api/notes          list, with ?page and ?perPage as numbers
    GET    /api/notes/:id      404s for an unknown id
    POST   /api/notes          422s for a bad body
    DELETE /api/notes/:id      401s without the admin token
    GET    /api/ping           something cheap to rate-limit
    GET    /healthz /readyz    liveness and readiness
    GET    /notes/:id          a note as a page — try one titled <script>
    GET    /login?next=…       follows next only if it stays on this origin
    GET    /login/sso          the one redirect allowed to leave

  allowed origins   ${(app.config.cors.origin as readonly string[]).join(', ')}
  rate limit        ${String(app.config.rateLimit.limit)} requests per ${String(app.config.rateLimit.window)}
  admin token       ${String(app.config.admin.token)}

  The admin token above is printed by the *application*, by name, and that is
  the distinction §16.2 draws: a value asked for by name is readable, and the
  same value inside any projection of the config object is not. Compare:

    npm run explain -w @erenthedeveloper0/zen-example-middleware

  where it is ${'*'.repeat(8)}.
`)
