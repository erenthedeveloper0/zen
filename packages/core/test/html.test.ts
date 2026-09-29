import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'parse5'
import {
  html, unsafeHtml, escapeHtml, isSafeHtml, NEUTRAL_URL, DEFAULT_CAPABILITIES, type SafeHtml,
} from '@erenthedeveloper0/zen-core'
import { makeApp } from './helpers.ts'

/**
 * HTML that is escaped by construction — rfcs/0001 §19.5.
 *
 * Hand-written cases first, one per position a hole can take, because each is
 * a sentence the RFC now says and a sentence is a test somebody has not
 * written yet. Then the property suites, whose oracles are the WHATWG URL
 * parser, a grammar for escaped text, and parse5 — a spec-conformant HTML
 * parser — judging whole pages built from random templates. None shares a line
 * with `runtime/html.ts`, which is what makes the suites evidence rather than a
 * restatement. `html` generates no code, so there is no interpreted twin to
 * fuzz against (§20.5); independent oracles are what stand in for one.
 */

const EVIL = '<script>alert(1)</script>'

/** The five entities `escapeHtml` writes, decoded — the text a browser shows. */
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] as string)
}

/** Escaped text contains no markup character, and no `&` that is not one of the five. */
const ESCAPED = /^(?:[^&<>"']|&(?:amp|lt|gt|quot|#39);)*$/

function refusal(render: () => unknown): string {
  try {
    render()
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'ZEN_HTML_UNSAFE', String(error))
    assert.equal((error as { status?: number }).status, 500)
    assert.equal((error as { expose?: boolean }).expose, false)
    return (error as Error).message
  }
  assert.fail('expected ZEN_HTML_UNSAFE')
}

describe('escapeHtml', () => {
  it('escapes the five characters that begin or end something in HTML', () => {
    assert.equal(escapeHtml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f')
    assert.equal(escapeHtml('&&'), '&amp;&amp;')
    assert.equal(escapeHtml('<'), '&lt;')
  })

  it('returns a string with nothing to escape unchanged', () => {
    assert.equal(escapeHtml('plain text, 42 — ünïcödé'), 'plain text, 42 — ünïcödé')
    assert.equal(escapeHtml(''), '')
  })
})

describe('element content (§19.5)', () => {
  it('escapes a string, so a script tag is text', () => {
    assert.equal(String(html`<p>${EVIL}</p>`), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('writes SafeHtml verbatim — which is how templates nest', () => {
    const items = ['a<', 'b&']
    assert.equal(
      String(html`<ul>${items.map((item) => html`<li>${item}</li>`)}</ul>`),
      '<ul><li>a&lt;</li><li>b&amp;</li></ul>',
    )
  })

  it('writes nothing for null, undefined, true and false, so && reads as it looks', () => {
    const admin = false
    assert.equal(String(html`<nav>${admin && html`<a href="/admin">Admin</a>`}${null}${undefined}${true}</nav>`), '<nav></nav>')
  })

  it('writes numbers and stringifies anything else, escaped', () => {
    assert.equal(String(html`<p>${0} ${-1.5} ${10n}</p>`), '<p>0 -1.5 10</p>')
    assert.equal(String(html`<p>${{ toString: () => '<b>' }}</p>`), '<p>&lt;b&gt;</p>')
  })

  it('escapes every element of an array that is not SafeHtml', () => {
    assert.equal(String(html`<p>${['<i>', html`<b>ok</b>`]}</p>`), '<p>&lt;i&gt;<b>ok</b></p>')
  })
})

describe('attribute values (§19.5)', () => {
  it('escapes both quotes, so a value cannot end the attribute it is in', () => {
    assert.equal(String(html`<a title="${'" onmouseover="x'}">t</a>`), '<a title="&quot; onmouseover=&quot;x">t</a>')
    assert.equal(String(html`<a title='${"' onmouseover='x"}'>t</a>`), "<a title='&#39; onmouseover=&#39;x'>t</a>")
  })

  it('escapes SafeHtml too — markup means nothing in an attribute, and its own quote would end it', () => {
    assert.equal(String(html`<a title="${html`<b class="x">`}">t</a>`), '<a title="&lt;b class=&quot;x&quot;&gt;">t</a>')
  })

  it('writes every hole in one value', () => {
    assert.equal(String(html`<p class="${'a'} ${'b"'}">x</p>`), '<p class="a b&quot;">x</p>')
  })

  it('allows the attributes that are only text — a <meta> description among them', () => {
    assert.equal(
      String(html`<meta name="description" content="${'Tom & "Jerry"'}">`),
      '<meta name="description" content="Tom &amp; &quot;Jerry&quot;">',
    )
  })
})

describe('text elements (§19.5)', () => {
  it('escapes a string inside <title> and <textarea>, as anywhere in element content', () => {
    assert.equal(String(html`<title>${EVIL}</title>`), '<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>')
    assert.equal(String(html`<textarea>${'</textarea><b>'}</textarea>`), '<textarea>&lt;/textarea&gt;&lt;b&gt;</textarea>')
  })

  it('reads their content as markup — which is what it is inside <svg>', () => {
    // A tracking pixel in <noscript> is an ordinary pattern, not a refusal…
    assert.equal(String(html`<noscript><img src="/pixel?id=${7}"></noscript>`), '<noscript><img src="/pixel?id=7"></noscript>')
    // …and a script inside an SVG <title> is a script, not text: HTML would
    // read <title> as raw text, and an SVG does not.
    assert.match(refusal(() => html`<svg><title><script>${1}</script></title></svg>`), /inside <script>/)
  })

  it('reads past an end tag, whatever its case', () => {
    assert.equal(String(html`<TITLE>t</Title ><p>${'<'}</p>`), '<TITLE>t</Title ><p>&lt;</p>')
  })
})

describe('two readings of one page — HTML and SVG (§19.5)', () => {
  // HTML reads <title>, <textarea>, <noscript>… as text ended by the first
  // "</name", and <script>/<style> as script and raw text; SVG and MathML read
  // all of them as markup. Every template in the first three tests was accepted
  // by the first version of the tag, and a spec-conformant parser put its value
  // in an event handler, a <script> or a <style>.

  it("refuses a text element's end tag where the markup reading would not end the element", () => {
    const cases: Array<[() => unknown, string]> = [
      [() => html`<noscript><p title="</noscript><img src=x onerror=${'go()'}>"></p></noscript>`, 'noscript'],
      [() => html`<title><a title="</title><script>${'go()'}</script>">`, 'title'],
      [() => html`<textarea><!-- </textarea><p>${'x'} --></textarea>`, 'textarea'],
      [() => html`<xmp><b data-x="</xmp>">${'x'}</b></xmp>`, 'xmp'],
      // An SVG <title> lets HTML back in, so this <textarea> is HTML's: its end tag counts too.
      [() => html`<svg><title><textarea><a title="</textarea><b>${'x'}</b>"></textarea></title></svg>`, 'textarea'],
    ]
    for (const [render, element] of cases) {
      assert.match(refusal(render), new RegExp(`content of <${element}> as text`), element)
    }
  })

  it('refuses a hole that could finish such an end tag', () => {
    assert.match(refusal(() => html`<textarea><a title="</text${'area x'}"></a></textarea>`), /could finish "<\/textarea"/)
    assert.match(refusal(() => html`<title><b title="<${'/title '}">t</b></title>`), /could finish "<\/title"/)
  })

  it('refuses what SVG would read as markup inside a <style>, or inside a <script> in an <svg>', () => {
    assert.match(refusal(() => html`<svg><style><!--</style>-->${'x'}</style></svg>`), /<style> holds a "<"/)
    assert.match(refusal(() => html`<math><style><img src=x onerror="1</style>${'x'}"></math>`), /<style> holds a "<"/)
    assert.match(refusal(() => html`<svg><script><![CDATA[ var s = "</script>"; ]]>${'x'}</script></svg>`), /<script> inside <svg> holds a "<"/)
    assert.match(refusal(() => html`<style>/* <b> */</style>`), /<style> holds a "<"/)
    assert.match(refusal(() => html`<svg><script>if (a<b) go()</script></svg>`), /<script> inside <svg>/)
  })

  it('refuses a CDATA section that HTML and SVG would end in different places', () => {
    assert.match(refusal(() => html`<![CDATA[ a>b ]]><p>${1}</p>`), /CDATA section holds a ">"/)
    assert.equal(String(html`<svg><![CDATA[ a<b ]]><text>${'t'}</text></svg>`), '<svg><![CDATA[ a<b ]]><text>t</text></svg>')
  })

  it('refuses a template that leaves a text element, an <svg> or a <math> open', () => {
    assert.match(refusal(() => html`<textarea>${'x'}`), /inside <textarea>, which it never closes/)
    assert.match(refusal(() => html`<svg><circle r="1"/>`), /inside <svg>, which it never closes/)
    assert.match(refusal(() => html`<math><mi>x</mi>`), /inside <math>, which it never closes/)
  })

  it('leaves the ordinary patterns alone', () => {
    const cases: Array<[() => unknown, string]> = [
      [() => html`<noscript>${html`<img src="/pixel?id=${7}">`}</noscript>`, '<noscript><img src="/pixel?id=7"></noscript>'],
      [() => html`<noscript>${html`<p>Turn on JavaScript</p>`}</noscript>`, '<noscript><p>Turn on JavaScript</p></noscript>'],
      [() => html`<title>${'Tom & </title> Jerry'}</title>`, '<title>Tom &amp; &lt;/title&gt; Jerry</title>'],
      [() => html`<script>for (let i=0;i<n;i++) go(i)</script><p>${'x'}</p>`, '<script>for (let i=0;i<n;i++) go(i)</script><p>x</p>'],
      [() => html`<script>//<![CDATA[
if (a<b) go()
//]]></script>`, '<script>//<![CDATA[\nif (a<b) go()\n//]]></script>'],
      [
        () => html`<svg viewBox="0 0 8 8"><style>.a{fill:red}</style><path class="a" d="${'M0 0h8v8H0z'}"/></svg>`,
        '<svg viewBox="0 0 8 8"><style>.a{fill:red}</style><path class="a" d="M0 0h8v8H0z"/></svg>',
      ],
      [
        () => html`<svg><script><![CDATA[ if (a<b) go() ]]></script><text>${'hi'}</text></svg>`,
        '<svg><script><![CDATA[ if (a<b) go() ]]></script><text>hi</text></svg>',
      ],
      [() => html`<svg>${html`<circle r="${4}"/>`}</svg>`, '<svg><circle r="4"/></svg>'],
      [() => html`<svg/><p>${'x'}</p>`, '<svg/><p>x</p>'],
    ]
    for (const [render, expected] of cases) assert.equal(String(render()), expected)
  })

  it('a fragment inside a text element may not end it — a string cannot, because it is escaped', () => {
    assert.equal(String(html`<textarea>${'</textarea><b>'}</textarea>`), '<textarea>&lt;/textarea&gt;&lt;b&gt;</textarea>')
    assert.match(refusal(() => html`<textarea>${unsafeHtml('</TEXTAREA><b>')}</textarea>`), /fragment inside <textarea>/)
    // Ending part-way into the end tag is as good as holding it: the next value can finish it.
    assert.match(refusal(() => html`<title>${unsafeHtml('a<')}${'/title>'}</title>`), /fragment inside <title>/)
    assert.match(refusal(() => html`<noscript>${[html`<b>ok</b>`, unsafeHtml('</noscript>')]}</noscript>`), /fragment inside <noscript>/)
  })

  it('a fragment whose script only HTML can read is refused inside SVG, however deep, and fine outside it', () => {
    const script = html`<script>if (a<b) go()</script>`
    assert.equal(String(html`<div>${script}</div>`), '<div><script>if (a<b) go()</script></div>')
    assert.match(refusal(() => html`<svg>${script}</svg>`), /fragment inside <svg> or <math>/)
    const wrapped = html`<section>${[html`<p>x</p>`, script]}</section>`
    assert.match(refusal(() => html`<math><mi>${wrapped}</mi></math>`), /fragment inside <svg> or <math>/)
    // Markup the application vouched for is taken at its word, here as everywhere.
    assert.equal(String(html`<svg>${unsafeHtml('<script>if (a<b) go()</script>')}</svg>`), '<svg><script>if (a<b) go()</script></svg>')
  })
})

describe('URL attributes: a scheme that runs script is replaced (§19.5)', () => {
  const link = (value: unknown) => String(html`<a href="${value}">x</a>`)

  it('replaces javascript:, in every spelling a browser accepts', () => {
    for (const hostile of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', '\x01javascript:alert(1)',
      'java\tscript:alert(1)', 'java\nscript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>',
      'livescript:x',
    ]) {
      assert.equal(link(hostile), `<a href="${NEUTRAL_URL}">x</a>`, JSON.stringify(hostile))
    }
  })

  it('keeps http, https, mailto, tel and every relative reference', () => {
    for (const fine of ['https://ok.example/?a=1', 'http://ok.example', 'mailto:ada@example.com', 'tel:+441234', '/users/7', '?page=2', '#top', 'relative/path', '//cdn.example/x']) {
      assert.equal(decode(link(fine).slice('<a href="'.length, -'">x</a>'.length)), fine)
    }
  })

  it('treats an & in a value as a literal — a link to Tom&Jerry is a relative link', () => {
    assert.equal(link('Tom&Jerry'), '<a href="Tom&amp;Jerry">x</a>')
  })

  it('checks the value assembled from every hole, not each hole alone', () => {
    assert.equal(String(html`<a href="${'java'}${'script:alert(1)'}">x</a>`), `<a href="${NEUTRAL_URL}">x</a>`)
  })

  it('does not let a character reference written after a hole complete the scheme', () => {
    const out = String(html`<a href="${'javascript'}&colon;alert(1)">x</a>`)
    assert.ok(out.startsWith(`<a href="${NEUTRAL_URL}`), out)
  })

  it('checks SafeHtml in a URL too — nesting is not a way around it', () => {
    assert.equal(link(html`${'javascript:alert(1)'}`), `<a href="${NEUTRAL_URL}">x</a>`)
  })

  it('trusts what the written text already decided', () => {
    // A path on this origin: whatever follows is part of the path.
    assert.equal(String(html`<a href="/u/${'javascript:x'}">x</a>`), '<a href="/u/javascript:x">x</a>')
    assert.equal(String(html`<a href="https://ok.example/${'javascript:x'}">x</a>`), '<a href="https://ok.example/javascript:x">x</a>')
  })

  it('refuses a hole inside a script URL the template wrote, or after a character reference', () => {
    assert.match(refusal(() => html`<a href="javascript:${'go()'}">x</a>`), /javascript: URL/)
    assert.match(refusal(() => html`<a href="&#106;${'avascript:x'}">x</a>`), /character reference/)
  })
})

describe('URL attributes that load code or receive a form: a hole may not choose the origin', () => {
  it('keeps a path on this origin and replaces anything else', () => {
    assert.equal(String(html`<script src="${'/app.js'}"></script>`), '<script src="/app.js"></script>')
    assert.equal(String(html`<script src="${'https://evil.example/x.js'}"></script>`), `<script src="${NEUTRAL_URL}"></script>`)
    assert.equal(String(html`<form action="${'//evil.example/steal'}"></form>`), `<form action="${NEUTRAL_URL}"></form>`)
    assert.equal(String(html`<base href="${'https://evil.example/'}">`), `<base href="${NEUTRAL_URL}">`)
  })

  it('refuses "/" followed by a hole that supplies the second slash', () => {
    const out = String(html`<script src="/${'/evil.example/x.js'}"></script>`)
    assert.ok(!out.includes('evil.example'), out)
  })

  it('allows a host the template wrote, and refuses one a hole would write', () => {
    assert.equal(String(html`<script src="https://cdn.example/${'x.js'}"></script>`), '<script src="https://cdn.example/x.js"></script>')
    assert.match(refusal(() => html`<script src="https://${'evil.example'}/x.js"></script>`), /choose the host/)
    assert.match(refusal(() => html`<script src="https://cdn.example@${'evil.example'}/x.js"></script>`), /choose the host/)
  })

  it('treats a link, an image and a frame as ordinary URLs', () => {
    assert.equal(String(html`<a href="${'https://other.example'}">x</a>`), '<a href="https://other.example">x</a>')
    assert.equal(String(html`<img src="${'https://img.example/a.png'}">`), '<img src="https://img.example/a.png">')
  })
})

describe('positions escaping cannot make safe are refused (§19.5)', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['inside <script>', () => html`<script>var x = ${1}</script>`, /inside <script>/],
    ['inside <style>', () => html`<style>p { color: ${'red'} }</style>`, /inside <style>/],
    ['an event handler', () => html`<button onclick="go('${1}')">x</button>`, /event handler onclick/],
    ['srcdoc', () => html`<iframe srcdoc="${'<p>'}"></iframe>`, /srcdoc/],
    ['a tag name', () => html`<${'img'} src=x>`, /tag name/],
    ['an attribute name', () => html`<div ${'onclick=alert(1)'}>x</div>`, /attribute name goes/],
    ['after an attribute', () => html`<div class="a"${'x'}>x</div>`, /attribute name goes/],
    ['an unquoted value', () => html`<a href=${'x'}>x</a>`, /unquoted value of href/],
    ['a comment', () => html`<!-- ${'x'} -->`, /comment/],
    ['a declaration', () => html`<!DOCTYPE ${'html'}>`, /comment or declaration/],
    ['an SVG animation', () => html`<svg><set attributeName="href" to="${'javascript:x'}"/></svg>`, /can set an href/],
    ['a meta refresh', () => html`<meta content="${'0;url=/x'}" http-equiv="refresh">`, /refresh/],
    ['a meta http-equiv', () => html`<meta http-equiv="${'refresh'}" content="0">`, /http-equiv/],
    ['a half-typed end tag', () => html`<title></ti${'tle'}><script>`, /tag name/],
    ['<!-- inside a script', () => html`<script><!--</script>${1}`, /<!--/],
    ['a template ending in a tag', () => html`<a href="/x"`, /ends inside the <a> tag/],
    ['a template ending in a value', () => html`<a href="/x`, /ends inside the href attribute/],
    ['a template ending in a comment', () => html`<!-- open`, /unclosed comment/],
    ['a template ending in a script', () => html`<script>go()`, /inside <script>, which it never closes/],
  ]

  for (const [name, render, pattern] of cases) {
    it(`refuses ${name}`, () => {
      assert.match(refusal(render), pattern)
    })
  }

  it('refuses whatever the values are, and on every call — the analysis is structural and cached', () => {
    const render = (value: unknown) => html`<script>var x = ${value}</script>`
    refusal(() => render(1))
    refusal(() => render(''))
    refusal(() => render(html``))
  })

  it('names the hole and the text before it, so the template can be found', () => {
    assert.match(refusal(() => html`<p>ok ${1}</p><button onclick="${2}">`), /hole 2, after "<\/p><button onclick="/)
  })

  it('refuses html called as a function — its written text is trusted, so it must be a literal', () => {
    const tag = html as unknown as (s: unknown, ...v: unknown[]) => unknown
    assert.match(refusal(() => tag(`<p>${EVIL}</p>`)), /called as a function/)
    assert.match(refusal(() => tag(['<p>', '</p>'], EVIL)), /called as a function/)
  })

  it('leaves the ordinary cases alone: comments, doctypes and scripts with no hole in them', () => {
    const page = html`<!doctype html><html><head><title>${'T'}</title><script>if (a < b) go()</script><!-- note --></head><body>${'x'}</body></html>`
    assert.equal(String(page), '<!doctype html><html><head><title>T</title><script>if (a < b) go()</script><!-- note --></head><body>x</body></html>')
  })
})

describe('the value (§19.5)', () => {
  it('cannot be forged by data — a parsed body, an object literal, a borrowed prototype', () => {
    const genuine = html`<b>ok</b>`
    assert.equal(isSafeHtml(genuine), true)
    assert.equal(isSafeHtml(JSON.parse('{"__safeHtml":true,"toString":"<b>"}')), false)
    assert.equal(isSafeHtml({ toString: () => '<script>' }), false)
    assert.equal(isSafeHtml(Object.create(Object.getPrototypeOf(genuine) as object)), false)
    assert.equal(isSafeHtml('<b>ok</b>'), false)
  })

  it('is its markup as a string and inside JSON', () => {
    const fragment = html`<b>${'<'}</b>`
    assert.equal(String(fragment), '<b>&lt;</b>')
    assert.equal(JSON.stringify({ fragment }), '{"fragment":"<b>&lt;</b>"}')
  })

  it('is an async iterable of its markup — a body ctx.stream() can take', async () => {
    const chunks: string[] = []
    for await (const chunk of html`<p>${'a&b'}</p>` as unknown as AsyncIterable<string>) chunks.push(chunk)
    assert.deepEqual(chunks, ['<p>a&amp;b</p>'])
  })

  it('unsafeHtml marks a string, and takes nothing else', () => {
    assert.equal(String(unsafeHtml('<b>trusted</b>')), '<b>trusted</b>')
    assert.equal(String(html`<div>${unsafeHtml('<b>trusted</b>')}</div>`), '<div><b>trusted</b></div>')
    refusal(() => unsafeHtml(42 as never))
  })
})

describe('through the framework (§19.5, §13.2)', () => {
  for (const [label, caps] of [['compiled context', DEFAULT_CAPABILITIES], ['interpreted twin', { ...DEFAULT_CAPABILITIES, eval: false }]] as const) {
    it(`ctx.html() writes SafeHtml as text/html — ${label}`, async () => {
      const app = makeApp({ caps })
      app.get('/hello', (ctx) => ctx.html(html`<p>Hello, ${(ctx.query as Record<string, string>)['name']}</p>`))
      const res = await app.inject('GET', `/hello?name=${encodeURIComponent(EVIL)}`)
      assert.equal(res.status, 200)
      assert.equal(res.header('content-type'), 'text/html; charset=utf-8')
      assert.equal(res.text(), '<p>Hello, &lt;script&gt;alert(1)&lt;/script&gt;</p>')
    })

    it(`ctx.html() refuses a plain string — ${label}`, async () => {
      const app = makeApp({ caps })
      app.get('/raw', (ctx) => ctx.html(`<p>${EVIL}</p>` as unknown as SafeHtml))
      const res = await app.inject('GET', '/raw')
      assert.equal(res.status, 500)
      assert.equal(res.json<{ code: string }>().code, 'ZEN_HTML_UNSAFE')
      assert.doesNotMatch(res.text(), /<script>/, 'nothing of the body reaches the client')
    })
  }

  it('a handler may return html`` — a page, as a returned string is text', async () => {
    const app = makeApp()
    app.get('/page', () => html`<h1>${'Hi & bye'}</h1>`)
    app.get('/data', () => ({ page: 'no' }))
    const page = await app.inject('GET', '/page')
    assert.equal(page.header('content-type'), 'text/html; charset=utf-8')
    assert.equal(page.text(), '<h1>Hi &amp; bye</h1>')
    const data = await app.inject('GET', '/data')
    assert.equal(data.header('content-type'), 'application/json; charset=utf-8', 'an ordinary object is still JSON')
  })

  it('a refused template is a 500 whose message stays in the logs', async () => {
    const app = makeApp()
    app.get('/bad', () => html`<script>var q = ${'x'}</script>`)
    const res = await app.inject('GET', '/bad')
    assert.equal(res.status, 500)
    const problem = res.json<{ code: string; title: string }>()
    assert.equal(problem.code, 'ZEN_HTML_UNSAFE')
    assert.equal(problem.title, 'Internal Server Error')
  })
})

// ── properties ──────────────────────────────────────────────────────────────

const SEEDS = 2_000

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T

const PIECES = ['<', '>', '&', '"', "'", '/', '=', ' ', '\t', '\n', 'a', 'Z', '0', 'script', 'onclick', '&amp;', '&#39;', '-->', ']]>', ' ', 'é', '`', '\\']

function hostileText(random: () => number): string {
  let out = ''
  const length = Math.floor(random() * 12)
  for (let i = 0; i < length; i++) out += pick(random, PIECES)
  return out
}

const LEADING = ['', ' ', '\t', '\x01', '\x00', ' \n ']
const SCHEMES = ['javascript', 'JavaScript', 'java\tscript', 'java\nscript', 'vbscript', 'data', 'http', 'https', 'mailto', 'tel', 'ftp', 'x-app', 'jav&#x61;script', '']
const SEPARATORS = [':', ':', ':', '&colon;', '%3A', '\t:', '']
const RESTS = ['alert(1)', '//evil.example/x.js', '/path', 'text/html,<script>', '', '?q=1', '#f', '\\\\evil.example', 'evil.example/a']

function hostileUrl(random: () => number): string {
  const lead = pick(random, LEADING)
  if (random() < 0.25) return lead + pick(random, ['/', '//', '/\\', '\\\\', '\\', '/\t/', '?', '#', '.', '../']) + pick(random, RESTS)
  return lead + pick(random, SCHEMES) + pick(random, SEPARATORS) + pick(random, RESTS)
}

/** What the page's scheme could be; the oracle has to be right under both. */
const BASES = ['http://app.test/p/', 'https://app.test/p/'] as const
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** The WHATWG URL parser's answer to "could following this run script?". */
function runsScript(value: string): boolean {
  for (const base of BASES) {
    let url: URL
    try {
      url = new URL(value, base)
    } catch {
      continue // unparseable: a browser follows nothing
    }
    if (!LINK_SCHEMES.has(url.protocol)) return true
  }
  return false
}

/** …and to "does it stay on the page's own origin?". */
function leavesOrigin(value: string): boolean {
  for (const base of BASES) {
    let url: URL
    try {
      url = new URL(value, base)
    } catch {
      continue
    }
    if (url.origin !== new URL(base).origin) return true
  }
  return false
}

describe('properties, against independent oracles (§20.5)', () => {
  it('a hostile string never escapes its hole — element content, both quotes, raw text', () => {
    const shapes: Array<[string, (v: unknown) => SafeHtml, string, string]> = [
      ['content', (v) => html`<p>${v}</p>`, '<p>', '</p>'],
      ['double-quoted', (v) => html`<a title="${v}">x</a>`, '<a title="', '">x</a>'],
      ['single-quoted', (v) => html`<a title='${v}'>x</a>`, "<a title='", "'>x</a>"],
      ['title', (v) => html`<title>${v}</title>`, '<title>', '</title>'],
      ['textarea', (v) => html`<textarea>${v}</textarea>`, '<textarea>', '</textarea>'],
    ]
    let markupCharacters = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const value = hostileText(random)
      if (/[<>&"']/.test(value)) markupCharacters++
      const [name, render, before, after] = pick(random, shapes)
      const out = String(render(value))
      assert.ok(out.startsWith(before) && out.endsWith(after), `seed ${seed} (${name}): the written text changed`)
      const hole = out.slice(before.length, out.length - after.length)
      assert.match(hole, ESCAPED, `seed ${seed} (${name}): ${JSON.stringify(value)} wrote markup`)
      assert.equal(decode(hole), value, `seed ${seed} (${name}): the text a browser shows is not the value`)
    }
    // Coverage: a generator that stopped producing markup characters would pass forever.
    assert.ok(markupCharacters > SEEDS / 2, `only ${markupCharacters} values contained a markup character`)
  })

  it('a link never carries a scheme that runs script — the WHATWG parser is the judge', () => {
    let neutralised = 0
    let kept = 0
    let keptWithScheme = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const url = hostileUrl(random)
      // One hole, or the same URL split across two — the check must read the whole value.
      const cut = Math.floor(random() * (url.length + 1))
      const out = random() < 0.5
        ? String(html`<a href="${url}">x</a>`)
        : String(html`<a href="${url.slice(0, cut)}${url.slice(cut)}">x</a>`)
      const value = decode(out.slice('<a href="'.length, -'">x</a>'.length))
      if (value === NEUTRAL_URL) {
        neutralised++
        continue
      }
      kept++
      assert.equal(value, url, `seed ${seed}: a kept URL was altered`)
      assert.equal(runsScript(value), false, `seed ${seed}: ${JSON.stringify(url)} was written into an href`)
      if (/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/[\t\n\r]/g, '').trimStart())) keptWithScheme++
    }
    assert.ok(neutralised > SEEDS / 10, `only ${neutralised} hostile URLs were neutralised`)
    assert.ok(kept > SEEDS / 10, `only ${kept} URLs were kept — the check is refusing everything`)
    assert.ok(keptWithScheme > SEEDS / 50, `only ${keptWithScheme} kept URLs had a scheme`)
  })

  it('a script source never leaves the origin — under an http page and an https one', () => {
    let neutralised = 0
    let kept = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const url = hostileUrl(random)
      const out = String(html`<script src="${url}"></script>`)
      const value = decode(out.slice('<script src="'.length, -'"></script>'.length))
      if (value === NEUTRAL_URL) {
        neutralised++
        continue
      }
      kept++
      assert.equal(leavesOrigin(value), false, `seed ${seed}: ${JSON.stringify(url)} could load a script from elsewhere`)
      assert.equal(runsScript(value), false, `seed ${seed}: ${JSON.stringify(url)} kept a script scheme`)
    }
    assert.ok(neutralised > SEEDS / 10 && kept > SEEDS / 20, `neutralised ${neutralised}, kept ${kept}`)
  })
})

