/**
 * Serializer throughput — rfcs/0001 §13.3.2.
 *
 * `node benchmarks/serializer/run.ts`
 *
 * The RFC claims 2-5x over `JSON.stringify`. This measures it rather than
 * repeating it, and it is set up so the comparison cannot flatter Zen:
 *
 *   - the **fair** case gives `JSON.stringify` an object with *exactly* the
 *     declared fields, so both engines emit identical bytes and neither is
 *     rewarded for doing less work;
 *   - the **realistic** case adds the undeclared fields a real handler carries
 *     (an ORM row with a password hash and internal columns), which is the
 *     situation the subsystem actually exists for.
 *
 * Byte-equality is asserted before timing, so a "win" produced by emitting
 * something different is reported as a failure rather than a number.
 */
import {
  buildProgram, compileSerializer, walkSerializer, CodeGen, DEFAULT_CAPABILITIES,
  type JsonSchema,
} from '@zenjs/core'

const codegen = new CodeGen({ caps: DEFAULT_CAPABILITIES })

interface Case {
  readonly name: string
  readonly schema: JsonSchema
  /** Exactly the declared fields — the fair comparison. */
  readonly lean: unknown
  /** Plus the fields a real row carries — the realistic one. */
  readonly fat: unknown
  readonly iterations: number
}

const UserSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    email: { type: 'string' },
    name: { type: 'string' },
    active: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'email', 'name', 'active', 'createdAt'],
}

const leanUser = (i: number) => ({
  id: i,
  email: `user${i}@example.com`,
  name: `User Number ${i}`,
  active: i % 3 !== 0,
  createdAt: '2024-03-01T12:00:00.000Z',
})

const fatUser = (i: number) => ({
  ...leanUser(i),
  passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
  internalNotes: 'flagged by fraud review 2024-02-11',
  stripeCustomerId: `cus_${i}`,
  updatedAt: '2024-03-02T09:00:00.000Z',
  deletedAt: null,
})

const CASES: readonly Case[] = [
  {
    name: 'flat object (5 fields)',
    schema: UserSchema,
    lean: leanUser(1),
    fat: fatUser(1),
    iterations: 300_000,
  },
  {
    name: 'list of 50 objects',
    schema: { type: 'array', items: UserSchema },
    lean: Array.from({ length: 50 }, (_, i) => leanUser(i)),
    fat: Array.from({ length: 50 }, (_, i) => fatUser(i)),
    iterations: 8_000,
  },
  {
    name: 'nested + arrays',
    schema: {
      type: 'object',
      properties: {
        owner: UserSchema,
        tags: { type: 'array', items: { type: 'string' } },
        counts: { type: 'array', items: { type: 'integer' } },
        meta: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
      },
      required: ['owner', 'tags', 'counts', 'meta'],
    },
    lean: {
      owner: leanUser(7),
      tags: ['alpha', 'beta', 'gamma', 'delta'],
      counts: [1, 2, 3, 5, 8, 13, 21],
      meta: { region: 'eu-west-1' },
    },
    fat: {
      owner: fatUser(7),
      tags: ['alpha', 'beta', 'gamma', 'delta'],
      counts: [1, 2, 3, 5, 8, 13, 21],
      meta: { region: 'eu-west-1', shard: 4, replica: 'b' },
      auditTrail: Array.from({ length: 10 }, (_, i) => ({ at: i, by: 'system' })),
    },
    iterations: 120_000,
  },
  {
    name: 'string-heavy (escapes)',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' }, slug: { type: 'string' } },
      required: ['title', 'body', 'slug'],
    },
    lean: {
      title: 'A "quoted" headline — with punctuation',
      body: 'Line one.\nLine two, with a backslash \\ and a tab\there.'.repeat(6),
      slug: 'a-quoted-headline',
    },
    fat: {
      title: 'A "quoted" headline — with punctuation',
      body: 'Line one.\nLine two, with a backslash \\ and a tab\there.'.repeat(6),
      slug: 'a-quoted-headline',
      draftBody: 'x'.repeat(400),
      editorNotes: 'internal',
    },
    iterations: 120_000,
  },
]

/**
 * Best of `REPS`, not the mean.
 *
 * A microbenchmark's mean is dominated by whatever else the machine did during
 * the run; its minimum is the closest available estimate of the work itself.
 * Taking the best of several passes is also the only way these numbers are
 * comparable across the laptop they were recorded on and the CI box.
 */
const REPS = 5

function time(fn: (i: number) => string, iterations: number): number {
  let sink = 0
  // Accumulate a byte count so nothing can be optimised away as dead.
  for (let i = 0; i < Math.min(iterations, 20_000); i++) sink += fn(i).length

  let best = Infinity
  for (let rep = 0; rep < REPS; rep++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) sink += fn(i).length
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6)
  }
  if (sink === -1) throw new Error('unreachable')
  return best
}

console.log('\n  Serializer throughput — ns/op, lower is better')
console.log('  node ' + process.version + '\n')

let failures = 0

for (const testCase of CASES) {
  const { program, diagnostics } = buildProgram(testCase.schema, false)
  if (program === null) {
    console.error(`  ${testCase.name}: schema rejected — ${JSON.stringify(diagnostics)}`)
    failures++
    continue
  }

  const compiled = compileSerializer(program, testCase.name, codegen)
  const walked = walkSerializer(program)

  // The claim is only meaningful if the bytes match.
  if (compiled(testCase.lean) !== JSON.stringify(testCase.lean)) {
    console.error(`  ${testCase.name}: compiled output differs from JSON.stringify on the lean value`)
    failures++
    continue
  }
  if (compiled(testCase.fat) !== walked(testCase.fat)) {
    console.error(`  ${testCase.name}: engines disagree`)
    failures++
    continue
  }

  console.log(`  ${testCase.name}  (${testCase.iterations.toLocaleString()} iterations)`)

  for (const [label, value] of [['same fields', testCase.lean], ['+ undeclared fields', testCase.fat]] as const) {
    const native = time(() => JSON.stringify(value), testCase.iterations)
    const fast = time(() => compiled(value), testCase.iterations)
    const walk = time(() => walked(value), testCase.iterations)

    const ns = (ms: number) => (ms * 1e6) / testCase.iterations
    console.log(
      `    ${label.padEnd(20)} ` +
      `JSON.stringify ${ns(native).toFixed(0).padStart(6)}   ` +
      `compiled ${ns(fast).toFixed(0).padStart(6)}  (${(native / fast).toFixed(2)}x)   ` +
      `walk ${ns(walk).toFixed(0).padStart(6)}  (${(native / walk).toFixed(2)}x)`,
    )
  }
  console.log('')
}

process.exitCode = failures === 0 ? 0 : 1
