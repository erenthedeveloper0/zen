import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Codes, docsUrl, NotFound } from '@visionpilot/zen-core'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const catalogue = readFileSync(join(root, 'docs', 'errors.md'), 'utf8')
const documented = new Set([...catalogue.matchAll(/^## (ZEN_[A-Z_]+)$/gm)].map((m) => m[1] as string))

/** Every `'ZEN_…'` literal in the published packages' sources. */
function producedCodes(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/'(ZEN_[A-Z_]+)'/g)) found.add(match[1] as string)
      }
    }
  }
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'src')
    try { walk(src) } catch { /* a package without sources */ }
  }
  return found
}

describe('docs/errors.md is the documentation every error links to (I7)', () => {
  it('has an entry for every code in Codes', () => {
    const missing = Object.values(Codes).filter((code) => !documented.has(code))
    assert.deepEqual(missing, [], `add a "## CODE" section to docs/errors.md for: ${missing.join(', ')}`)
  })

  it('has an entry for every code any package can produce', () => {
    const missing = [...producedCodes()].filter((code) => !documented.has(code))
    assert.deepEqual(missing, [], `add a "## CODE" section to docs/errors.md for: ${missing.join(', ')}`)
  })

  it('links a problem document and a diagnostic to that entry', () => {
    const problem = new NotFound('x').toProblem('/x', 'req')
    assert.equal(problem['type'], docsUrl('ZEN_NOT_FOUND'))
    assert.equal(docsUrl('ZEN_NOT_FOUND'), 'https://github.com/VisionPilot/Zen.js/blob/main/docs/errors.md#zen_not_found')
  })
})
