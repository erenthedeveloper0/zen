import { definePlugin, Codes, ZenError, type Plugin } from '@erenthedeveloper0/zen-core'
import type { RawReading, Staging } from './shared.ts'

/**
 * Request id — rfcs/0001 §19.4, §31.1.
 *
 * Zen already generates one: the dispatcher assigns `ctx.id` before the first
 * hook runs, so `ctx.log` and the RFC 9457 problem document already carry a
 * correlation key with no plugin at all. This adds the two halves that need a
 * decision rather than a default.
 *
 * ### Echoing it
 *
 * The id is useless to a caller who cannot see it. `x-request-id` on the reply
 * is what turns "something failed at 14:02" into a log query, and staging it
 * through `ctx.res` means it is on the 500 as well as the 200 — which is the
 * only response anybody actually needs it on.
 *
 * ### Accepting one, which is a trust decision
 *
 * Continuing a caller's trace id is the reason people reach for this plugin,
 * and it is **off by default** for the same reason `trustProxy` is (§19.4): an
 * inbound `X-Request-Id` is attacker-controlled. It lands in every log line
 * this request produces, in the problem document, and in whatever index those
 * are shipped to — so an unbounded, unvalidated value is log injection with a
 * framework helpfully doing the writing, and a value chosen to collide with a
 * real id is a way to make one request's trail read as another's.
 *
 * So `trustHeader` is opt-in, and even opted in the value must survive
 * {@link ACCEPTABLE}: 8–128 characters of `[A-Za-z0-9._-]`. That admits every
 * id anybody actually sends — ULIDs, UUIDs, hex, W3C trace ids — and admits no
 * newline, no space and no control character. A value that fails is not an
 * error; the request gets a fresh id, because refusing traffic over the shape
 * of a correlation header would be a worse failure than the one being avoided.
 * `x-request-id-rejected: 1` says it happened, so the caller can find out
 * without reading the server's logs.
 */

/**
 * The one field this plugin writes.
 *
 * `ctx.id` is `readonly` on `BaseContext` and is a plain field on both twins,
 * assigned once by the dispatcher. Overwriting it is a same-type store on an
 * existing field, so it changes no hidden class and I2 is untouched (§7.6) —
 * but it is the only place in this package that writes to a context, and
 * naming the type is how that stays deliberate.
 *
 * The alternative was a second id on a slot, and it is worse in the way that
 * matters: two ids means every log line, every problem document and every
 * downstream header has to say which one it means, and the first one that gets
 * it wrong is discovered during an incident.
 */
interface MutableId {
  id: string
}

export interface RequestIdOptions {
  /** Header to echo on the reply. `false` echoes nothing. */
  readonly header?: string | false | undefined
  /**
   * Adopt an inbound id when it is well-formed. Off by default — see above.
   *
   * `true` reads the same header as `header`. A string reads that one instead,
   * which is what a deployment behind a load balancer that stamps its own
   * (`x-amzn-trace-id`, `x-cloud-trace-context`) needs.
   */
  readonly trustHeader?: boolean | string | undefined
  /** Header carrying the rejection notice. `false` stays silent. */
  readonly rejectedHeader?: string | false | undefined
}

/**
 * 8–128 of `[A-Za-z0-9._-]`.
 *
 * Anchored, no alternation, no nested quantifier: linear in the input and
 * therefore inside §19.3's bounded-work rule, which forbids backtracking
 * regexes anywhere on the request path. The upper bound is part of the
 * validation, not a courtesy — an id is copied into every log line for the
 * request, so an unbounded one is an amplification the caller chooses.
 */
const ACCEPTABLE = /^[A-Za-z0-9._-]{8,128}$/

export function requestId(options: RequestIdOptions = {}): Plugin<void, {}> {
  const echo = options.header === undefined ? 'x-request-id' : options.header
  const trust =
    options.trustHeader === undefined || options.trustHeader === false ? null
    : options.trustHeader === true
      ? (echo === false ? 'x-request-id' : echo)
      : options.trustHeader
  const rejected = options.rejectedHeader === undefined ? 'x-request-id-rejected' : options.rejectedHeader

  if (echo === false && trust === null) {
    throw new ZenError(
      Codes.CONFIG_INVALID,
      'requestId() was configured to neither echo an id nor adopt one, which leaves it with nothing to do.',
      {
        status: 500,
        expose: false,
        hint: 'Drop the registration — Zen assigns ctx.id with or without this plugin — or turn one of the two back on.',
        consequence: 'As configured it registers a hook on every route that returns immediately.',
      },
    )
  }

  return definePlugin<void, {}>({
    name: 'request-id',
    version: '0.1.0',
    // First in the pack: a preflight answered by `cors` and a 429 refused by
    // `rate-limit` both short-circuit, and both should still carry the id that
    // the log line for them will be filed under.
    before: ['cors', 'rate-limit', 'security-headers'],

    setup(app) {
      app.hook('onRequest', function requestId(ctx: RawReading & Staging & MutableId): undefined {
        if (trust !== null) {
          const inbound = ctx.raw.header(trust)
          if (inbound !== undefined) {
            if (ACCEPTABLE.test(inbound)) ctx.id = inbound
            else if (rejected !== false) ctx.res.header(rejected, '1')
          }
        }
        if (echo !== false) ctx.res.header(echo, ctx.id)
        return undefined
      }, 'request-id')

      return { exports: { header: echo, trusts: trust } }
    },
  })
}
