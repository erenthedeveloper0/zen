import type { Diagnostic } from '../errors/zen-error.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { classifyReference } from '../primitives/url-reference.ts'

/**
 * Where a redirect may send a client — rfcs/0001 §19.5.
 *
 * The open redirect is the vulnerability that ships in almost every login
 * flow: `/login?next=https://evil.example` redirects, after a successful
 * sign-in, to a page that looks like the one the user just left and asks for
 * their password again. It is also a link an attacker can put in an email with
 * the application's own domain in it. So a redirect stays on this origin
 * unless the application said otherwise, and "otherwise" is a list of origins
 * written where a reviewer will see it:
 *
 *     zen({ redirect: { allowExternal: ['https://accounts.google.com'] } })
 *
 * That is §19.2's rule — the secure configuration is the default, and relaxing
 * it is a line of code that appears in review. The app that redirects to an
 * OAuth provider adds one line; the app that did not know it had a `?next=`
 * parameter is no longer an open redirect.
 *
 * "This origin" is decided without trusting anything the client wrote. A
 * relative reference — a path, a query, a fragment — cannot leave it, whatever
 * `Host` said; an absolute URL to the application's own host is treated as
 * external, because the only thing that could vouch for the host is that
 * header. Write redirects within the application as paths.
 */
export interface RedirectOptions {
  /**
   * Where `ctx.redirect()` may send a client besides this application:
   *
   * - `false` (the default) — nowhere. Paths, queries and fragments only.
   * - `['https://accounts.google.com', …]` — those origins too, exactly as
   *   `new URL(x).origin` writes them: scheme, lowercase host, a port only
   *   when it is not the scheme's default, and no path or trailing slash.
   * - `true` — any http or https URL. The old behaviour, as an explicit
   *   choice, for an application that constructs every target itself.
   */
  readonly allowExternal?: boolean | readonly string[] | undefined
}

/** The compiled form of {@link RedirectOptions} — what `ctx.redirect()` consults per call. */
export interface RedirectPolicy {
  /** `allowExternal: true`: any http(s) target may leave. */
  readonly anyHttp: boolean
  /** Origins a redirect may leave for, serialised as `URL#origin` writes them. */
  readonly origins: ReadonlySet<string>
}

/** The default, and what a policy-less caller of `redirectReply` gets. */
export const SAME_ORIGIN_ONLY: RedirectPolicy = Object.freeze({
  anyHttp: false,
  origins: new Set<string>() as ReadonlySet<string>,
})

/**
 * Compile `redirect` options at construction — every malformed origin is a
 * `ZEN_CONFIG_INVALID` diagnostic, reported by `ready()` with the rest (§12.7).
 *
 * Strict about the spelling for the reason §32.4 is strict about a CORS
 * allowlist: an entry that can never match looks configured, and the failure
 * it produces — every login redirect refused — is investigated in the wrong
 * place. `https://accounts.google.com/` has a trailing slash and matches no
 * origin, so it is refused with the spelling that would.
 */
export function compileRedirectPolicy(options: RedirectOptions | undefined): {
  readonly policy: RedirectPolicy
  readonly diagnostics: readonly Diagnostic[]
} {
  const allow = options?.allowExternal
  if (allow === undefined || allow === false) return { policy: SAME_ORIGIN_ONLY, diagnostics: [] }
  if (allow === true) return { policy: Object.freeze({ anyHttp: true, origins: new Set<string>() }), diagnostics: [] }

  const diagnostics: Diagnostic[] = []
  if (!Array.isArray(allow)) {
    diagnostics.push(invalid(
      `redirect.allowExternal must be true, false, or a list of origins, and is ${typeof allow}.`,
      "List the origins a redirect may leave for: redirect: { allowExternal: ['https://accounts.example'] }.",
    ))
    return { policy: SAME_ORIGIN_ONLY, diagnostics }
  }

  const origins = new Set<string>()
  for (const entry of allow as readonly unknown[]) {
    if (typeof entry !== 'string') {
      diagnostics.push(invalid(
        `redirect.allowExternal lists ${typeof entry === 'object' ? 'an object' : `a ${typeof entry}`}; every entry must be an origin string.`,
        "Write each as 'https://host', or 'https://host:port' for a port that is not the default.",
      ))
      continue
    }
    let parsed: URL | null = null
    try {
      parsed = new URL(entry)
    } catch {
      parsed = null
    }
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      diagnostics.push(invalid(
        `redirect.allowExternal lists "${entry}", which is not an http or https origin.`,
        "Write it with its scheme: 'https://accounts.example'.",
      ))
      continue
    }
    if (parsed.origin !== entry) {
      diagnostics.push(invalid(
        `redirect.allowExternal lists "${entry}", which is not an origin as a browser writes one.`,
        `Use "${parsed.origin}". An origin carries a scheme, a lowercase host and a non-default port — no path, no ` +
          'trailing slash, no credentials — and an entry in any other spelling would never match.',
      ))
      continue
    }
    origins.add(entry)
  }
  return { policy: Object.freeze({ anyHttp: false, origins }), diagnostics }
}

/**
 * Why `ctx.redirect(target)` must be refused under `policy`, or `null` when it
 * may be sent.
 *
 * A relative reference is decided by its first characters, without a `URL`
 * object — the path that nearly every redirect takes (§9.4's instinct: the
 * common case pays for nothing it does not use). Only a target that has a
 * scheme or an authority is parsed, to name its origin.
 */
export function redirectRefusal(target: string, policy: RedirectPolicy): string | null {
  const { kind, scheme } = classifyReference(target)
  if (kind === 'local') return null

  if (kind === 'scheme' && scheme !== 'http' && scheme !== 'https') {
    return `a ${scheme}: URL cannot be a redirect target that leaves this origin`
  }

  // `//host/…` takes the page's scheme, so it is two possible origins, and
  // both must be allowed; `http:host` is relative on an http page and the
  // origin `http://host` on an https one, which one parse without a base names.
  const origins: string[] = []
  try {
    if (kind === 'network') {
      origins.push(new URL(target, 'http://zen.invalid/').origin, new URL(target, 'https://zen.invalid/').origin)
    } else {
      origins.push(new URL(target).origin)
    }
  } catch {
    return 'it is not a valid URL'
  }

  if (policy.anyHttp) return null
  for (const origin of origins) {
    if (!policy.origins.has(origin)) {
      return `${origin} is not in redirect.allowExternal`
    }
  }
  return null
}

/** `ZEN_REDIRECT_EXTERNAL` — a 500, because the application tried; never exposed, because the target may be the attacker's. */
export function redirectRefused(reason: string): ZenError {
  return new ZenError(
    Codes.REDIRECT_EXTERNAL,
    `Refused to redirect: ${reason}. A redirect stays on this application's origin unless the target's origin is ` +
      'listed in redirect.allowExternal — the check that makes ?next=https://evil.example harmless.',
    {
      status: 500,
      expose: false,
      hint:
        'Validate a target that came from the request and fall back — ctx.redirect(isLocalUrl(next) ? next : \'/\') — ' +
        "or list the origin the application means to send clients to: zen({ redirect: { allowExternal: ['https://…'] } }).",
    },
  )
}

function invalid(message: string, hint: string): Diagnostic {
  return { severity: 'error', code: Codes.CONFIG_INVALID, message, hint }
}
