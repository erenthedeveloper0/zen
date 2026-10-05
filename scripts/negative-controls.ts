/**
 * Negative controls — CONTRIBUTING.md convention 3.
 *
 * `node scripts/negative-controls.ts [pattern]`
 *
 * > *A test that passes against the bug is not a test. Before trusting a new
 * > assertion, break the thing it covers and watch it fail.*
 *
 * Every pass of this codebase has run that by hand, and the pass that built the
 * middleware pack wrote down what it cost: *"worth rebuilding as a script next
 * pass rather than doing by hand — it is ~120 lines of patch the source, run one
 * suite, require a failure, restore, and it paid for itself immediately."* This
 * is that script.
 *
 * Each control names a real defect, states which assertion is supposed to catch
 * it, patches exactly one string in one source file, rebuilds, runs one suite,
 * and requires a **failure**. A control that passes is reported as `NOT CAUGHT`
 * and fails the run — the suite it names is proving less than it looks like it
 * is.
 *
 * Three things it refuses to do quietly, because each is a way for a control to
 * become theatre:
 *
 *   - **A `find` string that does not occur exactly once is a stale control**,
 *     not a passing one. Reported as `STALE` and fails the run. This is the
 *     failure mode that would otherwise arrive silently the first time somebody
 *     reformats the line a control depends on.
 *   - **A patch that does not compile is not a control.** The suite would run
 *     against the previous `dist/` and pass, which reads exactly like "the
 *     control was not caught". Reported as `BUILD FAILED`.
 *   - **Sources are restored in a `finally`,** and the run ends with a rebuild,
 *     so an interrupted run leaves the tree as it found it.
 *
 * Note the shape of what is being asserted here: not that the code is correct,
 * but that the *tests* are load-bearing. That is a different property and
 * nothing else in the repo checks it.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

interface Control {
  /** The defect, phrased as what a careless implementation would do. */
  readonly name: string
  readonly file: string
  readonly find: string
  readonly replace: string
  /**
   * A test file, run with `node --test`; or a script — `check-strata.ts`, the
   * claims ledger — run with `node`, which must exit non-zero.
   */
  readonly suite: string
  /** Which assertion is supposed to notice. Printed on a miss. */
  readonly caughtBy: string
}

const CORE = 'packages/core/src'
const ADAPTER = 'packages/adapter-node/src/index.ts'
const OPENAPI_DIFF = 'packages/openapi/src/diff.ts'
const URL_TABLE = 'packages/core/src/runtime/url.ts'

