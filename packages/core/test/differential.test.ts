import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  compilePipeline, simplePipeline, CodeGen, DEFAULT_CAPABILITIES, PlainContext, markSync,
  jsonReply, NO_HOOKS, PIPELINE_PHASES, MAX_SPECULATION,
  type HookPlan, type PipelineSpec, type PipelineStep, type Reply, type RawRequest,
} from '@erenthedeveloper0/zen-core'
import type { Deadline } from '@erenthedeveloper0/zen-core'

/**
 * Differential testing — rfcs/0001 §20.5.
 *
 * `simplePipeline` is the *semantic definition*; `compilePipeline` must match it
 * exactly on every observable: the reply, the order in which steps ran, and the
 * error thrown. This is the safety net that makes aggressive codegen acceptable,
 * and it is what catches bugs like "a phase middleware followed by an `around`
 * emits `r` without declaring it" — a defect no single-form test would find,
 * because it only appears in a *combination*.
 */

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })

type StepKind = 'sync-pass' | 'async-pass' | 'maybe-pass' | 'sync-halt' | 'async-halt' | 'around' | 'after'

const ALL_KINDS: readonly StepKind[] = [
  'sync-pass', 'async-pass', 'maybe-pass', 'sync-halt', 'async-halt', 'around', 'after',
]

function makeStep(kind: StepKind, id: number, log: string[]): PipelineStep {
  switch (kind) {
    case 'sync-pass':
      return { kind: 'phase', name: `s${id}`, fn: () => { log.push(`s${id}`) } }
    case 'async-pass':
      return { kind: 'phase', name: `a${id}`, fn: async () => { log.push(`a${id}`) } }
    case 'maybe-pass':
      return {
        kind: 'phase',
        name: `m${id}`,
        fn: () => { log.push(`m${id}`); return id % 2 === 0 ? undefined : Promise.resolve(undefined) },
      }
    case 'sync-halt':
      return { kind: 'phase', name: `h${id}`, fn: () => { log.push(`h${id}`); return jsonReply({ halted: id }, { status: 418 }) } }
    case 'async-halt':
      return { kind: 'phase', name: `H${id}`, fn: async () => { log.push(`H${id}`); return jsonReply({ halted: id }, { status: 418 }) } }
    case 'around':
      return {
        kind: 'around',
        name: `w${id}`,
        fn: async (_ctx: unknown, next: () => Promise<Reply>) => {
          log.push(`w${id}:in`)
          const reply = await next()
          log.push(`w${id}:out`)
          return reply
        },
      }
    case 'after':
      return {
        kind: 'after',
        name: `f${id}`,
        fn: (_ctx: unknown, reply: Reply) => { log.push(`f${id}`); return reply },
      }
  }
}

/**
 * A stand-in for `Deadline` — §4.4.
 *
 * The pipeline's entire contract with a deadline is two fields: it writes
 * `stage` at each boundary and reads `done` to decide whether to stop. Fuzzing
 * against the real class would arm eight hundred timers to test two property
 * accesses, and would make "the deadline blew *here*" a race rather than an
 * input. This is the contract, stated as a type.
 */
type FakeDeadline = Pick<Deadline, 'stage' | 'done'>

