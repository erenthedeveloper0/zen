import { definePlugin, type Logger, type Plugin, type Reply } from '@erenthedeveloper0/zen-core'
import { FUNCTION, either, oneOf, optionsSchema, type OptionField } from './shared.ts'

/**
 * Request logging — rfcs/0001 §31.1.
 *
 * One line per request, written through `ctx.log`, so it carries what every
 * other line about the request carries — the request id and the route
 * *template*, which keeps the field's cardinality that of the route table
 * rather than of the URLs — plus what only the end of a request knows:
 *
 *     {"level":"info","requestId":"01J…","route":"/users/:id","method":"GET",
 *      "status":200,"durationMs":1.284,"length":312,"msg":"request"}
 *
 * A global `onResponse` hook, like every member of the pack (§32.1): it runs
 * after the last byte, so it cannot delay or change the response it reports,
 * and an application that does not register it compiles exactly the pipelines
 * it compiled before — `onResponse` lists are held per route by the
 * dispatcher, never emitted into a pipeline (§9.4). It sees every request,
 * matched or not: a 404 flood is the traffic most worth a line.
 *
 * Redaction is the logger's (`logging.redact`, §16.1): this writes no header
 * and no body, only the facts above, so there is nothing of the request's here
 * to hide.
 */
export interface RequestLogOptions {
  /** The level each line is written at. `'info'`. */
  readonly level?: 'trace' | 'debug' | 'info' | 'warn' | undefined
  /**
   * Requests not to log — `(ctx) => ctx.path === '/healthz'`. A probe polled
   * every two seconds is a line nobody reads, written forever.
   */
  readonly skip?: ((ctx: RequestLogContext) => boolean) | undefined
}

/** What the hook reads off a context — structural, so the plugin needs no decoration. */
export interface RequestLogContext {
  readonly method: string
  readonly path: string
  readonly startTime: number
  readonly aborted: boolean
  readonly timedOut: boolean
  readonly log: Logger
}

const OPTIONS = optionsSchema('requestLog', {
  level: oneOf('trace', 'debug', 'info', 'warn'),
  skip: either(FUNCTION),
} satisfies Record<keyof RequestLogOptions, OptionField>)

export function requestLog(options: RequestLogOptions = {}): Plugin<void, {}> {
  const level = options.level ?? 'info'
  const skip = options.skip

  return definePlugin<void, {}>({
    name: 'request-log',
    version: '0.1.0',
    options: OPTIONS,
    boundOptions: options,

    setup(app) {
      app.hook('onResponse', function requestLog(ctx: RequestLogContext, reply: Reply): void {
        if (skip !== undefined && skip(ctx) === true) return
        const fields: Record<string, unknown> = {
          method: ctx.method,
          status: reply.status,
          durationMs: Math.round((performance.now() - ctx.startTime) * 1000) / 1000,
          length: lengthOf(reply),
        }
        // Published by the dispatcher before this hook runs (§4.4): a request
        // that ran out of time and one whose client left are not the same line.
        if (ctx.timedOut) fields['timedOut'] = true
        else if (ctx.aborted) fields['aborted'] = true
        ctx.log[level](fields, 'request')
      }, 'request-log')
    },
  })
}

/** The body's size as sent, when it is known: egress has set `Content-Length` for every body it encoded. */
function lengthOf(reply: Reply): number | null {
  const declared = reply.headers.get('content-length')
  if (declared === undefined) return null
  const length = Number(declared)
  return Number.isFinite(length) ? length : null
}
