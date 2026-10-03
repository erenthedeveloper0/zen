import type { CompiledRouter } from '../contracts/router.ts'
import type { ParamType, RouteRecord } from '../contracts/route.ts'
import type { UrlParams, UrlQuery } from '../contracts/url.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { closest } from '../primitives/nearest.ts'
import { isForbiddenKey } from './query.ts'

/**
 * URL generation — rfcs/0001 §5.7.
 *
 *     app.get('/notes/:id<int>', { name: 'notes.show' }, show)
 *     app.url('notes.show', { id: 7 })                  // '/notes/7'
 *     app.url('notes.show', { id: 7 }, { from: 'feed' }) // '/notes/7?from=feed'
 *
 * Reverse routing is free in principle because names and segments are already
 * on the frozen graph. What this module adds is the guarantee that makes it
 * worth having over a template literal: **a URL it returns is one the named
 * route answers, with the parameters it was given.** Not "usually" — it
 * checks, and it throws rather than return one that would route elsewhere.
 *
 * Three ways a hand-built `/notes/${id}` goes wrong, and what happens here:
 *
 *   - **The value escapes its segment.** `/files/${name}` with a name of
 *     `a/b`, `x?y`, `#top` or `../admin` is a different path, a query or a
 *     fragment. Every value is percent-encoded as one segment — and the two no
 *     encoding can save, `.` and `..`, are refused: a browser resolves them
 *     before it sends the request, `%2E%2E` included, so `/files/..` is a link
 *     to `/`.
 *   - **The value is one the route would not match.** `:id<int>` given `'7a'`
 *     builds a path the router 404s. The parameter's own type tests the value,
 *     so the link fails here, in the handler that built it, rather than for the
 *     person who clicked it.
 *   - **Another route answers it.** `/users/:id` given `'me'` is `/users/me`,
 *     and if `GET /users/me` exists it outranks the parameter (§5.6). The
 *     compiled router is asked, once per call, which route its answer belongs
 *     to; anything but this one is a refusal naming the route that won.
 *
 * The query string is written the way the route reads it back. `parseQuery`
 * decodes `+` as a space, so values are percent-encoded rather than
 * form-encoded; a list is repeated, joined or bracketed as the route's
 * coercion plan says (§11.4) — the same plan the OpenAPI generator reads for
 * `style: form, explode: false`, so the link, the document and the parser
 * agree because there is one answer. What the parser would drop or reshape is
 * refused instead: a key it strips (`__proto__`), a value it cannot represent
 * (an object — nested parsing is off, §19.5), a comma-list element holding a
 * comma, and more pairs than `maxQueryParams` lets it read.
 *
 * The result is always a path, never an origin: it starts with one `/`, so it
 * is what `isLocalUrl` accepts and what `ctx.redirect()` sends without
 * consulting `redirect.allowExternal`. A link to the same app needs nothing
 * more, and an absolute URL is the application's to make — from an origin it
 * configured, never from a `Host` header a client wrote.
 *
 * Nothing here generates code, so there is no interpreted twin; the oracle is
 * the router itself, and the URL parser a browser uses (§20.5).
 */

type Part =
  | { readonly kind: 'static'; readonly text: string }
  | { readonly kind: 'param'; readonly name: string; readonly type: ParamType | null; readonly optional: boolean }
  | { readonly kind: 'wildcard'; readonly name: string }

/** How the route reads a list in its query — §11.4's array styles. */
type ListStyle =
  | { readonly kind: 'repeat' }
  | { readonly kind: 'bracket' }
  | { readonly kind: 'comma'; readonly separator: string }

interface Plan {
  readonly name: string
  readonly route: RouteRecord
  readonly parts: readonly Part[]
  /** Every parameter the template names, wildcards included. */
  readonly params: ReadonlySet<string>
  /** Query keys whose list style is not the default repetition. */
  readonly lists: ReadonlyMap<string, ListStyle>
  /** Why no URL can reach this route, or `null` — decided once, at boot. */
  readonly unreachable: string | null
}

