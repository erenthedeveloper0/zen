/** Stratum 0 — no framework imports. */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const RANDOM_LEN = 16

let lastTime = 0
const lastRandom = new Uint8Array(RANDOM_LEN)

function fillRandom(): void {
  for (let i = 0; i < RANDOM_LEN; i++) {
    lastRandom[i] = (Math.random() * 32) | 0
  }
}

function incrementRandom(): void {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const v = lastRandom[i] as number
    if (v < 31) {
      lastRandom[i] = v + 1
      return
    }
    lastRandom[i] = 0
  }
  fillRandom() // overflow within the same millisecond; astronomically unlikely
}

/**
 * Monotonic ULID-shaped request id. Lexicographically sortable by time, which
 * is what makes it useful as a log correlation key.
 *
 * Not cryptographically random by design: this is a correlation id, and paying
 * for `crypto.randomUUID()` (~1µs and a syscall on some platforms) on every
 * request to produce something we then print in logs is not a trade worth
 * making. Anything security-bearing must use a CSPRNG explicitly.
 */
export function generateRequestId(now: number = Date.now()): string {
  if (now === lastTime) {
    incrementRandom()
  } else {
    lastTime = now
    fillRandom()
  }

  let time = ''
  let t = now
  for (let i = 9; i >= 0; i--) {
    time = (ENCODING[t % 32] as string) + time
    t = Math.floor(t / 32)
  }

  let rand = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    rand += ENCODING[lastRandom[i] as number] as string
  }

  return time + rand
}
