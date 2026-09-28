import type { AppGraph, Diagnostic, Plugin, SafeHtml } from '@erenthedeveloper0/zen-core'
import { BootError, definePlugin, unsafeHtml } from '@erenthedeveloper0/zen-core'
import { openapiDocument, type OpenApiOptions, type OpenApiResult } from './document.ts'
import type { DocDiagnostic } from './schema.ts'
import { renderReference } from './ui.ts'

/**
 * Serve the generated document — rfcs/0001 §29.2.
 *
 * The document is built **once, in `onBoot`, from the frozen graph**, and what
 * the endpoint serves is a pre-encoded string. Nothing here runs per request
 * except an ETag comparison: the documentation costs one string in memory and
 * zero work on the hot path, which is the whole reason it is architecture (§29.1)
 * rather than a middleware that walks a registry.
 */

export interface OpenApiPluginOptions extends OpenApiOptions {
  /** Where the JSON document is served. `false` disables the endpoint. */
  readonly json?: string | false | undefined
  /** Where the reference viewer is served. `false` disables it. */
  readonly ui?: string | false | undefined
  /**
   * Turn generator warnings into a boot failure.
   *
   * Worth switching on in CI once an API is public: "this route has no response
   * schema" is a documentation hole *and* a missing serializer contract, and the
   * cheapest moment to notice either is before the process starts.
   */
  readonly strict?: boolean | undefined
  /** Receives the finished document — how `zen openapi --out` will write it. */
  readonly onDocument?: ((result: OpenApiResult) => void | Promise<void>) | undefined
}

interface Served {
  result: OpenApiResult | null
  json: string
  etag: string
  html: SafeHtml
}

export const openapiPlugin: Plugin<OpenApiPluginOptions, {}> = definePlugin<OpenApiPluginOptions, {}>({
  name: 'openapi',
  version: '0.1.0',

  setup(app, options) {
    const jsonPath = options.json === undefined ? '/openapi.json' : options.json
    const uiPath = options.ui === undefined ? '/docs' : options.ui
    const served: Served = { result: null, json: '{}', etag: '', html: unsafeHtml('') }

    if (jsonPath !== false) {
      app.route({
        method: 'GET',
        path: jsonPath,
        name: 'openapi.json',
        // Excluded from the document it serves. A docs endpoint that documents
        // itself is noise in every generated client.
        meta: { hidden: true },
        handler: (ctx: DocsContext) => {
          if (ctx.headers['if-none-match'] === served.etag) return ctx.empty(304)
          return ctx.text(served.json, {
            media: 'application/json; charset=utf-8',
            headers: { etag: served.etag, 'cache-control': 'no-cache' },
          })
        },
      })
    }

    if (uiPath !== false) {
      app.route({
        method: 'GET',
        path: uiPath,
        name: 'openapi.ui',
        meta: { hidden: true },
        handler: (ctx: DocsContext) => ctx.html(served.html),
      })
    }

    app.onBoot(async (graph) => {
      const result = openapiDocument(graph as AppGraph, options)
      served.result = result
      served.json = JSON.stringify(result.document, null, 2)
      served.etag = weakEtag(served.json)
      // `unsafeHtml`, once, at boot: the page inlines the document in a JSON
      // island and a script, which `html` rightly refuses to fill from holes,
      // and `renderReference` escapes both itself (`<` as `<` in the
      // island, every text value through `escapeHtml`). The mark is the
      // statement that it did, made where a reviewer can check it (§19.5).
      served.html = unsafeHtml(uiPath === false
        ? ''
        : renderReference(result.document, { jsonPath: jsonPath === false ? null : jsonPath }))

      if (options.strict === true && result.diagnostics.length > 0) {
        throw new BootError(result.diagnostics.map(toBootDiagnostic))
      }
      await options.onDocument?.(result)
    })

    return {
      exports: {
        /** The finished document, once `ready()` has run. */
        document: () => served.result?.document ?? null,
        diagnostics: () => served.result?.diagnostics ?? [],
        json: () => served.json,
      },
    }
  },
})

/** Only the two accessors the handlers use — the plugin needs no decorations. */
interface DocsContext {
  readonly headers: Readonly<Record<string, string | undefined>>
  empty(status?: 204 | 205 | 304): unknown
  text(body: string, init?: { media?: string; headers?: Record<string, string> }): unknown
  html(body: SafeHtml): unknown
}

function toBootDiagnostic(diagnostic: DocDiagnostic): Diagnostic {
  return {
    severity: diagnostic.severity === 'info' ? 'warning' : diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    hint: diagnostic.hint,
    locations: [diagnostic.where],
  }
}

/**
 * FNV-1a over the document string. Weak, and correctly labelled `W/`: the
 * document is regenerated on every boot and two boots of the same code produce
 * byte-identical output (every map is emitted sorted), so this is a content
 * hash, not a resource version.
 */
function weakEtag(body: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `W/"${body.length.toString(36)}-${(hash >>> 0).toString(36)}"`
}