export interface UrlTableOptions {
  /** The router the app serves with — the oracle every URL is checked against. */
  readonly router: CompiledRouter
  /** What `parseQuery` will read on the way back in; more is refused, not dropped. */
  readonly maxQueryParams: number
}

/**
 * Every named route, read once at boot into a plan; `build` fills one in.
 *
 * Unnamed routes are absent on purpose. A route's name is its identity to
 * everything that outlives a refactor — the OpenAPI `operationId`, metrics
 * labels, and now links — and a link to an anonymous route would have to name
 * it by its path, which is the one thing a link should not have to repeat.
 */
export class UrlTable {
  readonly #plans: Map<string, Plan>
  readonly #router: CompiledRouter
  readonly #maxQueryParams: number

  constructor(routes: readonly RouteRecord[], opts: UrlTableOptions) {
    this.#router = opts.router
    this.#maxQueryParams = opts.maxQueryParams
    this.#plans = new Map()
    for (const route of routes) {
      if (route.name !== undefined) this.#plans.set(route.name, plan(route.name, route, opts.router))
    }
  }

  /** The names `build` accepts, in registration order. */
  get names(): readonly string[] {
    return [...this.#plans.keys()]
  }

  build(name: string, params?: UrlParams, query?: UrlQuery): string {
    const plan = this.#plans.get(name)
    if (plan === undefined) throw unknownRoute(name, this.#plans.keys())
    if (plan.unreachable !== null) throw refusal(plan, plan.unreachable)

    const given = params ?? NO_PARAMS
    for (const key of Object.keys(given)) {
      if (given[key] !== undefined && !plan.params.has(key)) {
        throw refusal(
          plan,
          `was given "${key}", and ${plan.route.path} has no parameter of that name` +
            (plan.params.size === 0 ? ' — it has none.' : ` — it has ${[...plan.params].map((p) => `:${p}`).join(', ')}.`),
          'A value for the query string goes in the third argument: url(name, params, query).',
        )
      }
    }

    let path = ''
    let omitted: string | null = null
    for (const part of plan.parts) {
      if (part.kind === 'static') {
        path += `/${part.text}`
        continue
      }
      const value = given[part.name]
      if (value === undefined) {
        if (part.kind === 'param' && part.optional) {
          omitted ??= part.name
          continue
        }
        throw refusal(plan, `needs :${part.name}, and was not given it.`)
      }
      if (omitted !== null) {
        throw refusal(
          plan,
          `was given :${part.name} without :${omitted}. An optional parameter can only be left out from the end of the path.`,
        )
      }
      path += `/${part.kind === 'wildcard' ? wildcardText(plan, part.name, value) : paramText(plan, part, value)}`
    }
    if (path === '') path = '/'

    const search = query === undefined ? '' : this.#query(plan, query)
    this.#verify(plan, path)
    return search === '' ? path : `${path}?${search}`
  }

  /**
   * The one question only the router can answer: does this path reach *this*
   * route? A parameter's type is not enough — `/users/me` satisfies `:id`, and
   * `GET /users/me` outranks it — and the router is the authority on ranking
   * because it is the thing that does it.
   */
  #verify(plan: Plan, path: string): void {
    const match = this.#router.match(plan.route.method, path)
    if (match !== null && match.route !== null && match.route.id === plan.route.id) return

    const winner = match === null ? null : match.route
    if (winner === null) {
      // Every value was encoded, typed and checked for dot segments, so a path
      // the router does not recognise at all means this module and the router
      // disagree about the path syntax. Refused all the same — returning it
      // would be returning a 404.
      throw refusal(plan, 'built a path the router matches no route for. This is a Zen bug; please report it.')
    }
    // The path is not in the message: it holds the values, and a link is where
    // a reset token or a signed id lives. The route that won is enough to act on.
    throw refusal(
      plan,
      `built a path that ${winner.method} ${winner.path}${winner.name === undefined ? '' : ` ("${winner.name}")`} ` +
        'answers instead: where two routes first differ, a static segment outranks a typed parameter, ' +
        'a typed one an untyped one, and any of them a wildcard (§5.6).',
      winner.name === undefined
        ? 'Use a value only this route matches, or give that route a name and link to it.'
        : `Use a value only this route matches, or link to "${winner.name}".`,
    )
  }

  #query(plan: Plan, query: UrlQuery): string {
    const pairs: string[] = []
    for (const key of Object.keys(query)) {
      const value = query[key]
      if (value === undefined || value === null) continue
      if (isForbiddenKey(key)) {
        throw refusal(plan, `was given the query key "${key}", which every parser in this framework drops (§19.5).`)
      }
      const encodedKey = encode(key)
      if (encodedKey === null) throw refusal(plan, `was given a query key that is not well-formed Unicode.`)

      if (!Array.isArray(value)) {
        pairs.push(`${encodedKey}=${queryValue(plan, key, value)}`)
        continue
      }
      if (value.length === 0) continue

      const style = plan.lists.get(key) ?? REPEAT
      if (style.kind === 'comma') {
        pairs.push(`${encodedKey}=${commaList(plan, key, value, style.separator)}`)
        continue
      }
      const listKey = style.kind === 'bracket' ? `${encodedKey}%5B%5D` : encodedKey
      for (const item of value as readonly unknown[]) pairs.push(`${listKey}=${queryValue(plan, key, item)}`)
    }

    if (pairs.length > this.#maxQueryParams) {
      throw refusal(
        plan,
        `would carry ${pairs.length} query parameters, and this app reads at most ${this.#maxQueryParams} — ` +
          'the rest would be dropped on the way in.',
        'Send fewer, or raise `maxQueryParams` in zen({ … }) — it bounds what every request may make the parser do.',
      )
    }
    return pairs.join('&')
  }
}

