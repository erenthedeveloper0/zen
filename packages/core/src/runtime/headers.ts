import type { HeaderBag } from '../contracts/reply.ts'
import type { HeaderValue, LowercaseName } from '../contracts/http.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'

/**
 * Small-array backed header bag — rfcs/0001 §13.6.
 *
 * Real responses carry 6-12 headers. At that size a linear scan over two
 * parallel arrays beats a Map on both time and allocation: no hashing, no
 * iterator objects, no entry allocation, and insertion order is free.
 */
export class SmallHeaderBag implements HeaderBag {
  #names: string[] = []
  #values: (string | string[])[] = []

  static from(init?: Readonly<Record<string, HeaderValue>>): SmallHeaderBag {
    const bag = new SmallHeaderBag()
    if (init) {
      for (const key in init) {
        const v = init[key]
        if (v !== undefined) bag.set(key, v)
      }
    }
    return bag
  }

  #indexOf(name: LowercaseName): number {
    const names = this.#names
    for (let i = 0; i < names.length; i++) {
      if (names[i] === name) return i
    }
    return -1
  }

  get(name: LowercaseName): string | undefined {
    const i = this.#indexOf(name)
    if (i === -1) return undefined
    const v = this.#values[i]
    return Array.isArray(v) ? v[0] : v
  }

  getAll(name: LowercaseName): readonly string[] {
    const i = this.#indexOf(name)
    if (i === -1) return EMPTY
    const v = this.#values[i]
    return Array.isArray(v) ? v : [v as string]
  }

  set(name: string, value: HeaderValue): void {
    const lower = name.toLowerCase()
    const normalised = Array.isArray(value) ? value.slice() : (value as string)
    assertHeaderValue(lower, normalised)
    const i = this.#indexOf(lower)
    if (i === -1) {
      this.#names.push(lower)
      this.#values.push(normalised)
    } else {
      this.#values[i] = normalised
    }
  }

  append(name: string, value: string): void {
    const lower = name.toLowerCase()
    assertHeaderValue(lower, value)
    const i = this.#indexOf(lower)
    if (i === -1) {
      this.#names.push(lower)
      this.#values.push(value)
      return
    }
    const existing = this.#values[i]
    if (Array.isArray(existing)) existing.push(value)
    else this.#values[i] = [existing as string, value]
  }

  has(name: LowercaseName): boolean {
    return this.#indexOf(name) !== -1
  }

  delete(name: LowercaseName): void {
    const i = this.#indexOf(name)
    if (i === -1) return
    this.#names.splice(i, 1)
    this.#values.splice(i, 1)
  }

  /** Flattened: multi-value headers expand to one entry per value. */
  entries(): Array<[string, string]> {
    const out: Array<[string, string]> = []
    for (let i = 0; i < this.#names.length; i++) {
      const name = this.#names[i] as string
      const value = this.#values[i] as string | string[]
      if (Array.isArray(value)) {
        for (let j = 0; j < value.length; j++) out.push([name, value[j] as string])
      } else {
        out.push([name, value])
      }
    }
    return out
  }

  get size(): number {
    return this.#names.length
  }
}

const EMPTY: readonly string[] = Object.freeze([])

/**
 * §19.5 — header values are *validated* for CR/LF at set time and throw. They
 * are never silently sanitised: quietly dropping an injected newline hides the
 * bug that produced it.
 */
function assertHeaderValue(name: string, value: string | string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) assertHeaderValue(name, v)
    return
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 13 || c === 10 || c === 0) {
      throw new ZenError(
        Codes.HEADER_INVALID,
        `Header "${name}" contains an illegal character (CR, LF or NUL) at index ${i}`,
        { status: 500, expose: false },
      )
    }
  }
}
