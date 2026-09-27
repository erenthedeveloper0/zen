import type { BodyPayload, FileReplyInit, Reply, ReplyInit, SetCookie, StreamSource } from '../contracts/reply.ts'
import { SmallHeaderBag } from './headers.ts'

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

export function htmlReply(value: string, init?: ReplyInit): Reply<string> {
  return new MutableReply<string>(200, { kind: 'text', value, media: 'text/html; charset=utf-8' }, init)
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

export function redirectReply(to: string, status: 301 | 302 | 303 | 307 | 308 = 302): Reply<null> {
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