function fakeContext(deadline: FakeDeadline | null = null): PlainContext {
  const raw: RawRequest = {
    method: 'GET',
    url: '/diff',
    header: () => undefined,
    headerNames: () => [],
    body: { kind: 'none', length: 0, read: async () => new Uint8Array(0), stream: async function* () {} },
    remote: { address: '127.0.0.1', port: 0, family: 'IPv4' },
    native: null,
  }
  const noop = () => {}
  const log = { level: 'fatal' as const, child() { return this }, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
  return new PlainContext(
    raw, null, {}, { log, maxQueryParams: 100, trustProxy: false }, 4,
    new AbortController().signal, deadline as Deadline | null,
  )
}

interface Observation {
  status: number
  body: string
  order: string[]
  error: string | null
  /** Where the deadline stopped it, if it did — the boundary must agree too. */
  stage: string | null
}

async function observe(
  spec: Omit<PipelineSpec, 'steps'>,
  steps: PipelineStep[],
  compiled: boolean,
  log: string[],
  hooks?: HookPlan,
  deadline?: FakeDeadline,
): Promise<Observation> {
  const full: PipelineSpec = hooks === undefined ? { ...spec, steps } : { ...spec, steps, hooks }
  const pipeline = compiled ? compilePipeline(full, codegen) : simplePipeline(full)
  const dl = deadline ?? null
  try {
    const reply = await pipeline(fakeContext(dl))
    return {
      status: reply.status,
      body: JSON.stringify(reply.body),
      order: [...log],
      error: null,
      stage: dl === null ? null : dl.stage,
    }
  } catch (error) {
    return {
      status: -1,
      body: '',
      order: [...log],
      error: error instanceof Error ? error.message : String(error),
      stage: dl === null ? null : dl.stage,
    }
  }
}

/** Deterministic PRNG so a failing seed is reproducible and committable. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('differential: compiled pipeline ≡ simple pipeline', () => {
  test('every single step kind', async () => {
    for (const kind of ALL_KINDS) {
      const base = { routeId: `single_${kind}`, handler: () => ({ ok: true }), intake: null, validators: [], serialize: null }

      const compiledLog: string[] = []
      const simpleLog: string[] = []
      const c = await observe(base, [makeStep(kind, 0, compiledLog)], true, compiledLog)
      const s = await observe(base, [makeStep(kind, 0, simpleLog)], false, simpleLog)

      assert.deepEqual(c, s, `divergence for single step "${kind}"`)
    }
  })

  test('every ordered pair of step kinds', async () => {
    for (const first of ALL_KINDS) {
      for (const second of ALL_KINDS) {
        const base = { routeId: `pair_${first}_${second}`, handler: () => ({ ok: true }), intake: null, validators: [], serialize: null }

        const compiledLog: string[] = []
        const simpleLog: string[] = []
        const c = await observe(base, [makeStep(first, 0, compiledLog), makeStep(second, 1, compiledLog)], true, compiledLog)
        const s = await observe(base, [makeStep(first, 0, simpleLog), makeStep(second, 1, simpleLog)], false, simpleLog)

        assert.deepEqual(c, s, `divergence for pair "${first}" → "${second}"`)
      }
    }
  })

  test('300 random chains of length 1-6', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = rng(seed)
      const length = 1 + Math.floor(random() * 6)
      const kinds: StepKind[] = []
      for (let i = 0; i < length; i++) {
        kinds.push(ALL_KINDS[Math.floor(random() * ALL_KINDS.length)] as StepKind)
      }

      const throwing = random() < 0.2
      const base = {
        routeId: `seed_${seed}`,
        handler: throwing
          ? () => { throw new Error('handler exploded') }
          : () => ({ seed }),
        intake: null,
        validators: [],
        serialize: null,
      }

      const compiledLog: string[] = []
      const simpleLog: string[] = []
      const c = await observe(base, kinds.map((k, i) => makeStep(k, i, compiledLog)), true, compiledLog)
      const s = await observe(base, kinds.map((k, i) => makeStep(k, i, simpleLog)), false, simpleLog)

      assert.deepEqual(c, s, `divergence at seed ${seed} for chain [${kinds.join(', ')}]`)
    }
  })
})

/**
 * Hooks get the same treatment — rfcs/0001 §9.4, §20.5.
 *
 * The compiled form emits nine unrolled call sites at fixed lifecycle
 * positions; the twin runs nine loops. That is exactly the kind of duplication
 * where a short-circuit from `postValidation` ends up running the epilogue in
 * one form and not the other, and no hand-written test covers the combination
 * that breaks. So: random hooks in random phases, with random sync classes,
 * against random middleware chains.
 */
type HookKind = 'sync' | 'async' | 'halt' | 'transform' | 'silent'

const HOOK_KINDS: readonly HookKind[] = ['sync', 'async', 'halt', 'transform', 'silent']

/** Phases whose return value short-circuits, versus the two transform phases. */
const TRANSFORM_PHASES = new Set(['onSerialize', 'onSend'])

function makeHook(phase: string, kind: HookKind, id: number, log: string[]): Function {
  const tag = `${phase}#${id}`
  const transform = TRANSFORM_PHASES.has(phase)

  switch (kind) {
    case 'sync':
      return markSync((..._args: unknown[]) => { log.push(tag) })
    case 'async':
      return async (..._args: unknown[]) => { log.push(tag) }
    case 'silent':
      return (..._args: unknown[]) => { log.push(tag); return undefined }
    case 'transform':
      // On a transform phase this rewrites the value; on a guard phase a
      // non-undefined return is a short-circuit, so it must produce a Reply.
      return transform
        ? (_ctx: unknown, value: unknown) => {
            log.push(tag)
            return phase === 'onSend' ? (value as Reply) : { wrapped: value }
          }
        : () => { log.push(tag); return undefined }
    case 'halt':
      return transform
        ? (_ctx: unknown, value: unknown) => { log.push(tag); return value }
        : () => { log.push(tag); return jsonReply({ haltedAt: tag }, { status: 418 }) }
  }
}

function makePlan(chosen: ReadonlyMap<string, HookKind[]>, log: string[]): HookPlan {
  const plan: Record<string, Function[]> = {}
  for (const phase of PIPELINE_PHASES) {
    const kinds = chosen.get(phase) ?? []
    plan[phase] = kinds.map((kind, i) => makeHook(phase, kind, i, log))
  }
  return plan as unknown as HookPlan
}

describe('differential: hooks in the compiled pipeline ≡ the twin', () => {
  test('every phase × every hook kind, alone', async () => {
    for (const phase of PIPELINE_PHASES) {
      if (phase === 'onParse') continue // composes into intake, not emitted here
      for (const kind of HOOK_KINDS) {
        const base = {
          routeId: `hook_${phase}_${kind}`,
          handler: () => ({ ok: true }),
          intake: null,
          validators: [],
          serialize: null,
        }
        const compiledLog: string[] = []
        const simpleLog: string[] = []
        const c = await observe(base, [], true, compiledLog, makePlan(new Map([[phase, [kind]]]), compiledLog))
        const s = await observe(base, [], false, simpleLog, makePlan(new Map([[phase, [kind]]]), simpleLog))

        assert.deepEqual(c, s, `divergence for ${phase} hook of kind "${kind}"`)
      }
    }
  })

  test('200 random hook plans crossed with random middleware chains', async () => {
    const phases = PIPELINE_PHASES.filter((p) => p !== 'onParse')
    const exercised = new Set<string>()
    let invocations = 0

    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed * 7919)

      const chosen = new Map<string, HookKind[]>()
      for (const phase of phases) {
        if (random() < 0.45) continue
        const count = 1 + Math.floor(random() * 2)
        chosen.set(phase, Array.from({ length: count }, () => HOOK_KINDS[Math.floor(random() * HOOK_KINDS.length)] as HookKind))
      }

      const stepCount = Math.floor(random() * 4)
      const kinds: StepKind[] = []
      for (let i = 0; i < stepCount; i++) {
        kinds.push(ALL_KINDS[Math.floor(random() * ALL_KINDS.length)] as StepKind)
      }

      const throwing = random() < 0.15
      const base = {
        routeId: `hookseed_${seed}`,
        handler: throwing ? () => { throw new Error('handler exploded') } : () => ({ seed }),
        intake: null,
        validators: [],
        serialize: null,
      }

      const compiledLog: string[] = []
      const simpleLog: string[] = []
      const c = await observe(base, kinds.map((k, i) => makeStep(k, i, compiledLog)), true, compiledLog, makePlan(chosen, compiledLog))
      const s = await observe(base, kinds.map((k, i) => makeStep(k, i, simpleLog)), false, simpleLog, makePlan(chosen, simpleLog))

      assert.deepEqual(
        c, s,
        `divergence at seed ${seed}\n  steps: [${kinds.join(', ')}]\n  hooks: ${JSON.stringify([...chosen])}`,
      )

      for (const entry of c.order) {
        if (!entry.includes('#')) continue
        invocations++
        exercised.add(entry.slice(0, entry.indexOf('#')))
      }
    }

    // A fuzzer that agrees because neither side ran anything is worse than no
    // fuzzer: it reports a pass and covers nothing.
    assert.deepEqual([...exercised].sort(), [...phases].sort(), 'some phase was never actually invoked')
    assert.ok(invocations > 200, `expected the fuzzer to run hooks; it ran ${invocations}`)
  })

  test('an empty plan is indistinguishable from no plan at all', async () => {
    const base = {
      routeId: 'empty_plan',
      handler: () => ({ ok: true }),
      intake: null,
      validators: [],
      serialize: null,
    }
    const withLog: string[] = []
    const withoutLog: string[] = []
    const withPlan = await observe(base, [], true, withLog, NO_HOOKS)
    const withoutPlan = await observe(base, [], true, withoutLog)

    assert.deepEqual(withPlan, withoutPlan)
  })
})

