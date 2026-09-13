/**
 * Stratum 1 — contracts. Types only; this module compiles to zero runtime bytes
 * apart from the interned method table, which is deliberate (see primitives/intern).
 */

export type HttpMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'TRACE'

/** Header names are always lowercase inside Zen. The brand keeps that honest. */
export type LowercaseName = string & { readonly __lowercase?: unique symbol }

export type StatusCode = number

export interface RemoteInfo {
  readonly address: string | undefined
  readonly port: number | undefined
  readonly family: 'IPv4' | 'IPv6' | undefined
}

export type HeaderValue = string | readonly string[]

export type HeaderInit =
  | Readonly<Record<string, HeaderValue>>
  | ReadonlyArray<readonly [string, HeaderValue]>