const CONTROLS: readonly Control[] = [
  // ── §13.4: the match ──────────────────────────────────────────────────────
  {
    name: 'score by the highest q among matching ranges, not the most specific one',
    file: `${CORE}/compile/media-type.ts`,
    find: '    if (range.specificity > bestSpecificity) {',
    replace: '    if (range.specificity >= -1) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"an explicit q=0 is honoured even under a wildcard that allows everything"',
  },
  {
    name: 'let an offer the client refused (q=0) win when nothing else matched',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '  let bestIndex = -1\n  let best = 0',
    replace: '  let bestIndex = -1\n  let best = -1',
    suite: 'packages/core/test/negotiation-properties.test.ts',
    caughtBy: 'invariant 5, "a refused representation is never served"',
  },
  {
    name: 'break a quality tie in favour of the last offer instead of the server preference',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '    if (q > best) {',
    replace: '    if (q >= best) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a tie goes to the server, not to the alphabet"',
  },
  {
    name: 'treat a malformed Accept as unsatisfiable instead of as absent',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '  if (ranges === null) return 0',
    replace: '  if (ranges === null) return -1',
    suite: 'packages/core/test/negotiation-properties.test.ts',
    caughtBy: 'invariant 3, "liveness", and the unparseable branch of the property suite',
  },

  // ── §13.4: Vary, and the 406 ──────────────────────────────────────────────
  {
    name: 'stage Vary: Accept only when the request actually sent an Accept header',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '    const staged = ctx.$resHeaders',
    replace: '    if (ctx.raw.header(\'accept\') === undefined) { ctx.$negotiated = negotiator(undefined); return }\n    const staged = ctx.$resHeaders',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"Vary: Accept is present with no Accept header, and on the 406"',
  },
  {
    name: 'answer 406 without saying what the route can produce',
    file: `${CORE}/runtime/negotiation.ts`,
    find: '    { details: { available } },',
    replace: '    {},',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"an unacceptable Accept is a 406 that lists what the route can produce"',
  },

  // ── §13.4: binding the contract ───────────────────────────────────────────
  {
    name: 'give a plain-form status the negotiated Content-Type',
    file: `${CORE}/runtime/response-engine.ts`,
    find: '  if (chosen !== null && chosen.statuses.has(status)) {',
    replace: '  if (chosen !== null) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a status declared in the plain form keeps its own Content-Type"',
  },
  {
    name: 'drop the negotiated media when an onSerialize hook replaces the payload',
    file: `${CORE}/runtime/response-engine.ts`,
    find: "    ;(reply as MutableReply).body = { kind: 'json', value, serialize: body.serialize, media: body.media }",
    replace: "    ;(reply as MutableReply).body = { kind: 'json', value, serialize: body.serialize }",
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"an onSerialize hook that swaps the payload keeps the representation"',
  },

  // ── §9.4: the zero-cost rule ──────────────────────────────────────────────
  {
    name: 'emit the negotiation step on every route, not only on negotiated ones',
    file: `${CORE}/compile/pipeline-compiler.ts`,
    find: '  const negotiates = (spec.negotiate ?? null) !== null',
    replace: '  const negotiates = true',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a plain route emits a pipeline byte-identical to one in an app with no negotiation"',
  },

  // ── §12.7: the boot diagnostics ───────────────────────────────────────────
  {
    name: 'accept the same media type declared twice',
    file: `${CORE}/compile/negotiation.ts`,
    find: '      if (offers.includes(parsed.media)) {',
    // Not `if (false)`: TypeScript reports the `continue` below as unreachable
    // and the patch stops compiling, which this script correctly refuses to
    // score as a caught control. The condition has to be opaque to the checker.
    replace: '      if (offers.includes(parsed.media) && offers.length < 0) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"the same media type twice is refused, because only one could be reached"',
  },
  {
    name: 'let two statuses on one route offer different media types',
    file: `${CORE}/compile/negotiation.ts`,
    find: '    if (offers.length === reference.length && offers.every((m, i) => m === reference[i])) continue',
    replace: '    continue',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"two statuses offering different media types is refused, naming both"',
  },
  {
    name: 'require every key to be a media type, so one typo hides the whole declaration',
    file: `${CORE}/compile/media-type.ts`,
    find: '  for (const key of Object.keys(value)) {\n    if (key.indexOf(\'/\') !== -1) return true\n  }\n  return false',
    replace: '  const keys = Object.keys(value)\n  if (keys.length === 0) return false\n  for (const key of keys) {\n    if (key.indexOf(\'/\') === -1) return false\n  }\n  return true',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"a typo alongside real media types names the typo, not the schema"',
  },

  // ── §4.4, §14.3: the Node adapter — defects only a real socket can see ────
  {
    name: 'treat the request body being consumed as the client disconnecting',
    file: ADAPTER,
    find: "    response.once('close', () => {\n      if (!response.writableFinished) this.#controller.abort()\n    })",
    replace: "    request.once('close', () => {\n      if (!response.writableEnded) this.#controller.abort()\n    })",
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"is not aborted by reading the request body"',
  },
  // No control for the adapter's `headersSent` guard, and that is this
  // script's finding rather than an omission: its first run showed the guard
  // is unreachable. Every path that sends headers and then fails goes through
  // `#pipe`, which destroys the response first, so the `destroyed` check above
  // it always answers. The guard stays, documented as defence in depth — but a
  // control that cannot be caught would be a permanently red line proving
  // nothing, which is the one thing this table must never contain.
  {
    name: 'log a client that left mid-stream as an application failure',
    file: ADAPTER,
    find: '      if (failure.failed) throw failure.error',
    replace: "      if (failure.failed || this.signal.aborted) throw failure.error ?? new Error('client left')",
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"survives a client disconnecting mid-stream, with nothing logged as a failure"',
  },
  {
    name: 'let keep-alive connections idle through shutdown',
    file: ADAPTER,
    find: '          state.closing = true',
    replace: '          state.closing = false',
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"does not wait out shutdownTimeout for connections a client is keeping alive"',
  },
  {
    name: 'serve a file that resolves outside its root',
    file: 'packages/adapter-node/src/file.ts',
    find: '  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep)',
    replace: '  return true',
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"refuses paths that escape the root, including through a symlink"',
  },

  // ── §13.5: server-sent events ─────────────────────────────────────────────
  {
    name: 'send a returned SSE channel as an octet-stream',
    file: `${CORE}/runtime/response-engine.ts`,
    find: '    if (isSseChannel(value)) return value.$reply\n',
    replace: '',
    suite: 'packages/core/test/sse.test.ts',
    caughtBy: '"finalize() turns a returned channel into its reply, not an octet-stream"',
  },
  {
    name: 'stop listening for disconnects when the deadline clock stops',
    file: `${CORE}/api/zen.ts`,
    find: '        deadline?.settle()\n        await this.#send(ctx, conn, reply, hooks.onResponse)',
    replace: '        deadline?.disarm()\n        await this.#send(ctx, conn, reply, hooks.onResponse)',
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"closes the channel and aborts ctx.signal when the client leaves — on a route with a deadline too"',
  },
  {
    name: 'let a channel buffer without bound for a client that stopped reading',
    file: `${CORE}/runtime/sse.ts`,
    find: '    if (buffered + frame.byteLength > maxBuffered) {',
    replace: '    if (buffered + frame.byteLength > maxBuffered && maxBuffered < 0) {',
    suite: 'packages/core/test/sse.test.ts',
    caughtBy: '"closes a stream whose reader has fallen further behind than maxBuffered"',
  },

  // ── §15: the container under concurrency and at shutdown ─────────────────
  {
    name: 'run an async singleton factory once per concurrent caller',
    file: `${CORE}/di/container.ts`,
    find: '      if (entry.pending !== null) return entry.pending\n',
    replace: '',
    suite: 'packages/core/test/di.test.ts',
    caughtBy: '"concurrent first resolves of an async singleton share one build"',
  },
  {
    name: 'stop disposing services at the first disposer that throws',
    file: `${CORE}/di/container.ts`,
    find: '      } catch (error) {\n        failures.push(error)\n      }',
    replace: '      } catch (error) {\n        throw error\n      }',
    suite: 'packages/core/test/di.test.ts',
    caughtBy: '"dispose() runs every disposer even when one throws, then reports them together"',
  },
  {
    name: 'abandon shutdown when an onClose hook throws',
    file: `${CORE}/api/zen.ts`,
    find: "        this.#log.error({ err: error, hook: hook.name }, 'onClose hook threw; continuing shutdown')",
    replace: '        throw error',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"runs every onClose hook and disposes services even when a hook throws"',
  },

  // ── §9.7, §7.5: registrations that could never take effect ───────────────
  {
    name: 'file a hook for an unknown phase and never call it',
    file: `${CORE}/api/zen.ts`,
    find: '    diagnostics.push(...diagnoseUnknown(this.#allHookRecords()))\n',
    replace: '',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"names the phase and suggests the one that was meant"',
  },
  {
    name: 'let a plugin decorate a name the context already owns',
    file: `${CORE}/api/zen.ts`,
    find: '    if (CONTEXT_MEMBERS.has(name)) {',
    replace: '    if (CONTEXT_MEMBERS.has(name) && name.length < 0) {',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"refuses a name the framework owns — it would replace ctx.json() on every route"',
  },

  // ── §11.4.1, §19.5: values that must not be quietly altered ──────────────
  {
    name: 'let <int> match an id it cannot represent exactly',
    file: 'packages/router/src/param-types.ts',
    find: ' && Number.isSafeInteger(Number(s))',
    replace: '',
    suite: 'packages/router/test/router.test.ts',
    caughtBy: '"an id past 2^53 does not match rather than rounding to another row"',
  },
  {
    name: "write a cookie Path containing ';' verbatim",
    file: `${CORE}/runtime/cookies.ts`,
    find: "  if (cookie.path !== undefined && !COOKIE_ATTRIBUTE.test(cookie.path)) throw invalidCookie('path', cookie.path)\n",
    replace: '',
    suite: 'packages/core/test/cookies.test.ts',
    caughtBy: '"refuses a `;` in the name, the domain or the path — it would start a new attribute"',
  },
  {
    name: "decode '+' as a space outside form encoding — in a path segment or a cookie",
    file: `${CORE}/primitives/path.ts`,
    find: '    return decodeURIComponent(value)\n',
    replace: "    return decodeURIComponent(value.replace(/\\+/g, ' '))\n",
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"a `+` is a plus — only form encoding spells a space that way"',
  },

  // ── §5.5, §5.6: which route answers ──────────────────────────────────────
  {
    name: 'let two routes share a name, so one answers the other\'s requests',
    file: `${CORE}/api/zen.ts`,
    find: '      const owner = ids.get(id)\n      if (owner !== undefined) {',
    replace: '      const owner = ids.get(id)\n      if (owner !== undefined && id.length < 0) {',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"two routes sharing a name are a boot error, not two routes answering each other"',
  },
  {
    name: 'try typed params in registration order',
    file: 'packages/router/src/trie.ts',
    find: '        node.typed.sort((x, y) => (x.type.name < y.type.name ? -1 : x.type.name > y.type.name ? 1 : 0))\n',
    replace: '',
    suite: 'packages/router/test/router.test.ts',
    caughtBy: '"the matcher tries typed params in the same order however they were registered"',
  },
  {
    name: 'read two different param types in one position as disjoint, whatever they accept',
    file: 'packages/router/src/conflicts.ts',
    find: "      if (shared === false) return { verdict: 'disjoint', witness: null, undecided: null }",
    replace: "      if (shared !== null) return { verdict: 'disjoint', witness: null, undecided: null }",
    suite: 'packages/router/test/router.test.ts',
    caughtBy: '"types that share a value are ambiguous, and the message names the value"',
  },
  {
    name: "leave HEAD out of a 405's Allow although the GET route serves it",
    file: 'packages/router/src/trie.ts',
    find: "  if (methods.has('GET')) allowed.add('HEAD')\n",
    replace: '',
    suite: 'packages/router/test/router.test.ts',
    caughtBy: '"405 reports the methods that exist on the path"',
  },
  {
    name: 'match an absolute-form request target as though it were a path',
    file: `${CORE}/primitives/path.ts`,
    find: '  const target = url.charCodeAt(0) === 47 /* / */ ? url : originForm(url)\n',
    replace: '  const target = url.length >= 0 ? url : originForm(url)\n',
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"an absolute-form request target is routed by its path (RFC 9112 §3.2.2)"',
  },

  // ── §2.2, §8.2: boot and the middleware contract ─────────────────────────
  {
    name: 'boot again for every caller instead of once',
    file: `${CORE}/api/zen.ts`,
    find: '    return (this.#booting ??= this.#boot())',
    replace: '    return this.#boot()',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"concurrent callers share one boot — a plugin\'s setup runs once"',
  },
  {
    name: 'hand an around middleware a bare Reply from next() when the rest compiled synchronous',
    file: `${CORE}/compile/pipeline-compiler.ts`,
    find: '          : `async function () { return ${inner.name}(ctx) }`',
    replace: '          : `function () { return ${inner.name}(ctx) }`',
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"next() is a Promise even when everything downstream compiled synchronous"',
  },

  // ── §4.2 stage 10, §7.4, §15.3: what a request releases ──────────────────
  {
    name: 'remember one value per disposer, so a slot set twice leaks its first value',
    file: `${CORE}/primitives/disposal.ts`,
    find: '    if (entry.value === value && entry.dispose === dispose) return',
    replace: '    if (entry.dispose === dispose) return',
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"a disposable slot set twice releases both values, newest first, once each"',
  },
  {
    name: 'queue what a settled request acquires on a list nothing will read again',
    file: `${CORE}/primitives/disposal.ts`,
    find: '  if (list === SETTLED) {\n',
    replace: '  if (list === SETTLED && name.length < 0) {\n',
    suite: 'packages/core/test/di.test.ts',
    caughtBy: '"a scoped service that finishes opening after its deadline answered is released at once"',
  },
  {
    name: "accept a scoped provider's dispose and never call it",
    file: `${CORE}/di/container.ts`,
    find: '        trackDisposal(scope as DisposalCarrier, entry.token.name, dispose, value)\n',
    replace: '',
    suite: 'packages/core/test/di.test.ts',
    caughtBy: '"each request disposes the instance it created, once, after the response"',
  },

  // ── §4.4: what a blown deadline reports ──────────────────────────────────
  {
    name: 'report a deadline as blown in less time than its budget',
    file: `${CORE}/runtime/deadline.ts`,
    find: '      elapsedMs: elapsed < this.budgetMs ? this.budgetMs : elapsed,',
    replace: '      elapsedMs: elapsed,',
    suite: 'packages/core/test/timeouts.test.ts',
    caughtBy: '"elapsedMs is never below the budget, whichever clock fired the timer"',
  },

  // ── the edges of a request ───────────────────────────────────────────────
  {
    name: 'let the default logger throw on a line JSON.stringify refuses',
    file: `${CORE}/runtime/logger.ts`,
    find: '        text = JSON.stringify(line, tolerant())',
    replace: "        text = JSON.stringify(line, tolerant()) ; throw new Error('unserialisable')",
    suite: 'packages/core/test/logger.test.ts',
    caughtBy: '"writes a line for a value JSON.stringify refuses — a cycle, a bigint"',
  },
  {
    name: 'answer an invalid Host header with a 500 from whichever handler reads ctx.url',
    file: `${CORE}/runtime/context.ts`,
    find: "    throw new BadRequest('The request target or its Host header is not a valid URL.')",
    replace: "    throw new TypeError('Invalid URL')",
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"an invalid Host header makes ctx.url a 400, not a TypeError"',
  },
  {
    name: 'refuse a +json body with a 415',
    file: `${CORE}/runtime/body.ts`,
    find: "(media.endsWith('+json') ? parsers.get('application/json') : undefined)",
    replace: "(media.endsWith('+xml') ? parsers.get('application/json') : undefined)",
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"a +json media type is JSON (RFC 6839)"',
  },
  {
    name: 'let a client that cancels an upload surface as an application 500',
    file: ADAPTER,
    find: '      if (signal?.aborted === true && error !== signal.reason) throw signal.reason\n      if (isClientAbort(error)) throw',
    replace: '      if (signal?.aborted === true && error !== signal.reason && error === null) throw signal.reason\n      if (isClientAbort(error) && error === null) throw',
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"is reported as the client leaving, not logged as an application failure"',
  },
  {
    name: 'ignore the port in app.listen(port)',
    file: `${CORE}/api/zen.ts`,
    find: '      ? { port: target, ...(host === undefined ? {} : { host }) }',
    replace: '      ? { ...(host === undefined ? {} : { host }) }',
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"takes a port number, as the five-line app of §1.2 writes it"',
  },
  {
    name: 'declare ListenOptions.signal and never listen to it',
    file: `${CORE}/api/zen.ts`,
    find: "      signal.addEventListener('abort', onAbort, { once: true })\n",
    replace: '      void onAbort\n',
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"shuts down gracefully when its signal aborts"',
  },

  // ── §19.5: HTML escaped by construction ──────────────────────────────────
  {
    name: 'forget one of the five characters escapeHtml escapes',
    file: `${CORE}/runtime/html.ts`,
    find: "      case 0x3c: entity = '&lt;'; break\n",
    replace: '',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"escapes a string, so a script tag is text", and the never-escapes-its-hole property',
  },
  {
    name: 'write a hole inside <script> as escaped text instead of refusing the template',
    file: `${CORE}/runtime/html.ts`,
    find: '      case SCRIPT:\n        return this.#refuse(',
    replace: '      case SCRIPT:\n        if (this.#rawEnd.length > 0) return K_TEXT\n        return this.#refuse(',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses inside <script>"',
  },
  {
    name: 'escape an event handler instead of refusing it — the entity-decoding bypass',
    file: `${CORE}/runtime/html.ts`,
    find: "    if (attribute.startsWith('on')) {",
    replace: "    if (attribute.startsWith('on') && attribute.length < 0) {",
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses an event handler"',
  },
  {
    name: 'escape a javascript: URL in an href instead of replacing it',
    file: `${CORE}/runtime/html.ts`,
    find: "  return kind === 'ambiguous' || (kind === 'scheme' && !SAFE_SCHEMES.has(reading.scheme))",
    replace: "  return kind === 'ambiguous'",
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"replaces javascript:, in every spelling a browser accepts", and the WHATWG-oracle property',
  },
  {
    name: 'read a URL without removing tab and newline, as the URL parser does — java\\tscript:',
    file: `${CORE}/primitives/url-reference.ts`,
    find: '      if (c === 0x09 || c === 0x0a || c === 0x0d) continue\n',
    replace: '',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"replaces javascript:, in every spelling a browser accepts"',
  },
  {
    name: 'let a <script src> hole choose the origin, checking only its scheme',
    file: `${CORE}/runtime/html.ts`,
    find: '    const origin = ORIGIN_ATTRIBUTES.get(tag)?.has(attribute) === true',
    replace: '    const origin = ORIGIN_ATTRIBUTES.get(tag)?.has(attribute) === false',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"keeps a path on this origin and replaces anything else", and the script-source property',
  },
  {
    name: 'write SafeHtml verbatim in an attribute, where its own quote ends the value',
    file: `${CORE}/runtime/html.ts`,
    find: '      case K_TEXT:\n        out += escapeHtml(asText(value))',
    replace: '      case K_TEXT:\n        out += asMarkup(value)',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"escapes SafeHtml too — markup means nothing in an attribute"',
  },
  {
    name: 'let ctx.html() take a plain string',
    file: `${CORE}/runtime/html.ts`,
    find: '  if (Markup.is(value)) return Markup.read(value)\n  throw new ZenError(',
    replace: "  if (Markup.is(value)) return Markup.read(value)\n  if (typeof value === 'string') return value\n  throw new ZenError(",
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"ctx.html() refuses a plain string"',
  },
  {
    name: 'brand SafeHtml with instanceof, which a borrowed prototype satisfies',
    file: `${CORE}/runtime/html.ts`,
    find: "return typeof value === 'object' && value !== null && #markup in value",
    replace: "return typeof value === 'object' && value !== null && value instanceof Markup",
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"cannot be forged by data — a parsed body, an object literal, a borrowed prototype"',
  },
  {
    name: "let a text element's end tag hide where the markup reading does not end the element — the </noscript> bypass",
    file: `${CORE}/runtime/html.ts`,
    find: '      if (c === LESS_THAN && this.#textElements.length > 0 && this.state !== DATA && this.state !== TAG_OPEN) {',
    replace: '      if (c === LESS_THAN && this.#textElements.length < 0) {',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses a text element\'s end tag where the markup reading would not end the element", and the whole-pages property',
  },
  {
    name: 'track only the outermost text element, missing the HTML <textarea> an SVG <title> lets back in',
    file: `${CORE}/runtime/html.ts`,
    find: '      if (TEXT_ELEMENTS.has(tag)) this.#textElements.push(tag)',
    replace: '      if (TEXT_ELEMENTS.has(tag) && this.#textElements.length === 0) this.#textElements.push(tag)',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses a text element\'s end tag where the markup reading would not end the element" (the SVG <title> case)',
  },
  {
    name: 'let a hole finish an end tag the written text began inside an attribute',
    file: `${CORE}/runtime/html.ts`,
    find: '    const finishes = this.#textElements.find((name) => endsPartWayInto(before, `</${name}`))',
    replace: '    const finishes = this.#textElements.find((name) => name.length < 0)',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses a hole that could finish such an end tag"',
  },
  {
    name: 'end a <style>, or an SVG <script>, where HTML does without asking whether SVG would too',
    file: `${CORE}/runtime/html.ts`,
    find: '    if (!holdsMarkup(text)) return\n',
    replace: '    if (!holdsMarkup(text) || text.length >= 0) return\n',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses what SVG would read as markup inside a <style>, or inside a <script> in an <svg>", and the whole-pages property',
  },
  {
    name: 'let a CDATA section end at the first ">" for HTML and at "]]>" for SVG',
    file: `${CORE}/runtime/html.ts`,
    find: '            if (i - 2 >= this.#cdataFrom && text.charCodeAt(i - 1) === CLOSE_BRACKET && text.charCodeAt(i - 2) === CLOSE_BRACKET) {',
    replace: '            if (i >= 0) {',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses a CDATA section that HTML and SVG would end in different places"',
  },
  {
    name: 'accept a template that leaves a text element or an <svg> open',
    file: `${CORE}/runtime/html.ts`,
    find: '    if (this.state === DATA && this.#textElements.length === 0 && this.#foreignOpen.length === 0) return null',
    replace: '    if (this.state === DATA) return null',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"refuses a template that leaves a text element, an <svg> or a <math> open"',
  },
  {
    name: 'write a fragment verbatim inside a <textarea> even when it holds "</textarea"',
    file: `${CORE}/runtime/html.ts`,
    find: '          if (couldEndElement(markup, element)) throw fragmentEndsElement(element)',
    replace: '          if (couldEndElement(markup, element) && element.length < 0) throw fragmentEndsElement(element)',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"a fragment inside a text element may not end it — a string cannot, because it is escaped"',
  },
  {
    name: 'nest a fragment whose script only HTML can read inside an <svg>',
    file: `${CORE}/runtime/html.ts`,
    find: '      if (foreign && !Markup.foreignSafe(value)) throw fragmentScriptInForeign()',
    replace: '      if (foreign && !Markup.foreignSafe(value) && markup.length < 0) throw fragmentScriptInForeign()',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"a fragment whose script only HTML can read is refused inside SVG, however deep, and fine outside it"',
  },
  {
    name: 'send a handler\'s returned html`` as an octet stream instead of a page',
    file: `${CORE}/runtime/response-engine.ts`,
    find: '    if (isSafeHtml(value)) return htmlReply(value)\n',
    replace: '',
    suite: 'packages/core/test/html.test.ts',
    caughtBy: '"a handler may return html`` — a page, as a returned string is text"',
  },

  // ── §19.5, §13.6: headers checked where they are set ────────────────────
  {
    name: 'check a short header value for CR, LF and NUL only, and let the adapter find the rest',
    file: `${CORE}/runtime/headers.ts`,
    find: '    if ((c < 0x20 && c !== 0x09) || c === 0x7f || c > 0xff) return i',
    replace: '    if (c === 0x0d || c === 0x0a || c === 0x00) return i',
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"refuses every character a header cannot carry, and a name that is not a token"',
  },
  {
    name: 'check a long header value for CR, LF and NUL only',
    file: `${CORE}/runtime/headers.ts`,
    find: 'const NOT_FIELD_VALUE = /[^\\t\\x20-\\x7e\\x80-\\xff]/',
    replace: 'const NOT_FIELD_VALUE = /[\\r\\n\\0]/',
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"refuses every character a header cannot carry…" (the 60-character values)',
  },
  {
    name: 'trust any header name, which Node then refuses outside the error path',
    file: `${CORE}/runtime/headers.ts`,
    find: "    if (typeof name !== 'string' || !TOKEN.test(name)) {",
    replace: "    if (typeof name !== 'string') {",
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"refuses every character a header cannot carry, and a name that is not a token"',
  },
  {
    name: 'check a staged header only at egress, where its failure escapes the error path',
    file: `${CORE}/runtime/context.ts`,
    find: '    assertHeader(name, value)\n    ;(this.#ctx.$resHeaders ??= []).push([name, value, false])',
    replace: '    ;(this.#ctx.$resHeaders ??= []).push([name, value, false])',
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"… is an ordinary ZEN_HEADER_INVALID 500, and onResponse still sees it"',
  },
  {
    name: 'check a staged cookie only at egress',
    file: `${CORE}/runtime/context.ts`,
    find: '    const cookie = { name, value, ...opts }\n    assertCookie(cookie)\n',
    replace: '    const cookie = { name, value, ...opts }\n',
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"a cookie name that is not a token is an ordinary ZEN_HEADER_INVALID 500…"',
  },
  {
    name: 'write a redirect target past ASCII raw, which no header can carry',
    file: `${CORE}/runtime/reply.ts`,
    find: "  reply.headers.set('location', NON_ASCII.test(to) ? percentEncodeNonAscii(to) : to)",
    replace: "  reply.headers.set('location', to)",
    suite: 'packages/core/test/redirect.test.ts',
    caughtBy: '"encodes each code point as UTF-8, which is what a browser makes of it anyway"',
  },

  // ── §19.5: redirects that stay home ──────────────────────────────────────
  {
    name: 'read a backslash as a path character, so /\\evil.example stays "local"',
    file: `${CORE}/primitives/url-reference.ts`,
    find: "        return this.#decide(c === 0x2f || c === 0x5c ? 'network' : 'local')",
    replace: "        return this.#decide(c === 0x2f ? 'network' : 'local')",
    suite: 'packages/core/test/redirect.test.ts',
    caughtBy: '"refuses everything else, in every spelling that has bypassed a check", and the WHATWG differential',
  },
  {
    name: 'let every http(s) redirect leave by default',
    file: `${CORE}/runtime/redirect.ts`,
    find: 'export const SAME_ORIGIN_ONLY: RedirectPolicy = Object.freeze({\n  anyHttp: false,',
    replace: 'export const SAME_ORIGIN_ONLY: RedirectPolicy = Object.freeze({\n  anyHttp: true,',
    suite: 'packages/core/test/redirect.test.ts',
    caughtBy: '"refuses everything else, in every spelling that has bypassed a check"',
  },
  {
    name: 'match the redirect allowlist on the host and ignore the scheme',
    file: `${CORE}/runtime/redirect.ts`,
    find: '    if (!policy.origins.has(origin)) {',
    replace: "    if (!policy.origins.has(origin.replace(/^http:/, 'https:'))) {",
    suite: 'packages/core/test/redirect.test.ts',
    caughtBy: '"refuses the look-alikes: a subdomain, userinfo, another scheme, another port"',
  },

  // ── §5.7: a URL url() returns reaches its route, with its values ──────────
  {
    name: 'write a value into its segment unencoded, so "a/b?c" becomes a path and a query',
    file: URL_TABLE,
    find: '    return encodeURIComponent(text)',
    replace: '    return text',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"a parameter is one segment, whatever it holds", and the property suite\'s WHATWG and router oracles',
  },
  {
    name: 'let a ".." through, which a browser resolves to a different path before sending',
    file: URL_TABLE,
    find: '  if (isDotSegment(text)) throw refusal(plan, dotRefusal(label, text))\n  if (part.type !== null',
    replace: '  if (part.type !== null',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"refuses ".", ".." and "" — no encoding can carry them to the route", and the WHATWG oracle',
  },
  {
    name: 'build a segment its parameter\'s type refuses, a link the router 404s',
    file: URL_TABLE,
    find: '  if (part.type !== null && !part.type.test(text)) {',
    replace: '  if (part.type !== null && !part.type.test(text) && text.length < 0) {',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"a parameter\'s type tests the value, so a link the router 404s is never built"',
  },
  {
    name: 'skip asking the router, so /users/:id given "me" links to GET /users/me',
    file: URL_TABLE,
    find: '    if (match !== null && match.route !== null && match.route.id === plan.route.id) return',
    replace: '    if (match !== null && match.route !== null && match.route.id !== \'\') return',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"a static route outranks a parameter", and the property suite\'s route oracle',
  },
  {
    name: 'accept an empty parameter, whose path is another route\'s',
    file: URL_TABLE,
    find: "  if (text === '') {\n    throw refusal(plan, `was given an empty ${label}, and a path",
    replace: "  if (text === '' && text.length < 0) {\n    throw refusal(plan, `was given an empty ${label}, and a path",
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"refuses ".", ".." and """, and the property suite',
  },
  {
    name: 'let a wildcard piece hold a "/", which arrives as two pieces',
    file: URL_TABLE,
    find: "      if (text.includes('/')) {",
    replace: "      if (text.includes('/') && text.length < 0) {",
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"a wildcard takes the rest of the path, as a string or as its segments"',
  },
  {
    name: 'give an optional parameter while the one before it was left out',
    file: URL_TABLE,
    find: '      if (omitted !== null) {',
    replace: '      if (omitted !== null && omitted.length < 0) {',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"…only from the end, under a path syntax that allows several (§3.5)"',
  },
  {
    name: 'write a Date the way String() does, which no <date> route matches',
    file: URL_TABLE,
    find: '      return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null',
    replace: '      return value instanceof Date && !Number.isNaN(value.getTime()) ? String(value) : null',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"a number, a bigint, a boolean and a Date are written the way their routes read them back"',
  },
  {
    name: 'send a __proto__ query key, which every parser here drops on arrival',
    file: URL_TABLE,
    find: '      if (isForbiddenKey(key)) {',
    replace: '      if (isForbiddenKey(key) && key.length < 0) {',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"refuses what the parser would drop or reshape", and the property suite\'s query oracle',
  },
  {
    name: 'join a comma list whose element holds a comma, which arrives as two values',
    file: URL_TABLE,
    find: '    if (text.includes(separator)) {',
    replace: '    if (text.includes(separator) && separator.length < 0) {',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"a list joined with commas where the route\'s profile says comma — and refused where that cannot round-trip"',
  },
  {
    name: 'quote the value a parameter\'s type refused, putting a token from a link into the log',
    file: URL_TABLE,
    find: "  return `a value of ${text.length} character${text.length === 1 ? '' : 's'}`",
    replace: '  return JSON.stringify(text)',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"never puts a value it was given into a refusal — a link is where tokens live"',
  },
  {
    name: 'print the built path when another route outranks it, values and all',
    file: URL_TABLE,
    find: '      `built a path that ${winner.method} ${winner.path}',
    replace: '      `built ${path}, which ${winner.method} ${winner.path}',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"never puts a value it was given into a refusal", the outranked case',
  },
  {
    name: 'build more query pairs than maxQueryParams lets the parser read, silently losing the rest',
    file: URL_TABLE,
    find: '    if (pairs.length > this.#maxQueryParams) {',
    replace: '    if (pairs.length > this.#maxQueryParams * 1000) {',
    suite: 'packages/core/test/url.test.ts',
    caughtBy: '"refuses what the parser would drop or reshape: __proto__, a nested object, more pairs than it reads"',
  },

  // ── §29.7: the API diff reads what a schema says, not how it is spelled ───
  {
    name: 'read a schema\'s types off `type` alone, so an anyOf states none',
    file: OPENAPI_DIFF,
    find: '  if (!Array.isArray(listed) || listed.length === 0 || depth > 8) return null',
    replace: '  if (!Array.isArray(listed) || listed.length >= 0 || depth > 8) return null',
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: '"an equivalent spelling is not a change — the anyOf zod 4.4 wrote and the type list 4.6 writes"',
  },
  {
    name: 'compare a nullable union by its types only, so a field can leave its object unseen',
    file: OPENAPI_DIFF,
    find: '  if (others.length === 1) {',
    replace: '  if (others.length === 1 && others.length < 0) {',
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: '"a field removed from a nullable object is breaking — inside an anyOf it used to be invisible"',
  },
  {
    name: 'leave const unread, so a const and a one-value enum diff as a change',
    file: OPENAPI_DIFF,
    find: '  const spelled = node.const !== undefined && node.enum === undefined ? { ...node, enum: [node.const] } : node',
    replace: '  const spelled = node',
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: '"an equivalent spelling is not a change", the const / enum pair',
  },
  {
    name: 'guard on the location as well as the component, so a recursive schema never stops',
    file: OPENAPI_DIFF,
    find: "  const key = before.ref === undefined && after.ref === undefined ? null : `${before.ref ?? ''}|${after.ref ?? ''}`",
    replace: "  const key = before.ref === undefined && after.ref === undefined ? null : `${before.ref ?? ''}|${after.ref ?? ''}|${where}`",
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: '"a recursive component is compared down to where it repeats, and the diff terminates"',
  },
  {
    name: 'never release a component from the guard, so its second use is skipped',
    file: OPENAPI_DIFF,
    find: '    if (key !== null) active.delete(key)',
    replace: '    if (key !== null && key.length < 0) active.delete(key)',
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: '"a component used twice in one response is reported at both uses"',
  },

  // ── 0.1.0-alpha.4: nothing silent ────────────────────────────────────────
  {
    name: 'leave anyOf branches out of the writeOnly walk, so a union carries the field out',
    file: `${CORE}/compile/exposure.ts`,
    find: '    for (const branch of [node.anyOf, node.oneOf, node.allOf]) {',
    replace: '    for (const branch of [node.oneOf, node.allOf]) {',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"…however deep, through arrays, records and every branch of a union"',
  },
  {
    name: 'check the plain JSON form for writeOnly and skip the schema handed to an encoder',
    file: `${CORE}/compile/negotiation.ts`,
    find: '        const exposed = exposureDiagnostics(shape, { routeId: options.routeId, status, media })',
    replace: '        const exposed = exposureDiagnostics(shape, { routeId: options.routeId, status, media }).slice(0, 0)',
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: '"every negotiated representation is checked, and a schema handed to an encoder too"',
  },
  {
    name: 'document a writeOnly field as returned, because boot refuses one anyway',
    file: 'packages/openapi/src/schema.ts',
    find: '        if (this.#opts.closed && this.#writeOnly(properties[key])) {',
    replace: '        if (this.#opts.closed && this.#writeOnly(properties[key]) && key.length < 0) {',
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: '"withholds it from a response projection, and from its required list"',
  },
  {
    name: "skip the options schema, so setup gets { limt: 100 } and falls back to a default",
    file: `${CORE}/api/zen.ts`,
    find: '      const verdict = await validatePluginOptions(entry.plugin, given)',
    replace: '      const verdict = await validatePluginOptions({ ...entry.plugin, options: undefined }, given)',
    suite: 'packages/core/test/plugins.test.ts',
    caughtBy: '"a key the schema does not declare is named, with the one it was meant to be"',
  },
  {
    name: 'validate the options, then hand setup what was written rather than the output',
    file: `${CORE}/api/zen.ts`,
    find: '            accepted.get(entry) as never,',
    replace: '            entry.options as never,',
    suite: 'packages/core/test/plugins.test.ts',
    caughtBy: '"setup receives the validated output — defaults applied — not what was written"',
  },
  {
    name: "name an unknown option without the declared key it was probably meant to be",
    file: `${CORE}/compile/plugin-options.ts`,
    find: '    out.push({ key, suggestion: closest(key, declared) })',
    replace: '    out.push({ key, suggestion: declared.length < 0 ? closest(key, declared) : null })',
    suite: 'packages/middleware/test/pack.test.ts',
    caughtBy: '"rateLimit({ limt: 100 }) fails at startup with a spelling suggestion — §8.6, verbatim"',
  },
  {
    name: "build a factory plugin without stating its options, so they are never checked",
    file: 'packages/middleware/src/rate-limit.ts',
    find: '    boundOptions: options,\n',
    replace: '',
    suite: 'packages/middleware/test/pack.test.ts',
    caughtBy: '"rateLimit({ limt: 100 }) fails at startup with a spelling suggestion — §8.6, verbatim"',
  },
  {
    name: "run onBoot from a list hook('onBoot') never reaches",
    file: `${CORE}/api/zen.ts`,
    find: "    for (const hook of this.#hooks.get('onBoot') ?? []) {",
    replace: "    for (const hook of (this.#hooks.get('onBoot') ?? []).filter((h) => h.name === '\\u0000')) {",
    suite: 'packages/core/test/plugins.test.ts',
    caughtBy: `"app.hook('onBoot') is called with the frozen graph"`,
  },
  {
    name: 'hand the graph a fresh map, so everything a plugin wrote with meta() is lost',
    file: `${CORE}/api/zen.ts`,
    find: '      meta: new Map(this.#rootScope.meta),',
    replace: '      meta: new Map(),',
    suite: 'packages/core/test/plugins.test.ts',
    caughtBy: '"what a plugin wrote is on graph.meta, namespaced by the plugin"',
  },
  {
    name: "ignore what plugins declared in graph.meta when writing security schemes",
    file: 'packages/openapi/src/document.ts',
    find: '    const securitySchemes = this.#securitySchemes()',
    replace: '    const securitySchemes = this.#opts.securitySchemes ?? (this.#securitySchemes(), undefined)',
    suite: 'packages/openapi/test/openapi.test.ts',
    caughtBy: `"merges a plugin's security schemes into components"`,
  },
  {
    name: 'put the compiler index on the graph where its type says a Slot is',
    file: `${CORE}/api/zen.ts`,
    find: '      slot: d.slotIndex === null ? null : (slots.find((s) => s.index === d.slotIndex) ?? null),',
    replace: '      slot: d.slotIndex === null ? null : (slots.find((s) => s.index === -1) ?? null),',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"a slot decoration carries its Slot, an accessor decoration its function"',
  },
  {
    name: 'mark a 503 thrown on purpose ZEN_INTERNAL, the code for an unclassified error',
    file: `${CORE}/errors/http-errors.ts`,
    find: "export const ServiceUnavailable = http(503, Codes.SERVICE_UNAVAILABLE, 'Service Unavailable')",
    replace: "export const ServiceUnavailable = http(503, Codes.INTERNAL, 'Service Unavailable')",
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"a 503 thrown on purpose is ZEN_SERVICE_UNAVAILABLE, not the unclassified ZEN_INTERNAL"',
  },
  {
    name: 'report an invalid Host header as an invalid body',
    file: `${CORE}/errors/http-errors.ts`,
    find: "export const BadRequest = http(400, Codes.BAD_REQUEST, 'Bad Request')",
    replace: "export const BadRequest = http(400, Codes.BODY_INVALID, 'Bad Request')",
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"invalid JSON keeps ZEN_BODY_INVALID; a bad Host is ZEN_BAD_REQUEST"',
  },
  {
    name: "read capabilities from options alone, so the adapter's are ignored",
    file: `${CORE}/api/zen.ts`,
    find: '    this.#caps = opts.caps ?? opts.adapter?.caps ?? DEFAULT_CAPABILITIES',
    replace: '    this.#caps = opts.caps ?? DEFAULT_CAPABILITIES',
    suite: 'packages/core/test/plugins.test.ts',
    caughtBy: '"a plugin requiring fs fails at boot on an adapter that declares fs: false"',
  },
  {
    name: 'compare a string requirement as truthiness, so websocket: "native" passes on "library"',
    file: `${CORE}/registry/plugin-registry.ts`,
    find: "      if ((required === true || typeof required === 'string') && actual !== required) {",
    replace: "      if (required === true && actual !== required) {",
    suite: 'packages/core/test/plugins.test.ts',
    caughtBy: '"a string requirement asks for that exact capability"',
  },
  {
    name: 'let the Node adapter claim compression it does not implement',
    file: ADAPTER,
    find: "  compression: 'none',",
    replace: "  compression: 'library',",
    suite: 'packages/adapter-node/test/adapter.test.ts',
    caughtBy: '"claims no compression and no WebSocket, because it implements neither"',
  },
  {
    name: "call every AbortError the request's own, so an upstream's is blamed on the client",
    file: `${CORE}/runtime/error-engine.ts`,
    find: '  if (signal !== undefined && signal.aborted && (error === signal.reason || error.cause === signal.reason)) {',
    replace: '  if (signal !== undefined || error.name.length > 0) {',
    suite: 'packages/core/test/app.test.ts',
    caughtBy: '"an upstream that timed out (AbortSignal.timeout) is a retryable 503"',
  },
  {
    name: 'keep a reply builder writable after egress, so a late header is accepted and dropped',
    file: `${CORE}/api/zen.ts`,
    find: '    ctx.$stage = SEALED_STAGE\n',
    replace: '',
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"a handler that never touched ctx.res is sealed too"',
  },
  {
    name: 'seal ctx.res but let a builder kept from before egress keep writing',
    file: `${CORE}/runtime/context.ts`,
    find: "    if (this.#ctx.$stage === SEALED_STAGE) throw replySent('header')\n",
    replace: '',
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"a ctx.res kept from the handler refuses every write after egress"',
  },
  {
    name: 'hard-code the injected peer, so ctx.ip cannot be tested against a real address',
    file: `${CORE}/api/zen.ts`,
    find: '      remote: init.remote ?? LOOPBACK,',
    replace: '      remote: LOOPBACK ?? init.remote,',
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"the given peer is ctx.ip, and the last hop when a proxy is trusted"',
  },
  {
    name: 'start ctx.ips at the leftmost entry whatever trustProxy says',
    file: `${CORE}/runtime/context.ts`,
    find: '      const from = trust === true ? 0 : entries.length - trust < 0 ? 0 : entries.length - trust',
    replace: '      const from = trust === true ? 0 : entries.length - trust < 0 ? 0 : 0',
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"one trusted hop: the address the load balancer saw, then the balancer itself"',
  },
  {
    name: "drop the params schema's required-key check, so every request is a 400 again",
    file: `${CORE}/compile/params-check.ts`,
    find: '  for (const key of shape.required ?? []) {',
    replace: '  for (const key of (shape.required ?? []).slice(0, 0)) {',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"refuses a required key the path does not supply, and names the one it has"',
  },
  {
    name: 'treat a closed params schema as open, so it refuses every request instead of booting',
    file: `${CORE}/compile/params-check.ts`,
    find: '    if (closed) {',
    replace: '    if (closed && name.length < 0) {',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"refuses a path parameter a closed schema would reject"',
  },
  {
    name: "evaluate a collection's when, and register its routes anyway",
    file: `${CORE}/api/zen.ts`,
    find: '      if (absent.size > 0 && inScope(pending.scope, absent)) continue',
    replace: '      if (absent.size < 0 && inScope(pending.scope, absent)) continue',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"a false subtree is absent from the router, the graph and its hooks"',
  },
  {
    name: 'accept use: on a route and never put it in the chain',
    file: `${CORE}/api/zen.ts`,
    find: '      middleware: (schema.use ?? []).map((fn) => ({',
    replace: '      middleware: (schema.use ?? []).slice(0, 0).map((fn) => ({',
    suite: 'packages/core/test/registration.test.ts',
    caughtBy: '"runs after the app\'s and the collection\'s, in the order listed, and is labelled [route]"',
  },
  {
    name: "ignore Symbol.asyncDispose on a singleton with no dispose of its own",
    file: `${CORE}/di/container.ts`,
    find: '      if (!entry.resolved) {\n        const dispose = entry.dispose ?? intrinsicDisposer(value)',
    replace: '      if (!entry.resolved) {\n        const dispose = entry.dispose ?? (value === intrinsicDisposer ? intrinsicDisposer(value) : undefined)',
    suite: 'packages/core/test/di.test.ts',
    caughtBy: '"a singleton with Symbol.asyncDispose and no dispose is released at shutdown"',
  },
  {
    name: 'release a slot value through its protocol in the interpreted context only',
    file: `${CORE}/compile/context-compiler.ts`,
    find: "    else if (typeof value === 'object' && value !== null) trackIntrinsic(this, slot.name, value)",
    replace: "    else if (typeof value === 'object' && value === null) trackIntrinsic(this, slot.name, value)",
    suite: 'packages/core/test/context.test.ts',
    caughtBy: '"Symbol.dispose alone works, and every value a slot held is released, in reverse order"',
  },
  {
    name: 'drop warnings with errors, so a negotiated route with a password field answers JSON only',
    file: `${CORE}/compile/negotiation.ts`,
    find: "  if (diagnostics.some((d) => d.severity === 'error')) return { record: null, representations: null, diagnostics }",
    replace: "  if (diagnostics.length > 0) return { record: null, representations: null, diagnostics }",
    suite: 'packages/core/test/negotiation.test.ts',
    caughtBy: `"format: 'password' is a warning, and the route still boots and negotiates"`,
  },
  {
    name: 'call every iteration delimited, so (a+)+ passes the regex lint',
    file: `${CORE}/primitives/regex-safety.ts`,
    find: '      if (!delimited(node.body, repeated)) {',
    replace: '      if (!delimited(node.body, repeated) && inner.length < 0) {',
    suite: 'packages/core/test/regex-safety.test.ts',
    caughtBy: '"refuses /(a+)+/"',
  },
  {
    name: "never run paramType's development check",
    file: `${CORE}/api/zen.ts`,
    find: '    if (this.#opts.dev === true) this.#warnUnsafeTest(name, type.test)',
    replace: '    if (this.#opts.dev === true && name.length < 0) this.#warnUnsafeTest(name, type.test)',
    suite: 'packages/core/test/regex-safety.test.ts',
    caughtBy: '"in development, names the param type and the repetition"',
  },
  {
    name: 'ship a backtracking regex in framework source',
    file: 'packages/middleware/src/request-id.ts',
    find: 'const ACCEPTABLE = /^[A-Za-z0-9._-]{8,128}$/',
    replace: 'const ACCEPTABLE = /^(?:[A-Za-z0-9._-]+)+$/',
    suite: 'scripts/check-regex.ts',
    caughtBy: 'scripts/check-regex.ts refusing a variable repetition inside an unbounded one',
  },
  {
    name: 'import upward, from the registry into the runtime',
    file: `${CORE}/registry/plugin-registry.ts`,
    find: "import { Codes } from '../errors/codes.ts'\n",
    replace: "import { Codes } from '../errors/codes.ts'\nexport type { PlainContext as UpwardEdge } from '../runtime/context.ts'\n",
    suite: 'scripts/check-strata.ts',
    caughtBy: 'scripts/check-strata.ts refusing an edge that points up the ladder',
  },
  {
    name: 'emit different code with every suite still passing',
    file: `${CORE}/compile/pipeline-compiler.ts`,
    find: "    lines.push('  let reply = d.finalize(out, false)')",
    replace: "    lines.push('  let reply = d.finalize(out, false) ')",
    suite: 'packages/core/test/generated-source.test.ts',
    caughtBy: '"every unit the compilers emit for the fixture app matches the committed snapshot"',
  },
  {
    name: "disarm a deadline without clearing its timer, so a probe's budget outlives the app",
    file: `${CORE}/runtime/deadline.ts`,
    find: '      clearTimeout(this.#timer)\n',
    replace: '',
    suite: 'packages/core/test/leaks.test.ts',
    caughtBy: '"listen, SSE, a deadline kept and one blown, a file, a health probe, close() — and nothing is left open"',
  },
  {
    name: "arm an injected request's deadline like a socket's, so an idle script exits before it answers",
    file: `${CORE}/api/zen.ts`,
    find: '    return new Deadline(budget, conn.signal, conn.inProcess === true)',
    replace: '    return new Deadline(budget, conn.signal, conn.inProcess === false)',
    suite: 'packages/core/test/timeouts.test.ts',
    caughtBy: `"a route's deadline answers an inject() in an otherwise idle script"`,
  },
  {
    name: 'regress a documented claim — the ledger, not only its unit suite, must notice',
    file: `${CORE}/errors/http-errors.ts`,
    find: "export const ServiceUnavailable = http(503, Codes.SERVICE_UNAVAILABLE, 'Service Unavailable')",
    replace: "export const ServiceUnavailable = http(503, Codes.INTERNAL, 'Service Unavailable')",
    suite: 'scripts/claims.ts',
    caughtBy: 'the claims ledger\'s "503-code" probe',
  },
  {
    name: 'promote a sentence to "Working today" with nothing to check it',
    file: 'README.md',
    find: ' <!-- claim: twins -->',
    replace: '',
    suite: 'scripts/claims.ts',
    caughtBy: 'the claims ledger refusing a "Working today" bullet with no marker',
  },
]

