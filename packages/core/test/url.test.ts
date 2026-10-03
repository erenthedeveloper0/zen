import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CAPABILITIES, definePlugin, isLocalUrl, parseQuery, type UrlParams, type UrlQuery, type ZenApp,
} from '@erenthedeveloper0/zen-core'
import { makeApp, shaped } from './helpers.ts'

/**
 * URL generation — rfcs/0001 §5.7.
 *
 * The property everything here is about: **a URL `url()` returns is one its
 * route answers, with the values it was given** — or `url()` throws. The
 * hand-written cases below are the ways a hand-built `/x/${value}` goes wrong;
 * the property suite at the end builds URLs from hostile values over a route
 * table full of shadowing traps and judges every one by two oracles that share
 * no code with `url()`: the WHATWG URL parser, which is what a browser applies
 * to an `href` before it sends anything, and the application itself, through
 * `inject()` — router, params builder, query parser and all.
 */

function refused(build: () => unknown, code = 'ZEN_PARAM_MISMATCH'): string {
  try {
    build()
  } catch (error) {
    assert.equal((error as { code?: string }).code, code, String(error))
    assert.equal((error as { status?: number }).status, 500)
    assert.equal((error as { expose?: boolean }).expose, false)
    return (error as Error).message
  }
  assert.fail(`expected ${code}`)
}

/** An app whose every route echoes what it received. */
async function echoing(register: (app: ZenApp) => void, opts: Parameters<typeof makeApp>[0] = {}): Promise<ZenApp> {
  const app = makeApp(opts)
  register(app)
  await app.ready()
  return app
}

const echo = (ctx: { route: { name?: string | undefined } | null; params: unknown; query: unknown }) =>
  ({ route: ctx.route?.name ?? null, params: ctx.params, query: ctx.query })

async function reached(app: ZenApp, url: string): Promise<{ route: string | null; params: Record<string, unknown>; query: Record<string, unknown> }> {
  const response = await app.inject('GET', url)
  assert.equal(response.status, 200, `${url} → ${response.status} ${response.text()}`)
  return response.json()
}

// ─────────────────────────────────────────────────────────────────────────────

