import { explainConfig } from '@erenthedeveloper0/zen'
import { makeApp } from './app.ts'

/**
 * `npm run config:explain` — rfcs/0001 §16.1, §2.4.
 *
 * "Where did this value come from" is one of the most frequently asked and
 * least frequently answerable questions in production, and it is unanswerable
 * in every system that resolves configuration by spreading objects over each
 * other: the result of `{...a, ...b}` has no memory of `a`. Here the resolution
 * *is* a list of records that know their layer, and the object the application
 * reads is the summary — so this table is not a debugging feature bolted on
 * beside the resolver, it is the resolver's actual output.
 *
 * This file is the fourth "build the reader, not just the writer" exercise in
 * the repo, after the OpenAPI generator, the observability example and the
 * health inspector. Every one of the previous three found a defect in the
 * producer that no amount of extra feature-writing would have. This one found
 * its own — see the README.
 */
const app = makeApp({ quiet: true, inspect: true })
await app.ready()

const snapshot = app.graph().config

console.log('')
console.log(explainConfig(snapshot))
console.log('')

// ── the coverage question, which the table above does not answer ────────────
//
// The same family as `examples/health`'s "3 of 5 dependencies are probed" and
// the response-schema coverage report §28 wants: a denominator the framework
// knows, and a numerator worth being uncomfortable about.

const unset = snapshot.env.filter((e) => e.source === 'not set')
const fromDefault = snapshot.values.filter((v) => v.layer === 'default' || v.layer === 'plugin')

console.log('  Coverage')
console.log('')
console.log(`    ${snapshot.env.length - unset.length}/${snapshot.env.length} declared variables are actually set`)
if (unset.length > 0) {
  console.log(`      relying on a schema default: ${unset.map((e) => e.key).join(', ')}`)
}
console.log(`    ${snapshot.values.length - fromDefault.length}/${snapshot.values.length} values are stated by this application`)
console.log(`      inherited from a framework or plugin default: ${fromDefault.map((v) => v.path).join(', ')}`)
console.log('')
console.log(`    ${snapshot.secrets.length} marked secret: ${snapshot.secrets.join(', ')}`)

// The uncomfortable half. A value that *looks* sensitive and is not marked is
// either fine or the bug this whole feature exists to prevent, and only the
// author can say which — the same shape as §11.4's "near misses" idea, and the
// reason it is a report rather than a rule.
const SUSPICIOUS = /(secret|token|password|passwd|key|credential|dsn|auth)/i
const nearMisses = [
  ...snapshot.env.filter((e) => !e.secret && SUSPICIOUS.test(e.key)).map((e) => e.key),
  ...snapshot.values.filter((v) => !v.secret && SUSPICIOUS.test(v.path)).map((v) => v.path),
]
if (nearMisses.length > 0) {
  console.log('')
  console.log(`    near misses — named like a secret, not marked as one:`)
  console.log(`      ${nearMisses.join(', ')}`)
  console.log(`      Mark them with format: 'password' in the schema, or list them in`)
  console.log(`      defineConfig({ secrets: [...] }). A heuristic must not do this`)
  console.log(`      automatically: "key" is in "apiVersion" adjacent fields and in`)
  console.log(`      "keyspace", and a framework that redacted them would teach people`)
  console.log(`      to turn redaction off.`)
}

// §16.3's cost claim, in the same shape as §9.4, §4.4 and §11.4 assert theirs:
// against the emitted bytes. `ctx.config` is a getter over the shared
// ContextEnv, so no route pays for a configuration it does not read — and no
// route pays for one it does.
const pipelines = app.generatedSource().filter((u) => u.name.startsWith('pipeline:'))
console.log('')
console.log(`  generated pipelines: ${pipelines.length}`)
for (const unit of pipelines) {
  console.log(`    ${unit.name.padEnd(38)} ${String(unit.source.length).padStart(5)} bytes`)
}
console.log('')

await app.close()
