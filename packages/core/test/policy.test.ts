import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { BootError, CONFIG_DEFAULTS, BODY_DEFAULTS, defineConfig, explainConfig, type Logger } from '@erenthedeveloper0/zen-core'
import { nodeAdapter } from '@erenthedeveloper0/zen-adapter-node'
import { here, makeApp, shaped } from './helpers.ts'

/**
 * Request policy as configuration, and the hardened profile — rfcs/0001
 * §16.1, §19.2. Every value the policy holds has a layer and a source, so
 * "where did this 30-second budget come from" is a question `explainConfig`
 * answers.
 */

const row = (app: ReturnType<typeof makeApp>, path: string) => app.graph().config.values.find((v) => v.path === path)

function recorder(): { logger: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = []
  const at = (level: string) => (a: unknown, b?: string): void => { lines.push({ level, msg: typeof a === 'string' ? a : (b ?? '') }) }
  const logger: Logger = {
    level: 'trace',
    child: () => logger,
    trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal'),
  }
  return { logger, lines }
}

describe('policy is configuration, with a source (§16.1)', () => {
  test('the framework defaults are layer 1, and agree with the runtime’s own', async () => {
    const app = makeApp()
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(row(app, 'policy.timeout.default')?.value, false)
    assert.equal(row(app, 'policy.timeout.default')?.layer, 'default')
    assert.equal(row(app, 'policy.trustProxy')?.value, false)
    assert.deepEqual((CONFIG_DEFAULTS['policy'] as { body: unknown }).body, BODY_DEFAULTS, 'one set of numbers, two places')
  })

  test("zen({ timeout, body, redirect, trustProxy, maxQueryParams }) contributes under the source zen()", async () => {
    const app = makeApp({
      timeout: '5s',
      body: { maxSize: 64 },
      redirect: { allowExternal: ['https://accounts.example'] },
      trustProxy: 1,
      maxQueryParams: 10,
    })
    app.post('/in', { body: shaped({ type: 'object' }) }, () => 'ok')
    await app.ready()
    for (const [path, value] of [
      ['policy.timeout.default', '5s'],
      ['policy.body.maxSize', 64],
      ['policy.trustProxy', 1],
      ['policy.maxQueryParams', 10],
    ] as const) {
      assert.equal(row(app, path)?.value, value, path)
      assert.equal(row(app, path)?.source, 'zen()', path)
    }
    assert.deepEqual(row(app, 'policy.redirect.allowExternal')?.value, ['https://accounts.example'])
    assert.match(explainConfig(app.graph().config), /policy\.timeout\.default\s+5s\s+← zen\(\)/)
    // …and they are what runs.
    assert.equal((await app.inject('POST', '/in', { body: { x: 'y'.repeat(100) } })).status, 413)
  })

  test('the configuration file beats zen() in the same layer; overrides beat both', async () => {
    const config = defineConfig({ policy: { timeout: { default: '2s' } } })
    const fromFile = makeApp({ timeout: '5s', config })
    fromFile.get('/', () => 'ok')
    await fromFile.ready()
    assert.equal(row(fromFile, 'policy.timeout.default')?.value, '2s')
    assert.equal(row(fromFile, 'policy.timeout.default')?.source, 'zen.config')
    assert.equal(fromFile.graph().routes[0]?.timeout?.ms, 2000, 'and it is the deadline the route got')

    const overridden = makeApp({ timeout: '5s', config, overrides: { policy: { timeout: { default: '1s' } } } })
    overridden.get('/', () => 'ok')
    await overridden.ready()
    assert.equal(overridden.graph().routes[0]?.timeout?.ms, 1000)
  })

  test('the redirect allowlist rides it: set in configuration, enforced by ctx.redirect()', async () => {
    const config = defineConfig({ policy: { redirect: { allowExternal: ['https://id.example'] } } })
    const app = makeApp({ config })
    app.get('/go', (ctx) => ctx.redirect('https://id.example/login'))
    app.get('/evil', (ctx) => ctx.redirect('https://evil.example/'))
    assert.equal((await app.inject('GET', '/go')).status, 302)
    assert.equal((await app.inject('GET', '/evil')).json<{ code: string }>().code, 'ZEN_REDIRECT_EXTERNAL')
    assert.equal(row(app, 'policy.redirect.allowExternal')?.source, 'zen.config')
  })

  test('a malformed allowlist entry in the configuration file is refused at its defineConfig', async () => {
    const config = defineConfig({ policy: { redirect: { allowExternal: ['https://id.example/'] } } }); const at = here()
    const app = makeApp({ config })
    app.get('/', () => 'ok')
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const diagnostic = error.diagnostics.find((d) => d.code === 'ZEN_CONFIG_INVALID')
    assert.equal(diagnostic?.origins?.[0]?.line, at.line)
  })

  test('trustProxy and maxQueryParams from configuration are what a context reads', async () => {
    const config = defineConfig({ policy: { trustProxy: 1, maxQueryParams: 2 } })
    const app = makeApp({ config })
    app.get('/who', (ctx) => ({ ip: ctx.ip, keys: Object.keys(ctx.query).length }))
    const res = await app.inject('GET', '/who?a=1&b=2&c=3', { headers: { 'x-forwarded-for': '203.0.113.9' } })
    assert.deepEqual(res.json(), { ip: '203.0.113.9', keys: 2 })
  })

  test('a value the policy cannot honour is refused, naming the path and its source', async () => {
    const app = makeApp({ config: defineConfig({ policy: { body: { maxSize: -5 }, trustProxy: 'yes' } }) })
    app.get('/', () => 'ok')
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError)
    const locations = error.diagnostics.filter((d) => d.code === 'ZEN_CONFIG_INVALID').flatMap((d) => d.locations ?? [])
    assert.deepEqual(locations.sort(), ['policy.body.maxSize ← zen.config', 'policy.trustProxy ← zen.config'])
  })

  test('the HTTP ingress limits reach the adapter, and an explicit adapter option still wins', async () => {
    const long = `/${'a'.repeat(200)}`
    const fromConfig = makeApp({ adapter: nodeAdapter(), config: defineConfig({ policy: { http: { maxUrlLength: 100 } } }) })
    fromConfig.get(long, () => 'ok')
    const handle = await fromConfig.listen({ port: 0 })
    try {
      assert.equal(await status(`${handle.url}${long}`), 414)
    } finally {
      await fromConfig.close()
    }
    const explicit = makeApp({ adapter: nodeAdapter({ maxUrlLength: 1000 }), config: defineConfig({ policy: { http: { maxUrlLength: 100 } } }) })
    explicit.get(long, () => 'ok')
    const second = await explicit.listen({ port: 0 })
    try {
      assert.equal(await status(`${second.url}${long}`), 200)
    } finally {
      await explicit.close()
    }
  })
})

