import type { RouteRecord } from '../contracts/route.ts'
import type { RequestPhase } from '../contracts/hook.ts'
import type { ConfigSnapshot } from '../contracts/config.ts'
import { describeField } from '../compile/coercion-plan.ts'

/**
 * `explainRoute` — rfcs/0001 §8.5.
 *
 * "I can't tell what middleware runs on this route" is the single most common
 * complaint about mature Express codebases. The answer here is one function,
 * because the AppGraph already holds the resolved chain.
 *
 * The property that makes this worth having rather than nice to have: it reads
 * `record.middleware` and `record.hooks`, which are *the same arrays the
 * pipeline compiler consumes*. There is no second model of the ordering to keep
 * in sync, so the explanation cannot drift from the pipeline — it can only be
 * wrong by the pipeline being wrong. `hooks.test.ts` pins that down by
 * comparing this output against the order the steps actually ran in.
 */
export function explainRoute(record: RouteRecord): string {
  const lines: string[] = []
  const head = `${record.method} ${record.path}`
  lines.push(record.name === undefined ? head : `${head.padEnd(38)}→ ${record.name}`)
  if (record.origin !== undefined) {
    lines.push(`  registered  ${record.origin.file}:${record.origin.line}`)
  }
  lines.push('')

  const rows = steps(record)
  const kindWidth = Math.max(10, ...rows.map((s) => s.kind.length)) + 2
  const scopeWidth = Math.max(10, ...rows.map((s) => s.scope.length)) + 2
  for (const step of rows) {
    lines.push(`  ${step.kind.padEnd(kindWidth)}${step.scope.padEnd(scopeWidth)}${step.name}`)
  }

  return lines.join('\n')
}

export interface ExplainedStep {
  /** `onRequest`, `phase`, `around`, `validate`, `handler`, `serialize`, … */
  readonly kind: string
  /** `[global]`, `[/api]`, `[route]` — where the registration lives. */
  readonly scope: string
  readonly name: string
}

/**
 * The ordered chain for one route, as data.
 *
 * Separated from the string rendering because tools want the list — a CLI
 * renders it, a test asserts on it, and an LSP would turn each entry into a
 * jump target.
 */
export function steps(record: RouteRecord): ExplainedStep[] {
  const out: ExplainedStep[] = []
  const hooks = (phase: RequestPhase): void => {
    for (const hook of record.hooks.get(phase) ?? []) {
      out.push({ kind: phase, scope: scopeLabel(hook.scope), name: hook.name ?? 'anonymous' })
    }
  }

  // The deadline heads the list because it bounds everything below it, and it
  // names the scope that declared it: "why does this route give up after two
  // seconds" is a provenance question whose answer is usually a collection in
  // another file (§4.4).
  if (record.timeout !== null) {
    out.push({
      kind: 'deadline',
      scope: scopeLabel(record.timeout.from),
      name: `${record.timeout.ms} ms budget, checked at each stage boundary`,
    })
  }

  hooks('onRequest')
  hooks('onRoute')

  // §13.4 — listed here because this is where it runs: after the hooks, before
  // any application middleware, and therefore before intake and validation.
  // That position is the answer to "why did this route 406 before my auth
  // middleware ran", which is the one surprising thing about the feature, so
  // the chain has to show it rather than leave it to the prose.
  //
  // The *offers* are printed, in preference order, because that is the fact
  // that decides everything downstream: which representation an `Accept: * / *`
  // gets, which way a tie breaks, and what the 406 lists.
  if (record.negotiation !== null) {
    out.push({
      kind: 'negotiate',
      scope: '',
      name: `${record.negotiation.offers.join(' > ')} — Vary: Accept, 406 otherwise`,
    })
  }

  // `after` middleware is hoisted out of the flow by the compiler — it runs in
  // the epilogue, even when an earlier step short-circuits (§8.2) — so listing
  // it positionally here would describe an order that never happens.
  for (const middleware of record.middleware) {
    if (middleware.kind === 'after') continue
    out.push({ kind: middleware.kind, scope: scopeLabel(middleware.scope), name: middleware.name })
  }

  if (record.schema.body !== undefined) {
    out.push({ kind: 'intake', scope: '', name: 'read + parse body' })
    hooks('onParse')
  }

  hooks('preValidation')

  // §11.4 — listed above `validate` because that is where it runs, and listed
  // as the *derived plan* rather than the profile that produced it. "Why did
  // `?tags=a` arrive as an array" is the question this answers, and a line
  // reading `arrays: 'repeat'` would not answer it: the profile is a policy and
  // only the plan says what the policy decided about this schema.
  if (record.coercion !== null) {
    for (const [source, plan] of record.coercion) {
      out.push({ kind: 'coerce', scope: '', name: `${source}: ${plan.fields.map(describeField).join(', ')}` })
    }
  }

  const sources = (['params', 'query', 'headers', 'cookies', 'body'] as const)
    .filter((source) => record.schema[source] !== undefined)
  if (sources.length > 0) out.push({ kind: 'validate', scope: '', name: sources.join(', ') })
  hooks('postValidation')

  hooks('preHandler')
  out.push({ kind: 'handler', scope: '', name: functionName(record.handler) })
  hooks('postHandler')

  // The epilogue mirrors the entry: `after` middleware, then the transform
  // hooks, then the response contract — which is attached last so it covers
  // whatever is actually sent (§13.3).
  for (const middleware of record.middleware) {
    if (middleware.kind !== 'after') continue
    out.push({ kind: 'after', scope: scopeLabel(middleware.scope), name: middleware.name })
  }

  hooks('onSerialize')
  hooks('onSend')
  const statuses = Object.keys(record.schema.response ?? {})
  if (statuses.length > 0) {
    // A negotiated status has one contract *per representation*, so saying
    // "200 (compiled)" would under-report by exactly the dimension this route
    // added. The count is what a reader needs: it is the number of serializers
    // this one status compiled, and it is the number that grows if somebody
    // adds a media type without noticing.
    const negotiated = new Set(record.negotiation?.statuses ?? [])
    const variants = record.negotiation?.offers.length ?? 0
    const rendered = statuses.map((status) =>
      negotiated.has(Number(status)) ? `${status}×${variants}` : status)
    out.push({ kind: 'serialize', scope: '', name: `${rendered.join(', ')} (compiled)` })
  }

  hooks('onResponse')
  hooks('onError')
  hooks('onTimeout')

  return out
}

