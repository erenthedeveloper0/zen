import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  REDACTED, LAYER_RANK, explainConfig, resolveConfig,
  type ConfigLayer, type ConfigOverlay, type EnvSource,
} from '@zenjs/core'

/**
 * Property tests for the config fold — rfcs/0001 §16, §20.5.
 *
 * **There is no differential twin here, and that is correct.** Convention says
 * every *compiled* subsystem needs an interpreted twin and a fuzzer that
 * compares them; config compiles nothing. It folds a stack of layers at boot
 * and hands back a frozen object, so there is no second implementation for a
 * fuzzer to disagree with, and inventing one would be theatre. Health is the
 * other subsystem with no twin, for the same reason.
 *
 * What replaces it is a property suite over random layer stacks, because the
 * bugs in a fold are the ones nobody writes a case for: a scalar shadowed by a
 * branch, a branch shadowed by a scalar, the same path supplied by five layers,
 * a source that wins nothing. Six invariants, and the last is the one that
 * would be silent in production:
 *
 *   1. **Totality** — the snapshot and the object describe the same set of
 *      paths. A snapshot that lists a path `app.config` does not have is a
 *      tool telling an operator about a value that is not there.
 *   2. **Precedence** — the winning layer for every path is the highest-ranked
 *      layer that supplied it, checked against the generated stack rather than
 *      against the store's own answer.
 *   3. **Nothing is invented** — every resolved path was supplied by some layer.
 *   4. **Determinism** — the same stack resolves identically twice, and
 *      shuffling the *supply* order of differently-ranked layers changes
 *      nothing.
 *   5. **The tree is frozen all the way down** (§16.4).
 *   6. **No secret appears in any projection** — not in the snapshot, not in
 *      `explainConfig`, not in `JSON.stringify` of the config object.
 *
 * The suite also asserts its own **coverage**. Two implementations that agree
 * because neither ran anything report a pass and prove nothing, and a generator
 * that never produces a scalar/branch collision proves nothing about the rule
 * that exists to resolve one.
 */

const SEEDS = 2_000

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T

/** The five layers that carry a *tree*. `dotenv`/`env`/`flag` carry strings. */
const TREE_LAYERS: readonly ConfigLayer[] = ['default', 'plugin', 'config', 'overlay', 'override']

const KEYS = ['a', 'b', 'c'] as const
const SCALARS: readonly unknown[] = ['x', 'y', 0, 1, -2.5, true, false, null, ['p', 'q'], []]

interface Generated {
  readonly overlays: readonly ConfigOverlay[]
  readonly envSources: readonly EnvSource[]
  readonly secrets: readonly string[]
  readonly secretValues: readonly string[]
  /** Every (path, layer) a layer actually supplied, in supply order. */
  readonly supplied: ReadonlyArray<{ path: string; layer: ConfigLayer }>
  readonly stats: { collisions: number; deep: number; secretLeaves: number }
}