describe('url() builds the path of a named route (§5.7)', () => {
  it('a static route is its path, and the root is /', async () => {
    const app = await echoing((a) => {
      a.get('/', { name: 'home' }, echo)
      a.get('/health/live', { name: 'live' }, echo)
    })
    assert.equal(app.url('home'), '/')
    assert.equal(app.url('live'), '/health/live')
    assert.equal(app.url('live', {}), '/health/live')
  })

  it('a parameter is one segment, whatever it holds', async () => {
    const app = await echoing((a) => a.get('/users/:id', { name: 'users.show' }, echo))
    const hostile = 'a b/c?d#e%f+g&h=é'
    const url = app.url('users.show', { id: hostile })
    assert.equal(url, '/users/a%20b%2Fc%3Fd%23e%25f%2Bg%26h%3D%C3%A9')
    assert.deepEqual((await reached(app, url)).params, { id: hostile })
  })

  it('a number, a bigint, a boolean and a Date are written the way their routes read them back', async () => {
    const app = await echoing((a) => {
      a.get('/n/:id<int>', { name: 'n' }, echo)
      a.get('/big/:id', { name: 'big' }, echo)
      a.get('/flag/:on', { name: 'flag' }, echo)
      a.get('/day/:at<date>', { name: 'day' }, echo)
    })
    assert.equal(app.url('n', { id: 42 }), '/n/42')
    assert.equal(app.url('n', { id: -7 }), '/n/-7')
    assert.equal(app.url('big', { id: 9007199254740993n }), '/big/9007199254740993')
    assert.equal(app.url('flag', { on: false }), '/flag/false')

    const at = new Date('2026-10-03T12:34:56.789Z')
    const url = app.url('day', { at })
    assert.equal(url, '/day/2026-10-03T12%3A34%3A56.789Z')
    assert.deepEqual((await reached(app, url)).params, { at: at.toISOString() })
    assert.deepEqual((await reached(app, app.url('n', { id: 42 }))).params, { id: 42 })
  })

  it('a parameter\'s type tests the value, so a link the router would 404 is never built', async () => {
    const app = await echoing((a) => {
      a.get('/n/:id<int>', { name: 'n' }, echo)
      a.get('/u/:id<uuid>', { name: 'u' }, echo)
    })
    for (const id of ['4.2', 'abc', '9007199254740993', ' 1']) {
      assert.match(refused(() => app.url('n', { id })), /which that type refuses/, id)
    }
    assert.match(refused(() => app.url('u', { id: 'not-a-uuid' })), /:id<uuid>/)
  })

  it('an optional parameter may be left out', async () => {
    const app = await echoing((a) => a.get('/posts/:slug?', { name: 'posts' }, echo))
    assert.equal(app.url('posts'), '/posts')
    assert.equal(app.url('posts', { slug: undefined }), '/posts')
    assert.equal(app.url('posts', { slug: 'hello' }), '/posts/hello')
    assert.equal((await reached(app, '/posts')).route, 'posts')
  })

  it('…only from the end, under a path syntax that allows several (§3.5)', async () => {
    // Zen's own syntax allows one trailing optional; the router expands any
    // number of them, and `PathParser` is a seam another syntax plugs into.
    const archive = [
      { kind: 'static', value: 'archive' },
      { kind: 'param', value: 'year', type: 'int', optional: true },
      { kind: 'param', value: 'month', type: 'int', optional: true },
    ] as const
    const app = await echoing((a) => a.get('/archive', { name: 'archive' }, echo), {
      pathParser: { parse: (path) => ({ path, segments: path === '/archive' ? archive : [] }) },
    })
    assert.equal(app.url('archive'), '/archive')
    assert.equal(app.url('archive', { year: 2026 }), '/archive/2026')
    assert.equal(app.url('archive', { year: 2026, month: 10 }), '/archive/2026/10')
    assert.deepEqual((await reached(app, '/archive/2026/10')).params, { year: 2026, month: 10 })
    assert.match(refused(() => app.url('archive', { month: 10 })), /was given :month without :year/)
  })

  it('a wildcard takes the rest of the path, as a string or as its segments', async () => {
    const app = await echoing((a) => a.get('/files/*path', { name: 'files' }, echo))
    assert.equal(app.url('files', { path: 'docs/intro guide.md' }), '/files/docs/intro%20guide.md')
    assert.equal(app.url('files', { path: ['docs', 'a?b.md'] }), '/files/docs/a%3Fb.md')
    assert.deepEqual((await reached(app, app.url('files', { path: ['docs', 'a?b.md'] }))).params, { path: 'docs/a?b.md' })

    assert.match(refused(() => app.url('files', { path: '' })), /matches at least one segment/)
    for (const path of ['/docs', 'docs/', 'a//b']) {
      assert.match(refused(() => app.url('files', { path })), /an empty segment/, path)
    }
    assert.match(refused(() => app.url('files', { path: ['a/b'] })), /holds a "\/"/)
  })

  it('refuses ".", ".." and "" — no encoding can carry them to the route', async () => {
    const app = await echoing((a) => {
      a.get('/files/:name', { name: 'file' }, echo)
      a.get('/tree/*path', { name: 'tree' }, echo)
    })
    // A browser resolves these before it sends the request — `%2E%2E` too — so
    // `/files/..` is a link to `/`. The WHATWG parser says so:
    assert.equal(new URL('/files/..', 'https://app.test').pathname, '/')
    assert.equal(new URL('/files/%2E%2E', 'https://app.test').pathname, '/')

    assert.match(refused(() => app.url('file', { name: '..' })), /no URL can carry/)
    assert.match(refused(() => app.url('file', { name: '.' })), /no URL can carry/)
    assert.match(refused(() => app.url('file', { name: '' })), /an empty :name/)
    assert.match(refused(() => app.url('tree', { path: 'a/../etc/passwd' })), /no URL can carry/)
    // `..` inside a value is just text, and stays inside its segment.
    assert.equal(app.url('file', { name: '..secret' }), '/files/..secret')
  })

  it('a route whose own path holds a dot segment cannot be linked to', async () => {
    const app = await echoing((a) => a.get('/a/./b', { name: 'dotted' }, echo))
    assert.match(refused(() => app.url('dotted')), /cannot be linked to/)
  })

  it('refuses a value no URL can carry: an object, a list, NaN, an invalid Date, a lone surrogate', async () => {
    const app = await echoing((a) => a.get('/x/:v', { name: 'x' }, echo))
    assert.match(refused(() => app.url('x', { v: {} as never })), /an object for :v/)
    assert.match(refused(() => app.url('x', { v: ['a', 'b'] })), /a list for :v/)
    assert.match(refused(() => app.url('x', { v: Number.NaN })), /NaN for :v/)
    assert.match(refused(() => app.url('x', { v: Infinity })), /Infinity for :v/)
    assert.match(refused(() => app.url('x', { v: new Date('nope') })), /an invalid Date/)
    assert.match(refused(() => app.url('x', { v: 'a\uD800b' })), /not well-formed Unicode/)
  })

  it('refuses a parameter the path does not have, and one it needs and was not given', async () => {
    const app = await echoing((a) => a.get('/n/:id<int>', { name: 'n' }, echo))
    const extra = refused(() => app.url('n', { id: 1, page: 2 }))
    assert.match(extra, /was given "page", and \/n\/:id<int> has no parameter of that name — it has :id\./)
    assert.match(refused(() => app.url('n', {})), /needs :id/)
    assert.match(refused(() => app.url('n')), /needs :id/)
    // `undefined` is "not given", not a key.
    assert.equal(app.url('n', { id: 1, page: undefined }), '/n/1')
  })

  it('names the route it could not find, and the one that was probably meant', async () => {
    const app = await echoing((a) => {
      a.get('/users/:id', { name: 'users.show' }, echo)
      a.get('/users', echo)
    })
    assert.match(refused(() => app.url('user.show'), 'ZEN_ROUTE_UNKNOWN'), /no route is named "user\.show"\. Did you mean "users\.show"\?/)
    assert.match(refused(() => app.url('/users/:id'), 'ZEN_ROUTE_UNKNOWN'), /takes a route name, not a path/)
    // An unnamed route has no name to link by — by design: a link that names a
    // path repeats the one thing a link should not have to.
    refused(() => app.url('GET /users'), 'ZEN_ROUTE_UNKNOWN')
  })

  it('never puts a value it was given into a refusal — a link is where tokens live', async () => {
    // A refusal is logged. The parameter, its type and the shape of the value
    // are enough to find the call; the value itself may be a reset token or a
    // signed id, which is why the header check and the redirect check withhold
    // theirs too.
    const app = await echoing((a) => {
      a.get('/reset/:token<hex>', { name: 'reset' }, echo)
      a.get('/invite/new/:step', { name: 'invite.new' }, echo)
      a.get('/invite/:code/:step', { name: 'invite' }, echo)
      a.get('/tree/*path', { name: 'tree' }, echo)
    })
    const SECRET = 'sk_live_9f8e7d6c5b4a'
    const messages = [
      refused(() => app.url('reset', { token: SECRET })),
      refused(() => app.url('invite', { code: 'new', step: SECRET })),
      refused(() => app.url('tree', { path: [SECRET, `${SECRET}/x`] })),
    ]
    for (const message of messages) assert.doesNotMatch(message, new RegExp(SECRET), message)
    assert.match(messages[0] as string, /a value of 20 characters for :token<hex>/)
    assert.match(messages[1] as string, /GET \/invite\/new\/:step \("invite\.new"\) answers instead/)
  })

  it('is ZEN_APP_NOT_READY before ready(), when routes are not compiled yet', () => {
    const app = makeApp()
    app.get('/x', { name: 'x' }, () => 'x')
    refused(() => app.url('x'), 'ZEN_APP_NOT_READY')
  })

  it('reaches the routes all() registers, by their method-suffixed names', async () => {
    const app = await echoing((a) => a.all('/proxy/:id', { name: 'proxy' }, echo))
    assert.equal(app.url('proxy.post', { id: 'a' }), '/proxy/a')
    refused(() => app.url('proxy', { id: 'a' }), 'ZEN_ROUTE_UNKNOWN')
  })
})