/**
 * Deadlines get the same treatment — rfcs/0001 §4.4, §20.5.
 *
 * The compiled form emits a stage mark and a branch at three fixed points; the
 * twin runs the same two facts through a closure. What has to agree is not only
 * "did it stop" but **where** — the boundary a request was abandoned at is what
 * a 504 reports and what a metrics hook labels on, so a compiler that stopped
 * one stage later than the twin would produce a plausible, wrong answer that no
 * status-code assertion would catch.
 *
 * The interesting seeds are the ones where the deadline blows *during* the
 * chain rather than before it: a `disconnect` step flips `done` partway
 * through, and both forms then have to abandon at the same next boundary
 * regardless of what intake, validators, hooks and `around` wrappers sit
 * between here and there.
 */
describe('differential: deadlines in the compiled pipeline ≡ the twin', () => {
  const disconnect = (log: string[]): PipelineStep => ({
    kind: 'phase',
    name: 'disconnect',
    fn: (ctx: unknown) => {
      log.push('disconnect')
      const dl = (ctx as { $deadline: FakeDeadline | null }).$deadline
      if (dl !== null) dl.done = true
    },
  })

  test('a deadline already blown stops at the first boundary, in both forms', async () => {
    for (const withIntake of [false, true]) {
      const log = { c: [] as string[], s: [] as string[] }
      const base = (l: string[]) => ({
        routeId: `blown_${String(withIntake)}`,
        handler: () => { l.push('handler'); return { ok: true } },
        intake: withIntake ? async (c: unknown) => { void c; l.push('intake') } : null,
        validators: [{ source: 'body', run: () => { l.push('validate') } }],
        serialize: null,
        deadline: true,
      })

      const c = await observe(base(log.c), [], true, log.c, undefined, { stage: 'pre', done: true })
      const s = await observe(base(log.s), [], false, log.s, undefined, { stage: 'pre', done: true })

      assert.deepEqual(c, s, `divergence with intake=${String(withIntake)}`)
      assert.equal(c.status, 499)
      assert.equal(c.stage, withIntake ? 'intake' : 'validate')
      assert.deepEqual(c.order, [], 'nothing should have run past an already-blown deadline')
    }
  })

  test('200 random chains where the deadline blows partway through', async () => {
    let abandoned = 0
    let completed = 0

    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed * 104_729)

      const kinds: StepKind[] = []
      const length = Math.floor(random() * 4)
      for (let i = 0; i < length; i++) {
        kinds.push(ALL_KINDS[Math.floor(random() * ALL_KINDS.length)] as StepKind)
      }
      // Where the client leaves, or nowhere.
      const cut = random() < 0.7 ? Math.floor(random() * (kinds.length + 1)) : -1

      const chosen = new Map<string, HookKind[]>()
      for (const phase of PIPELINE_PHASES) {
        if (phase === 'onParse' || random() < 0.7) continue
        chosen.set(phase, [HOOK_KINDS[Math.floor(random() * HOOK_KINDS.length)] as HookKind])
      }

      const withIntake = random() < 0.5
      const validatorCount = Math.floor(random() * 3)

      const build = (log: string[]) => {
        const steps = kinds.map((k, i) => makeStep(k, i, log))
        if (cut >= 0) steps.splice(cut, 0, disconnect(log))
        return steps
      }
      const base = (log: string[]) => ({
        routeId: `dl_${seed}`,
        handler: () => { log.push('handler'); return { seed } },
        intake: withIntake ? async () => { log.push('intake') } : null,
        validators: Array.from({ length: validatorCount }, (_, i) => ({
          source: `v${i}`,
          run: () => { log.push(`v${i}`) },
        })),
        serialize: null,
        deadline: true,
      })

      const cLog: string[] = []
      const sLog: string[] = []
      const state = (): FakeDeadline => ({ stage: 'pre', done: false })
      const c = await observe(base(cLog), build(cLog), true, cLog, makePlan(chosen, cLog), state())
      const s = await observe(base(sLog), build(sLog), false, sLog, makePlan(chosen, sLog), state())

      assert.deepEqual(
        c, s,
        `divergence at seed ${seed}\n  steps: [${kinds.join(', ')}]  cut@${cut}\n` +
        `  intake: ${String(withIntake)}  validators: ${validatorCount}\n` +
        `  hooks: ${JSON.stringify([...chosen])}`,
      )

      if (c.status === 499) abandoned++
      else completed++
    }

    // Two implementations that agree because neither ever took the branch is a
    // pass that proves nothing — the same trap the hook fuzzer's coverage
    // assertion exists for.
    assert.ok(abandoned > 40, `expected the deadline to fire often; it fired ${abandoned} times`)
    assert.ok(completed > 20, `expected some requests to finish; ${completed} did`)
  })

  test('a spec without a deadline is byte-identical to one that opts out', () => {
    const spec = (deadline: boolean | undefined): PipelineSpec => ({
      routeId: 'optout',
      steps: [],
      handler: () => ({ ok: true }),
      intake: async () => {},
      validators: [{ source: 'body', run: () => {} }],
      serialize: null,
      ...(deadline === undefined ? {} : { deadline }),
    })

    const probe = (s: PipelineSpec): string => {
      const gen = new CodeGen({ caps: DEFAULT_CAPABILITIES, retain: true })
      compilePipeline(s, gen)
      return gen.units[gen.units.length - 1]?.source ?? ''
    }

    assert.equal(probe(spec(undefined)), probe(spec(false)))
    assert.ok(!probe(spec(false)).includes('$deadline'))
    assert.ok(probe(spec(true)).includes('$deadline'))
  })
})

