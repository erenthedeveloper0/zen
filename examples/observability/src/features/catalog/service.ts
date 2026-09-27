import { token } from '@visionpilot/zen'
import type { Product } from './schemas.ts'

/**
 * The domain, kept deliberately thin.
 *
 * `cost` exists so the handler stage has something to measure: an example whose
 * every stage rounds to zero cannot demonstrate stage attribution. It is a busy
 * loop rather than a `setTimeout` because a timer would measure the event loop
 * and this is supposed to look like a slow query.
 */
export interface CatalogService {
  list(limit: number, tag?: string): { items: Product[]; total: number }
  find(id: number): (Product & { readonly costCents: number; readonly supplier: string }) | undefined
}

const ROWS: Array<Product & { costCents: number; supplier: string }> = [
  { id: 1, name: 'Mechanical keyboard', priceCents: 12900, tags: ['input', 'desk'], costCents: 5400, supplier: 'Shenzhen Keys Ltd' },
  { id: 2, name: 'Standing desk', priceCents: 48900, tags: ['desk'], costCents: 21000, supplier: 'Nordic Frames AB' },
  { id: 3, name: 'Monitor arm', priceCents: 8900, tags: ['desk', 'mount'], costCents: 3100, supplier: 'Nordic Frames AB' },
  { id: 4, name: 'Trackball', priceCents: 6900, tags: ['input'], costCents: 2400, supplier: 'Shenzhen Keys Ltd' },
]

export const CatalogToken = token<CatalogService>('catalog')

export function makeCatalog(workUnits = 0): CatalogService {
  return {
    list(limit, tag) {
      burn(workUnits)
      const matched = tag === undefined ? ROWS : ROWS.filter((row) => row.tags.includes(tag))
      return { items: matched.slice(0, limit), total: matched.length }
    },
    find(id) {
      burn(workUnits)
      return ROWS.find((row) => row.id === id)
    },
  }
}

function burn(units: number): void {
  let x = 0
  for (let i = 0; i < units * 1000; i++) x += i % 7
  if (x === -1) throw new Error('unreachable')
}
