import type {
  Container, DiDiagnostic, Lifetime, ProviderRecord, ProviderSpec, ScopeCarrier, Token,
} from '../contracts/container.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { allocateCell } from '../registry/slot-registry.ts'
import { intrinsicDisposer, trackDisposal, type DisposalCarrier } from '../primitives/disposal.ts'
import { closest } from '../primitives/nearest.ts'
import type { SourceOrigin } from '../primitives/origin.ts'

/**
 * Declare a typed service identifier.
 *
 * Interfaces are first-class citizens — `token<Logger>('logger')` works, whereas
 * class-based DI cannot inject an interface at all.
 *
 * `{ optional: true }` declares a service the application may not provide —
 * §15.2. Resolving it without a provider is `undefined`, and nothing that
 * depends on it is refused at boot for its absence. The type says so: the
 * token's value is `T | undefined`, so the code that reads it has to decide.
 */
export function token<T>(name: string, options: { readonly optional: true }): Token<T | undefined>
export function token<T>(name: string, options?: { readonly optional?: false | undefined }): Token<T>
export function token<T>(name: string, options: { readonly optional?: boolean | undefined } = {}): Token<T> {
  const index = allocateCell(`service:${name}`, 'service')
  return options.optional === true ? { name, index, optional: true } : { name, index }
}

interface Entry<T> {
  readonly token: Token<T>
  readonly deps: readonly Token<unknown>[]
  readonly factory: (...deps: never[]) => T | Promise<T>
  readonly lifetime: Lifetime
  readonly dispose: ((value: T) => void | Promise<void>) | undefined
  readonly eager: boolean
  readonly origin: SourceOrigin | undefined
  instance: T | undefined
  resolved: boolean
  /**
   * A singleton whose async factory is still running.
   *
   * Without it, two requests that both arrive before the first build finishes
   * each call the factory — two connection pools behind one "singleton", each
   * request holding a different one — and the dispose list gains the entry
   * twice, so shutdown disposed the second instance twice and never the first.
   */
  pending: Promise<T> | null
}

const UNRESOLVED = Symbol('zen.unresolved')

export class ZenContainer implements Container {
  #entries = new Map<Token<unknown>, Entry<unknown>>()
  /** Singletons to release at shutdown, oldest first, each with how to release it. */
  #disposeOrder: Array<{ readonly entry: Entry<unknown>; readonly dispose: (value: never) => void | Promise<void> }> = []
  #resolving = new Set<Token<unknown>>()
  /** Tokens a test replaced — see `override`. */
  #overridden = new Set<Token<unknown>>()

