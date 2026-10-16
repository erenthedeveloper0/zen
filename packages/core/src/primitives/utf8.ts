/** Stratum 0 — no framework imports. */

/**
 * The number of bytes `text` takes as UTF-8, without encoding it.
 *
 * Exactly what `TextEncoder` writes and what Node's `Buffer.byteLength(text,
 * 'utf8')` reports, including for malformed input: a lone surrogate is written
 * as U+FFFD, three bytes, by all three. A `Content-Length` computed here and a
 * body encoded by anything else agree, which is the only reason it exists.
 *
 * Linear in the string and about 1–2 ns a character, so it is cheaper than
 * encoding only for short strings: egress counts a short body rather than
 * encode it, and encodes a long one (§13.7).
 */
export function utf8Length(text: string): number {
  const units = text.length
  let length = units
  for (let i = 0; i < units; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) continue
    if (unit < 0x800) {
      length += 1
      continue
    }
    // A surrogate pair is one code point, four bytes, for two UTF-16 units.
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < units) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 2
        i++
        continue
      }
    }
    // Everything else in the BMP, and a lone surrogate written as U+FFFD.
    length += 2
  }
  return length
}