/**
 * Speculative sync — rfcs/0001 §8.4's `maybe` row, and §28.3's rule that the
 * differential suite, not benchmark envy, decides whether it stays.
 *
 * A plain function is a speculation point: called synchronously, and waited
 * for only if it returned a thenable. The members that matter are therefore the
 * ones that sometimes do and sometimes do not — a cache that answers from
 * memory or goes to the network, a validator that is synchronous until a
 * refinement is async. So every member here is *flaky*: a plain function that
 * returns a value or a promise of it, chosen at random on every call, from a
 * seed both forms share, in every position a speculation point can stand —
 * hooks of every phase, phase middleware, validators, the handler, `after`
 * middleware and both transform phases.
 */
describe('differential: speculative sync (§8.4)', () => {
  interface Flaky {
    readonly random: () => number
    promised: number
    returned: number
  }

  /** A value now or a promise of it later — decided per call, from the shared seed. */
  const flaky = <T>(state: Flaky, value: () => T): T | Promise<T> => {
    if (state.random() < 0.5) {
      state.returned++
      return value()
    }
    state.promised++
    return Promise.resolve().then(value)
  }

  type FlakyStep = 'flaky-pass' | 'flaky-halt' | 'flaky-throw' | 'plain-pass' | 'plain-halt' | 'sync-pass' | 'around' | 'flaky-after'
  const FLAKY_STEPS: readonly FlakyStep[] = ['flaky-pass', 'flaky-halt', 'flaky-throw', 'plain-pass', 'plain-halt', 'sync-pass', 'around', 'flaky-after']

  function flakyStep(kind: FlakyStep, id: number, log: string[], state: Flaky): PipelineStep {
    switch (kind) {
      case 'flaky-pass':
        return { kind: 'phase', name: `fp${id}`, fn: () => flaky(state, () => { log.push(`fp${id}`) }) }
      case 'flaky-halt':
        return { kind: 'phase', name: `fh${id}`, fn: () => flaky(state, () => { log.push(`fh${id}`); return jsonReply({ halted: id }, { status: 418 }) }) }
      case 'flaky-throw':
        return {
          kind: 'phase',
          name: `ft${id}`,
          fn: () => flaky(state, () => { log.push(`ft${id}`); if (state.random() < 0.3) throw new Error(`step ${id} exploded`) }),
        }
      case 'plain-pass':
        return { kind: 'phase', name: `pp${id}`, fn: () => { log.push(`pp${id}`) } }
      case 'plain-halt':
        return { kind: 'phase', name: `ph${id}`, fn: () => { log.push(`ph${id}`); return jsonReply({ halted: id }, { status: 418 }) } }
      case 'sync-pass':
        return { kind: 'phase', name: `s${id}`, fn: markSync(() => { log.push(`s${id}`) }) }
      case 'around':
        return {
          kind: 'around',
          name: `w${id}`,
          fn: async (_ctx: unknown, next: () => Promise<Reply>) => {
            log.push(`w${id}:in`)
            const reply = await next()
            log.push(`w${id}:out`)
            return reply
          },
        }
      case 'flaky-after':
        return { kind: 'after', name: `fa${id}`, fn: (_ctx: unknown, reply: Reply) => flaky(state, () => { log.push(`fa${id}`); return reply }) }
    }
  }

  /** A plan whose every hook is a flaky plain function, in the phases `chosen` names. */
  function flakyPlan(chosen: ReadonlySet<string>, log: string[], state: Flaky): HookPlan {
    const plan: Record<string, Function[]> = {}
    for (const phase of PIPELINE_PHASES) {
      if (!chosen.has(phase) || phase === 'onParse') {
        plan[phase] = []
        continue
      }
      const tag = `${phase}#0`
      plan[phase] = [
        TRANSFORM_PHASES.has(phase)
          ? (_ctx: unknown, value: unknown) => flaky(state, () => { log.push(tag); return phase === 'onSend' ? value : { wrapped: value } })
          : (..._args: unknown[]) => flaky(state, () => { log.push(tag); return state.random() < 0.15 ? jsonReply({ haltedAt: tag }, { status: 418 }) : undefined }),
      ]
    }
    return plan as unknown as HookPlan
  }

  /** Whether the compiled form finished without returning a promise — the property this exists for. */
  async function run(pipeline: (ctx: unknown) => Reply | Promise<Reply>, log: string[]): Promise<Observation & { synchronous: boolean }> {
    let synchronous = false
    try {
      const pending = pipeline(fakeContext())
      synchronous = typeof (pending as { then?: unknown }).then !== 'function'
      const reply = await pending
      return { status: reply.status, body: JSON.stringify(reply.body), order: [...log], error: null, stage: null, synchronous }
    } catch (error) {
      return { status: -1, body: '', order: [...log], error: error instanceof Error ? error.message : String(error), stage: null, synchronous }
    }
  }

  test('400 random chains of plain functions that return a value or a promise, at random, on every call', async () => {
    let synchronousCompletions = 0
    let asynchronousCompletions = 0
    let promised = 0
    let returned = 0
    let errors = 0

    for (let seed = 1; seed <= 400; seed++) {
      const shape = rng(seed * 48_271)
      const kinds: FlakyStep[] = Array.from({ length: Math.floor(shape() * 5) }, () => FLAKY_STEPS[Math.floor(shape() * FLAKY_STEPS.length)] as FlakyStep)
      const phases = new Set(PIPELINE_PHASES.filter(() => shape() < 0.3))
      const validators = Math.floor(shape() * 3)
      const handlerKind = shape()

      const build = (log: string[], state: Flaky): PipelineSpec => ({
        routeId: `flaky_${seed}`,
        steps: kinds.map((k, i) => flakyStep(k, i, log, state)),
        handler: handlerKind < 0.6
          ? () => flaky(state, () => { log.push('handler'); return { seed } })
          : handlerKind < 0.8
            ? () => { log.push('handler'); return { seed } }
            : () => flaky(state, () => { log.push('handler'); throw new Error('handler exploded') }),
        intake: null,
        validators: Array.from({ length: validators }, (_, i) => ({
          source: `v${i}`,
          run: () => flaky(state, () => { log.push(`v${i}`) }) as void | Promise<void>,
        })),
        serialize: null,
        hooks: flakyPlan(phases, log, state),
      })

      const cState: Flaky = { random: rng(seed), promised: 0, returned: 0 }
      const sState: Flaky = { random: rng(seed), promised: 0, returned: 0 }
      const cLog: string[] = []
      const sLog: string[] = []
      const compiled = await run(compilePipeline(build(cLog, cState), codegen), cLog)
      const simple = await run(simplePipeline(build(sLog, sState)), sLog)

      const { synchronous, ...observed } = compiled
      const { synchronous: _ignored, ...reference } = simple
      assert.deepEqual(observed, reference, `divergence at seed ${seed}\n  steps: [${kinds.join(', ')}]\n  hooks: [${[...phases].join(', ')}]\n  validators: ${validators}`)

      if (synchronous) synchronousCompletions++
      else asynchronousCompletions++
      if (compiled.error !== null) errors++
      promised += cState.promised
      returned += cState.returned
    }

    // Both ways a speculation point can go, often enough to be tested on
    // purpose — and whole requests that finished synchronously, which is the
    // reason the form exists. A fuzzer whose plain functions never returned a
    // promise would compare two implementations on the one path that cannot be
    // wrong.
    assert.ok(synchronousCompletions >= 40, `expected requests that finished without a promise; got ${synchronousCompletions}`)
    assert.ok(asynchronousCompletions >= 100, `expected requests a speculation sent async; got ${asynchronousCompletions}`)
    assert.ok(promised >= 300 && returned >= 300, `speculation points went async ${promised}× and stayed sync ${returned}×`)
    assert.ok(errors >= 20, `expected throws, synchronous and from a continuation; got ${errors}`)
  })

  test('a route of plain functions compiles to source with no async and no await, and allocates no promise', () => {
    const gen = new CodeGen({ caps: DEFAULT_CAPABILITIES, retain: true })
    const pipeline = compilePipeline({
      routeId: 'plain',
      steps: [
        { kind: 'phase', name: 'authenticate', fn: () => {} },
        { kind: 'after', name: 'audit', fn: (_ctx: unknown, reply: Reply) => reply },
      ],
      handler: () => ({ ok: true }),
      intake: null,
      validators: [{ source: 'query', run: () => {} }],
      serialize: null,
      hooks: { ...NO_HOOKS, onRequest: [() => {}], onSend: [() => {}] },
    }, gen)

    const source = gen.units[gen.units.length - 1]?.source ?? ''
    assert.doesNotMatch(source, /\basync\b/)
    assert.doesNotMatch(source, /\bawait\b/)
    const result = pipeline(fakeContext())
    assert.equal(typeof (result as { then?: unknown }).then, 'undefined')
    assert.equal((result as Reply).status, 200)
  })

  test(`more than ${MAX_SPECULATION} speculation points keep the async form, and ${MAX_SPECULATION} do not`, () => {
    const source = (points: number): string => {
      const gen = new CodeGen({ caps: DEFAULT_CAPABILITIES, retain: true })
      compilePipeline({
        routeId: `points_${points}`,
        // the handler is one point; the rest are phase middleware
        steps: Array.from({ length: points - 1 }, (_, i) => ({ kind: 'phase' as const, name: `m${i}`, fn: () => {} })),
        handler: () => ({ ok: true }),
        intake: null,
        validators: [],
        serialize: null,
      }, gen)
      return gen.units[gen.units.length - 1]?.source ?? ''
    }
    assert.doesNotMatch(source(MAX_SPECULATION), /\basync\b/, `${MAX_SPECULATION} points are within the bound`)
    assert.match(source(MAX_SPECULATION + 1), /\basync function seg0\b/, `${MAX_SPECULATION + 1} points must not deepen the stack further`)
  })

  test('next() is a promise when the downstream is speculative, and a synchronous throw arrives as a rejection', async () => {
    let kind = ''
    const pipeline = compilePipeline({
      routeId: 'wrapped',
      steps: [{
        kind: 'around',
        name: 'timing',
        fn: (_ctx: unknown, next: () => Promise<Reply>) => {
          const pending = next()
          kind = typeof (pending as { then?: unknown }).then
          return pending
        },
      }],
      handler: () => { throw new Error('downstream') },
      intake: null,
      validators: [],
      serialize: null,
    }, codegen)
    await assert.rejects(Promise.resolve().then(() => pipeline(fakeContext())), /downstream/)
    assert.equal(kind, 'function')
  })
})

describe('sync fast path', () => {
  // `markSync` declares a function synchronous outright; a plain function is a
  // speculation point (the suite above). An `async` function is neither.
  test('an all-sync chain compiles to a non-async function (§8.4)', () => {
    const pipeline = compilePipeline(
      {
        routeId: 'allsync',
        steps: [{ kind: 'phase', name: 'noop', fn: markSync(() => {}) }],
        handler: markSync(() => ({ ok: true })),
        intake: null,
        validators: [],
        serialize: null,
      },
      codegen,
    )

    const result = pipeline(fakeContext())
    // The whole point: no promise is allocated for the entire request.
    assert.equal(typeof (result as { then?: unknown }).then, 'undefined')
    assert.equal((result as Reply).status, 200)
  })

  test('an async member forces the async form', () => {
    const pipeline = compilePipeline(
      {
        routeId: 'hasasync',
        steps: [{ kind: 'phase', name: 'slow', fn: async () => {} }],
        handler: () => ({ ok: true }),
        intake: null,
        validators: [],
        serialize: null,
      },
      codegen,
    )

    const result = pipeline(fakeContext())
    assert.equal(typeof (result as Promise<Reply>).then, 'function')
  })
})
