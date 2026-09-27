import type { Collection } from '@erenthedeveloper0/zen'

/**
 * The routes that must not have a deadline at all.
 *
 * A stream, a long poll, a download. These are why `timeout: false` exists as
 * a distinct value from omitting the key: under an app-wide default, omitting
 * inherits, and a streaming route that silently inherits a two-second budget is
 * a bug that only shows up on the third chunk.
 *
 * Saying `false` at the route is also the readable form. The alternative —
 * registering streams outside the bounded collection — encodes an operational
 * property as a file layout, which is exactly the kind of invisible coupling
 * §10.3 refuses.
 */
export function feedRoutes(c: Collection): void {
  c.get('/live', {
    name: 'feed.live',
    timeout: false,
  }, function liveFeed(ctx) {
    return ctx.stream(async function* () {
      for (let i = 1; i <= 5; i++) {
        // The connection signal still applies — opting out of a *deadline* is
        // not opting out of cancellation. A client that disconnects still ends
        // this loop, which is the difference between an unbounded route and a
        // leaked one.
        if (ctx.signal.aborted) return
        yield `event: tick\ndata: {"n":${i}}\n\n`
        await new Promise((r) => setTimeout(r, 20))
      }
    }, { media: 'text/event-stream' })
  })
}