// ─────────────────────────────────────────────────────────────────────────────

const filter = process.argv[2]
const selected = filter === undefined
  ? CONTROLS
  : CONTROLS.filter((c) => c.name.includes(filter) || c.file.includes(filter))

if (selected.length === 0) {
  console.error(`No control matches "${filter}".`)
  process.exit(1)
}

type Outcome = 'CAUGHT' | 'NOT CAUGHT' | 'STALE' | 'BUILD FAILED'

/**
 * `process.execPath` and a resolved script path, never a shell.
 *
 * `spawnSync('npx', args, { shell: true })` is the obvious way to write this on
 * Windows and it is the wrong one: with `shell: true` the arguments are
 * concatenated rather than escaped, which Node now warns about (DEP0190), and
 * this script's arguments include file paths from a table anyone can edit.
 */
const run = (args: readonly string[]): number =>
  spawnSync(process.execPath, args as string[], { stdio: 'pipe' }).status ?? 1

const TSC = 'node_modules/typescript/bin/tsc'
const build = (): boolean => run([TSC, '-b']) === 0

console.log('\n  Negative controls — CONTRIBUTING.md convention 3')
console.log(`  ${selected.length} control${selected.length === 1 ? '' : 's'}, each must make its suite fail\n`)

if (!build()) {
  console.error('  The tree does not compile before any control was applied. Fix that first.')
  process.exit(1)
}