const NO_PARAMS: UrlParams = Object.freeze({})
const REPEAT: ListStyle = Object.freeze({ kind: 'repeat' })

// ─────────────────────────────────────────────────────────────────────────────

function plan(name: string, route: RouteRecord, router: CompiledRouter): Plan {
  const parts: Part[] = []
  const params = new Set<string>()
  let unreachable: string | null = null

  for (const segment of route.segments) {
    if (segment.kind === 'static') {
      const text = encode(segment.value)
      if (text === null) unreachable ??= `cannot be linked to: its path holds a segment that is not well-formed Unicode.`
      else if (isDotSegment(segment.value)) {
        unreachable ??= `cannot be linked to: ${route.path} holds a "${segment.value}" segment, which a browser resolves away before it sends the request.`
      }
      parts.push({ kind: 'static', text: text ?? '' })
      continue
    }
    params.add(segment.value)
    parts.push(segment.kind === 'wildcard'
      ? { kind: 'wildcard', name: segment.value }
      : {
          kind: 'param',
          name: segment.value,
          type: segment.type === undefined ? null : router.paramTypes.get(segment.type) ?? null,
          optional: segment.optional === true,
        })
  }

  return { name, route, parts, params, lists: listStyles(route), unreachable }
}

/** §11.4's plan, read for the query keys whose lists are not simply repeated. */
function listStyles(route: RouteRecord): ReadonlyMap<string, ListStyle> {
  const styles = new Map<string, ListStyle>()
  const fields = route.coercion?.get('query')?.fields ?? []
  for (const field of fields) {
    const op = field.op
    if (op === null || op.kind !== 'array') continue
    if (op.split !== null) styles.set(field.key, { kind: 'comma', separator: op.split })
    else if (field.altKey !== null) styles.set(field.key, { kind: 'bracket' })
  }
  return styles
}