// ── whole pages, judged by an HTML parser ───────────────────────────────────
//
// The suites above judge one position at a time. This one builds pages: random
// templates of nested elements — HTML's text elements, <script> and <style>,
// SVG and MathML and the elements that lead back out of them, attribute values
// holding end tags — with hostile values in their holes and random fragments
// nested in each other. parse5, which implements the WHATWG tree builder, parses
// every page the tag accepted, with scripting on and off, and reports where each
// value landed. A value may end up as text, or in an attribute that cannot run
// it. Anywhere else — in a script or style, an event handler, a tag or
// attribute name, a comment, a URL that runs script — is the failure a
// position-by-position check misses: the tag and a browser disagreeing about
// where an element ends.

/** The parts of a parse5 node the judge reads. */
interface ParsedNode {
  readonly nodeName: string
  readonly tagName?: string
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>
  readonly childNodes?: readonly ParsedNode[]
  readonly content?: ParsedNode
  readonly value?: string
  readonly data?: string
}

/** Every value carries a marker, so wherever the parser put it, it can be found. */
const MARKER = /zq\d+x/

/** [tag, attributes] — `§` is a hole. */
const ELEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['p', ''], ['div', ' class="§"'], ['b', ''], ['a', ' href="§"'], ['a', ' href="/u/§" title="§"'], ['span', " title='§'"],
  ['p', ' title="</title>"'], ['i', ' title="</textarea>"'], ['u', ' title="</noscript>"'], ['em', ' data-x="</xmp "'],
  // An attribute that ends the text element around it, for HTML, and then
  // opens a place where a value is code — the shape that got past the first version.
  ['p', ' title="</noscript><img src=x onerror=§>"'], ['a', ' title="</title><script>§</script>"'],
  ['b', " title='</textarea><b onclick=§>'"], ['i', ' data-x="</xmp><iframe srcdoc=§>"'],
  ['u', ' title="</iframe><svg onload=§>"'], ['s', ' title="</noembed><img src=x onerror=§>"'],
  ['q', ' title="</noframes><script>§</script>"'],
  ['title', ''], ['textarea', ' name="§"'], ['noscript', ''], ['iframe', ' src="§"'], ['xmp', ''], ['noembed', ''], ['noframes', ''],
  ['script', ''], ['style', ''],
  ['svg', ''], ['math', ''], ['foreignObject', ''], ['desc', ''], ['mi', ''], ['mtext', ''], ['g', ' fill="§"'],
  ['select', ''], ['table', ''], ['template', ''], ['form', ' action="/f/§"'], ['button', ' formaction="§"'],
  ['b', ' onclick="§"'],
]
const TEXT = ['§', '§', '§', 'text ', 'a<b ', 'x > y ', ' ', '<br>', '<!-- note -->', '<img src="§">', '<circle r="§"/>']
const CODE = [
  'if (a<b) go() ', 'p { color: red } ', '/* <b> */ ', 'x = "</b>" ', '<![CDATA[ a<b ]]> ', '§', '',
  // Text that ends the element for HTML but not for SVG, then a hole: inside an
  // SVG script or style, or a MathML one, the hole is still code.
  '<![CDATA[ "</script>" ]]>§', '<!--</style>-->§', '<img src=x onerror="1</style>§">',
]
const STRAY = ['"', "'", '<', '>', '</', '=', '<!--', '-->', '<![CDATA[', ']]>', '<![CDATA[ x ]]>', '<![CDATA[ a>b ]]>', '</p>']
const BREAKOUT = [
  '"', "'", '<', '>', '/', ' ', '=', '&', '/title>', '/noscript ', '/textarea>', '/script>', '/xmp ', '/iframe>',
  ' onclick=go()', 'javascript:', ']]>', '-->', '<!--', '<script>', '\t', '\n', ':',
]

