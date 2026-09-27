import { definePlugin, type Reply } from '@visionpilot/zen'

/**
 * Plugins are compiled before the application's decoration set exists, so their
 * middleware is typed structurally against what it actually touches (§10.4) —
 * the same convention `examples/rest-api/src/plugins.ts` uses. Declaring `id`
 * and nothing else is the point: this plugin cannot quietly start depending on
 * `ctx.user` later.
 */
interface TimedContext {
  readonly id: string
}

/**
 * An app-local plugin — `src/plugins/`, §23.4.
 *
 * It exists here to make one thing visible: the docs endpoints are ordinary
 * routes. This after-middleware stamps every reply, including `/openapi.json`
 * and `/docs`, because a plugin-registered route goes through the same registry,
 * the same middleware chain and the same conflict analysis as any other (§29.2).
 */
export const requestId = definePlugin<{ header?: string }, {}>({
  name: 'request-id',
  version: '1.0.0',
  setup(app, options) {
    const header = options.header ?? 'x-request-id'
    app.after(((ctx: TimedContext, reply: Reply) => {
      reply.headers.set(header, ctx.id)
      return reply
    }) as never, { name: 'request-id' })
  },
})