/** One path parameter, as the segment the router will decode back to it. */
function paramText(plan: Plan, part: Extract<Part, { kind: 'param' }>, value: unknown): string {
  const label = `:${part.name}${part.type === null ? '' : `<${part.type.name}>`}`
  const text = textOf(value)
  if (text === null) throw refusal(plan, `was given ${describe(value)} for ${label}. ${CARRIES}`)
  if (text === '') {
    throw refusal(plan, `was given an empty ${label}, and a path with an empty segment is a different path.`)
  }
  if (isDotSegment(text)) throw refusal(plan, dotRefusal(label, text))
  if (part.type !== null && !part.type.test(text)) {
    throw refusal(
      plan,
      `was given ${shape(text)} for ${label}, which that type refuses — the router would not match the result.`,
    )
  }
  const encoded = encode(text)
  if (encoded === null) throw refusal(plan, `was given a ${label} that is not well-formed Unicode.`)
  return encoded
}

/**
 * The rest of the path, one encoded segment per piece.
 *
 * The router joins a wildcard's segments back with `/` after decoding each, so
 * a piece holding a `/` — possible only in the list form — would arrive as two
 * pieces. A piece that is empty, `.` or `..` would not arrive at all: an empty
 * one collapses, and the dot segments are resolved by the browser.
 */
function wildcardText(plan: Plan, name: string, value: unknown): string {
  const label = `*${name}`
  const pieces = Array.isArray(value) ? (value as readonly unknown[]) : null
  const texts: string[] = []
  if (pieces === null) {
    const text = textOf(value)
    if (text === null) throw refusal(plan, `was given ${describe(value)} for ${label}. ${CARRIES}`)
    texts.push(...text.split('/'))
  } else {
    for (const piece of pieces) {
      const text = textOf(piece)
      if (text === null) throw refusal(plan, `was given ${describe(piece)} in ${label}. ${CARRIES}`)
      if (text.includes('/')) {
        throw refusal(plan, `was given a piece of ${label} that holds a "/", and one segment cannot hold one.`)
      }
      texts.push(text)
    }
  }

  const out: string[] = []
  for (const text of texts) {
    if (text === '') {
      throw refusal(
        plan,
        texts.length === 1
          ? `was given an empty ${label}, and a wildcard matches at least one segment.`
          : `was given a ${label} with an empty segment — a leading, trailing or doubled "/".`,
      )
    }
    if (isDotSegment(text)) throw refusal(plan, dotRefusal(label, text))
    const encoded = encode(text)
    if (encoded === null) throw refusal(plan, `was given a ${label} that is not well-formed Unicode.`)
    out.push(encoded)
  }
  return out.join('/')
}

function queryValue(plan: Plan, key: string, value: unknown): string {
  const text = textOf(value)
  if (text === null) {
    throw refusal(
      plan,
      `was given ${describe(value)} for ?${key}. A query value is a string, number, bigint, boolean or Date, ` +
        'or a list of them — nested objects are not parsed on the way in (§11.4, §19.5).',
    )
  }
  const encoded = encode(text)
  if (encoded === null) throw refusal(plan, `was given a value for ?${key} that is not well-formed Unicode.`)
  return encoded
}

/**
 * A `comma` list, which `splitList` reads back by splitting on the separator
 * and trimming the space or tab around each element (§11.4) — so an element
 * holding the separator becomes two, one with that space loses it, and a list
 * of one empty string reads as no list at all.
 */
function commaList(plan: Plan, key: string, list: readonly unknown[], separator: string): string {
  const out: string[] = []
  for (const item of list) {
    const text = textOf(item)
    if (text === null) {
      throw refusal(plan, `was given ${describe(item)} in ?${key}. A list holds strings, numbers, bigints, booleans or Dates.`)
    }
    if (text.includes(separator)) {
      throw refusal(plan, `was given an element of ?${key} that holds a "${separator}", and this route reads ?${key} as a "${separator}"-separated list — it would arrive as two values.`)
    }
    if (text !== trimOws(text)) {
      throw refusal(plan, `was given an element of ?${key} that starts or ends with a space or tab, which a "${separator}"-list element loses on the way in.`)
    }
    const encoded = encode(text)
    if (encoded === null) throw refusal(plan, `was given a value in ?${key} that is not well-formed Unicode.`)
    out.push(encoded)
  }
  if (out.length === 1 && out[0] === '') {
    throw refusal(plan, `was given [""] for ?${key}, and an empty "${separator}"-list reads as no elements at all.`)
  }
  // `,` is a sub-delimiter a query carries as it is, and `?ids=1,2,3` is the
  // spelling clients send and people read. Anything else is encoded: `&`, `=`,
  // `+` and `#` all mean something to the query string itself.
  return out.join(separator === ',' ? ',' : (encode(separator) ?? separator))
}