function content(random: () => number, depth: number): string {
  let out = ''
  const items = 1 + Math.floor(random() * 3)
  for (let i = 0; i < items; i++) {
    const r = random()
    if (depth < 3 && r < 0.5) {
      const [name, attributes] = pick(random, ELEMENTS)
      const inside = name === 'script' || name === 'style' ? pick(random, CODE) : content(random, depth + 1)
      out += `<${name}${attributes}>${inside}</${name}>`
    } else if (r < 0.93) {
      out += pick(random, TEXT)
    } else {
      out += pick(random, STRAY)
    }
  }
  return out
}

/** A real template object: frozen, with `raw`, so the tag analyses it like a literal. */
function templateOf(text: string): TemplateStringsArray {
  const parts = text.split('§')
  return Object.freeze(Object.assign(parts.slice(), { raw: Object.freeze(parts.slice()) })) as unknown as TemplateStringsArray
}

interface Tally {
  markers: number
  accepted: number
  refusals: Map<string, number>
}

function hostile(random: () => number, tally: Tally): string {
  const mark = `zq${++tally.markers}x`
  let out = ''
  const pieces = 1 + Math.floor(random() * 4)
  for (let i = 0; i < pieces; i++) out += random() < 0.6 ? pick(random, BREAKOUT) : mark
  return out.includes(mark) ? out : out + mark
}

