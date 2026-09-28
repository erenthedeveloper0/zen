import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BootError, DEFAULT_CAPABILITIES, classifyReference, compileRedirectPolicy, isLocalUrl, redirectRefusal,
  redirectReply, SAME_ORIGIN_ONLY,
} from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

/**
 * Redirects that stay home — rfcs/0001 §19.5.
 *
 * The open redirect is the vulnerability in almost every login flow:
 * `/login?next=https://evil.example`. The hand-written cases below are the
 * spellings that have each bypassed a check somewhere — a protocol-relative
 * `//`, a backslash, a tab the URL parser removes, a leading space it strips,
 * `https:` with no slashes — and the differential at the end compares the
 * check against the WHATWG URL parser itself over random targets, because the
 * parser is what the browser will actually use on the `Location` header.
 */

const SAME_ORIGIN = ['/dashboard', '/', '/a/b?c=d#e', '?page=2', '#top', 'relative/path', '../up', '', '/%2F%2Fevil.example', '/.//evil.example']

const LEAVES = [
  'https://evil.example', 'http://evil.example/x', '//evil.example', '///evil.example', '/\\evil.example',
  '\\\\evil.example', '\\/evil.example', '/\t/evil.example', '/\n/evil.example', ' //evil.example',
  '\x00//evil.example', 'https:evil.example', 'http:evil.example', 'HTTPS://EVIL.EXAMPLE', 'javascript:alert(1)',
  'data:text/html,x', 'https://app.example@evil.example/', 'mailto:x@evil.example',
]

function refused(render: () => unknown): string {
  try {
    render()
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'ZEN_REDIRECT_EXTERNAL', String(error))
    assert.equal((error as { status?: number }).status, 500)
    assert.equal((error as { expose?: boolean }).expose, false)
    return (error as Error).message
  }
  assert.fail('expected ZEN_REDIRECT_EXTERNAL')
}

describe('by default a redirect stays on this origin (§19.5)', () => {
  it('sends a path, a query or a fragment', () => {
    for (const target of SAME_ORIGIN) {
      assert.equal(redirectReply(target).headers.get('location'), target, JSON.stringify(target))
    }
  })

  it('refuses everything else, in every spelling that has bypassed a check', () => {
    for (const target of LEAVES) refused(() => redirectReply(target))
  })

  it('refuses an absolute URL on the application\'s own host — only the Host header could vouch for it', () => {
    refused(() => redirectReply('https://app.example/dashboard'))
  })

  it('names the origin it refused, and the fix', () => {
    const message = refused(() => redirectReply('https://evil.example/phish'))
    assert.match(message, /https:\/\/evil\.example is not in redirect\.allowExternal/)
    assert.doesNotMatch(message, /phish/, 'the path of a hostile URL is not logged')
  })

  for (const [label, caps] of [['compiled context', DEFAULT_CAPABILITIES], ['interpreted twin', { ...DEFAULT_CAPABILITIES, eval: false }]] as const) {
    it(`ctx.redirect(ctx.query.next) is not an open redirect — ${label}`, async () => {
      const app = makeApp({ caps })
      app.get('/login', (ctx) => ctx.redirect((ctx.query as Record<string, string>)['next'] ?? '/'))

      const home = await app.inject('GET', '/login?next=%2Faccount')
      assert.equal(home.status, 302)
      assert.equal(home.header('location'), '/account')

      const away = await app.inject('GET', `/login?next=${encodeURIComponent('//evil.example')}`)
      assert.equal(away.status, 500)
      assert.equal(away.header('location'), undefined, 'no Location header leaves')
      assert.equal(away.json<{ code: string }>().code, 'ZEN_REDIRECT_EXTERNAL')
    })
  }
})

describe('the status (§13.2)', () => {
  it('is 302 by default, a number as before, or part of an init object', () => {
    assert.equal(redirectReply('/x').status, 302)
    assert.equal(redirectReply('/x', 303).status, 303)
    assert.equal(redirectReply('/x', { status: 301 }).status, 301)
    assert.equal(redirectReply('/x', {}).status, 302)
  })

  it('refuses a target that is not a string, rather than redirecting to "undefined"', () => {
    assert.throws(() => redirectReply(undefined as never), TypeError)
  })
})

