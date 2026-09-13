import type { MatchResult, RouteRecord, ParamType, PathSegment } from './route.ts'

/**
 * The path-syntax seam (§3.5). Core needs `RouteRecord.segments` but must not
 * own the syntax — `ExpressPathSyntax` is a drop-in for migration.
 */
export interface PathParser {
  parse(path: string): { readonly path: string; readonly segments: readonly PathSegment[] }
}

export interface RouterOptions {
  readonly caseSensitive?: boolean | undefined
  readonly ignoreTrailingSlash?: boolean | undefined
  readonly paramTypes?: ReadonlyMap<string, ParamType> | undefined
  /** When false the interpreted twin is used regardless of capabilities (§20.5). */
  readonly compile?: boolean | undefined
}

export interface RouterStats {
  readonly nodes: number
  readonly staticRoutes: number
  readonly dynamicRoutes: number
  readonly engine: 'compiled' | 'interpreted'
}

export interface CompiledRouter {
  match(method: string, path: string): MatchResult
  readonly stats: RouterStats
  /** Present when compiled; enables `zen build` emission and source maps. */
  readonly source: string | undefined
  /**
   * The param-type registry this router was built with, builtins included.
   *
   * §5.2 promises that one `paramType` declaration serves three consumers: the
   * trie matcher, the parse function, and OpenAPI. The third one lives in a
   * package that must not depend on the router (§24.3), so the registry is
   * published here and carried on the frozen `AppGraph` — rather than
   * re-declared in `@zenjs/openapi`, which is how the two copies would drift.
   */
  readonly paramTypes: ReadonlyMap<string, ParamType>
}

/**
 * Every subsystem is an interface with at least two implementations (I6). For
 * the router those are `CompiledRadixRouter` and `InterpretedRadixRouter`, run
 * against each other by the differential fuzzer.
 */
export interface Router {
  readonly name: string
  build(routes: readonly RouteRecord[], opts?: RouterOptions): CompiledRouter
  analyze(routes: readonly RouteRecord[]): readonly RouteDiagnostic[]
}

export type DiagnosticSeverity = 'error' | 'warning'

export interface RouteDiagnostic {
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly message: string
  readonly routes: readonly RouteRecord[]
  readonly hint?: string | undefined
}
