import type { Reply } from '../contracts/reply.ts'
import { html } from './html.ts'
import { htmlReply } from './reply.ts'

/**
 * The development error page — rfcs/0001 §12.6.
 *
 * What a browser gets, in development, for a request that failed: the same
 * facts the problem document's `debug` carries — the code and message, where
 * the route was registered, where the error was raised and the code around
 * it, the route's resolved chain, the fix and its consequence, the docs link —
 * laid out to be read rather than parsed. Built with the `html` tag, so every
 * value in it is escaped by construction (§19.5): an error message is text the
 * application did not write, and a debug page is no place for a reflected
 * script.
 *
 * Development only, and only for a request whose `Accept` prefers HTML: an API
 * client keeps its problem document either way.
 */
export function devErrorPage(problem: Readonly<Record<string, unknown>>): Reply {
  const debug = (problem['debug'] ?? {}) as DevDebug
  const status = typeof problem['status'] === 'number' ? problem['status'] : 500
  const code = String(problem['code'] ?? 'ZEN_INTERNAL')
  const title = String(problem['title'] ?? 'Error')
  const message = typeof debug.message === 'string' ? debug.message : title

  const frame = debug.frame === undefined
    ? html``
    : html`<section><h2>${debug.frame.file}:${debug.frame.line}</h2><pre class="frame">${debug.frame.lines.map((l) =>
      html`<span class="${l.line === debug.frame?.line ? 'hit' : 'line'}"><b>${String(l.line).padStart(5)}</b> ${l.text}
</span>`)}</pre></section>`
  const chain = debug.chain === undefined || debug.chain.length === 0
    ? html``
    : html`<section><h2>What runs on this route</h2><ol>${debug.chain.map((step) => html`<li><code>${step}</code></li>`)}</ol></section>`
  const stack = Array.isArray(debug.stack) && debug.stack.length > 0
    ? html`<section><h2>Stack</h2><pre>${debug.stack.join('\n')}</pre></section>`
    : html``
  const where = [
    debug.thrown === undefined ? null : html`<dt>raised at</dt><dd><code>${debug.thrown}</code></dd>`,
    debug.origin === undefined ? null : html`<dt>route registered at</dt><dd><code>${debug.origin}</code></dd>`,
    debug.route === undefined || debug.route === null ? null : html`<dt>route</dt><dd><code>${debug.route}</code></dd>`,
  ].filter((x) => x !== null)

  const page = html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${status} ${code}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#1d1d1f}
header{background:#b00020;color:#fff;padding:24px 32px}
header p{margin:4px 0 0;opacity:.9}
main{padding:8px 32px 48px;max-width:1100px}
h1{margin:0;font-size:20px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:#555;margin:24px 0 8px}
pre{background:#fff;border:1px solid #ddd;border-radius:6px;padding:12px;overflow:auto;font:13px/1.45 ui-monospace,monospace}
.hit{background:#ffe3e3;display:block}.line{display:block}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{color:#555}dd{margin:0}
.fix{background:#e8f5e9;border-left:4px solid #2e7d32;padding:8px 12px}.also{background:#fff8e1;border-left:4px solid #f9a825;padding:8px 12px}
</style></head>
<body>
<header><h1>${status} · ${code}</h1><p>${message}</p></header>
<main>
${where.length === 0 ? html`` : html`<section><h2>Where</h2><dl>${where}</dl></section>`}
${debug.hint === undefined ? html`` : html`<p class="fix"><b>fix:</b> ${debug.hint}</p>`}
${debug.consequence === undefined ? html`` : html`<p class="also"><b>also:</b> ${debug.consequence}</p>`}
${frame}
${chain}
${stack}
${typeof debug.docs === 'string' ? html`<p>docs: <a href="${debug.docs}">${debug.docs}</a></p>` : html``}
<p><small>Development only: this page is never served without <code>dev: true</code>, and only to a request that asks for HTML.</small></p>
</main>
</body>
</html>`
  return htmlReply(page, { status: status as never })
}

/** The development facts `ErrorEngine` puts in `debug` — see `DevFacts`. */
interface DevDebug {
  readonly message?: unknown
  readonly stack?: readonly string[]
  readonly route?: string | null
  readonly origin?: string
  readonly thrown?: string
  readonly frame?: { readonly file: string; readonly line: number; readonly lines: ReadonlyArray<{ readonly line: number; readonly text: string }> }
  readonly chain?: readonly string[]
  readonly hint?: string
  readonly consequence?: string
  readonly docs?: string
}
