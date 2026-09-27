/**
 * Dependency injection — rfcs/0001 §15.
 *
 * Optional and unmagical. A large share of Node applications are well served by
 * module-scoped singletons, and a framework that forces a container on them has
 * made their life worse. Equally, applications with request-scoped tenancy or
 * per-request transactions genuinely benefit, and telling them "just use
 * closures" is how you get a homegrown container.
 *
 * No `reflect-metadata`, no decorators, no class-as-token — class tokens cannot
 * inject an interface without inventing a runtime artefact, and they break under
 * `isolatedModules` and bundler tree-shaking.
 */

import type { Disposal } from '../primitives/disposal.ts'

export type Lifetime = 'singleton' | 'scoped' | 'transient'

export interface Token<T> {
  readonly name: string
  /** Index into the context slot array; only meaningful for `scoped`. */
  readonly index: number
  /** Phantom type carrier. Never present at runtime. */
  readonly $type?: T
}

export interface ProviderSpec<T> {
  /**
   * Declared explicitly rather than reflected. This is what makes boot-time
   * cycle and lifetime analysis possible with no decorator metadata.
   */
  readonly deps?: readonly Token<never>[] | undefined
  readonly factory: (...deps: never[]) => T | Promise<T>
  readonly lifetime?: Lifetime | undefined
  readonly dispose?: ((value: T) => void | Promise<void>) | undefined
  /** Instantiate at boot rather than on first resolve. */
  readonly eager?: boolean | undefined
}

export interface ProviderRecord {
  readonly token: Token<unknown>
  readonly deps: readonly Token<unknown>[]
  readonly lifetime: Lifetime
  readonly eager: boolean
}

export interface DiDiagnostic {
  readonly severity: 'error' | 'warning'
  readonly code: string
  readonly message: string
  readonly hint?: string | undefined
}

/**
 * Per-request storage handed to the container by the dispatcher.
 *
 * `$disposers` is where a request-scoped instance with a `dispose` is queued
 * for release when the request settles (§15.3). Optional so that a container
 * can still be exercised with a bare `{ $s: [] }` in a test, where there is no
 * request to settle.
 */
export interface ScopeCarrier {
  readonly $s: unknown[]
  $disposers?: Disposal[] | null | undefined
}

export interface Container {
  provide<T>(token: Token<T>, spec: ProviderSpec<T> | ((...deps: never[]) => T)): void
  has(token: Token<unknown>): boolean
  resolve<T>(token: Token<T>, scope?: ScopeCarrier): T
  resolveAsync<T>(token: Token<T>, scope?: ScopeCarrier): Promise<T>
  /** Cycles, missing providers, captive dependencies. Run at boot. */
  analyze(): readonly DiDiagnostic[]
  readonly providers: readonly ProviderRecord[]
  dispose(): Promise<void>
}
