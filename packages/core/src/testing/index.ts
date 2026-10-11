import type { RawRequest } from '../contracts/adapter.ts'
import type { Context, RouteInfo } from '../contracts/context.ts'
import type { ProviderSpec, Token } from '../contracts/container.ts'
import type { HttpMethod, RemoteInfo } from '../contracts/http.ts'
import type { Logger } from '../contracts/logger.ts'
import type { RouteId } from '../contracts/route.ts'
import type { Slot } from '../contracts/slot.ts'
import type { InjectedResponse } from '../api/zen.ts'
import { PlainContext, type ContextEnv } from '../runtime/context.ts'
import { NoopLogger } from '../runtime/logger.ts'
import { SAME_ORIGIN_ONLY } from '../runtime/redirect.ts'
import { ZenContainer } from '../di/container.ts'
import { slotCount } from '../registry/slot-registry.ts'
import { generateRequestId } from '../primitives/id.ts'

/**
 * `@erenthedeveloper0/zen-core/testing` — rfcs/0001 §15.5, §20.2, §20.3.
 *
 * Three tools, each the shortest honest route to one kind of test:
 *
 *   - {@link createTestApp} builds the real application with some services
 *     replaced *before* it compiles, so the application under test is compiled
 *     with the fakes and behaves as production does in every other respect.
 *   - {@link testContext} builds a context with no application behind it, for
 *     calling a handler as the function it is.
 *   - {@link assertNoLeaks} closes an application and fails if it left
 *     anything running — the check the framework makes about itself (§20.7),
 *     as one an application can make about itself.
 *
 * A subpath of `zen-core` rather than a package of its own: a test kit that
 * could be a version behind the core it drives would be testing something
 * else.
 */

// ─────────────────────────────────────────────────────────────────────────────
// createTestApp
// ─────────────────────────────────────────────────────────────────────────────

/** What replaces a service — the two forms `app.provide` takes. */
export type Replacement<T> = ProviderSpec<T> | ((...deps: never[]) => T | Promise<T>)

/**
 * `[[Db, () => memoryDb()], [Clock, () => fixedClock(…)]]`, each replacement
 * checked against its own token: a fake `Db` that returns the wrong shape is a
 * compile error, not a passing test of something else.
 */
export type Overrides<O extends readonly unknown[]> = {
  readonly [K in keyof O]: readonly [Token<O[K]>, Replacement<Inferred<O[K]>>]
}

/**
 * `T`, read only from the token. Without it the replacement's return type is a
 * second inference site, and a fake of the wrong shape would widen `T` to a
 * union both satisfy. (`NoInfer`, spelt so that TypeScript 5.0 reads it.)
 */
type Inferred<T> = [T][T extends unknown ? 0 : never]

export interface TestAppOptions<O extends readonly unknown[] = readonly unknown[]> {
  /**
   * Services to replace — §15.5. Each wins over every `provide()` of its token,
   * the application's and the ones a plugin makes as it boots, and is in place
   * before anything compiles.
   */
  readonly override?: Overrides<O> | undefined
  /**
   * Configuration that beats every other source — §16.1's override layer,
   * where a test's values belong: a test that cannot beat the developer's own
   * `.env.local` is a test that passes on one machine.
   */
  readonly config?: Readonly<Record<string, unknown>> | undefined
  /**
   * How {@link assertNoLeaks} counts what is running. Node's
   * `process.getActiveResourcesInfo()` by default; a runtime without it passes
   * its own, or a leak check says it cannot run.
   */
  readonly resources?: ResourceProbe | undefined
}

/** The live resources of the process, one entry per resource, by type. */
export type ResourceProbe = () => readonly string[]

/** What `inject()` takes — see `ZenApp.inject`. */
export interface TestRequestInit {
  readonly headers?: Record<string, string> | undefined
  readonly body?: unknown
  readonly signal?: AbortSignal | undefined
  readonly remote?: RemoteInfo | undefined
}

/** The part of an application `createTestApp` drives. `zen()` and `createApp()` both return one. */
export interface TestableApp {
  overrideProvider<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T)): unknown
  overrideConfig(values: Readonly<Record<string, unknown>>): unknown
  ready(): Promise<unknown>
  inject(method: string, url: string, init?: TestRequestInit): Promise<InjectedResponse>
  close(reason?: string): Promise<void>
}

