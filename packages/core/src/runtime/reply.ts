import type {
  BodyPayload, FileReplyInit, RedirectInit, RedirectStatus, Reply, ReplyInit, SetCookie, StreamSource,
} from '../contracts/reply.ts'
import type { SafeHtml } from '../contracts/html.ts'
import { SmallHeaderBag } from './headers.ts'
import { safeHtmlMarkup } from './html.ts'
import { SAME_ORIGIN_ONLY, redirectRefusal, redirectRefused, type RedirectPolicy } from './redirect.ts'

export class MutableReply<T = unknown> implements Reply<T> {
  status: number
  readonly headers: SmallHeaderBag
  cookies: SetCookie[] = []
  body: BodyPayload

  constructor(status: number, body: BodyPayload, init?: ReplyInit) {
    this.status = init?.status ?? status
    this.body = body
    this.headers = init?.headers ? SmallHeaderBag.from(init.headers) : new SmallHeaderBag()
  }
}

export function jsonReply<T>(value: T, init?: ReplyInit): Reply<T> {
  return new MutableReply<T>(200, { kind: 'json', value }, init)
}

export function textReply(value: string, init?: ReplyInit): Reply<string> {
  return new MutableReply<string>(200, { kind: 'text', value, media: init?.media ?? 'text/plain; charset=utf-8' }, init)
}

/**
 * §19.5 — `SafeHtml` only. A string here was the one response builder that
 * would write a user's `<script>` into a page with no second thought; the
 * check is a private-field brand, so no JSON body can pass it.
 */
export function htmlReply(body: SafeHtml, init?: ReplyInit): Reply<string> {
  return new MutableReply<string>(200, { kind: 'text', value: safeHtmlMarkup(body), media: 'text/html; charset=utf-8' }, init)
}

export function bytesReply(value: Uint8Array, init?: ReplyInit): Reply<Uint8Array> {
  return new MutableReply<Uint8Array>(200, { kind: 'bytes', value, media: init?.media ?? 'application/octet-stream' }, init)
}

export function streamReply(value: StreamSource, init?: ReplyInit): Reply<null> {
  return new MutableReply<null>(200, { kind: 'stream', value, media: init?.media ?? 'application/octet-stream' }, init)
}

export function fileReply(path: string, init?: FileReplyInit): Reply<null> {
  return new MutableReply<null>(200, { kind: 'file', path, media: init?.media, root: init?.root }, init)
}

export function emptyReply(status: 204 | 205 | 304 = 204): Reply<null> {
  return new MutableReply<null>(status, EMPTY_BODY)
}

/**
 * A redirect, checked against the application's policy — §19.5.
 *
 * `policy` defaults to the strictest one, so a caller that builds replies
 * without a context gets a redirect that cannot leave the origin rather than
 * one that can. `init.allowExternal` skips the check for one reply; the CR/LF
 * check on the header (§19.5, `ZEN_HEADER_INVALID`) applies either way.
 */
export function redirectReply(
  to: string,
  init?: RedirectStatus | RedirectInit,
  policy: RedirectPolicy = SAME_ORIGIN_ONLY,
): Reply<null> {
  if (typeof to !== 'string') {
    const given: unknown = to
    throw new TypeError(`ctx.redirect() takes the target as a string, and was given ${given === null ? 'null' : typeof given}.`)
  }
  let status: RedirectStatus = 302
  let external = false
  if (typeof init === 'number') {
    status = init
  } else if (init !== undefined) {
    if (init.status !== undefined) status = init.status
    external = init.allowExternal === true
  }
  if (!external) {
    const refusal = redirectRefusal(to, policy)
    if (refusal !== null) throw redirectRefused(refusal)
  }
  const reply = new MutableReply<null>(status, EMPTY_BODY)
  reply.headers.set('location', to)
  return reply
}

const EMPTY_BODY: BodyPayload = Object.freeze({ kind: 'empty' as const })

export function isReply(value: unknown): value is Reply {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'body' in value &&
    'headers' in value
  )
}

/** Mutable in-place until egress; `MutableReply` is the only writer. */
export function asMutable(reply: Reply): MutableReply {
  return reply as MutableReply
}