/** Render a random template — refused or accepted — with random values, some of them nested fragments. */
function page(random: () => number, depth: number, tally: Tally): SafeHtml | null {
  const strings = templateOf(content(random, 0))
  const values: unknown[] = []
  for (let i = 0; i < strings.length - 1; i++) {
    const nested = depth < 2 && random() < 0.3 ? page(random, depth + 1, tally) : null
    values.push(nested === null ? hostile(random, tally) : random() < 0.5 ? nested : [hostile(random, tally), nested])
  }
  try {
    const rendered = html(strings, ...values)
    tally.accepted++
    return rendered
  } catch (error) {
    assert.equal((error as { code?: string }).code, 'ZEN_HTML_UNSAFE', String(error))
    const message = (error as Error).message
    const reason =
      /content of <\w+> as text|could finish "<\//.test(message) ? 'an end tag the two readings place differently'
      : /holds a "<"/.test(message) ? 'markup SVG would read in a script or style'
      : /CDATA section holds/.test(message) ? 'a CDATA section with a ">" in it'
      : /fragment inside/.test(message) ? 'a fragment refused where it was nested'
      : /never closes/.test(message) ? 'an element left open'
      : 'another refused position'
    tally.refusals.set(reason, (tally.refusals.get(reason) ?? 0) + 1)
    return null
  }
}

