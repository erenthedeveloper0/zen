/**
 * The claims ledger — every "built" sentence, checked against the built packages.
 *
 * `node scripts/claims.ts [pattern]` (after `npx tsc -b`) — a pattern runs the
 * probes whose id contains it, and still checks every marker.
 *
 * HANDOFF's lesson is that every sentence in the README is a test somebody has
 * not written yet. Two audits applied it by hand and found every probe they
 * wrote failing: a registration accepted and never run, an option schema read
 * by nothing, a check the RFC described in the present tense. This is the
 * lesson applied by the build instead. Every bullet of the README's "Working
 * today" and every `> **Status:` block in ARCHITECTURE.md carries a
 * `<!-- claim: id -->` marker; each id names a probe here, run against `dist/`
 * the way a user's code would run.
 *
 * The run fails when:
 *
 *   - a claim's probe fails — the sentence is no longer true;
 *   - a bullet or a Status block has no marker, or a marker names no probe —
 *     a sentence that nothing checks;
 *   - a probe has no marker — a check for a sentence the docs no longer make;
 *   - a **gap** closes. The docs admit what is not built with
 *     `<!-- gap: id -->`, and each gap's probe asserts the gap is still there.
 *     The day one is built, the build fails until the docs say so — which is
 *     how a fixed defect stops being described as missing, and how a feature
 *     cannot become "working today" by accident.
 *
 * The seed is the audit of the `0.1.0-alpha.3` build: its fourteen probes,
 * every one of which found a gap, are inverted here as the seven claims
 * `0.1.0-alpha.4` made true and the seven gaps it admits, each marked
 * `(alpha.3 audit, probe n)` below.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const Z = await import('@erenthedeveloper0/zen')
const OAS = await import('@erenthedeveloper0/zen-openapi')
const {
  zen, definePlugin, slot, token, markSync, jsonSchema, html, explainRoute, defineConfig, normaliseIssues,
  NoopLogger, BootError, ServiceUnavailable, DEFAULT_CAPABILITIES, NODE_CAPABILITIES, healthPlugin,
  cors, rateLimit, nodeAdapter, resolvePlugins,
} = Z as Record<string, any>

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Verdict = { readonly ok: boolean; readonly observed: string }
type Probe = () => Promise<Verdict> | Verdict

const verdict = (ok: boolean, observed: string): Verdict => ({ ok, observed })

const app = (opts: Record<string, unknown> = {}): any =>
  zen({ logger: new NoopLogger(), lifecycle: false, env: {}, ...opts })

/** A Standard Schema with no shape — the validator alone. */
const schema = (check: (v: any) => boolean, message = 'rejected by probe schema') => ({
  '~standard': { version: 1, vendor: 'claims', validate: (v: unknown) => (check(v) ? { value: v } : { issues: [{ message, path: [] }] }) },
})

/** A Standard Schema that exposes its JSON Schema, with a literal validator for `type`/`required`. */
function shaped(json: any): any {
  const typeOk = (v: any, t: string): boolean =>
    t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? typeof v === 'object' && v !== null : typeof v === t
  const check = (v: any, node: any, path: PropertyKey[]): any[] => {
    if (node === undefined) return []
    if (node.type !== undefined && !typeOk(v, node.type)) return [{ message: `expected ${node.type}`, path }]
    if (node.type === 'object') {
      const out: any[] = []
      for (const key of node.required ?? []) if (v?.[key] === undefined) out.push({ message: 'required', path: [...path, key] })
      for (const key of Object.keys(node.properties ?? {})) if (v?.[key] !== undefined) out.push(...check(v[key], node.properties[key], [...path, key]))
      return out
    }
    return []
  }
  return {
    '~standard': { version: 1, vendor: 'claims-shaped', validate: (v: unknown) => { const issues = check(v, json, []); return issues.length > 0 ? { issues } : { value: v } } },
    toJSONSchema: () => json,
  }
}

/** The codes of the boot error `ready()` rejects with, or `[]` when it boots. */
async function bootCodes(a: any): Promise<string[]> {
  try {
    await a.ready()
    return []
  } catch (error) {
    if (error instanceof BootError) return (error as any).diagnostics.map((d: any) => d.code)
    return [`threw ${(error as Error)?.message}`]
  }
}