// ─────────────────────────────────────────────────────────────────────────────

const CARRIES = 'A path segment is built from a string, number, bigint, boolean or Date.'

/** The text a value is written as, or `null` when no URL can carry it. */
function textOf(value: unknown): string | null {
  switch (typeof value) {
    case 'string': return value
    case 'number': return Number.isFinite(value) ? String(value) : null
    case 'bigint': return String(value)
    case 'boolean': return value ? 'true' : 'false'
    case 'object':
      // `toISOString`, which every `<date>` reads back as the same instant —
      // `String(date)` is a locale-shaped sentence no route would match.
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null
    default: return null
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (value instanceof Date) return 'an invalid Date'
  if (typeof value === 'number') return String(value)
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

/**
 * A value as a refusal names it: by its length, never its text.
 *
 * A link is where a password-reset token, a signed id or a magic-link code
 * lives, and a refusal is logged — the same reason the header check reports a
 * code point rather than the value, and the redirect check an origin rather
 * than the path. The parameter, its type and the shape of what arrived are
 * enough to find the call that built it.
 */
function shape(text: string): string {
  return `a value of ${text.length} character${text.length === 1 ? '' : 's'}`
}

/**
 * Percent-encoding, as one path segment or one query component.
 *
 * `encodeURIComponent` leaves only `A–Z a–z 0–9 - _ . ! ~ * ' ( )` unescaped,
 * so nothing it writes can end a segment, start a query or a fragment, or be
 * read by the WHATWG parser as anything but what it is — and `decodeURIComponent`
 * (which is what the router and `parseQuery` apply) is its exact inverse. It
 * throws only on a lone surrogate, which has no UTF-8 spelling at all.
 */
function encode(text: string): string | null {
  try {
    return encodeURIComponent(text)
  } catch {
    return null
  }
}

function isDotSegment(text: string): boolean {
  return text === '.' || text === '..'
}

function dotRefusal(label: string, text: string): string {
  return `was given "${text}" for ${label}, which no URL can carry: a browser resolves a "${text}" segment ` +
    '— or its percent-encoded spelling — before it sends the request, so the link would lead somewhere else.'
}

function trimOws(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++
  while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--
  return text.slice(start, end)
}

function refusal(plan: Plan, detail: string, hint?: string): ZenError {
  return new ZenError(
    Codes.PARAM_MISMATCH,
    `url("${plan.name}") for ${plan.route.method} ${plan.route.path} ${detail}`,
    { status: 500, expose: false, hint, meta: { route: plan.name } },
  )
}

function unknownRoute(given: unknown, names: Iterable<string>): ZenError {
  // A caller without types can pass anything; the message is about a name.
  const name = String(given)
  const known = [...names]
  const guess = closest(name, known)
  const looksLikePath = name.startsWith('/')
  return new ZenError(
    Codes.ROUTE_UNKNOWN,
    `url("${name}"): no route is named "${name}".` +
      (guess !== null ? ` Did you mean "${guess}"?` : '') +
      (looksLikePath ? ' url() takes a route name, not a path.' : ''),
    {
      status: 500,
      expose: false,
      hint: looksLikePath || known.length === 0
        ? "Name the route you are linking to — app.get(path, { name: 'notes.show' }, handler) — and pass that name."
        : guess === null
          ? `Check the spelling: ${known.length} route${known.length === 1 ? ' is' : 's are'} named, e.g. ${known.slice(0, 3).map((n) => `"${n}"`).join(', ')}.`
          : undefined,
      meta: { route: name },
    },
  )
}
