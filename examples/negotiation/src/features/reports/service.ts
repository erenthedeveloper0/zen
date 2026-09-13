/**
 * The domain, such as it is.
 *
 * Every record carries `internalMargin`, and it reaches neither the JSON nor
 * the CSV. Not because anything here removes it — because neither
 * representation's schema declares it, so the compiled serializer has no branch
 * that could emit it (§13.3) and the CSV encoder's column list never contained
 * it (§13.4). One declaration, two wire formats, one guarantee.
 */
export interface Sale {
  readonly id: number
  readonly region: string
  readonly ownerId: number
  readonly ownerName: string
  readonly amount: number
  readonly currency: string
  readonly closedAt: string
  /** Never on the wire, in any representation. */
  readonly internalMargin: number
}

const SEED: readonly Sale[] = [
  { id: 1, region: 'emea', ownerId: 11, ownerName: 'Ada Lovelace', amount: 12_400, currency: 'EUR', closedAt: '2026-07-02', internalMargin: 0.41 },
  { id: 2, region: 'emea', ownerId: 12, ownerName: 'Alan Turing', amount: 8_900, currency: 'GBP', closedAt: '2026-07-04', internalMargin: 0.33 },
  { id: 3, region: 'amer', ownerId: 13, ownerName: 'Grace Hopper', amount: 31_000, currency: 'USD', closedAt: '2026-07-11', internalMargin: 0.52 },
  { id: 4, region: 'apac', ownerId: 14, ownerName: 'Radia Perlman', amount: 5_150, currency: 'AUD', closedAt: '2026-07-19', internalMargin: 0.28 },
  // A title-shaped field that a spreadsheet would execute if it were written
  // into a cell unguarded — see `escapeCell` in `src/media/csv.ts`. Kept in the
  // seed data so the guard is exercised by the example and not only by a test.
  { id: 5, region: 'emea', ownerId: 15, ownerName: '=1+1', amount: 700, currency: 'EUR', closedAt: '2026-07-22', internalMargin: 0.19 },
]

export class SalesService {
  #sales: Sale[] = [...SEED]

  list(region: string | undefined, limit: number): readonly Sale[] {
    const matching = region === undefined ? this.#sales : this.#sales.filter((s) => s.region === region)
    return matching.slice(0, limit)
  }

  find(id: number): Sale | undefined {
    return this.#sales.find((s) => s.id === id)
  }

  get regions(): readonly string[] {
    return [...new Set(this.#sales.map((s) => s.region))]
  }
}