describe('redirect.allowExternal (§19.5)', () => {
  const { policy } = compileRedirectPolicy({ allowExternal: ['https://accounts.example', 'https://sso.example:8443'] })

  it('lets a redirect leave for a listed origin', () => {
    const reply = redirectReply('https://accounts.example/o/oauth2/auth?client_id=1', undefined, policy)
    assert.equal(reply.headers.get('location'), 'https://accounts.example/o/oauth2/auth?client_id=1')
    assert.equal(redirectReply('https://sso.example:8443/login', undefined, policy).status, 302)
  })

  it('refuses the look-alikes: a subdomain, userinfo, another scheme, another port', () => {
    for (const target of [
      'https://accounts.example.evil.com/', 'https://accounts.example@evil.com/', 'http://accounts.example/',
      'https://accounts.example:444/', 'https://sso.example/login', 'https://evil.com/?https://accounts.example',
    ]) {
      refused(() => redirectReply(target, undefined, policy))
    }
  })

  it('refuses a protocol-relative target unless both of its possible origins are listed', () => {
    refused(() => redirectReply('//accounts.example/x', undefined, policy))
    const both = compileRedirectPolicy({ allowExternal: ['http://accounts.example', 'https://accounts.example'] }).policy
    assert.equal(redirectReply('//accounts.example/x', undefined, both).status, 302)
  })

  it('true allows any http(s) target, and still no other scheme', () => {
    const any = compileRedirectPolicy({ allowExternal: true }).policy
    assert.equal(redirectReply('https://anywhere.example/', undefined, any).status, 302)
    assert.equal(redirectReply('//anywhere.example/', undefined, any).status, 302)
    refused(() => redirectReply('javascript:alert(1)', undefined, any))
    refused(() => redirectReply('data:text/html,x', undefined, any))
  })

  it('is compiled into ctx.redirect() from the app options', async () => {
    const app = makeApp({ redirect: { allowExternal: ['https://accounts.example'] } })
    app.get('/sso', (ctx) => ctx.redirect('https://accounts.example/login', 303))
    app.get('/phish', (ctx) => ctx.redirect('https://evil.example/login'))
    const sso = await app.inject('GET', '/sso')
    assert.equal(sso.status, 303)
    assert.equal(sso.header('location'), 'https://accounts.example/login')
    assert.equal((await app.inject('GET', '/phish')).status, 500)
  })

  it('refuses a malformed entry at boot, all of them at once, with the spelling that would match', async () => {
    const app = makeApp({
      redirect: { allowExternal: ['https://accounts.example/', 'accounts.example', 'HTTPS://SSO.EXAMPLE', 'https://x.example:443', 'ftp://x.example', 7 as never] },
    })
    app.get('/', () => 'ok')
    const error = await app.ready().then(() => null, (e: unknown) => e)
    assert.ok(error instanceof BootError, String(error))
    const invalid = error.diagnostics.filter((d) => d.code === 'ZEN_CONFIG_INVALID')
    assert.equal(invalid.length, 6)
    assert.match(invalid[0]?.hint ?? '', /Use "https:\/\/accounts\.example"/)
    assert.match(invalid[2]?.hint ?? '', /Use "https:\/\/sso\.example"/)
    assert.match(invalid[3]?.hint ?? '', /Use "https:\/\/x\.example"/)
  })
})

describe('allowExternal on one call (§19.5)', () => {
  it('skips the origin check for a target the application built itself', () => {
    assert.equal(redirectReply('https://tenant.example/', { allowExternal: true }).headers.get('location'), 'https://tenant.example/')
  })

  it('still refuses a CR or LF — the header check is not the redirect check', () => {
    assert.throws(
      () => redirectReply('https://tenant.example/\r\nSet-Cookie: a=b', { allowExternal: true }),
      (error: unknown) => (error as { code?: string }).code === 'ZEN_HEADER_INVALID',
    )
  })
})

describe('isLocalUrl — the check to make on a ?next= before redirecting to it', () => {
  it('is true for a path, a query or a fragment, and false for anything with a scheme or authority', () => {
    for (const target of SAME_ORIGIN) assert.equal(isLocalUrl(target), true, JSON.stringify(target))
    for (const target of LEAVES) assert.equal(isLocalUrl(target), false, JSON.stringify(target))
    assert.equal(isLocalUrl(undefined as never), false)
  })
})

