import { Codes, ZenError } from '@zenjs/core'
import type { CorsExports } from './cors.ts'

/**
 * Cross-plugin consistency — the check §2.4 makes possible.
 *
 * `Cross-Origin-Resource-Policy: same-origin` tells the browser to refuse
 * cross-origin reads of this response. `cors({ origin: [...] })` tells it to
 * permit them. Together they are a configuration that says two opposite things,
 * the CORP one wins, and the symptom is a CORS setup that "does not work" for
 * reasons that appear nowhere in the CORS configuration.
 *
 * In a framework where middleware is a list of opaque functions there is
 * nothing to check. Here both are plugins on one graph and `exportsOf` lets
 * each read the other's decision, so it is a boot error naming both settings.
 *
 * ### Why this is its own module rather than a function in `security.ts`
 *
 * Because only the plugin that runs **second** can see both, and which one that
 * is now depends on hook ordering rather than on this check. `securityHeaders`
 * has to register its hook *first* — its headers must be staged before anything
 * can short-circuit, or a preflight and a 429 go out without `nosniff` — so it
 * can no longer be the one that reads `cors`'s exports.
 *
 * Rather than move the check to `cors.ts` and leave it there until the next
 * ordering change moves it back, both plugins call this with whatever they can
 * see. The one that ran first passes `undefined` for the other half and returns;
 * the one that ran second has both and decides. Order-independent by
 * construction, which is the property that was actually wanted.
 */
export function assertCorsCorpConsistent(
  corp: string | false,
  cors: CorsExports | undefined,
  reporter: string,
): void {
  if (cors === undefined || corp !== 'same-origin') return

  const allowing = cors.origins === 'any' || cors.origins === 'dynamic' || cors.origins.length > 0
  if (!allowing) return

  const described =
    cors.origins === 'any' ? "'*'"
    : cors.origins === 'dynamic' ? 'origins chosen by a predicate'
    : cors.origins.join(', ')

  throw new ZenError(
    Codes.CONFIG_INVALID,
    `security-headers sets Cross-Origin-Resource-Policy: same-origin while cors allows ${described}. ` +
      'The two instruct the browser to do opposite things, and the CORP header wins.',
    {
      status: 500,
      expose: false,
      hint:
        "Use crossOriginResource: 'same-site' (the default) or 'cross-origin' if these responses are " +
        'meant to be read cross-origin, or narrow the CORS allowlist if they are not.',
      consequence:
        'Left as configured, every allowed origin still fails in the browser — and it fails with a ' +
        'message naming CORS, so the search starts in the file that is correct. ' +
        `Reported by ${reporter}, whichever of the two was registered second.`,
    },
  )
}