/** An application under test, booted, with a method per verb. */
export interface TestApp<A> {
  readonly app: A
  inject(method: string, url: string, init?: TestRequestInit): Promise<InjectedResponse>
  get(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  post(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  put(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  patch(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  delete(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  head(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  options(url: string, init?: TestRequestInit): Promise<InjectedResponse>
  /** The application's shutdown sequence (§4.5): drain, `onClose`, dispose services. */
  close(): Promise<void>
}

/**
 * Build the application, replace services, boot it — §15.5, §20.2.
 *
 *     const t = await createTestApp(makeApp, { override: [[Db, () => memoryDb()]] })
 *     const res = await t.get('/users/1')
 *
 * `make` is the application's own factory, and it returns the application
 * *unbooted*: a replacement applied after compilation would be a mock, and the
 * point is that there are none. A factory that already called `ready()` is
 * refused by the first replacement with `ZEN_APP_FROZEN`.
 */
export async function createTestApp<A extends TestableApp, const O extends readonly unknown[] = readonly []>(
  make: () => A | Promise<A>,
  options: TestAppOptions<O> = {},
): Promise<TestApp<A>> {
  const probe = options.resources ?? defaultProbe()
  const baseline = probe === null ? null : count(probe())
  const app = await make()
  for (const entry of (options.override ?? []) as ReadonlyArray<readonly [Token<unknown>, Replacement<unknown>]>) {
    app.overrideProvider(entry[0], entry[1] as ProviderSpec<unknown>)
  }
  if (options.config !== undefined) app.overrideConfig(options.config)
  await app.ready()
  const harness = new Harness(app)
  HARNESSES.set(harness, { probe, baseline })
  return harness
}

/** What `assertNoLeaks` needs from the `createTestApp` that built a harness — kept off its surface. */
const HARNESSES = new WeakMap<object, { readonly probe: ResourceProbe | null; readonly baseline: ReadonlyMap<string, number> | null }>()

class Harness<A extends TestableApp> implements TestApp<A> {
  readonly app: A
  #closed: Promise<void> | null = null

  constructor(app: A) {
    this.app = app
  }

  inject(method: string, url: string, init: TestRequestInit = {}): Promise<InjectedResponse> {
    return this.app.inject(method, url, init)
  }

  get(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('GET', url, init) }
  post(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('POST', url, init) }
  put(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('PUT', url, init) }
  patch(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('PATCH', url, init) }
  delete(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('DELETE', url, init) }
  head(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('HEAD', url, init) }
  options(url: string, init?: TestRequestInit): Promise<InjectedResponse> { return this.inject('OPTIONS', url, init) }

  close(): Promise<void> {
    // Once: `assertNoLeaks` closes too, and a test's own `after` hook may.
    return (this.#closed ??= this.app.close('test'))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// assertNoLeaks
// ─────────────────────────────────────────────────────────────────────────────

export interface LeakCheckOptions {
  /** How long resources may take to close after shutdown. 1000 ms. */
  readonly within?: number | undefined
}

/**
 * Close the application and fail if anything it opened is still running — a
 * timer, a socket, a server — compared with what was running when
 * {@link createTestApp} built it.
 *
 * Only growth counts, and only once `within` has passed: resources close on
 * later turns of the event loop, and a check that sampled at once would report
 * the socket that was in the middle of closing.
 */
export async function assertNoLeaks(target: TestApp<unknown>, options: LeakCheckOptions = {}): Promise<void> {
  const known = HARNESSES.get(target)
  await target.close()
  if (known === undefined) {
    throw new TypeError('assertNoLeaks: pass the TestApp that createTestApp() returned.')
  }
  const { probe, baseline } = known
  if (probe === null || baseline === null) {
    throw new Error(
      'assertNoLeaks: this runtime has no way to count live resources. ' +
        'Pass createTestApp(make, { resources: () => [...] }) with a probe for it.',
    )
  }

  const until = Date.now() + (options.within ?? 1000)
  let extra = grown(baseline, count(probe()))
  while (extra.size > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    extra = grown(baseline, count(probe()))
  }
  if (extra.size > 0) {
    const list = [...extra].map(([type, n]) => `${n} × ${type}`).join(', ')
    throw new Error(
      `assertNoLeaks: the application left ${list} running after close(). ` +
        'A timer, socket or server that outlives the application is a process that will not exit (§20.7).',
    )
  }
}

function defaultProbe(): ResourceProbe | null {
  const host = (globalThis as { process?: { getActiveResourcesInfo?: () => string[] } }).process
  const info = host?.getActiveResourcesInfo
  return typeof info === 'function' ? () => info.call(host) : null
}

function count(resources: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const type of resources) out.set(type, (out.get(type) ?? 0) + 1)
  return out
}

function grown(baseline: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): Map<string, number> {
  const extra = new Map<string, number>()
  for (const [type, n] of now) {
    const more = n - (baseline.get(type) ?? 0)
    if (more > 0) extra.set(type, more)
  }
  return extra
}

// ─────────────────────────────────────────────────────────────────────────────
// testContext
// ─────────────────────────────────────────────────────────────────────────────

export interface TestContextInit {
  readonly method?: HttpMethod | undefined
  /** The request target, query string included. `/` by default. */
  readonly url?: string | undefined
  /** `ctx.params`, as validation would have left them — already typed. */
  readonly params?: Readonly<Record<string, unknown>> | undefined
  /** `ctx.query`, already validated. Parsed from `url` when absent. */
  readonly query?: Readonly<Record<string, unknown>> | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** `ctx.cookies`, already validated. Parsed from a `cookie` header when absent. */
  readonly cookies?: Readonly<Record<string, unknown>> | undefined
  /** `ctx.body`, already validated. */
  readonly body?: unknown
  /** Slot values, set before the handler runs — `[[CurrentUser, alice]]`. */
  readonly slots?: Iterable<readonly [Slot<never>, unknown]> | undefined
  /** Services `ctx.resolve()` finds — the same pairs `createTestApp`'s `override` takes. */
  readonly services?: Iterable<readonly [Token<never>, Replacement<never>]> | undefined
  /** `ctx.config`. */
  readonly config?: Readonly<Record<string, unknown>> | undefined
  /**
   * What a plugin would have decorated the context with — `{ user: alice }`. A
   * test of a handler that reads `ctx.user` should not need the plugin that
   * puts it there.
   */
  readonly decorations?: Readonly<Record<string, unknown>> | undefined
  readonly route?: Partial<RouteInfo> | undefined
  readonly signal?: AbortSignal | undefined
  readonly logger?: Logger | undefined
  readonly remote?: RemoteInfo | undefined
}

/**
 * A context with no application behind it — §20.3.
 *
 *     const ctx = testContext({ params: { id: 1 }, slots: [[CurrentUser, alice]] })
 *     const reply = await showUser(ctx)
 *
 * A `PlainContext`, the interpreted twin that *is* the definition of a Zen
 * context (§7.6), so a handler sees what it would see in production:
 * `ctx.json()` returns a reply, `ctx.get(slot)` throws `ZEN_SLOT_EMPTY` for a
 * slot nobody set, `ctx.res` stages headers. What it has none of is what a
 * pipeline would have done — validation, hooks, middleware — which is what
 * {@link createTestApp} is for. The values given are taken as validated, and
 * the type is the one the call site asks for: `C` is not checked against
 * them.
 */
export function testContext<C = Context>(init: TestContextInit = {}): C {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value
  const method = init.method ?? 'GET'
  const raw: RawRequest = {
    method,
    url: init.url ?? '/',
    header: (name) => headers[name],
    headerNames: () => Object.keys(headers),
    body: {
      kind: 'none',
      length: 0,
      read: () => Promise.resolve(new Uint8Array(0)),
      stream: async function* () { /* no body */ },
    },
    remote: init.remote ?? { address: '127.0.0.1', port: 0, family: 'IPv4' },
    native: null,
  }

  const container = new ZenContainer()
  for (const [token, spec] of init.services ?? []) container.provide(token as Token<unknown>, spec as unknown as ProviderSpec<unknown>)

  const env: ContextEnv = {
    log: init.logger ?? new NoopLogger(),
    maxQueryParams: 100,
    trustProxy: false,
    container,
    config: Object.freeze({ ...(init.config ?? {}) }),
    redirect: SAME_ORIGIN_ONLY,
  }

  const route: RouteInfo | null = init.route === undefined
    ? null
    : {
        id: (init.route.id ?? `${init.route.method ?? method} ${init.route.path ?? '/'}`) as RouteId,
        name: init.route.name,
        method: init.route.method ?? method,
        path: init.route.path ?? '/',
        meta: init.route.meta ?? new Map(),
      }

  const ctx = new PlainContext(raw, route, { ...(init.params ?? {}) }, env, slotCount(), init.signal ?? new AbortController().signal)
  ctx.id = generateRequestId()
  ctx.startTime = performance.now()
  if (init.query !== undefined) ctx.$query = init.query as never
  if (init.cookies !== undefined) ctx.$cookies = init.cookies as never
  if (init.body !== undefined) ctx.$body = init.body
  for (const [slot, value] of init.slots ?? []) ctx.set(slot as unknown as Slot<unknown>, value)
  for (const [name, value] of Object.entries(init.decorations ?? {})) {
    Object.defineProperty(ctx, name, { value, enumerable: true, configurable: false, writable: false })
  }
  return ctx as unknown as C
}

// ─────────────────────────────────────────────────────────────────────────────
// fixedClock
// ─────────────────────────────────────────────────────────────────────────────

/** A clock a test controls — what `override: [[Clock, () => fixedClock(…)]]` installs. */
export interface TestClock {
  /** Epoch milliseconds. */
  now(): number
  date(): Date
  /** Move the clock forward. */
  advance(ms: number): void
  set(at: string | number | Date): void
}

/**
 * A clock that moves only when the test says so — §15.5's example override.
 *
 * Zen does not own the application's notion of time: a service that needs
 * "now" takes a clock the application provides, and a test replaces it like
 * any other service. This is the replacement.
 */
export function fixedClock(at: string | number | Date = 0): TestClock {
  let current = toEpoch(at)
  return {
    now: () => current,
    date: () => new Date(current),
    advance(ms) { current += ms },
    set(next) { current = toEpoch(next) },
  }
}

function toEpoch(at: string | number | Date): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(ms)) throw new RangeError(`fixedClock: "${String(at)}" is not a date`)
  return ms
}