function scopeLabel(scope: string): string {
  if (scope === 'root' || scope === 'app') return '[global]'
  if (scope === 'route') return '[route]'
  return `[${scope}]`
}

function functionName(fn: unknown): string {
  const name = (fn as { name?: string }).name
  return name === undefined || name === '' ? 'anonymous' : name
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * `explainConfig` — rfcs/0001 §16.1, the `zen inspect config` output.
 *
 * ```
 *   server.port          3000        ← .env.development:2
 *   server.host          127.0.0.1   ← default
 *   database.url         ********    ← process.env  (redacted)
 * ```
 *
 * "Where did this value come from" is one of the most frequently asked and
 * least frequently answerable questions in production, and it is unanswerable
 * in every system that resolves config by spreading objects: the result of
 * `{...a, ...b}` has no memory of `a`. This function is not the reason the
 * store keeps provenance — the store keeps provenance because the question is
 * worth answering — but it is the thing that proves it did, which is convention
 * #2 in the handoff: build the reader, not just the writer.
 *
 * It reads `ConfigSnapshot` and nothing else. The snapshot is redacted at the
 * source (§22.1), so this function has no `secret` branch to forget — the
 * closest thing to a security property a printer can have is not being trusted
 * with the secret in the first place.
 */
export function explainConfig(snapshot: ConfigSnapshot): string {
  const lines: string[] = []

  if (snapshot.env.length > 0) {
    lines.push('  Environment')
    lines.push('')
    const keyWidth = Math.max(12, ...snapshot.env.map((e) => e.key.length)) + 2
    const valueWidth = Math.max(10, ...snapshot.env.map((e) => render(e.value).length)) + 2
    for (const entry of snapshot.env) {
      const notes: string[] = []
      if (entry.secret) notes.push('redacted')
      if (entry.usedBy.length > 0) notes.push(`used by ${entry.usedBy.join(', ')}`)
      lines.push(
        `    ${entry.key.padEnd(keyWidth)}${render(entry.value).padEnd(valueWidth)}← ${entry.source}` +
        (notes.length === 0 ? '' : `  (${notes.join('; ')})`),
      )
    }
    lines.push('')
  }

  lines.push('  Configuration')
  lines.push('')
  if (snapshot.values.length === 0) {
    lines.push('    (none declared)')
  } else {
    const pathWidth = Math.max(12, ...snapshot.values.map((v) => v.path.length)) + 2
    const valueWidth = Math.max(10, ...snapshot.values.map((v) => render(v.value).length)) + 2
    for (const value of snapshot.values) {
      lines.push(
        `    ${value.path.padEnd(pathWidth)}${render(value.value).padEnd(valueWidth)}← ${value.source}` +
        (value.secret ? '  (redacted)' : ''),
      )
    }
  }

  // The layer table is the half people do not think to ask for and reach for
  // once they have seen it: a source that supplied twelve variables and won
  // none of them is either redundant or shadowed, and both are worth knowing
  // before the next incident rather than during it.
  if (snapshot.sources.length > 0) {
    lines.push('')
    lines.push('  Sources, in precedence order (later wins)')
    lines.push('')
    const nameWidth = Math.max(12, ...snapshot.sources.map((s) => s.name.length)) + 2
    for (const source of snapshot.sources) {
      lines.push(
        `    ${source.layer.padEnd(10)}${source.name.padEnd(nameWidth)}` +
        `${String(source.won).padStart(3)} of ${String(source.supplied).padStart(3)} kept` +
        // The line that finds a typo in a `.env` file. Never printed for the
        // process environment, where it would be sixty lines of noise.
        (source.undeclared > 0 ? `   · ${source.undeclared} set here that nothing declares` : ''),
      )
    }
  }

  return lines.join('\n')
}

function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return '—'
  if (Array.isArray(value)) return `[${value.map(render).join(', ')}]`
  return JSON.stringify(value) ?? String(value)
}