// ── the differential ────────────────────────────────────────────────────────

const SEEDS = 2_000

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T

const ATOMS = ['/', '\\', '//', '/\\', '\\/', '\t', '\n', '\r', ' ', '\x00', '\x1f', ':', '?', '#', '@', '.', '..', '%2f', '%5C',
  'http', 'https', 'HTTPS', 'javascript', 'evil.example', 'accounts.example', 'app', 'a', '1', '+', '-', 'é', '　']

/** How a scheme can start a target — the branch a uniform draw from ATOMS almost never reached. */
const SCHEME_STARTS = ['http:', 'https:', 'HTTPS:', 'javascript:', 'a:', 'ftp:', 'h\ttps:', ' https:', 'http\n:', 'x+y.z-1:']

function randomTarget(random: () => number): string {
  // A third start with something scheme-shaped. The first version of this
  // generator drew every atom uniformly and produced a scheme 24 times in
  // 2,000 — the coverage assertion below is what said so.
  let out = random() < 0.35 ? pick(random, SCHEME_STARTS) : ''
  const length = 1 + Math.floor(random() * 6)
  for (let i = 0; i < length; i++) out += pick(random, ATOMS)
  return out
}

const BASES = ['http://app.test/p/', 'https://app.test/p/'] as const

/** The WHATWG parser: every origin a browser on either scheme would end up at, or `null` if it would not navigate. */
function destinations(target: string): string[] | null {
  const origins: string[] = []
  for (const base of BASES) {
    try {
      origins.push(new URL(target, base).origin)
    } catch {
      return null
    }
  }
  return origins
}

describe('differential: the reference scanner ≡ the WHATWG URL parser (§20.5)', () => {
  it('agrees on which targets stay on the origin, over 2,000 random targets', () => {
    const tally = { local: 0, network: 0, scheme: 0 }
    for (let seed = 1; seed <= SEEDS; seed++) {
      const target = randomTarget(rng(seed))
      const { kind } = classifyReference(target)
      tally[kind as keyof typeof tally]++
      const ends = destinations(target)
      const stays = ends !== null && ends[0] === 'http://app.test' && ends[1] === 'https://app.test'
      assert.equal(kind === 'local', stays, `seed ${seed}: ${JSON.stringify(target)} is "${kind}", the parser says ${JSON.stringify(ends)}`)
    }
    // Coverage: each answer was reached often enough to have been tested.
    for (const [kind, count] of Object.entries(tally)) {
      assert.ok(count > SEEDS / 20, `only ${count} targets classified "${kind}"`)
    }
  })

  it('never lets a target through to an origin the policy does not name', () => {
    const { policy } = compileRedirectPolicy({ allowExternal: ['https://accounts.example'] })
    let allowedAway = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const target = random() < 0.5 ? randomTarget(random) : `https://accounts.example${randomTarget(random)}`
      if (redirectRefusal(target, policy) !== null) continue
      const ends = destinations(target)
      assert.ok(ends !== null, `seed ${seed}: sent ${JSON.stringify(target)}, which the parser cannot read`)
      for (const [i, origin] of ends.entries()) {
        const home = i === 0 ? 'http://app.test' : 'https://app.test'
        assert.ok(origin === home || origin === 'https://accounts.example', `seed ${seed}: ${JSON.stringify(target)} reaches ${origin}`)
        if (origin === 'https://accounts.example') allowedAway++
      }
    }
    assert.ok(allowedAway > SEEDS / 20, `only ${allowedAway} redirects left for the listed origin`)
  })

  it('SAME_ORIGIN_ONLY sends exactly what the parser keeps home', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const target = randomTarget(rng(seed))
      const ends = destinations(target)
      const stays = ends !== null && ends[0] === 'http://app.test' && ends[1] === 'https://app.test'
      assert.equal(redirectRefusal(target, SAME_ORIGIN_ONLY) === null, stays, `seed ${seed}: ${JSON.stringify(target)}`)
    }
  })
})