function generate(seed: number): Generated {
  const random = rng(seed)
  const supplied: Array<{ path: string; layer: ConfigLayer }> = []
  const stats = { collisions: 0, deep: 0, secretLeaves: 0 }

  // A small alphabet of paths at three depths, so collisions between a scalar
  // at `a` and a branch at `a.b` are common rather than a once-in-a-run event.
  const paths: string[] = []
  for (const k of KEYS) {
    paths.push(k)
    for (const j of KEYS) {
      paths.push(`${k}.${j}`)
      if (random() < 0.4) paths.push(`${k}.${j}.${pick(random, KEYS)}`)
    }
  }

  const envKeys = ['TOKEN', 'URL', 'NAME']
  const secretKeys = envKeys.filter(() => random() < 0.5)
  const envValues: Record<string, string> = {}
  for (const key of envKeys) envValues[key] = `${key.toLowerCase()}-${Math.floor(random() * 1e6)}`

  const overlays: ConfigOverlay[] = []
  const layerCount = 1 + Math.floor(random() * 4)
  const seen = new Set<string>()

  for (let i = 0; i < layerCount; i++) {
    const layer = pick(random, TREE_LAYERS)
    const values: Record<string, unknown> = {}
    const count = 1 + Math.floor(random() * 5)

    for (let j = 0; j < count; j++) {
      const path = pick(random, paths)
      if (seen.has(path)) stats.collisions++
      seen.add(path)
      if (path.includes('.')) stats.deep++
      supplied.push({ path, layer })

      // Some leaves are thunks that hand back an environment value verbatim —
      // the shape that makes secrecy propagate (§16.2).
      let value: unknown
      const roll = random()
      if (roll < 0.25) {
        const key = pick(random, envKeys)
        value = (env: Record<string, unknown>) => env[key]
        if (secretKeys.includes(key)) stats.secretLeaves++
      } else {
        value = pick(random, SCALARS)
      }
      assign(values, path, value)
    }
    overlays.push({ layer, name: `src${i}`, values })
  }

  return {
    overlays,
    envSources: [{
      layer: 'env',
      name: 'process.env',
      entries: Object.entries(envValues).map(([key, value]) => ({ key, value })),
    }],
    secrets: secretKeys,
    secretValues: secretKeys.map((k) => envValues[k] as string),
    supplied,
    stats,
  }
}

function assign(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = root
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string
    const next = node[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[parts[parts.length - 1] as string] = value
}

/** Every leaf path of a resolved config object. Arrays and `null` are leaves. */
function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return prefix === '' ? [] : [prefix]
  }
  const out: string[] = []
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key]
    out.push(...leafPaths(value, prefix === '' ? key : `${prefix}.${key}`))
  }
  return out
}