describe('url() never builds a link another route answers (§5.6)', () => {
  it('a static route outranks a parameter', async () => {
    const app = await echoing((a) => {
      a.get('/users/me', { name: 'users.me' }, echo)
      a.get('/users/:id', { name: 'users.show' }, echo)
    })
    const message = refused(() => app.url('users.show', { id: 'me' }))
    assert.match(message, /built a path that GET \/users\/me \("users\.me"\) answers instead/)
    assert.equal(app.url('users.show', { id: 'mel' }), '/users/mel')
  })

  it('a typed parameter outranks an untyped one', async () => {
    const app = await echoing((a) => {
      a.get('/items/:id<int>', { name: 'items.byId' }, echo)
      a.get('/items/:key', { name: 'items.byKey' }, echo)
    })
    assert.match(refused(() => app.url('items.byKey', { key: '42' })), /"items\.byId"\) answers instead/)
    assert.equal(app.url('items.byKey', { key: 'chair' }), '/items/chair')
    assert.equal((await reached(app, app.url('items.byKey', { key: 'chair' }))).route, 'items.byKey')
  })

  it('anything outranks a wildcard', async () => {
    const app = await echoing((a) => {
      a.get('/files/special', { name: 'files.special' }, echo)
      a.get('/files/*path', { name: 'files' }, echo)
    })
    assert.match(refused(() => app.url('files', { path: 'special' })), /"files\.special"\) answers instead/)
    assert.equal(app.url('files', { path: 'special/inner' }), '/files/special/inner')
  })

  it('says what to do when the route that won has no name', async () => {
    const app = await echoing((a) => {
      a.get('/users/me', echo)
      a.get('/users/:id', { name: 'users.show' }, echo)
    })
    const error = (() => { try { app.url('users.show', { id: 'me' }) } catch (e) { return e as { hint?: string } } return null })()
    assert.match(error?.hint ?? '', /give that route a name and link to it/)
  })

  it('is decided by the router the app serves with, compiled or interpreted', async () => {
    for (const caps of [DEFAULT_CAPABILITIES, { ...DEFAULT_CAPABILITIES, eval: false }]) {
      const app = await echoing((a) => {
        a.get('/users/me', { name: 'users.me' }, echo)
        a.get('/users/:id<int>', { name: 'users.show' }, echo)
      }, { caps })
      assert.equal(app.url('users.show', { id: 7 }), '/users/7')
      refused(() => app.url('users.show', { id: 'me' }))
    }
  })
})

