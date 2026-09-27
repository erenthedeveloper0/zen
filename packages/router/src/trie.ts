import type {
  HttpMethod, MatchResult, ParamType, ParamsObject, PathSegment, RouteRecord,
} from '@visionpilot/zen-core'
import { decodeComponent, splitSegments } from '@visionpilot/zen-core'

export interface RouteEntry {
  readonly route: RouteRecord
  readonly paramNames: readonly string[]
  readonly paramTypes: readonly (ParamType | null)[]
  /** Fixed-shape params builder. Generated per route when codegen is available. */
  build: (values: readonly string[]) => ParamsObject
}

export interface TrieNode {
  statics: Map<string, TrieNode> | null
  /**
   * Typed params, ordered by type name. Tried before the untyped param child.
   *
   * By name and not by insertion, because insertion order *is* registration
   * order, and §5.6's promise is that registration order never decides which
   * route answers. `/items/:id<int>` beside `/items/:key<slug>` used to send
   * `/items/42` to whichever was registered first — two files imported the
   * other way round served a different handler. Types that provably overlap
   * like that are now a boot error (`conflicts.ts`); this order is what decides
   * the pairs nothing can prove either way, and it is the same on every boot.
   */
  typed: Array<{ name: string; type: ParamType; node: TrieNode }> | null
  param: { name: string; node: TrieNode } | null
  wildcard: { name: string; node: TrieNode } | null
  methods: Map<HttpMethod, RouteEntry> | null
}

export function createNode(): TrieNode {
  return { statics: null, typed: null, param: null, wildcard: null, methods: null }
}

export interface InsertOptions {
  readonly paramTypes: ReadonlyMap<string, ParamType>
  readonly onDuplicate: (existing: RouteRecord, incoming: RouteRecord) => void
  readonly unknownParamType: (type: string, route: RouteRecord) => void
}

export function insert(
  root: TrieNode,
  route: RouteRecord,
  segments: readonly PathSegment[],
  opts: InsertOptions,
): RouteEntry {
  let node = root
  const paramNames: string[] = []
  const paramTypes: (ParamType | null)[] = []

  for (const segment of segments) {
    if (segment.kind === 'static') {
      node.statics ??= new Map()
      let child = node.statics.get(segment.value)
      if (child === undefined) {
        child = createNode()
        node.statics.set(segment.value, child)
      }
      node = child
      continue
    }

    if (segment.kind === 'wildcard') {
      if (node.wildcard === null) {
        node.wildcard = { name: segment.value, node: createNode() }
      }
      paramNames.push(segment.value)
      paramTypes.push(null)
      node = node.wildcard.node
      continue
    }

    // param
    paramNames.push(segment.value)

    if (segment.type !== undefined) {
      const type = opts.paramTypes.get(segment.type)
      if (type === undefined) {
        opts.unknownParamType(segment.type, route)
        paramTypes.push(null)
        node = ensurePlainParam(node, segment.value)
        continue
      }
      paramTypes.push(type)
      node.typed ??= []
      let child = node.typed.find((t) => t.type.name === type.name)
      if (child === undefined) {
        child = { name: segment.value, type, node: createNode() }
        node.typed.push(child)
        node.typed.sort((x, y) => (x.type.name < y.type.name ? -1 : x.type.name > y.type.name ? 1 : 0))
      }
      node = child.node
      continue
    }

    paramTypes.push(null)
    node = ensurePlainParam(node, segment.value)
  }

  const entry: RouteEntry = {
    route,
    paramNames,
    paramTypes,
    build: genericBuilder(paramNames, paramTypes),
  }

  node.methods ??= new Map()
  const existing = node.methods.get(route.method)
  if (existing !== undefined) {
    opts.onDuplicate(existing.route, route)
    return existing
  }
  node.methods.set(route.method, entry)
  return entry
}

function ensurePlainParam(node: TrieNode, name: string): TrieNode {
  if (node.param === null) node.param = { name, node: createNode() }
  return node.param.node
}

/** The interpreted builder — replaced per route by a generated one when possible. */
export function genericBuilder(
  names: readonly string[],
  types: readonly (ParamType | null)[],
): (values: readonly string[]) => ParamsObject {
  return (values) => {
    const out: ParamsObject = {}
    for (let i = 0; i < names.length; i++) {
      const raw = values[i]
      if (raw === undefined) continue
      const type = types[i]
      out[names[i] as string] = type === null || type === undefined ? raw : (type.parse(raw) as string)
    }
    return out
  }
}

