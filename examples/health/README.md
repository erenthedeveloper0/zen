# examples/health

Liveness, readiness, and the drain window — [RFC 0001 §31.4](../../ARCHITECTURE.md#314-health-and-readiness), [§4.5](../../ARCHITECTURE.md#45-graceful-shutdown).

```bash
npm run example:health      # start it
npm run health:explain      # which dependencies are probed, and by whom
```

An orders API with three dependencies you can break from the command line, so
the interesting behaviour is something you watch rather than something you read.

---

## The one distinction the whole thing rests on

| | asks | answered from | getting it wrong |
| --- | --- | --- | --- |
| `/healthz` | *should the orchestrator restart me?* | process state, nothing else | restarts the fleet during a database outage |
| `/readyz` | *should the load balancer send me traffic?* | lifecycle state **and** dependencies | 502s on every rolling deploy |

Both failures are famous and they are one word apart in a YAML file. The
expensive one is the first: a liveness probe that checks the database says
"restart me" when the database is down — every pod says it at once, the
orchestrator obliges, and the fleet spends the outage crash-looping instead of
waiting. Restarting also guarantees the connection pools never get the chance
to reconnect.

So the default here is the safe one. `app.health(name, probe)` registers a
**readiness** check; reaching liveness takes an explicit `kind: 'liveness'`,
which is a thing a reviewer can see.

---

## Watch it work

```bash
curl -s localhost:3000/readyz | jq
```

```json
{
  "status": "pass",
  "state": "live",
  "probe": "readiness",
  "durationMs": 46.3,
  "checks": {
    "db":       { "status": "pass", "observedValue": 4.2,  "observedUnit": "ms", "cached": false },
    "cache":    { "status": "pass", "observedValue": 1.1,  "observedUnit": "ms", "cached": false, "critical": false },
    "payments": { "status": "pass", "observedValue": 45.9, "observedUnit": "ms", "cached": false, "output": "46ms" }
  },
  "service": "orders",
  "version": "dev"
}
```

That is `application/health+json` — [draft-inadarei-api-health-check][draft],
not a hand-rolled `{ ok: true }`, for the same reason errors are RFC 9457: an
existing format everything already understands.

### Break the database

```bash
curl -sX POST localhost:3000/control/db/down
curl -si localhost:3000/readyz  | head -1     # HTTP/1.1 503
curl -si localhost:3000/healthz | head -1     # HTTP/1.1 200
```

Out of the load balancer, not out of the fleet.

### Break the cache

```bash
curl -sX POST localhost:3000/control/db/ok
curl -sX POST localhost:3000/control/cache/down
curl -s localhost:3000/readyz | jq '.status, .checks.cache.status'
# "warn"
# "fail"
```

200, because `cache` is registered `critical: false`. The component is reported
honestly as `fail`; the *summary* degrades to `warn`. A cold cache is slower,
not broken, and taking the instance out of rotation would convert a latency
problem into an availability one.

This is the option that decides whether health checks get written at all. If
every check is load-bearing, adding one is a risk, so people stop — and the
endpoint stops describing the service.

### Make a dependency hang

```bash
curl -sX POST localhost:3000/control/payments/hang
time curl -s localhost:3000/readyz | jq '.checks.payments'
```

```json
{ "status": "fail", "observedValue": 600.4, "observedUnit": "ms",
  "output": "probe exceeded its 600ms budget", "cached": false }
```

**This is the failure hand-written health endpoints do not survive.** A
dependency that returns an error is easy. One that returns *nothing* makes the
endpoint stop answering, so the orchestrator's own probe times out and restarts
a process that was completely alive.

Two things stop it here, and both matter:

- Each check carries **its own budget**, so a wedged one cannot hold the report.
  The other components are still reported, and still correct — a single budget
  over the whole endpoint would produce one 504 and the least useful sentence
  available during an incident.
- The probe is handed a real **`AbortSignal`** ([§4.4](../../ARCHITECTURE.md#44-deadlines-cancellation-backpressure)),
  so it is *cancelled* rather than abandoned. A probe left running holds a
  connection open against a dependency that is, by definition, already having a
  bad day.

### Watch a shutdown

```bash
while true; do curl -s -o /dev/null -w '%{http_code} ' localhost:3000/readyz; sleep 0.5; done
```

…then `Ctrl-C` the server.

```
200 200 200 503 503 503 503 503 503 (connection refused)
```

Readiness goes red **immediately**, and the process keeps answering for the
whole drain window before the socket closes. That is §4.5 step 1, and it is
why this feature exists: a service that stops accepting connections and *then*
reports itself unready has already 502'd everything the load balancer sent in
between.

---

## The Kubernetes side

```yaml
livenessProbe:
  httpGet:  { path: /healthz, port: 3000 }
  periodSeconds: 10
  failureThreshold: 3          # 30s of being wedged before a restart

readinessProbe:
  httpGet:  { path: /readyz, port: 3000 }
  periodSeconds: 2
  failureThreshold: 2          # out of rotation ~4s after the first red

startupProbe:
  httpGet:  { path: /healthz, port: 3000 }
  periodSeconds: 3
  failureThreshold: 20         # 60s to boot, without liveness in the way
```

Then do the arithmetic that almost nobody does:

> `periodSeconds × failureThreshold` for **readiness** is the worst case before
> this pod leaves the endpoints list — **4 seconds** above. The drain delay must
> be longer than that, or the socket closes while traffic is still arriving.

`config.drainDelay` is `5000`. It should look thin, because in most deployments
this value is zero and the sum was never done at all.

Note the `startupProbe`. Liveness passes while `starting` for the same reason
readiness does not: a service that takes 40 seconds to warm a cache is not
ready, but it is very much alive, and a liveness probe that cannot tell the
difference means it never finishes booting.

---

## What is where

| file | what it demonstrates |
| --- | --- |
| `src/app.ts` | the composition root — the entire health policy in one file |
| `src/plugins/payments.ts` | a plugin that owns a connection **and its check** |
| `src/shared/dependencies.ts` | three fakes that fail in three different ways |
| `src/features/orders/` | the ordinary API readiness is gating |
| `src/inspect.ts` | the checks as a table, off the frozen `AppGraph` |
| `test/health.test.ts` | all of the above, through `inject()`, no cluster |

### The plugin owns the check

```ts
app.health('payments', async (signal) => {
  const { latencyMs } = await client.query(signal)
  return latencyMs > 200
    ? { status: 'warn', message: `degraded: ${latencyMs.toFixed(0)}ms` }
    : { status: 'pass', message: `${latencyMs.toFixed(0)}ms` }
}, { timeout: '600ms', description: 'third-party payment gateway' })
```

The application cannot write this check. It does not know what a cheap query
against someone else's client looks like, what counts as degraded, or what
budget is reasonable. So the plugin publishes the answer and the service's only
decision is whether to **require** it:

```ts
app.use(healthPlugin, { checks: ['db', 'payments'] })
```

`checks` is an assertion, not a filter. Delete the payments plugin and this app
refuses to boot:

```
ZEN_HEALTH_CHECK_MISSING  Readiness was configured to require "payments", but no
                          check was registered under that name.
    fix:  Register it with app.health(name, probe), or remove it from the
          plugin's `checks` list.
    also: Left unchecked, /readyz would answer 200 for a dependency nothing is
          actually probing.
```

Same principle as [§9.7](../../ARCHITECTURE.md#97-phases-this-build-cannot-fire):
a check that can never run must not be indistinguishable from one that passed.

---

## Two smaller things worth stealing

**Polling is free.** Results are cached for `ttl` (1s) and concurrent probes of
the same check share one in-flight promise. The orchestrator, the load balancer
and the metrics scraper all polling at once cost **one** round trip.
`benchmarks/health/run.ts` measures it: 500 simultaneous polls, 1 probe.

A failure is cached for the same TTL as a success. That is deliberate —
re-probing on every request while a dependency is down aims your full scrape
rate at the component least able to absorb it. The cost is that recovery is
visible up to one TTL late, which at one second is fine.

**Thrown errors do not reach the wire by default.** A message the probe
*returned* is always reported; a driver's exception is not, because `pg` says
`getaddrinfo ENOTFOUND db-primary.internal` and that is topology. This example
sets `details: true` because its endpoints are cluster-internal — the same rule
as [§13.3](../../ARCHITECTURE.md#133-the-compiled-json-serializer): what you
declared may ship, what you did not may not.

[draft]: https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check-06
