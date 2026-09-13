import type {
  Container, DiDiagnostic, Lifetime, ProviderRecord, ProviderSpec, ScopeCarrier, Token,
} from '../contracts/container.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { allocateCell } from '../api/slot.ts'

/**
 * Declare a typed service identifier.
 *
 * Interfaces are first-class citizens — `token<Logger>('logger')` works, whereas
 * class-based DI cannot inject an interface at all.
 */
export function token<T>(name: string): Token<T> {
  return { name, index: allocateCell(`service:${name}`, 'service') }
}

interface Entry<T> {
  readonly token: Token<T>
  readonly deps: readonly Token<unknown>[]
  readonly factory: (...deps: never[]) => T | Promise<T>
  readonly lifetime: Lifetime
  readonly dispose: ((value: T) => void | Promise<void>) | undefined
  readonly eager: boolean
  instance: T | undefined
  resolved: boolean
}

const UNRESOLVED = Symbol('zen.unresolved')

export class ZenContainer implements Container {
  #entries = new Map<Token<unknown>, Entry<unknown>>()
  #disposeOrder: Array<Entry<unknown>> = []
  #resolving = new Set<Token<unknown>>()

  provide<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T)): void {
    const normalised: ProviderSpec<T> = typeof spec === 'function' ? { factory: spec } : spec
    this.#entries.set(token as Token<unknown>, {
      token: token as Token<unknown>,
      deps: (normalised.deps ?? []) as readonly Token<unknown>[],
      factory: normalised.factory as (...deps: never[]) => unknown,
      lifetime: normalised.lifetime ?? 'singleton',
      dispose: normalised.dispose as ((value: unknown) => void | Promise<void>) | undefined,
      eager: normalised.eager ?? false,
      instance: undefined,
      resolved: false,
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

  #resolve(token: Token<unknown>, scope: ScopeCarrier | undefined, allowAsync: boolean): unknown {
    const entry = this.#entries.get(token)
    if (entry === undefined) {
      throw new ZenError(
        Codes.DI_MISSING,
        `No provider registered for service "${token.name}". ` +
          `Register one with app.provide(${token.name}, …) before ready().`,
        { status: 500, expose: false },
      )
    }

    if (entry.lifetime === 'singleton' && entry.resolved) return entry.instance

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
        return Promise.all(deps).then((settled) =>
          this.#finish(entry, entry.factory(...(settled as never[])), scope),
        )
      }

      return this.#finish(entry, entry.factory(...(deps as never[])), scope)
    } finally {
      this.#resolving.delete(token)
    }
  }

  #finish(entry: Entry<unknown>, produced: unknown, scope: ScopeCarrier | undefined): unknown {
    if (isPromise(produced)) {
      return produced.then((value) => this.#store(entry, value, scope))
    }
    return this.#store(entry, produced, scope)
  }

  #store(entry: Entry<unknown>, value: unknown, scope: ScopeCarrier | undefined): unknown {
    if (entry.lifetime === 'singleton') {
      entry.instance = value
      entry.resolved = true
      if (entry.dispose !== undefined) this.#disposeOrder.push(entry)
    } else if (entry.lifetime === 'scoped' && scope !== undefined) {
      scope.$s[entry.token.index] = value
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
        if (!this.#entries.has(dep)) {
          diagnostics.push({
            severity: 'error',
            code: Codes.DI_MISSING,
            message: `Service "${entry.token.name}" depends on "${dep.name}", which has no provider.`,
            hint: this.#suggest(dep.name),
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

  /** Reverse dependency order — dependents tear down before their dependencies. */
  async dispose(): Promise<void> {
    for (let i = this.#disposeOrder.length - 1; i >= 0; i--) {
      const entry = this.#disposeOrder[i]
      if (entry?.dispose === undefined) continue
      await entry.dispose(entry.instance)
      entry.resolved = false
      entry.instance = undefined
    }
    this.#disposeOrder.length = 0
  }

  #suggest(name: string): string | undefined {
    const candidates = [...this.#entries.keys()].map((t) => t.name)
    const close = candidates.find((c) => c.toLowerCase().includes(name.toLowerCase().slice(0, 4)))
    return close === undefined ? undefined : `Did you mean "${close}"?`
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<unknown>).then === 'function'
}

export { UNRESOLVED }
