/**
 * A catalogue, in memory.
 *
 * Every parameter this service takes is *already the right type*, and that is
 * the assertion the example is making. Nothing below calls `Number()`,
 * `parseInt`, `=== 'true'`, or `Array.isArray`; there is no defensive
 * normalisation at the top of a function, which is the layer that quietly
 * accumulates in every service whose inputs arrive as strings.
 *
 * If §11.4 stopped working, this file would stop *type-checking* rather than
 * start misbehaving — `filter.page - 1` on a string is a compile error and
 * `products.slice('0', '20')` is not. That is the property worth having: the
 * types were always right, and the runtime is what caught up.
 */

export interface Product {
  readonly sku: string
  readonly name: string
  readonly price: number
  readonly rating: number
  readonly inStock: boolean
  readonly tags: readonly string[]
}

export interface CatalogFilter {
  readonly page: number
  readonly limit: number
  readonly inStock?: boolean | undefined
  readonly tags: readonly string[]
  readonly sku?: string | undefined
  readonly sort: 'price' | 'name' | 'rating'
}

/**
 * Note `00713` and `00042`.
 *
 * A catalogue whose SKUs are zero-padded numerals is not a contrived fixture —
 * it is what every ERP export looks like — and it is the case a value-guessing
 * coercer gets wrong in a way nobody notices until a customer receives the
 * wrong item.
 */
const PRODUCTS: readonly Product[] = [
  { sku: '00713', name: 'Aeron chair', price: 1395, rating: 4.8, inStock: true, tags: ['furniture', 'sale'] },
  { sku: '00042', name: 'Standing desk', price: 899, rating: 4.5, inStock: true, tags: ['furniture', 'new'] },
  { sku: 'KB-101', name: 'Split keyboard', price: 349, rating: 4.7, inStock: false, tags: ['peripherals', 'sale'] },
  { sku: 'MN-320', name: '32" 4K monitor', price: 649, rating: 4.4, inStock: true, tags: ['peripherals'] },
  { sku: 'LT-900', name: 'Laptop stand', price: 79, rating: 4.1, inStock: true, tags: ['accessories', 'sale'] },
  { sku: 'CB-006', name: 'Cable set', price: 29, rating: 3.9, inStock: false, tags: ['accessories'] },
  { sku: 'HD-450', name: 'Studio headphones', price: 279, rating: 4.6, inStock: true, tags: ['audio', 'new'] },
  { sku: 'MC-220', name: 'USB microphone', price: 149, rating: 4.2, inStock: true, tags: ['audio'] },
]

export interface Page {
  readonly items: readonly Product[]
  readonly total: number
}

export function search(filter: CatalogFilter): Page {
  let items = PRODUCTS

  if (filter.sku !== undefined) items = items.filter((p) => p.sku === filter.sku)
  if (filter.inStock !== undefined) items = items.filter((p) => p.inStock === filter.inStock)
  if (filter.tags.length > 0) items = items.filter((p) => filter.tags.some((tag) => p.tags.includes(tag)))

  const sorted = [...items].sort((a, b) =>
    filter.sort === 'name' ? a.name.localeCompare(b.name) : b[filter.sort] - a[filter.sort])

  const start = (filter.page - 1) * filter.limit
  return { items: sorted.slice(start, start + filter.limit), total: sorted.length }
}

export function byIds(ids: readonly number[]): readonly Product[] {
  // The legacy endpoint's ids are *positions*, which is why they are numbers
  // and the SKUs are not. Two identifier-shaped things in one service, one of
  // which is arithmetic and one of which is not — the distinction the schema
  // makes and a heuristic cannot.
  return ids.map((id) => PRODUCTS[id]).filter((p): p is Product => p !== undefined)
}

export function find(sku: string): Product | undefined {
  return PRODUCTS.find((p) => p.sku === sku)
}
