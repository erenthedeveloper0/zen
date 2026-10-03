/** Stratum 0 — no framework imports. */

/**
 * The candidate within two edits of `input`, compared case-insensitively — or
 * `null` when nothing is that close.
 *
 * What every "Did you mean" in the framework is made of: a misspelled hook
 * phase (`onReqest`) and a misspelled route name (`notes.gett`) are the same
 * mistake, and one definition of "close" is what keeps two diagnostics from
 * disagreeing about whether `noted.get` was a typo. Two edits, because a third
 * starts matching names that were never related — `users.show` is three edits
 * from `user.slow`.
 */
export function closest(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null
  let bestDistance = 3
  const lower = input.toLowerCase()
  for (const candidate of candidates) {
    const d = editDistance(lower, candidate.toLowerCase())
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

/** Levenshtein distance, one row at a time. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        previous + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] as number
}