describe('url() writes the query the way the route reads it (§11.4)', () => {
  it('scalars and lists, with null and undefined left out', async () => {
    const app = await echoing((a) => a.get('/search', { name: 'search' }, echo))
    const url = app.url('search', {}, {
      q: 'a b+c&d=e', page: 2, exact: true, since: new Date('2026-01-01T00:00:00.000Z'),
      tag: ['x', 'y'], none: null, gone: undefined, empty: [], blank: '',
    })
    assert.equal(url, '/search?q=a%20b%2Bc%26d%3De&page=2&exact=true&since=2026-01-01T00%3A00%3A00.000Z&tag=x&tag=y&blank=')
    assert.deepEqual((await reached(app, url)).query, {
      q: 'a b+c&d=e', page: '2', exact: 'true', since: '2026-01-01T00:00:00.000Z', tag: ['x', 'y'], blank: '',
    })
  })

  it('a list joined with commas where the route\'s profile says comma — and refused where that cannot round-trip', async () => {
    const Ids = shaped({ type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } } } })
    const app = await echoing((a) => a.get('/legacy', { name: 'legacy', query: Ids, coercion: { query: { arrays: 'comma' } } }, echo))
    const url = app.url('legacy', {}, { ids: [1, 2, 3] })
    assert.equal(url, '/legacy?ids=1,2,3')
    assert.deepEqual((await reached(app, url)).query, { ids: [1, 2, 3] })

    assert.match(refused(() => app.url('legacy', {}, { ids: ['1,2'] })), /would arrive as two values/)
    assert.match(refused(() => app.url('legacy', {}, { ids: [' 1'] })), /loses on the way in/)
    assert.match(refused(() => app.url('legacy', {}, { ids: [''] })), /reads as no elements at all/)
  })

  it('a list bracketed where the route\'s profile says bracket', async () => {
    const Tags = shaped({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } })
    const app = await echoing((a) => a.get('/php', { name: 'php', query: Tags, coercion: { query: { arrays: 'bracket' } } }, echo))
    const url = app.url('php', {}, { tags: ['a', 'b'] })
    assert.equal(url, '/php?tags%5B%5D=a&tags%5B%5D=b')
    assert.deepEqual((await reached(app, url)).query['tags'], ['a', 'b'])
    assert.deepEqual((await reached(app, app.url('php', {}, { tags: ['solo'] }))).query['tags'], ['solo'])
  })

  it('refuses what the parser would drop or reshape: __proto__, a nested object, more pairs than it reads', async () => {
    const app = await echoing((a) => a.get('/s', { name: 's' }, echo), { maxQueryParams: 3 })
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.match(refused(() => app.url('s', {}, { [key]: 'x' })), /drops/, key)
    }
    assert.match(refused(() => app.url('s', {}, { filter: { a: 1 } as never })), /nested objects are not parsed/)
    assert.match(refused(() => app.url('s', {}, { a: 1, b: 2, c: [3, 4] })), /would carry 4 query parameters, and this app reads at most 3/)
    assert.equal(app.url('s', {}, { a: 1, b: 2, c: 3 }), '/s?a=1&b=2&c=3')
  })
})