describe("zen({ profile: 'hardened' }) (§19.2)", () => {
  test('its values come from a named source in layer 1, beaten by anything later', async () => {
    const app = makeApp({ profile: 'hardened', trustProxy: false })
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(row(app, 'policy.timeout.default')?.value, '30s')
    assert.equal(row(app, 'policy.timeout.default')?.source, 'profile: hardened')
    assert.equal(row(app, 'policy.http.maxRequestsPerSocket')?.value, 1000)
    assert.equal(row(app, 'validation.response')?.value, 'log', 'production: log rather than throw')
    assert.equal(app.graph().routes[0]?.timeout?.ms, 30_000)

    const beaten = makeApp({ profile: 'hardened', trustProxy: false, timeout: '2s' })
    beaten.get('/', () => 'ok')
    await beaten.ready()
    assert.equal(beaten.graph().routes[0]?.timeout?.ms, 2000)
  })

  test('in development it leaves strict serialization and throwing validation alone', async () => {
    const app = makeApp({ profile: 'hardened', trustProxy: false, dev: true })
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(row(app, 'validation.response')?.value, 'error')
    assert.equal(row(app, 'serialization.strict')?.value, true)
  })

  test('a trustProxy nobody set is warned about at boot, and the first forwarded request once', async () => {
    const { logger, lines } = recorder()
    const app = makeApp({ profile: 'hardened', logger })
    app.get('/', () => 'ok')
    await app.ready()
    assert.equal(lines.filter((l) => /hardened profile expects policy\.trustProxy/.test(l.msg)).length, 1)
    for (let i = 0; i < 3; i++) await app.inject('GET', '/', { headers: { 'x-forwarded-for': '198.51.100.1' } })
    assert.equal(lines.filter((l) => /arrived through a proxy/.test(l.msg)).length, 1)

    const { logger: quiet, lines: none } = recorder()
    const explicit = makeApp({ profile: 'hardened', logger: quiet, trustProxy: 1 })
    explicit.get('/', () => 'ok')
    await explicit.inject('GET', '/', { headers: { 'x-forwarded-for': '198.51.100.1' } })
    assert.equal(none.filter((l) => /trustProxy/.test(l.msg)).length, 0, 'said explicitly: nothing to say')
  })

  test('an unknown profile is refused where it is written', () => {
    assert.throws(() => makeApp({ profile: 'paranoid' as never }), { code: 'ZEN_CONFIG_INVALID' })
  })
})

function status(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}
