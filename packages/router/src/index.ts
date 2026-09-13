import type {
  CompiledRouter, MatchResult, ParamType, ParamsObject, RouteDiagnostic, RouteRecord, Router,
  RouterOptions, RouterStats, HttpMethod,
} from '@zenjs/core'
import { CodeGen, ZenError, Codes, DEFAULT_CAPABILITIES } from '@zenjs/core'
import { BUILTIN_PARAM_TYPES } from './param-types.ts'
import { analyzeRoutes } from './conflicts.ts'
import {
  createNode, insert, matchTrie, genericBuilder, countNodes,
  type RouteEntry, type TrieNode,
} from './trie.ts'
import { expandOptional } from './segments.ts'

export * from './segments.ts'
export * from './param-types.ts'
export { analyzeRoutes } from './conflicts.ts'
export type { TrieNode, RouteEntry } from './trie.ts'

export interface ZenRouterOptions extends RouterOptions {
  readonly codegen?: CodeGen | undefined
}

/**
 * The Zen router — rfcs/0001 §5, §12 (subsystem 12).
 *
 * Two engines behind one interface (I6):
 *
 *   - **compiled**: a static-path `Map` fast path (O(1), zero allocation) plus a
 *     backtracking trie walk, with a *generated fixed-shape params builder* per
 *     route. Building `{ id: 42, slug: 'x' }` from a generated object literal
 *     keeps the params object monomorphic; adding properties in a loop puts it
 *     in dictionary mode, which is optimisation R4.
 *   - **interpreted**: the same trie with a generic params builder. Used when
 *     `caps.eval === false`, and as the differential-testing reference.
 */
export class ZenRouter implements Router {
  readonly name = 'zen-radix'

  build(routes: readonly RouteRecord[], opts: ZenRouterOptions = {}): CompiledRouter {
    const paramTypes = mergeParamTypes(opts.paramTypes)
    const codegen = opts.codegen ?? new CodeGen({ caps: DEFAULT_CAPABILITIES })
    const useCodegen = (opts.compile ?? true) && codegen.enabled

    const root = createNode()
    /** §5.4 — static paths never touch the trie at match time. */
    const staticRoutes = new Map<string, Map<HttpMethod, RouteEntry>>()
    let staticCount = 0
    let dynamicCount = 0

    for (const route of routes) {
      for (const variant of expandOptional(route.segments)) {
        const entry = insert(root, route, variant, {
          paramTypes,
          onDuplicate: (existing, incoming) => {
            throw new ZenError(
              Codes.ROUTE_DUPLICATE,
              `Duplicate route ${incoming.method} ${incoming.path}` +
                (existing.origin ? ` (already registered at ${formatOrigin(existing.origin)})` : ''),
              { status: 500, expose: false },
            )
          },
          unknownParamType: (type, owner) => {
            throw new ZenError(
              Codes.PARAM_TYPE_UNKNOWN,
              `Unknown parameter type "<${type}>" in ${owner.method} ${owner.path}. ` +
                `Known types: ${[...paramTypes.keys()].join(', ')}. Register more with app.paramType().`,
              { status: 500, expose: false },
            )
          },
        })

        if (useCodegen && entry.paramNames.length > 0) {
          entry.build = compileParamsBuilder(entry, codegen)
        }

        if (variant.every((s) => s.kind === 'static')) {
          const path = '/' + variant.map((s) => s.value).join('/')
          const key = path === '/' ? '/' : path
          let table = staticRoutes.get(key)
          if (table === undefined) {
            table = new Map()
            staticRoutes.set(key, table)
          }
          table.set(route.method, entry)
          staticCount++
        } else {
          dynamicCount++
        }
      }
    }

    return new CompiledZenRouter(root, staticRoutes, {
      nodes: countNodes(root),
      staticRoutes: staticCount,
      dynamicRoutes: dynamicCount,
      engine: useCodegen ? 'compiled' : 'interpreted',
    }, paramTypes)
  }

  analyze(routes: readonly RouteRecord[], opts: ZenRouterOptions = {}): RouteDiagnostic[] {
    return analyzeRoutes(routes, { paramTypes: mergeParamTypes(opts.paramTypes) })
  }
}

class CompiledZenRouter implements CompiledRouter {
  readonly stats: RouterStats
  readonly source: string | undefined = undefined
  readonly paramTypes: ReadonlyMap<string, ParamType>
  #root: TrieNode
  #static: Map<string, Map<HttpMethod, RouteEntry>>

  constructor(
    root: TrieNode,
    staticRoutes: Map<string, Map<HttpMethod, RouteEntry>>,
    stats: RouterStats,
    paramTypes: ReadonlyMap<string, ParamType>,
  ) {
    this.#root = root
    this.#static = staticRoutes
    this.stats = stats
    this.paramTypes = paramTypes
  }

  match(method: string, path: string): MatchResult {
    // Fast path: exact static hit is one Map lookup and allocates nothing.
    const table = this.#static.get(path)
    if (table !== undefined) {
      const entry = table.get(method as HttpMethod)
      if (entry !== undefined) return { route: entry.route, params: EMPTY_PARAMS }
      if (method === 'HEAD') {
        const get = table.get('GET')
        if (get !== undefined) return { route: get.route, params: EMPTY_PARAMS }
      }
      // Fall through: a dynamic route may still match, and only if none does is
      // this genuinely a 405.
      const dynamic = matchTrie(this.#root, method, path)
      if (dynamic !== null && dynamic.route !== null) return dynamic
      return { route: null, allowed: [...table.keys()] }
    }

    return matchTrie(this.#root, method, path)
  }
}

const EMPTY_PARAMS: ParamsObject = Object.freeze({}) as ParamsObject

/**
 * R4 — generate a fixed-shape object literal instead of adding properties in a
 * loop. `{ id: t0.parse(v[0]), slug: v[1] }` gives every request for this route
 * a params object with the same hidden class.
 */
function compileParamsBuilder(entry: RouteEntry, codegen: CodeGen): (values: readonly string[]) => ParamsObject {
  const fields = entry.paramNames
    .map((name, i) => {
      const type = entry.paramTypes[i]
      const access = `v[${i}]`
      return type === null || type === undefined
        ? `${JSON.stringify(name)}: ${access}`
        : `${JSON.stringify(name)}: t[${i}].parse(${access})`
    })
    .join(', ')

  return codegen.materialise<(values: readonly string[]) => ParamsObject>(
    {
      name: `params:${entry.route.method}:${entry.route.path}`,
      source: `return function buildParams(v) { return { ${fields} } }`,
      externals: { t: entry.paramTypes },
    },
    () => genericBuilder(entry.paramNames, entry.paramTypes),
  )
}

function mergeParamTypes(extra?: ReadonlyMap<string, ParamType>): ReadonlyMap<string, ParamType> {
  if (extra === undefined || extra.size === 0) return BUILTIN_PARAM_TYPES
  const merged = new Map(BUILTIN_PARAM_TYPES)
  for (const [name, type] of extra) merged.set(name, type)
  return merged
}

function formatOrigin(origin: { file: string; line: number; column: number }): string {
  return `${origin.file}:${origin.line}:${origin.column}`
}

export const router: Router = new ZenRouter()