describe('a URL from url() stays home (§19.5.2)', () => {
  it('is a local path, so ctx.redirect() sends it with no allowlist', async () => {
    const app = await echoing((a) => {
      a.get('/notes/:id<int>', { name: 'notes.show' }, echo)
      a.post('/notes', { name: 'notes.create' }, (ctx) => ctx.redirect(a.url('notes.show', { id: 7 }, { created: 1 }), 303))
    })
    const url = app.url('notes.show', { id: 7 }, { created: 1 })
    assert.ok(isLocalUrl(url))
    const response = await app.inject('POST', '/notes')
    assert.equal(response.status, 303)
    assert.equal(response.header('location'), '/notes/7?created=1')
  })

  it('cannot be steered off the origin by a value — "//evil.example" is one encoded segment', async () => {
    const app = await echoing((a) => a.get('/:slug', { name: 'page' }, echo))
    for (const slug of ['/evil.example', '\\evil.example', 'https://evil.example', '%2F%2Fevil.example']) {
      const url = app.url('page', { slug })
      assert.ok(isLocalUrl(url), `${slug} → ${url}`)
      assert.equal(new URL(url, 'https://app.test').origin, 'https://app.test', url)
    }
  })
})

describe('url() is reachable where routes are written (§5.7)', () => {
  it('from a collection handle — what a feature module is given', async () => {
    const app = await echoing((a) => {
      a.collection('/api/notes', { name: 'notes' }, (notes) => {
        notes.get('/:id<int>', { name: 'notes.get' }, echo)
        notes.post('/', { name: 'notes.create' }, (ctx) =>
          ctx.json({ ok: true }, { status: 201, headers: { location: notes.url('notes.get', { id: 12 }) } }))
      })
    })
    const created = await app.inject('POST', '/api/notes')
    assert.equal(created.status, 201)
    assert.equal(created.header('location'), '/api/notes/12')
  })

  it('from a plugin\'s registrar at request time — and ZEN_APP_NOT_READY from its setup', async () => {
    let duringSetup = ''
    const plugin = definePlugin({
      name: 'linker',
      version: '1.0.0',
      setup(registrar) {
        try { registrar.url('linker.self') } catch (error) { duringSetup = (error as { code: string }).code }
        registrar.route({
          method: 'GET', path: '/linker/:n<int>', name: 'linker.self',
          handler: (ctx: { params: { n: number } }) => ({ next: registrar.url('linker.self', { n: ctx.params.n + 1 }) }),
        } as never)
      },
    })
    const app = makeApp()
    app.use(plugin)
    await app.ready()
    assert.equal(duringSetup, 'ZEN_APP_NOT_READY')
    assert.deepEqual((await app.inject('GET', '/linker/1')).json(), { next: '/linker/2' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Property: hostile values over a table of shadowing traps, judged by the
// browser's URL parser and by the application itself.
// ─────────────────────────────────────────────────────────────────────────────

const SEEDS = 2_000

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T

/** Characters with a meaning somewhere in a URL, and some that only look harmless. */
const ATOMS = [
  'a', 'Z', '0', '7', '42', '-1', '1.5', 'ff', 'me', 'special', 'new', 'é', '日本', '　',
  ' ', '+', '%', '%2F', '%2e', '%41', '/', '\\', '?', '#', '&', '=', ';', ':', '@', '.', '..', '~', '*', "'", '"',
  '<', '>', '`', '{', '}', '|', '^', '(', ')', '!', '$', ',', '[', ']', '\n', '\t', '\u0000', '\u007f', '\uD800', '',
]

/** The route table: every way one route can outrank another, and every segment kind. */
const TABLE: ReadonlyArray<readonly [name: string, path: string]> = [
  ['root', '/'],
  ['users.me', '/users/me'],
  ['users.show', '/users/:id'],
  ['items.byId', '/items/:id<int>'],
  ['items.byKey', '/items/:key'],
  ['blobs', '/blobs/:id<hex>'],
  ['pair', '/a/:x/b/:y'],
  ['posts', '/posts/:slug?'],
  ['files.special', '/files/special'],
  ['files', '/files/*path'],
  ['days', '/days/:on<date>'],
  ['mixed', '/m/:n<int>/:rest'],
]

/** What each parameter of each route is, for the generator and for the expected echo. */
const PARAMS: Readonly<Record<string, ReadonlyArray<readonly [name: string, kind: 'plain' | 'int' | 'hex' | 'date' | 'wildcard' | 'optional']>>> = {
  'root': [],
  'users.me': [],
  'users.show': [['id', 'plain']],
  'items.byId': [['id', 'int']],
  'items.byKey': [['key', 'plain']],
  'blobs': [['id', 'hex']],
  'pair': [['x', 'plain'], ['y', 'plain']],
  'posts': [['slug', 'optional']],
  'files.special': [],
  'files': [['path', 'wildcard']],
  'days': [['on', 'date']],
  'mixed': [['n', 'int'], ['rest', 'plain']],
}

function randomText(random: () => number): string {
  let out = ''
  const length = Math.floor(random() * 4)
  for (let i = 0; i < length; i++) out += pick(random, ATOMS)
  return out
}

function randomValue(random: () => number, kind: string): unknown {
  const roll = random()
  if (kind === 'int' && roll < 0.5) return Math.floor(random() * 2000) - 1000
  if (kind === 'date' && roll < 0.5) return new Date(Math.floor(random() * 4e12))
  if (kind === 'hex' && roll < 0.4) return (Math.floor(random() * 1e9)).toString(16)
  if (kind === 'wildcard' && roll < 0.5) {
    // The list form, and now and then a piece holding a "/" — the one input
    // only the list form can produce, and a uniform draw over ATOMS reached it
    // twice in 2,000 (the coverage assertion below is what said so).
    const pieces = Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomText(random))
    if (random() < 0.25) pieces.push(`${randomText(random)}/${randomText(random)}`)
    return pieces
  }
  if (kind === 'optional' && roll < 0.3) return undefined
  if (roll < 0.04) return {} as never
  if (roll < 0.08) return Number.NaN
  if (roll < 0.12) return BigInt(Math.floor(random() * 1e6))
  if (roll < 0.15) return random() < 0.5
  return randomText(random)
}

const QUERY_KEYS = ['q', 'page', 'tag', 'a b', 'é', '', 'x[]', '__proto__', '%', '&', '=', '+', '#']

function randomQuery(random: () => number): UrlQuery | undefined {
  if (random() < 0.4) return undefined
  // Null-prototype, or `out['__proto__'] = v` sets the prototype instead of a
  // key — the very trap §19.5 strips from parsed input — and the generator
  // never produced the input that branch exists for (coverage said: 0 of 2,000).
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const count = Math.floor(random() * 4)
  for (let i = 0; i < count; i++) {
    const key = pick(random, QUERY_KEYS)
    const roll = random()
    out[key] = roll < 0.15 ? null
      : roll < 0.35 ? Array.from({ length: Math.floor(random() * 3) }, () => randomText(random))
      : roll < 0.45 ? Math.floor(random() * 100)
      : randomText(random)
  }
  return out as UrlQuery
}

/** What the route's handler should see for a parameter it was given. */
function expectedParam(kind: string, value: unknown): unknown {
  const text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('/') : String(value)
  if (kind === 'int') return Number(text)
  if (kind === 'date') return new Date(text).toISOString()
  return text
}

/** What `parseQuery` should hand back for what was given — the strings, repeated keys as arrays. */
function expectedQuery(query: UrlQuery | undefined): Record<string, unknown> {
  // Null-prototype for the generator's reason: a `__proto__` that slipped
  // through `url()` has to be *expected*, so its absence on arrival fails.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      out[key] = value.length === 1 ? String(value[0]) : value.map(String)
    } else {
      out[key] = String(value)
    }
  }
  // A plain object to compare with what `json()` parsed; a spread defines an
  // own `__proto__` key as data rather than calling the setter.
  return { ...out }
}

/** Which refusal it was, for the coverage assertion. */
function reason(message: string): string {
  if (/no URL can carry/.test(message)) return 'dot'
  if (/empty/.test(message)) return 'empty'
  if (/which that type refuses/.test(message)) return 'type'
  if (/answers instead/.test(message)) return 'outranked'
  if (/not well-formed Unicode/.test(message)) return 'surrogate'
  if (/holds a "\/"/.test(message)) return 'slash'
  if (/drops/.test(message)) return 'dropped key'
  if (/an object|NaN|a list for/.test(message)) return 'not a value'
  return `other: ${message}`
}

describe('property: every URL url() returns reaches its route with its values (§5.7, §20.5)', () => {
  it('over 2,000 random hostile inputs — judged by the WHATWG URL parser and by the app itself', async () => {
    const app = await echoing((a) => {
      for (const [name, path] of TABLE) a.get(path, { name }, echo)
    })

    const refusals = new Map<string, number>()
    const built = new Map<string, number>()
    const encoded = new Map<string, number>()
    let successes = 0

    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const [name] = pick(random, TABLE)
      const params: Record<string, unknown> = {}
      for (const [param, kind] of PARAMS[name] ?? []) params[param] = randomValue(random, kind)
      const query = randomQuery(random)

      let url: string
      try {
        url = app.url(name, params as UrlParams, query)
      } catch (error) {
        assert.equal((error as { code?: string }).code, 'ZEN_PARAM_MISMATCH', `seed ${seed}: ${String(error)}`)
        const why = reason((error as Error).message)
        assert.ok(!why.startsWith('other'), `seed ${seed}: an unclassified refusal — ${why}`)
        refusals.set(why, (refusals.get(why) ?? 0) + 1)
        continue
      }

      // 1. It is a path on this origin.
      assert.ok(isLocalUrl(url), `seed ${seed}: ${url} is not local`)

      // 2. A browser sends it unchanged: no dot segment resolved, no slash
      //    re-read, nothing that ends the path early. Its query may be
      //    re-escaped (WHATWG encodes `'` there), but it says the same thing.
      const parsed = new URL(url, 'https://app.test/base/')
      assert.equal(parsed.origin, 'https://app.test', `seed ${seed}: ${url}`)
      const path = url.includes('?') ? url.slice(0, url.indexOf('?')) : url
      assert.equal(parsed.pathname, path, `seed ${seed}: a browser would request ${parsed.pathname} for ${url}`)
      assert.equal(parsed.hash, '', `seed ${seed}: ${url} has a fragment`)
      assert.deepEqual({ ...parseQuery(parsed.pathname + parsed.search) }, { ...parseQuery(url) }, `seed ${seed}: ${url}`)

      // 3. What a browser sends is answered by this route, with these values.
      const got = await reached(app, parsed.pathname + parsed.search)
      assert.equal(got.route, name, `seed ${seed}: ${url} reached ${got.route}, not ${name}`)
      const expected: Record<string, unknown> = {}
      for (const [param, kind] of PARAMS[name] ?? []) {
        if (params[param] !== undefined) expected[param] = expectedParam(kind, params[param])
      }
      assert.deepEqual(got.params, expected, `seed ${seed}: ${url}`)
      assert.deepEqual(got.query, expectedQuery(query), `seed ${seed}: ${url}`)

      successes++
      built.set(name, (built.get(name) ?? 0) + 1)
      for (const escape of ['%2F', '%3F', '%23', '%25', '%20', '%5C']) {
        if (url.includes(escape)) encoded.set(escape, (encoded.get(escape) ?? 0) + 1)
      }
    }

    // Coverage. A property suite whose generator never reaches a branch tests
    // nothing there, and says so with a green tick (§20.5).
    assert.ok(successes > SEEDS / 3, `only ${successes} of ${SEEDS} inputs built a URL`)
    for (const [name] of TABLE) {
      assert.ok((built.get(name) ?? 0) >= 10, `only ${built.get(name) ?? 0} URLs built for "${name}"`)
    }
    for (const why of ['dot', 'empty', 'type', 'outranked', 'surrogate', 'slash', 'dropped key', 'not a value']) {
      assert.ok((refusals.get(why) ?? 0) >= 5, `only ${refusals.get(why) ?? 0} refusals of kind "${why}" — ${JSON.stringify([...refusals])}`)
    }
    for (const escape of ['%2F', '%3F', '%23', '%25', '%20', '%5C']) {
      assert.ok((encoded.get(escape) ?? 0) >= 10, `only ${encoded.get(escape) ?? 0} built URLs carried ${escape} to their route`)
    }
  })
})