const results: Array<{ control: Control; outcome: Outcome }> = []

for (const control of selected) {
  const original = readFileSync(control.file, 'utf8')
  let outcome: Outcome

  try {
    const occurrences = original.split(control.find).length - 1
    if (occurrences !== 1) {
      // Not a pass and not a failure: the control no longer describes the code,
      // which means it has been proving nothing since whenever that changed.
      outcome = 'STALE'
      results.push({ control, outcome })
      report(control, outcome, `expected 1 occurrence of the patch site, found ${occurrences}`)
      continue
    }

    writeFileSync(control.file, original.replace(control.find, control.replace), 'utf8')

    if (!build()) {
      outcome = 'BUILD FAILED'
    } else {
      // A per-test ceiling, because some defects hang rather than fail — a
      // shutdown that waits on a connection nobody closes — and a control
      // that never returns would stall CI instead of reporting.
      const status = control.suite.endsWith('.test.ts')
        ? run(['--test', '--test-timeout=30000', control.suite])
        : run([control.suite])
      outcome = status === 0 ? 'NOT CAUGHT' : 'CAUGHT'
    }
  } finally {
    writeFileSync(control.file, original, 'utf8')
  }

  results.push({ control, outcome: outcome! })
  report(control, outcome!)
}

// Leave the tree exactly as it was found, compiled.
if (!build()) {
  console.error('\n  The tree does not compile after restoring. This is a bug in this script.')
  process.exit(1)
}

const missed = results.filter((r) => r.outcome !== 'CAUGHT')
console.log(`\n  ${results.length - missed.length}/${results.length} controls caught\n`)

if (missed.length > 0) {
  for (const { control, outcome } of missed) {
    console.log(`  ${outcome}: ${control.name}`)
    console.log(`    ${control.caughtBy} did not fail — that assertion is not load-bearing.`)
  }
  console.log('')
  process.exitCode = 1
}

function report(control: Control, outcome: Outcome, detail?: string): void {
  const mark = outcome === 'CAUGHT' ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} ${outcome.padEnd(12)} ${control.name}`)
  if (detail !== undefined) console.log(`       ${detail}`)
}