function http(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ─────────────────────────────────────────────────────────────────────────────
// Claims — what the docs say is built
// ─────────────────────────────────────────────────────────────────────────────

const CLAIMS: Readonly<Record<string, Probe>> = {
  'compiled-units': async () => {
    const a = app()
    a.get('/a/:b', () => 'ok')
    await a.ready()
    const units = a.generatedSource().map((u: any) => u.name)
    return verdict(['context', 'params:GET:/a/:b', 'pipeline:GET_/a/:b'].every((n) => units.includes(n)), units.join(', '))
  },

  'ctx-ips': async () => {
    const a = app({ trustProxy: 1 })
    a.get('/', (ctx: any) => ({ ip: ctx.ip, ips: ctx.ips, protocol: ctx.protocol }))
    const res = await a.inject('GET', '/', {
      headers: { 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' },
      remote: { address: '10.0.0.5', port: 1, family: 'IPv4' },
    })
    const body = res.json()
    return verdict(body.ip === '198.51.100.1' && body.ips.join() === '198.51.100.1,10.0.0.5' && body.protocol === 'https', JSON.stringify(body))
  },

  router: async () => {
    const a = app()
    a.paramType('hex2', { test: (s: string) => s.length === 2 && /^[0-9a-f]+$/.test(s), parse: (s: string) => s })
    a.get('/s', () => 'static')
    a.get('/n/:id<int>', (ctx: any) => ({ id: ctx.params.id }))
    a.get('/h/:c<hex2>', (ctx: any) => ({ c: ctx.params.c }))
    a.get('/f/*rest', (ctx: any) => ({ rest: ctx.params.rest }))
    a.get('/o/:x?', (ctx: any) => ({ x: ctx.params.x ?? null }))
    a.post('/m', () => 'post')
    const typed = (await a.inject('GET', '/n/7')).json().id
    const refused = (await a.inject('GET', '/n/x')).status
    const custom = (await a.inject('GET', '/h/zz')).status
    const rest = (await a.inject('GET', '/f/a/b')).json().rest
    const optional = [(await a.inject('GET', '/o')).json().x, (await a.inject('GET', '/o/1')).json().x]
    const wrong = await a.inject('GET', '/m')
    const head = (await a.inject('HEAD', '/s')).status
    const ok = typed === 7 && refused === 404 && custom === 404 && rest === 'a/b' && optional.join() === ',1' &&
      wrong.status === 405 && /POST/.test(wrong.header('allow') ?? '') && head === 200
    return verdict(ok, `int=${typed} /n/x=${refused} hex=${custom} rest=${rest} optional=${optional} 405 allow=${wrong.header('allow')} HEAD=${head}`)
  },

  // (alpha.3 audit, probe 13) — the documented, fixed behaviour now that the options are gone.
  'router-options': async () => {
    const a = app()
    a.get('/users', () => 'ok')
    const slash = (await a.inject('GET', '/users/')).status
    const upper = (await a.inject('GET', '/USERS')).status
    return verdict(slash === 200 && upper === 404, `/users/ → ${slash}, /USERS → ${upper}`)
  },

  'regex-unsafe': () => {
    const warned: string[] = []
    const logger = Object.assign(new NoopLogger(), { warn: (obj: any) => { warned.push(obj?.code) }, child() { return logger } })
    zen({ logger, lifecycle: false, env: {}, dev: true }).paramType('sku', { test: (s: string) => /^([A-Z]+-?)+$/.test(s), parse: (s: string) => s })
    return verdict(warned.includes('ZEN_REGEX_UNSAFE'), `warnings: ${warned.join(', ') || 'none'}`)
  },

  'boot-conflicts': async () => {
    const a = app()
    a.get('/x', { name: 'dup' }, () => 'a')
    a.get('/x', () => 'b')
    a.get('/y', { name: 'dup' }, () => 'c')
    let rendered = ''
    try { await a.ready() } catch (error) { rendered = (error as Error).message }
    return verdict(/Boot failed: [2-9] problems/.test(rendered), rendered.split('\n')[0] ?? 'booted')
  },

  'express-spellings': async () => {
    const a = app()
    a.all('/any', (ctx: any) => ctx.method)
    const both = [(await a.inject('GET', '/any')).text(), (await a.inject('POST', '/any')).text()]
    const handle = await a.listen(0)
    const live = await http(`${handle.url}/any`)
    await a.close()
    return verdict(both.join() === 'GET,POST' && live.status === 200, `all → ${both}, listen(0) → ${live.status}`)
  },

  'middleware-scopes': async () => {
    const order: string[] = []
    const Seen = slot('claims.scopes')
    const a = app()
    a.use(() => { order.push('app') })
    a.around(async (_ctx: any, next: any) => { order.push('around'); return next() })
    a.after((_ctx: any, reply: any) => { order.push('after'); return reply })
    a.collection('/c', (c: any) => {
      c.use((ctx: any) => { order.push('collection'); ctx.set(Seen, 'slot') })
      c.get('/r', { use: [() => { order.push('route') }] }, (ctx: any) => { order.push(`handler:${ctx.get(Seen)}`); return 'ok' })
    })
    await a.inject('GET', '/c/r')
    return verdict(order.join() === 'app,around,collection,route,handler:slot,after', order.join(' → '))
  },

  'route-use': async () => {
    const a = app()
    a.get('/owned/:id', { use: [function checkOwnership() {}] }, () => 'ok')
    await a.ready()
    const text = explainRoute(a.graph().routes[0])
    return verdict(/\[route\]\s+checkOwnership/.test(text), text.split('\n').find((l: string) => l.includes('checkOwnership')) ?? 'not listed')
  },

  'collection-when': async () => {
    const seen: unknown[] = []
    const a = app({ env: { DEBUG_ROUTES: 'off' } })
    a.collection('/debug', { when: (env: any) => { seen.push(env.DEBUG_ROUTES); return env.DEBUG_ROUTES === 'on' } }, (c: any) => { c.get('/state', () => 'x') })
    a.get('/', () => 'root')
    const status = (await a.inject('GET', '/debug/state')).status
    const paths = a.graph().routes.map((r: any) => r.path)
    return verdict(status === 404 && paths.join() === '/' && seen.join() === 'off', `GET /debug/state → ${status}; graph routes ${paths}`)
  },

  hooks: async () => {
    const order: string[] = []
    const a = app()
    const mark = (name: string) => () => { order.push(name) }
    for (const phase of ['onRequest', 'onRoute', 'onParse', 'preValidation', 'postValidation', 'preHandler', 'postHandler', 'onSend', 'onResponse']) {
      a.hook(phase, phase === 'onParse' ? () => { order.push('onParse'); return { parsed: true } } : mark(phase))
    }
    a.hook('onSerialize', (_ctx: any, payload: unknown) => { order.push('onSerialize'); return payload })
    a.hook('onError', mark('onError'))
    a.hook('onTimeout', mark('onTimeout'))
    a.post('/x', { body: schema(() => true) }, () => ({ ok: true }))
    a.get('/boom', () => { throw new Error('x') })
    a.get('/slow', { timeout: '10ms' }, async (ctx: any) => { await new Promise((r) => ctx.signal.addEventListener('abort', r)); return 'late' })
    await a.inject('POST', '/x', { body: { a: 1 } })
    const success = order.splice(0).join()
    await a.inject('GET', '/boom')
    await a.inject('GET', '/slow')
    // A blown deadline nobody answers is an ordinary ZEN_TIMEOUT error after
    // its onTimeout hooks have run, so onError sees it too (§4.4).
    const failures = order.filter((p) => p === 'onError' || p === 'onTimeout').join()
    const expected = 'onRequest,onRoute,onParse,preValidation,postValidation,preHandler,postHandler,onSerialize,onSend,onResponse'
    return verdict(success === expected && failures === 'onError,onTimeout,onError', `${success} | throw → onError; deadline → onTimeout, onError: ${failures}`)
  },

  // (alpha.3 audit, probe 1)
  'onboot-hook': async () => {
    const a = app()
    let called = false
    a.hook('onBoot', () => { called = true })
    a.get('/', () => 'ok')
    await a.ready()
    return verdict(called, `hook called=${called}`)
  },

  'unmatched-hooks': async () => {
    let seen = 0
    const a = app()
    a.hook('onRequest', () => { seen++ })
    a.get('/', () => 'ok')
    const status = (await a.inject('GET', '/nothing-here')).status
    return verdict(status === 404 && seen === 1, `404 ran onRequest ${seen}×`)
  },

  deadlines: async () => {
    let aborted = false
    let left = -1
    const a = app()
    a.collection('/api', { timeout: '1s' }, (c: any) => {
      c.get('/slow', { timeout: '20ms' }, async (ctx: any) => {
        left = ctx.timeLeft
        await new Promise((r) => ctx.signal.addEventListener('abort', r))
        aborted = ctx.signal.aborted
        return 'late'
      })
    })
    const status = (await a.inject('GET', '/api/slow')).status
    return verdict(status === 504 && aborted && left > 0 && left <= 20, `status=${status} aborted=${aborted} timeLeft=${left}`)
  },

  health: async () => {
    const a = app()
    a.health('db', async () => ({ status: 'fail', message: 'down' }))
    a.use(healthPlugin, { path: '/healthz', readiness: '/readyz' })
    const live = (await a.inject('GET', '/healthz')).status
    const ready = (await a.inject('GET', '/readyz')).status
    return verdict(live === 200 && ready === 503, `/healthz → ${live}, /readyz → ${ready}`)
  },

  plugins: async () => {
    const order: string[] = []
    const p = (name: string, extra: Record<string, unknown> = {}) => definePlugin({ name, version: '1.0.0', setup() { order.push(name) }, ...extra })
    const a = app()
    a.use(p('c', { dependsOn: { b: '^1' } }))
    a.use(p('b', { dependsOn: { a: '^1' }, setup(r: any) { order.push('b'); r.decorate('tenant', () => 'acme') } }))
    a.use(p('a'))
    a.get('/', (ctx: any) => ctx.tenant)
    const tenant = (await a.inject('GET', '/')).text()
    const cycle = resolvePlugins(
      [p('x', { dependsOn: { y: '*' } }), p('y', { dependsOn: { x: '*' } })].map((plugin, i) => ({ plugin, options: undefined, order: i })),
      DEFAULT_CAPABILITIES,
    ).diagnostics.map((d: any) => d.code)
    return verdict(order.join() === 'a,b,c' && tenant === 'acme' && cycle.includes('ZEN_PLUGIN_CYCLE'), `setup order ${order}, decoration ${tenant}, cycle ${cycle}`)
  },

  // (alpha.3 audit, probe 2)
  'plugin-options': async () => {
    let seen: unknown
    const a = app()
    a.use(definePlugin({
      name: 'p', version: '1.0.0',
      options: shaped({ type: 'object', properties: { limit: { type: 'number' } } }),
      setup(_r: any, o: unknown) { seen = o },
    }), { limt: 100 })
    a.get('/', () => 'ok')
    const codes = await bootCodes(a)
    return verdict(codes.includes('ZEN_PLUGIN_OPTIONS') && seen === undefined, `boot=${codes.join(',') || 'booted'}, setup got ${JSON.stringify(seen)}`)
  },

  'adapter-caps': async () => {
    const fsless = { name: 'fsless', caps: { ...DEFAULT_CAPABILITIES, fs: false }, listen: () => Promise.reject(new Error('unused')) }
    const a = app({ adapter: fsless })
    a.use(definePlugin({ name: 'uploads', version: '1.0.0', requires: { fs: true }, setup() {} }))
    a.get('/', () => 'ok')
    const codes = await bootCodes(a)
    const honest = NODE_CAPABILITIES.compression === 'none' && NODE_CAPABILITIES.websocket === 'none'
    return verdict(codes.includes('ZEN_CAPABILITY_UNAVAILABLE') && honest, `boot=${codes.join(',') || 'booted'}, node compression=${NODE_CAPABILITIES.compression} websocket=${NODE_CAPABILITIES.websocket}`)
  },

  di: async () => {
    const events: string[] = []
    const Tx = token('claims.tx')
    const a = app()
    a.provide(Tx, { lifetime: 'scoped', factory: () => ({}), dispose: () => { events.push('dispose') } })
    a.get('/', (ctx: any) => { ctx.resolve(Tx); return 'ok' })
    a.hook('onResponse', () => { events.push('response') })
    await a.inject('GET', '/')
    const Scoped = token('claims.scoped')
    const Single = token('claims.single')
    const captive = app()
    captive.provide(Scoped, { lifetime: 'scoped', factory: () => 1 })
    captive.provide(Single, { lifetime: 'singleton', deps: [Scoped], factory: (n: number) => n })
    captive.get('/', () => 'ok')
    const codes = await bootCodes(captive)
    return verdict(events.join() === 'response,dispose' && codes.length > 0, `scoped: ${events}; captive dependency → ${codes.join(',') || 'booted'}`)
  },

  'intrinsic-dispose': async () => {
    const released: string[] = []
    const Pool = token('claims.pool')
    const Conn = slot('claims.conn')
    const a = app()
    a.provide(Pool, { factory: () => ({ [Symbol.asyncDispose]: async () => { released.push('singleton') } }) })
    a.get('/', (ctx: any) => { ctx.resolve(Pool); ctx.set(Conn, { [Symbol.dispose]: () => { released.push('slot') } }); return 'ok' })
    await a.inject('GET', '/')
    await a.close()
    return verdict(released.join() === 'slot,singleton', `released: ${released.join(', ') || 'nothing'}`)
  },

  'validation-envelopes': async () => {
    const a = app()
    a.post('/u', { body: shaped({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }) }, () => 'ok')
    const res = await a.inject('POST', '/u', { body: { n: 'x' } })
    const problem = res.json()
    return verdict(res.status === 422 && /problem\+json/.test(res.header('content-type') ?? '') && problem.errors?.[0]?.path?.join() === 'n',
      `${res.status} ${res.header('content-type')} errors[0].path=${problem.errors?.[0]?.path}`)
  },

  // (alpha.3 audit, probe 5) — with a schema Zen can describe; an opaque one is the library's to judge.
  'params-mismatch': async () => {
    const a = app()
    a.get('/users/:id', { params: shaped({ type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] }) }, () => 'ok')
    const codes = await bootCodes(a)
    return verdict(codes.includes('ZEN_PARAM_MISMATCH'), `boot=${codes.join(',') || 'booted'}`)
  },

  // (alpha.3 audit, probe 12)
  '503-code': () => {
    const code = new ServiceUnavailable().code
    return verdict(code === 'ZEN_SERVICE_UNAVAILABLE', `503 → ${code}`)
  },

  'abort-classification': async () => {
    const a = app()
    a.get('/upstream', async () => { const signal = AbortSignal.timeout(1); await delay(15); throw signal.reason })
    a.get('/own', () => { const c = new AbortController(); c.abort(); throw c.signal.reason })
    const upstream = await a.inject('GET', '/upstream')
    const own = await a.inject('GET', '/own')
    return verdict(upstream.status === 503 && upstream.json().code === 'ZEN_SERVICE_UNAVAILABLE' && own.status === 500,
      `upstream timeout → ${upstream.status} ${upstream.json().code}, own abort → ${own.status}`)
  },

  coercion: async () => {
    const a = app()
    a.get('/q', { query: shaped({ type: 'object', properties: { page: { type: 'integer' }, sku: { type: 'string' } } }) },
      (ctx: any) => ({ page: ctx.query.page, sku: ctx.query.sku, pageType: typeof ctx.query.page }))
    const body = (await a.inject('GET', '/q?page=2&sku=00713')).json()
    return verdict(body.page === 2 && body.pageType === 'number' && body.sku === '00713', JSON.stringify(body))
  },

  config: async () => {
    const Env = shaped({ type: 'object', properties: { API_KEY: { type: 'string', format: 'password' } }, required: ['API_KEY'] })
    const defs = defineConfig({ env: Env, upstream: { key: (env: any) => env.API_KEY } })
    const a = app({ config: defs, env: { API_KEY: 'sk_live_claims' } })
    a.get('/', (ctx: any) => ({ readable: ctx.config.upstream.key === 'sk_live_claims' }))
    const readable = (await a.inject('GET', '/')).json().readable
    const leaked = JSON.stringify(a.config).includes('sk_live_claims') || JSON.stringify(a.graph().config).includes('sk_live_claims')
    const missing = app({ config: defs, env: {} })
    missing.get('/', () => 'ok')
    const codes = await bootCodes(missing)
    return verdict(readable && !leaked && codes.includes('ZEN_ENV_INVALID'), `readable=${readable} leaked=${leaked} missing env → ${codes.join(',')}`)
  },

  'middleware-pack': async () => {
    const a = app()
    a.use(cors({ origin: ['https://app.example'] }))
    a.use(rateLimit({ limit: 1, window: '1m' }))
    a.get('/', () => 'ok')
    const preflight = await a.inject('OPTIONS', '/no-route', { headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } })
    await a.inject('GET', '/flood', { headers: { origin: 'https://app.example' } })
    const limited = await a.inject('GET', '/flood', { headers: { origin: 'https://app.example' } })
    const misspelt = app()
    misspelt.use(rateLimit({ limt: 100 }))
    misspelt.get('/', () => 'ok')
    const codes = await bootCodes(misspelt)
    const ok = preflight.status === 204 && preflight.header('access-control-allow-origin') === 'https://app.example' &&
      limited.status === 429 && limited.header('access-control-allow-origin') === 'https://app.example' && codes.includes('ZEN_PLUGIN_OPTIONS')
    return verdict(ok, `preflight to no route → ${preflight.status}; 404 flood → ${limited.status} with ACAO=${limited.header('access-control-allow-origin')}; limt → ${codes}`)
  },

  negotiation: async () => {
    Z.registerMediaEncoder('text/csv', () => (rows: any) => rows.map((r: any) => r.id).join('\n'))
    const Rows = jsonSchema({ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } })
    const a = app()
    a.get('/rows', { response: { 200: { 'application/json': Rows, 'text/csv': Rows } } }, () => [{ id: 1 }, { id: 2 }])
    a.get('/plain', { response: { 200: Rows } }, () => [{ id: 1 }])
    const csv = await a.inject('GET', '/rows', { headers: { accept: 'text/csv' } })
    const refused = await a.inject('GET', '/rows', { headers: { accept: 'image/png' } })
    await a.ready()
    const plain = a.generatedSource().find((u: any) => u.name === 'pipeline:GET_/plain')?.source ?? ''
    const ok = csv.text() === '1\n2' && /accept/i.test(csv.header('vary') ?? '') && refused.status === 406 &&
      /accept/i.test(refused.header('vary') ?? '') && !/negotiat/i.test(plain)
    return verdict(ok, `csv=${JSON.stringify(csv.text())} vary=${csv.header('vary')} 406 vary=${refused.header('vary')}`)
  },

  serializers: async () => {
    const a = app()
    a.get('/u', { response: { 200: jsonSchema({ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }) } },
      () => ({ id: 1, passwordHash: 'x' }))
    const text = (await a.inject('GET', '/u')).text()
    return verdict(text === '{"id":1}', text)
  },

  'write-only': async () => {
    const a = app()
    a.get('/me', { response: { 200: jsonSchema({ type: 'object', properties: { password: { type: 'string', writeOnly: true } } }) } }, () => ({}))
    const codes = await bootCodes(a)
    return verdict(codes.includes('ZEN_RESPONSE_WRITE_ONLY'), `boot=${codes.join(',') || 'booted'}`)
  },

  'injection-defences': async () => {
    const rendered = String(html`<p>${'<script>alert(1)</script>'}</p>`)
    const a = app()
    a.get('/go', (ctx: any) => ctx.redirect('https://evil.example/'))
    a.get('/page', (ctx: any) => ctx.html(html`<b>${'<i>'}</b>`))
    const away = await a.inject('GET', '/go')
    const page = await a.inject('GET', '/page')
    const ok = !rendered.includes('<script>') && away.status === 500 && page.text() === '<b>&lt;i&gt;</b>'
    return verdict(ok, `escaped=${!rendered.includes('<script>')} external redirect → ${away.status} page=${page.text()}`)
  },

  'url-generation': async () => {
    const a = app()
    a.get('/users/:id<int>', { name: 'users.show' }, () => 'ok')
    a.get('/users/me', () => 'me')
    await a.ready()
    const link = a.url('users.show', { id: 7 }, { tab: 'a b' })
    let refused = ''
    try { a.url('users.show', { id: 'me' }) } catch (error) { refused = (error as any).code }
    return verdict(link === '/users/7?tab=a%20b' && refused !== '', `link=${link} refused=${refused}`)
  },

  openapi: async () => {
    const User = jsonSchema({ title: 'User', type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] })
    const before = app()
    before.get('/users', { response: { 200: User } }, () => ({ id: 1 }))
    before.get('/users/:id', { response: { 200: User } }, () => ({ id: 1 }))
    await before.ready()
    const after = app()
    after.get('/users', { response: { 200: User } }, () => ({ id: 1 }))
    await after.ready()
    const a = OAS.openapiDocument(before.graph(), { title: 't', version: '1' }).document as any
    const b = OAS.openapiDocument(after.graph(), { title: 't', version: '1' }).document as any
    const refs = JSON.stringify(a).match(/#\/components\/schemas\/User/g)?.length ?? 0
    const breaking = OAS.diffDocuments(a, b).breaking.length
    return verdict(a.openapi === '3.1.0' && refs >= 2 && breaking > 0, `openapi ${a.openapi}, User refs ${refs}, breaking changes on removing a path ${breaking}`)
  },

  // (alpha.3 audit, probe 3)
  'plugin-meta': async () => {
    const a = app()
    a.use(definePlugin({ name: 'm', version: '1.0.0', setup(r: any) { r.meta('answer', 42); r.meta('openapi.securitySchemes', { bearer: { type: 'http', scheme: 'bearer' } }) } }))
    a.get('/', () => 'ok')
    await a.ready()
    const doc = OAS.openapiDocument(a.graph(), { title: 't', version: '1' }).document as any
    const scheme = doc.components?.securitySchemes?.bearer?.scheme
    return verdict(a.graph().meta.get('m.answer') === 42 && scheme === 'bearer', `graph.meta.size=${a.graph().meta.size}, documented scheme=${scheme}`)
  },

  'body-intake': async () => {
    const a = app()
    a.get('/none', () => 'ok')
    a.post('/json', { body: schema(() => true) }, (ctx: any) => ({ polluted: ({} as any).polluted === true, keys: Object.keys(ctx.body) }))
    const res = await a.inject('POST', '/json', { headers: { 'content-type': 'application/json' }, body: '{"__proto__":{"polluted":true},"a":1}' })
    const none = a.generatedSource().find((u: any) => u.name === 'pipeline:GET_/none')?.source ?? ''
    const body = res.json()
    return verdict(!/intake/.test(none) && body.polluted === false && body.keys.join() === 'a', `no-body route intake=${/intake/.test(none)}; ${JSON.stringify(body)}`)
  },

  'node-adapter': async () => {
    let aborted = false
    const a = app()
    a.get('/hang', async (ctx: any) => { await new Promise((r) => ctx.signal.addEventListener('abort', r)); aborted = true; return 'x' })
    const handle = await a.listen(0)
    await new Promise<void>((resolve) => {
      const req = request(`${handle.url}/hang`, { agent: false })
      req.on('error', () => {})
      req.end()
      setTimeout(() => { req.destroy(); resolve() }, 30)
    })
    for (let i = 0; i < 50 && !aborted; i++) await delay(10)
    await a.close()
    return verdict(aborted, `ctx.signal aborted on disconnect: ${aborted}`)
  },

  sse: async () => {
    const a = app()
    a.get('/events', (ctx: any) => { const sse = ctx.sse({ keepAlive: 0 }); sse.send({ event: 'e', data: { a: 1 } }); sse.close(); return sse })
    const res = await a.inject('GET', '/events')
    let text = ''
    for await (const frame of res.reply.body.channel) text += new TextDecoder().decode(frame)
    return verdict(/text\/event-stream/.test(res.header('content-type') ?? '') && text === 'event: e\ndata: {"a":1}\n\n',
      `${res.header('content-type')} ${JSON.stringify(text)}`)
  },

  files: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zen-claims-'))
    await writeFile(join(dir, 'a.txt'), '0123456789')
    const a = app()
    a.get('/f/*path', (ctx: any) => ctx.file(ctx.params.path, { root: dir }))
    const handle = await a.listen(0)
    try {
      const full = await http(`${handle.url}/f/a.txt`)
      const again = await http(`${handle.url}/f/a.txt`, { headers: { 'if-none-match': full.headers['etag'] } })
      const range = await http(`${handle.url}/f/a.txt`, { headers: { range: 'bytes=2-4' } })
      const escape = await http(`${handle.url}/f/..%2F..%2Fetc%2Fpasswd`)
      const ok = full.status === 200 && full.body === '0123456789' && again.status === 304 && range.status === 206 && range.body === '234' && escape.status === 404
      return verdict(ok, `200 → 304 on ETag, 206 "${range.body}", escape → ${escape.status}`)
    } finally {
      await a.close()
      await rm(dir, { recursive: true, force: true })
    }
  },

  'process-lifecycle': async () => {
    const controller = new AbortController()
    const a = app()
    a.get('/', () => 'ok')
    const handle = await a.listen({ port: 0, signal: controller.signal })
    const before = (await http(`${handle.url}/`)).status
    controller.abort()
    let after = 'refused'
    for (let i = 0; i < 50; i++) {
      try { await http(`${handle.url}/`); after = 'still accepting' } catch { after = 'refused'; break }
      await delay(10)
    }
    return verdict(before === 200 && after === 'refused', `before abort ${before}, after: ${after}`)
  },

  inject: async () => {
    const a = app()
    a.get('/', (ctx: any) => ctx.ip)
    a.get('/stream', () => (async function* () { yield 'a'; yield 'b' })())
    const ip = (await a.inject('GET', '/', { remote: { address: '203.0.113.9', port: 1, family: 'IPv4' } })).text()
    // `text()` reads what is already in hand; a stream is read from the reply.
    const reply = (await a.inject('GET', '/stream')).reply
    let streamed = ''
    for await (const chunk of reply.body.value) streamed += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    // A script with nothing else alive, awaiting an inject() that only its
    // deadline can answer — the case a socket's open handle used to cover.
    const idle = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { zen, NoopLogger } = await import('@erenthedeveloper0/zen')
      const app = zen({ logger: new NoopLogger(), lifecycle: false, env: {} })
      app.get('/slow', { timeout: '20ms' }, (ctx) => new Promise((r) => ctx.signal.addEventListener('abort', () => r('late'))))
      console.log((await app.inject('GET', '/slow')).status)
    `], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
    const answered = idle.status === 0 && idle.stdout.trim() === '504'
    return verdict(ip === '203.0.113.9' && reply.body.kind === 'stream' && streamed === 'ab' && answered,
      `remote ip=${ip}, ${reply.body.kind} body=${streamed}, idle script awaiting a deadline → exit ${idle.status}, printed ${JSON.stringify(idle.stdout.trim())}`)
  },

  'graceful-shutdown': async () => {
    let acceptingAtDispose = true
    const Pool = token('claims.shutdown')
    const a = app()
    let url = ''
    a.provide(Pool, {
      factory: () => ({}),
      dispose: async () => {
        try { await http(`${url}/`); acceptingAtDispose = true } catch { acceptingAtDispose = false }
      },
    })
    a.get('/', (ctx: any) => { ctx.resolve(Pool); return 'ok' })
    const handle = await a.listen(0)
    url = handle.url
    await http(`${url}/`)
    await a.close()
    return verdict(!acceptingAtDispose, `server still accepting when the singleton was disposed: ${acceptingAtDispose}`)
  },

  twins: async () => {
    const build = (caps?: unknown) => {
      const a = app(caps === undefined ? {} : { caps })
      a.use(() => {})
      a.get('/n/:id<int>', { response: { 200: jsonSchema({ type: 'object', properties: { id: { type: 'integer' } } }) } }, (ctx: any) => ({ id: ctx.params.id, extra: 1 }))
      a.get('/q', (ctx: any) => ({ q: ctx.query.a }))
      return a
    }
    const compiled = build()
    const interpreted = build({ ...DEFAULT_CAPABILITIES, eval: false })
    const out: string[] = []
    for (const target of ['/n/5', '/q?a=1&a=2', '/n/x', '/missing']) {
      const [x, y] = [await compiled.inject('GET', target), await interpreted.inject('GET', target)]
      out.push(`${target}:${x.status === y.status && x.text().replace(/"requestId":"[^"]+"/, '') === y.text().replace(/"requestId":"[^"]+"/, '')}`)
    }
    return verdict(out.every((o) => o.endsWith('true')), `compiled ≡ interpreted: ${out.join(' ')}`)
  },

  // (alpha.3 audit, probe 6)
  'reply-sent': async () => {
    const a = app()
    let kept: any
    a.get('/', (ctx: any) => { kept = ctx; return 'ok' })
    await a.inject('GET', '/')
    let outcome = 'accepted silently'
    try { kept.res.header('x-late', '1') } catch (error) { outcome = (error as any).code }
    return verdict(outcome === 'ZEN_REPLY_SENT', outcome)
  },

  'sync-fast-path': async () => {
    const a = app()
    a.get('/marked', markSync(() => 'x'))
    a.get('/plain', () => 'x')
    await a.ready()
    const source = (name: string) => a.generatedSource().find((u: any) => u.name === name)?.source ?? ''
    const marked = !/async function/.test(source('pipeline:GET_/marked'))
    const plain = /async function/.test(source('pipeline:GET_/plain'))
    return verdict(marked && plain, `markSync route synchronous=${marked}; plain function on the async path=${plain}`)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Gaps — what the docs admit is not built. Each probe returns ok while the gap
// is still there; the day it closes, the docs are wrong in the other direction.
// ─────────────────────────────────────────────────────────────────────────────

const GAPS: Readonly<Record<string, Probe>> = {
  // (alpha.3 audit, probe 4)
  'route-origin': async () => {
    const a = app()
    a.get('/users/:id<int>', () => 'ok')
    await a.ready()
    const origin = a.graph().routes[0].origin
    return verdict(origin === undefined, `origin=${JSON.stringify(origin)}`)
  },

  // (alpha.3 audit, probe 7)
  'middleware-when': async () => {
    let ran = 0
    const a = app()
    a.use(() => { ran++ }, { name: 'gated', when: () => false })
    a.get('/', () => 'ok')
    await a.inject('GET', '/')
    return verdict(ran === 1, `ran ${ran}× with when: () => false`)
  },

  // (alpha.3 audit, probe 8)
  'router-codegen': async () => {
    const a = app()
    a.get('/a/:b/c/:d', () => 'ok')
    await a.ready()
    const units = a.generatedSource().map((u: any) => u.name)
    return verdict(!units.some((n: string) => /router|matcher/.test(n)), units.join(', '))
  },

  // (alpha.3 audit, probe 9)
  'ctx-log': async () => {
    let child = 0
    const base = new NoopLogger()
    const logger = Object.assign(Object.create(Object.getPrototypeOf(base)), base, { child() { child++; return this } })
    const a = zen({ logger, lifecycle: false, env: {} })
    let same = false
    a.get('/', (ctx: any) => { same = ctx.log === logger; return 'ok' })
    await a.inject('GET', '/')
    return verdict(same && child === 0, `same logger=${same}, child() calls=${child}`)
  },

  // (alpha.3 audit, probe 10)
  'whatwg-response': async () => {
    const a = app()
    a.get('/', () => new Response('hello', { status: 201 }))
    const status = (await a.inject('GET', '/')).status
    return verdict(status !== 201, `status=${status}`)
  },

  // (alpha.3 audit, probe 11)
  'issue-codes': () => {
    const issues = normaliseIssues([{ message: 'Too small: expected number to be >=1', path: ['page'] }], 'query')
    return verdict(issues[0].code !== 'min', `code=${issues[0].code} (a mapper would say min)`)
  },

  // (alpha.3 audit, probe 14)
  'per-route-body-limit': async () => {
    const a = app()
    a.post('/upload', { body: schema(() => true), bodyLimit: 10, maxBodySize: 10 }, () => 'ok')
    const status = (await a.inject('POST', '/upload', { body: { big: 'x'.repeat(200) } })).status
    return verdict(status === 200, `10-byte route limit → ${status}`)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// The docs side
// ─────────────────────────────────────────────────────────────────────────────

const DOCS = ['README.md', 'ARCHITECTURE.md'] as const
const MARKER = /<!--\s*(claim|gap):\s*([^>]*?)\s*-->/g

const failures: string[] = []
const marked = { claim: new Map<string, string[]>(), gap: new Map<string, string[]>() }

for (const doc of DOCS) {
  const lines = readFileSync(join(ROOT, doc), 'utf8').split('\n')
  let inWorkingToday = false
  lines.forEach((line, index) => {
    const where = `${doc}:${index + 1}`
    for (const match of line.matchAll(MARKER)) {
      const kind = match[1] as 'claim' | 'gap'
      for (const id of (match[2] as string).split(',').map((s) => s.trim()).filter(Boolean)) {
        const list = marked[kind].get(id) ?? []
        list.push(where)
        marked[kind].set(id, list)
      }
    }
    if (doc === 'README.md') {
      if (/^### /.test(line)) inWorkingToday = line.trim() === '### Working today'
      if (inWorkingToday && line.startsWith('- ') && !/<!--\s*claim:/.test(line)) {
        failures.push(`${where}  a "Working today" bullet with no <!-- claim: id --> — what checks it?\n    ${line.slice(0, 100)}`)
      }
    }
    if (doc === 'ARCHITECTURE.md' && line.startsWith('> **Status') && !/<!--\s*claim:/.test(line)) {
      failures.push(`${where}  a Status block with no <!-- claim: id -->\n    ${line.slice(0, 100)}`)
    }
  })
}

for (const [kind, table] of [['claim', CLAIMS], ['gap', GAPS]] as const) {
  for (const [id, where] of marked[kind]) {
    if (table[id] === undefined) failures.push(`${where.join(', ')}  <!-- ${kind}: ${id} --> names no probe in scripts/claims.ts`)
  }
  for (const id of Object.keys(table)) {
    if (!marked[kind].has(id)) failures.push(`scripts/claims.ts  the ${kind} "${id}" is marked nowhere in ${DOCS.join(' or ')} — remove it, or mark the sentence it checks`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

async function run(probe: Probe): Promise<Verdict> {
  try {
    return await probe()
  } catch (error) {
    return verdict(false, `the probe threw: ${(error as Error)?.stack?.split('\n').slice(0, 2).join(' ') ?? String(error)}`)
  }
}

const only = process.argv[2]
const selected = (table: Readonly<Record<string, Probe>>) =>
  Object.entries(table).filter(([id]) => only === undefined || id.includes(only))

let held = 0
for (const [id, probe] of selected(CLAIMS)) {
  const result = await run(probe)
  console.log(`${result.ok ? 'ok  ' : 'FAIL'}  claim  ${id.padEnd(22)} ${result.observed}`)
  if (result.ok) held++
  else failures.push(`claim "${id}" (${(marked.claim.get(id) ?? []).join(', ')}) does not hold: ${result.observed}`)
}
let open = 0
for (const [id, probe] of selected(GAPS)) {
  const result = await run(probe)
  console.log(`${result.ok ? 'gap ' : 'SHUT'}  gap    ${id.padEnd(22)} ${result.observed}`)
  if (result.ok) open++
  else failures.push(`gap "${id}" (${(marked.gap.get(id) ?? []).join(', ')}) has closed: ${result.observed}\n    fix: it is built now — make it a claim, and correct the sentences that call it missing`)
}

console.log(`\n${held}/${selected(CLAIMS).length} claims hold; ${open}/${selected(GAPS).length} admitted gaps still open.`)
if (failures.length > 0) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log('Every documented claim has a probe, and every probe agrees with the documentation.')
process.exit(0)