const ANIMATION = new Set(['set', 'animate', 'animatemotion', 'animatetransform'])
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'cite', 'poster', 'background', 'data', 'codebase', 'longdesc', 'usemap',
  'manifest', 'icon', 'lowsrc', 'dynsrc', 'archive', 'classid', 'profile',
])
const ORIGIN_BOUND: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['script', new Set(['src', 'href'])], ['base', new Set(['href'])], ['form', new Set(['action'])],
  ['button', new Set(['formaction'])], ['input', new Set(['formaction'])], ['object', new Set(['data', 'codebase'])],
  ['embed', new Set(['src'])],
])

/**
 * Where a marker must never be, in the tree a browser builds: `null`, or what
 * went wrong. `code` is true under a <script> or <style> of either namespace.
 */
function misplaced(node: ParsedNode, code: boolean, where: { text: string[] }): string | null {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') {
      const text = child.value ?? ''
      if (!MARKER.test(text)) continue
      if (code) return `a value is the text of a script or style: ${JSON.stringify(text)}`
      where.text.push(node.nodeName)
      continue
    }
    if (child.nodeName === '#comment') {
      if (MARKER.test(child.data ?? '')) return `a value is inside a comment: ${JSON.stringify(child.data)}`
      continue
    }
    if (child.nodeName === '#documentType') continue
    const tag = (child.tagName ?? child.nodeName).toLowerCase()
    if (MARKER.test(tag)) return `a value became a tag name: <${tag}>`
    const attributes = child.attrs ?? []
    for (const { name, value } of attributes) {
      const attribute = name.toLowerCase()
      if (MARKER.test(attribute)) return `a value became an attribute name: ${attribute} on <${tag}>`
      if (!MARKER.test(value)) continue
      const said = `${attribute}=${JSON.stringify(value)} on <${tag}>`
      if (attribute.startsWith('on') || attribute === 'srcdoc') return `a value is in ${said}`
      if (ANIMATION.has(tag) && ['to', 'from', 'by', 'values', 'attributename'].includes(attribute)) return `a value animates ${said}`
      if (tag === 'meta') return `a value is in ${said}`
      if (URL_ATTRIBUTES.has(attribute) && runsScript(value)) return `a value runs script from ${said}`
      if (ORIGIN_BOUND.get(tag)?.has(attribute) === true && leavesOrigin(value)) return `a value chose the origin of ${said}`
    }
    const inner = code || tag === 'script' || tag === 'style'
    const found = misplaced(child, inner, where) ?? (child.content === undefined ? null : misplaced(child.content, inner, where))
    if (found !== null) return found
  }
  return null
}

