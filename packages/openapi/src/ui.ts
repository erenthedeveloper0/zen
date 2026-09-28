import { escapeHtml } from '@erenthedeveloper0/zen-core'
import type { OpenApiDocument } from './types.ts'

/**
 * A self-contained API reference — rfcs/0001 §29.2.
 *
 * Scalar, Swagger UI and Redoc are all better-looking than this, and all three
 * are normally wired in with a `<script src="https://cdn…">`. That is a fine
 * default for a public docs site and a bad one for a framework: it makes an
 * internal endpoint phone a third party on every page load, it breaks behind a
 * strict CSP, it breaks in an air-gapped deployment, and it breaks on a laptop
 * on a train. So the built-in viewer has **no external requests at all** — the
 * document is inlined at boot and the page is HTML, CSS and ~90 lines of script.
 *
 * `ui: false` turns it off; serving Scalar or Redoc instead is a five-line route
 * in application code, and the README shows it.
 */
export function renderReference(document: OpenApiDocument, options: { jsonPath: string | null } = { jsonPath: null }): string {
  const title = escapeHtml(document.info.title)
  // `</script` inside a JSON island would end the block early. Escaping `<` is
  // the standard, complete fix — `<` is the same character to JSON.parse.
  const inlined = JSON.stringify(document).replace(/</g, '\\u003c')
  const jsonLink = options.jsonPath === null
    ? ''
    : `<a class="json-link" href="${escapeHtml(options.jsonPath)}">openapi.json</a>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — API reference</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p class="version">v${escapeHtml(document.info.version)}${jsonLink}</p>
</header>
<main id="root"></main>
<script type="application/json" id="spec">${inlined}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}

const STYLE = `
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--code:#f6f6f7;--accent:#3060d0}
@media(prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8ea;--muted:#9a9aa2;--line:#2c2d33;--code:#1e1f24;--accent:#7aa2f7}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:28px 32px 18px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:22px;font-weight:650}
.version{margin:6px 0 0;color:var(--muted);font-size:13px}
.json-link{margin-left:12px;color:var(--accent);text-decoration:none}
.json-link:hover{text-decoration:underline}
main{padding:24px 32px 64px;max-width:1000px}
h2{margin:32px 0 4px;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.tag-desc{margin:0 0 10px;color:var(--muted);font-size:13.5px}
details{border:1px solid var(--line);border-radius:8px;margin:8px 0;background:var(--bg)}
details[open]{background:var(--code)}
summary{cursor:pointer;padding:11px 14px;display:flex;align-items:center;gap:10px;list-style:none;font-size:14px}
summary::-webkit-details-marker{display:none}
.method{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.05em;padding:5px 7px;border-radius:4px;color:#fff;min-width:56px;text-align:center}
.get{background:#2b7a4b}.post{background:#2f5fb3}.put{background:#a86100}.patch{background:#7a4bb3}.delete{background:#b33a3a}.head,.options{background:#5a5a66}
.path{font:13.5px ui-monospace,SFMono-Regular,Menlo,monospace}
.summary{color:var(--muted);font-size:13px;margin-left:auto;text-align:right}
.dep{text-decoration:line-through;opacity:.65}
.body{padding:2px 14px 16px;border-top:1px solid var(--line)}
h3{margin:16px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:6px 0 0}
.req{color:#b33a3a;font-size:11px;margin-left:4px}
.status{font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;margin-right:8px}
`

const SCRIPT = `
const spec = JSON.parse(document.getElementById('spec').textContent)
const root = document.getElementById('root')
const METHODS = ['get','post','put','patch','delete','head','options']

function resolve(schema, depth) {
  if (!schema || depth > 6) return schema || {}
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop()
    const target = (spec.components && spec.components.schemas || {})[name]
    return target ? Object.assign({ 'x-name': name }, resolve(target, depth + 1)) : {}
  }
  return schema
}

function typeOf(schema) {
  const s = resolve(schema, 0)
  if (s['x-name']) return s['x-name']
  if (Array.isArray(s.type)) return s.type.join(' | ')
  if (s.type === 'array') return typeOf(s.items || {}) + '[]'
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(' | ')
  if (s.const !== undefined) return JSON.stringify(s.const)
  return s.type || 'any'
}

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function paramTable(params) {
  const table = el('table')
  table.innerHTML = '<tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr>'
  for (const p of params) {
    const row = table.insertRow()
    const name = row.insertCell()
    name.appendChild(el('code', null, p.name))
    if (p.required) name.appendChild(el('span', 'req', 'required'))
    row.insertCell().textContent = p.in
    row.insertCell().appendChild(el('code', null, typeOf(p.schema)))
    row.insertCell().textContent = p.description || ''
  }
  return table
}

function schemaBlock(schema) {
  return el('pre', null, JSON.stringify(schema, null, 2))
}

function operationNode(path, method, op) {
  const details = el('details')
  const summary = el('summary')
  summary.appendChild(el('span', 'method ' + method, method.toUpperCase()))
  summary.appendChild(el('span', 'path' + (op.deprecated ? ' dep' : ''), path))
  if (op.summary) summary.appendChild(el('span', 'summary', op.summary))
  details.appendChild(summary)

  const body = el('div', 'body')
  if (op.description) body.appendChild(el('p', 'tag-desc', op.description))
  body.appendChild(el('h3', null, 'operationId'))
  body.appendChild(el('code', null, op.operationId))

  if (op.parameters && op.parameters.length) {
    body.appendChild(el('h3', null, 'Parameters'))
    body.appendChild(paramTable(op.parameters))
  }
  if (op.requestBody) {
    body.appendChild(el('h3', null, 'Request body'))
    for (const [media, content] of Object.entries(op.requestBody.content || {})) {
      body.appendChild(el('code', null, media))
      body.appendChild(schemaBlock(content.schema))
    }
  }
  body.appendChild(el('h3', null, 'Responses'))
  for (const [status, response] of Object.entries(op.responses || {})) {
    const line = el('div')
    line.appendChild(el('span', 'status', status))
    line.appendChild(el('span', null, response.description || ''))
    body.appendChild(line)
    for (const content of Object.values(response.content || {})) {
      body.appendChild(schemaBlock(content.schema))
    }
  }
  details.appendChild(body)
  return details
}

const groups = new Map()
for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const method of METHODS) {
    const op = item[method]
    if (!op) continue
    const tag = (op.tags && op.tags[0]) || 'default'
    if (!groups.has(tag)) groups.set(tag, [])
    groups.get(tag).push([path, method, op])
  }
}

const described = new Map((spec.tags || []).map(t => [t.name, t.description]))
for (const tag of [...groups.keys()].sort()) {
  root.appendChild(el('h2', null, tag))
  const description = described.get(tag)
  if (description) root.appendChild(el('p', 'tag-desc', description))
  for (const [path, method, op] of groups.get(tag)) {
    root.appendChild(operationNode(path, method, op))
  }
}
`