  provide<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T), origin?: SourceOrigin): void {
    // A test's replacement wins over every provider, whenever it registers —
    // a plugin's `setup` providing the real service at boot included (§15.5).
    if (this.#overridden.has(token as Token<unknown>)) return
    this.#set(token, spec, origin)
  }

  /**
   * Replace a service for a test — §15.5. Sticky: a `provide()` of the same
   * token afterwards, by the application or by a plugin as it boots, is
   * ignored, so the fake is the one the application is compiled with whatever
   * order the two were registered in.
   */
  override<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T), origin?: SourceOrigin): void {
    this.#overridden.add(token as Token<unknown>)
    this.#set(token, spec, origin)
  }

  #set<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T), origin: SourceOrigin | undefined): void {
    const normalised: ProviderSpec<T> = typeof spec === 'function' ? { factory: spec } : spec
    this.#entries.set(token as Token<unknown>, {
      token: token as Token<unknown>,
      deps: (normalised.deps ?? []) as readonly Token<unknown>[],
      factory: normalised.factory as (...deps: never[]) => unknown,
      lifetime: normalised.lifetime ?? 'singleton',
      dispose: normalised.dispose as ((value: unknown) => void | Promise<void>) | undefined,
      eager: normalised.eager ?? false,
      origin,
      instance: undefined,
      resolved: false,
      pending: null,
    })
  }

  has(token: Token<unknown>): boolean {
    return this.#entries.has(token)
  }

  get providers(): readonly ProviderRecord[] {
    return [...this.#entries.values()].map((e) => ({
      token: e.token,
      deps: e.deps,
      lifetime: e.lifetime,
      eager: e.eager,
      origin: e.origin,
    }))
  }

  resolve<T>(token: Token<T>, scope?: ScopeCarrier): T {
    const value = this.#resolve(token as Token<unknown>, scope, false)
    if (isPromise(value)) {
      throw new ZenError(
        Codes.INTERNAL,
        `Service "${token.name}" has an async factory; use ctx.resolveAsync() or mark it eager so it is built at boot.`,
        { status: 500, expose: false },
      )
    }
    return value as T
  }

  async resolveAsync<T>(token: Token<T>, scope?: ScopeCarrier): Promise<T> {
    return (await this.#resolve(token as Token<unknown>, scope, true)) as T
  }

  /**
   * @internal — `resolve`, except that an asynchronous build comes back as its
   * promise instead of being refused. What §15.1's per-request injection uses,
   * so a service that builds synchronously costs no promise to inject.
   */
  resolveEither<T>(token: Token<T>, scope?: ScopeCarrier): T | Promise<T> {
    return this.#resolve(token as Token<unknown>, scope, true) as T | Promise<T>
  }

  #resolve(token: Token<unknown>, scope: ScopeCarrier | undefined, allowAsync: boolean): unknown {
    const entry = this.#entries.get(token)
    if (entry === undefined) {
      if (token.optional === true) return undefined
      throw new ZenError(
        Codes.DI_MISSING,
        `No provider registered for service "${token.name}". ` +
          `Register one with app.provide(${token.name}, …) before ready().`,
        { status: 500, expose: false },
      )
    }

    if (entry.lifetime === 'singleton') {
      if (entry.resolved) return entry.instance
      // Single-flight: a build already under way is joined, never repeated.
      if (entry.pending !== null) return entry.pending
    }

    if (entry.lifetime === 'scoped') {
      if (scope === undefined) {
        throw new ZenError(
          Codes.DI_LIFETIME,
          `Service "${token.name}" is request-scoped and cannot be resolved outside a request.`,
          { status: 500, expose: false },
        )
      }
      const cached = scope.$s[token.index]
      if (cached !== undefined) return cached
    }

    // Runtime cycle guard. `analyze()` catches these at boot; this is the
    // backstop for containers built dynamically in tests.
    if (this.#resolving.has(token)) {
      throw new ZenError(
        Codes.DI_CYCLE,
        `Circular dependency while resolving "${token.name}".`,
        { status: 500, expose: false },
      )
    }
    this.#resolving.add(token)

    try {
      const deps = entry.deps.map((dep) => this.#resolve(dep, scope, allowAsync))
      const anyAsync = deps.some(isPromise)

      if (anyAsync) {
        if (!allowAsync) {
          throw new ZenError(
            Codes.INTERNAL,
            `Service "${token.name}" depends on an async provider; use resolveAsync().`,
            { status: 500, expose: false },
          )
        }
        return this.#inFlight(
          entry,
          scope,
          Promise.all(deps).then((settled) => entry.factory(...(settled as never[]))),
        )
      }

      const produced = entry.factory(...(deps as never[]))
      return isPromise(produced) ? this.#inFlight(entry, scope, produced) : this.#store(entry, produced, scope)
    } finally {
      this.#resolving.delete(token)
    }
  }

  /**
   * An async build, published where the next caller will find it *before*
   * anything is awaited — that ordering is the whole of single-flight.
   *
   * A singleton publishes on its entry; a scoped service in its own cell of the
   * request's slot array, so two `resolveAsync` calls inside one request share
   * one instance exactly as two synchronous ones always did.
   */
  #inFlight(entry: Entry<unknown>, scope: ScopeCarrier | undefined, build: Promise<unknown>): Promise<unknown> {
    const index = entry.token.index
    const settled: Promise<unknown> = build.then(
      (value) => {
        if (entry.lifetime === 'singleton') entry.pending = null
        return this.#store(entry, value, scope)
      },
      (error: unknown) => {
        // A failed build is not cached. The next caller tries again, which is
        // what a database that was briefly unreachable at first use needs.
        if (entry.lifetime === 'singleton') entry.pending = null
        else if (entry.lifetime === 'scoped' && scope !== undefined && scope.$s[index] === settled) {
          scope.$s[index] = undefined
        }
        throw error
      },
    )
    if (entry.lifetime === 'singleton') entry.pending = settled
    else if (entry.lifetime === 'scoped' && scope !== undefined) scope.$s[index] = settled
    return settled
  }

  #store(entry: Entry<unknown>, value: unknown, scope: ScopeCarrier | undefined): unknown {
    // §15.3 — "Disposal integrates with the explicit resource management
    // proposal where available": a value implementing `Symbol.asyncDispose` or
    // `Symbol.dispose` is released through it when the provider declared no
    // `dispose` of its own. An explicit `dispose` always wins.
    if (entry.lifetime === 'singleton') {
      // Queued for disposal once, on the transition to resolved — never per
      // call, or shutdown disposes one instance twice.
      if (!entry.resolved) {
        const dispose = entry.dispose ?? intrinsicDisposer(value)
        if (dispose !== undefined) this.#disposeOrder.push({ entry, dispose })
      }
      entry.instance = value
      entry.resolved = true
    } else if (entry.lifetime === 'scoped' && scope !== undefined) {
      scope.$s[entry.token.index] = value
      // §15.3: "scoped — disposed at stage 10, reverse creation order". The
      // `dispose` option used to be accepted here and never called, so a
      // per-request transaction or pooled connection was simply dropped —
      // released only when the pool itself noticed, if ever.
      const dispose = entry.dispose ?? intrinsicDisposer(value)
      if (dispose !== undefined && scope.$disposers !== undefined) {
        trackDisposal(scope as DisposalCarrier, entry.token.name, dispose, value)
      }
    }
    return value
  }

  /**
   * Boot-time graph validation — §15.4.
   *
   * The lifetime check is the one that matters most: a singleton depending on a
   * scoped service is the classic captive-dependency bug (the singleton captures
   * the *first* request's tenant forever). It should be impossible to ship, so
   * it is an error rather than a runtime surprise.
   */
  analyze(): readonly DiDiagnostic[] {
    const diagnostics: DiDiagnostic[] = []

    for (const entry of this.#entries.values()) {
      for (const dep of entry.deps) {
        if (!this.#entries.has(dep) && dep.optional !== true) {
          diagnostics.push({
            severity: 'error',
            code: Codes.DI_MISSING,
            message: `Service "${entry.token.name}" depends on "${dep.name}", which has no provider.`,
            hint: this.#suggest(dep.name),
            ...originsOf(entry),
          })
        }
      }
    }

    const WHITE = 0, GREY = 1, BLACK = 2
    const colour = new Map<Token<unknown>, number>()
    const stack: string[] = []

    const visit = (token: Token<unknown>): void => {
      const entry = this.#entries.get(token)
      if (entry === undefined) return
      const state = colour.get(token) ?? WHITE
      if (state === BLACK) return
      if (state === GREY) {
        const start = stack.indexOf(token.name)
        const cycle = [...stack.slice(start === -1 ? 0 : start), token.name]
        diagnostics.push({
          severity: 'error',
          code: Codes.DI_CYCLE,
          message: `Circular service dependency: ${cycle.join(' → ')}`,
          hint: 'Break the cycle by introducing an interface token, or resolve one side lazily inside the factory.',
          ...originsOf(...stack.slice(start === -1 ? 0 : start).map((name) => this.#byName(name)), entry),
        })
        return
      }

      colour.set(token, GREY)
      stack.push(token.name)
      for (const dep of entry.deps) {
        visit(dep)
        const depEntry = this.#entries.get(dep)
        if (depEntry !== undefined && entry.lifetime === 'singleton' && depEntry.lifetime === 'scoped') {
          diagnostics.push({
            severity: 'error',
            code: Codes.DI_LIFETIME,
            message:
              `Singleton "${entry.token.name}" depends on request-scoped "${dep.name}". ` +
              `The singleton would capture the first request's instance forever.`,
            hint: `Make "${entry.token.name}" scoped, or resolve "${dep.name}" per request inside the handler.`,
            ...originsOf(entry, depEntry),
          })
        }
      }
      stack.pop()
      colour.set(token, BLACK)
    }

    for (const token of this.#entries.keys()) visit(token)
    return diagnostics
  }

  /** Instantiate eager singletons; called once, at boot. */
  async warm(): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.eager && entry.lifetime === 'singleton') {
        await this.resolveAsync(entry.token)
      }
    }
  }

  /**
   * Dispose singletons in reverse creation order — §4.5 step 5.
   *
   * Every disposer runs even when an earlier one throws. A pool whose `end()`
   * rejects must not leave the cache client and the message consumer behind it
   * open, which is what stopping at the first failure did. The failures are
   * reported together afterwards, as one `AggregateError`.
   */
  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (let i = this.#disposeOrder.length - 1; i >= 0; i--) {
      const queued = this.#disposeOrder[i]
      if (queued === undefined) continue
      const { entry, dispose } = queued
      try {
        await dispose(entry.instance as never)
      } catch (error) {
        failures.push(error)
      }
      entry.resolved = false
      entry.instance = undefined
    }
    this.#disposeOrder.length = 0
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} service(s) failed to dispose`)
    }
  }

  /**
   * §15.4's "the nearest similarly-named registered token" — through
   * `closest`, the one definition of "close" every other suggestion in the
   * framework uses. This looked for the name's first four letters anywhere in
   * another, so a typo in those four (`bdtoken`) was told nothing, and a
   * missing `cache` was offered whichever token first contained `cach`.
   */
  #byName(name: string): Entry<unknown> | undefined {
    for (const entry of this.#entries.values()) if (entry.token.name === name) return entry
    return undefined
  }

  #suggest(name: string): string | undefined {
    const close = closest(name, [...this.#entries.keys()].map((t) => t.name))
    return close === null ? undefined : `Did you mean "${close}"?`
  }
}

/** The `provide()` sites of the entries a diagnostic is about, once each. */
function originsOf(...entries: ReadonlyArray<Entry<unknown> | undefined>): { origins?: SourceOrigin[] } {
  const origins: SourceOrigin[] = []
  for (const entry of entries) {
    if (entry?.origin !== undefined && !origins.includes(entry.origin)) origins.push(entry.origin)
  }
  return origins.length === 0 ? {} : { origins }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function'
}

export { UNRESOLVED }