describe('whole pages, against a spec-conformant HTML parser (§19.5, §20.5)', () => {
  it('a value lands only where it is text, whatever the page around it', () => {
    const tally: Tally = { markers: 0, accepted: 0, refusals: new Map() }
    const landed = new Map<string, number>()
    let judged = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed)
      const rendered = page(random, 0, tally)
      if (rendered === null) continue
      const markup = String(rendered)
      if (!MARKER.test(markup)) continue
      judged++
      for (const scriptingEnabled of [true, false]) {
        const where = { text: [] as string[] }
        const problem = misplaced(parse(markup, { scriptingEnabled }) as unknown as ParsedNode, false, where)
        assert.equal(problem, null, `seed ${seed}, scripting ${scriptingEnabled ? 'on' : 'off'}: ${problem}\n${markup}`)
        for (const parent of where.text) landed.set(parent, (landed.get(parent) ?? 0) + 1)
      }
    }

    // Coverage. A generator that stopped producing the hard cases would pass forever.
    assert.ok(judged > SEEDS / 5, `only ${judged} pages with a value in them were judged`)
    for (const element of ['title', 'textarea', 'noscript', 'xmp', 'iframe']) {
      assert.ok((landed.get(element) ?? 0) > 10, `values reached <${element}> text only ${landed.get(element) ?? 0} times`)
    }
    for (const element of ['svg', 'math', 'mi']) {
      assert.ok((landed.get(element) ?? 0) > 10, `values reached <${element}> content only ${landed.get(element) ?? 0} times`)
    }
    for (const reason of [
      'an end tag the two readings place differently', 'markup SVG would read in a script or style',
      'a CDATA section with a ">" in it', 'a fragment refused where it was nested', 'an element left open',
    ]) {
      assert.ok((tally.refusals.get(reason) ?? 0) > 5, `refused for ${reason} only ${tally.refusals.get(reason) ?? 0} times`)
    }
  })
})