/**
 * Depth-first match with backtracking, in the priority order of §5.6:
 *
 *     static > typed param > param > wildcard
 *
 * decided left-to-right *per segment*, not by whole-route score. Whole-route
 * scoring is what makes other routers' behaviour hard to predict. Registration
 * order is never a factor, so splitting routes across files can never change
 * behaviour — a property Express does not have.
 *
 * Backtracking matters: `/a/b` (static) and `/:x/c` both exist, and `/a/c` must
 * match the second. A greedy non-backtracking walk would 404.
 */
export function matchTrie(root: TrieNode, method: string, path: string): MatchResult {
  const segments = splitAndDecode(path)
  if (segments === null) return null

  const captures: string[] = []
  const allowed = new Set<HttpMethod>()

  const entry = walk(root, segments, 0, captures, method as HttpMethod, allowed)
  if (entry !== null) {
    return { route: entry.route, params: entry.build(captures) }
  }
  if (allowed.size > 0) {
    return { route: null, allowed: [...allowed] }
  }
  return null
}

function walk(
  node: TrieNode,
  segments: readonly string[],
  index: number,
  captures: string[],
  method: HttpMethod,
  allowed: Set<HttpMethod>,
): RouteEntry | null {
  if (index === segments.length) {
    const methods = node.methods
    if (methods !== null) {
      const entry = methods.get(method)
      if (entry !== undefined) return entry
      if (method === 'HEAD') {
        const get = methods.get('GET')
        if (get !== undefined) return get
      }
      addAllowed(methods, allowed)
    }
    return null
  }

  const segment = segments[index] as string

  // 1 — static
  if (node.statics !== null) {
    const child = node.statics.get(segment)
    if (child !== undefined) {
      const hit = walk(child, segments, index + 1, captures, method, allowed)
      if (hit !== null) return hit
    }
  }

  // 2 — typed params (matcher-enforced, so `/users/abc` cleanly 404s)
  if (node.typed !== null) {
    for (const typed of node.typed) {
      if (!typed.type.test(segment)) continue
      captures.push(segment)
      const hit = walk(typed.node, segments, index + 1, captures, method, allowed)
      if (hit !== null) return hit
      captures.pop()
    }
  }

  // 3 — untyped param
  if (node.param !== null) {
    captures.push(segment)
    const hit = walk(node.param.node, segments, index + 1, captures, method, allowed)
    if (hit !== null) return hit
    captures.pop()
  }

  // 4 — wildcard consumes the remainder
  if (node.wildcard !== null) {
    const methods = node.wildcard.node.methods
    if (methods !== null) {
      const rest = segments.slice(index).join('/')
      const entry = methods.get(method)
      if (entry !== undefined) {
        captures.push(rest)
        return entry
      }
      if (method === 'HEAD') {
        const get = methods.get('GET')
        if (get !== undefined) {
          captures.push(rest)
          return get
        }
      }
      addAllowed(methods, allowed)
    }
  }

  return null
}

/**
 * The methods a 405's `Allow` names for one node — including `HEAD` wherever a
 * `GET` exists, because the matcher serves it there (§4.2) and RFC 9110 §10.2.1
 * says `Allow` lists what the resource supports. The header used to omit it, so
 * a client following the 405's own advice never learned it could ask for
 * headers alone — while the CORS preflight, which reads the graph, said it could.
 */
export function addAllowed(methods: ReadonlyMap<HttpMethod, unknown>, allowed: Set<HttpMethod>): void {
  for (const m of methods.keys()) allowed.add(m)
  if (methods.has('GET')) allowed.add('HEAD')
}

/**
 * Split first, decode second. Decoding first would turn `%2F` into a separator
 * and let `/files/a%2F..%2Fetc` escape its route — a path-traversal class bug
 * that several frameworks have shipped.
 *
 * Percent-decoding only: `+` in a path is a plus. It is a space in form
 * encoding and nowhere else, and decoding it as one turned `/files/a+b%20c`
 * into `a b c` — but only when the segment also held a `%`, so the same file
 * name answered differently depending on an unrelated character.
 */
export function splitAndDecode(path: string): string[] | null {
  const raw = splitSegments(path)
  for (let i = 0; i < raw.length; i++) {
    const segment = raw[i] as string
    if (segment.indexOf('%') === -1) continue
    const decoded = decodeComponent(segment)
    if (decoded === null) return null
    raw[i] = decoded
  }
  return raw
}

export function countNodes(node: TrieNode): number {
  let n = 1
  if (node.statics !== null) for (const child of node.statics.values()) n += countNodes(child)
  if (node.typed !== null) for (const child of node.typed) n += countNodes(child.node)
  if (node.param !== null) n += countNodes(node.param.node)
  if (node.wildcard !== null) n += countNodes(node.wildcard.node)
  return n
}