function everyObject(node: unknown, visit: (o: object) => void): void {
  if (typeof node !== 'object' || node === null) return
  visit(node)
  if (Array.isArray(node)) return
  for (const key of Object.keys(node)) everyObject((node as Record<string, unknown>)[key], visit)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the fold, over random layer stacks (§16.1)', () => {
  test(`${SEEDS} seeds satisfy every invariant`, () => {
    const totals = { collisions: 0, deep: 0, secretLeaves: 0, arrays: 0, shadowedSources: 0 }

    for (let seed = 1; seed <= SEEDS; seed++) {
      const generated = generate(seed)
      const input = {
        definition: {
          env: undefined,
          shape: {},
          secrets: generated.secrets,
        } as never,
        envSources: generated.envSources,
        overlays: generated.overlays,
      }

      const result = resolveConfig(input)
      const where = `seed ${seed}`

      // 1. totality — the snapshot describes exactly the object.
      const objectPaths = leafPaths(result.config).sort()
      const snapshotPaths = result.snapshot.values.map((v) => v.path).sort()
      assert.deepEqual(snapshotPaths, objectPaths, `${where}: snapshot and object disagree about which paths exist`)

      // 2. precedence — recomputed from the generated stack, not read back from
      //    the store, so a bug in the store cannot validate itself.
      for (const value of result.snapshot.values) {
        const contributors = generated.supplied.filter((s) => s.path === value.path)
        if (contributors.length === 0) continue      // framework default
        const best = contributors.reduce((a, b) => (LAYER_RANK[b.layer] >= LAYER_RANK[a.layer] ? b : a))
        // A deeper or shallower path can legitimately have replaced this one,
        // in which case the store's answer comes from that layer instead; only
        // assert where nothing collided with it.
        const collided = generated.supplied.some(
          (s) => s.path !== value.path
            && (s.path.startsWith(`${value.path}.`) || value.path.startsWith(`${s.path}.`)),
        )
        if (!collided) {
          assert.equal(value.layer, best.layer, `${where}: ${value.path} resolved from the wrong layer`)
        }
      }

      // 3. nothing invented.
      for (const path of objectPaths) {
        const known = generated.supplied.some((s) => s.path === path || path.startsWith(`${s.path}.`) || s.path.startsWith(`${path}.`))
        const isDefault = path.startsWith('server.')
        assert.ok(known || isDefault, `${where}: ${path} was never supplied by any layer`)
      }

      // 4. determinism, and independence from supply order across layers.
      const again = resolveConfig(input)
      assert.deepEqual(JSON.parse(JSON.stringify(again.config)), JSON.parse(JSON.stringify(result.config)), `${where}: not deterministic`)

      const shuffled = resolveConfig({ ...input, overlays: [...generated.overlays].reverse() })
      const sameRank = new Set(generated.overlays.map((o) => o.layer)).size === generated.overlays.length
      if (sameRank) {
        assert.deepEqual(
          JSON.parse(JSON.stringify(shuffled.config)),
          JSON.parse(JSON.stringify(result.config)),
          `${where}: precedence depended on supply order rather than on the layer`,
        )
      }

      // 5. frozen all the way down.
      everyObject(result.config, (o) => {
        assert.ok(Object.isFrozen(o), `${where}: an object inside config was not frozen`)
      })

      // 6. no secret in any projection. This is the one that would be silent.
      const printed = [
        JSON.stringify(result.snapshot),
        explainConfig(result.snapshot),
        JSON.stringify(result.config),
      ].join('\n')
      for (const secret of generated.secretValues) {
        assert.ok(!printed.includes(secret), `${where}: a secret reached a projection`)
      }

      totals.collisions += generated.stats.collisions
      totals.deep += generated.stats.deep
      totals.secretLeaves += generated.stats.secretLeaves
      totals.arrays += result.snapshot.values.filter((v) => Array.isArray(v.value)).length
      totals.shadowedSources += result.snapshot.sources.filter((s) => s.supplied > 0 && s.won === 0).length
    }

    // Coverage. Two implementations that agree because neither ran anything
    // report a pass and prove nothing; the same is true of a generator that
    // never produced the case a rule exists for.
    assert.ok(totals.collisions > SEEDS / 2, `too few path collisions: ${totals.collisions}`)
    assert.ok(totals.deep > SEEDS, `too few nested paths: ${totals.deep}`)
    assert.ok(totals.secretLeaves > SEEDS / 4, `too few secret-carrying leaves: ${totals.secretLeaves}`)
    assert.ok(totals.arrays > 0, `no array values were generated`)
    assert.ok(totals.shadowedSources > 0, `no source was ever fully shadowed`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the fold is total (§16.1)', () => {
  test('an empty stack still resolves, and still has provenance', () => {
    const result = resolveConfig({ definition: undefined, envSources: [], overlays: [] })
    // Framework defaults are a layer, so "nothing configured" is still a
    // complete, explainable answer rather than an empty object.
    assert.equal(result.config['server'] !== undefined, true)
    assert.ok(result.snapshot.values.every((v) => v.layer === 'default'))
    assert.equal(result.diagnostics.length, 0)
  })

  test('a source that wins nothing says so', () => {
    const result = resolveConfig({
      definition: undefined,
      envSources: [],
      overlays: [
        { layer: 'plugin', name: 'loser', values: { a: 1, b: 2 } },
        { layer: 'override', name: 'winner', values: { a: 9, b: 9 } },
      ],
    })
    const loser = result.snapshot.sources.find((s) => s.name === 'loser')
    // "This file supplied twelve variables and won none of them" is worth
    // knowing before the next incident rather than during it.
    assert.equal(loser?.supplied, 2)
    assert.equal(loser?.won, 0)
  })

  test('a secret marked by path is redacted even with no env schema at all', () => {
    const result = resolveConfig({
      definition: { env: undefined, shape: { api: { key: 'sk-live-1234' } }, secrets: ['api.key'] } as never,
      envSources: [],
      overlays: [],
    })
    assert.equal(result.config['api'] !== undefined, true)
    assert.equal((result.config['api'] as { key: string }).key, 'sk-live-1234')
    assert.equal(result.snapshot.values.find((v) => v.path === 'api.key')?.value, REDACTED)
    assert.ok(!JSON.stringify(result.config).includes('sk-live-1234'))
  })
})
