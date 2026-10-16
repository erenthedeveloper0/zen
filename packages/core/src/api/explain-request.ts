import type { HookPlan, HookRecord, PipelinePhase, RequestPhase } from '../contracts/hook.ts'
import type { Reply } from '../contracts/reply.ts'
import type { MiddlewareRef, RouteRecord } from '../contracts/route.ts'
import type { PipelineSpec, ValidatorStep } from '../compile/pipeline-compiler.ts'
import type { SerializerTable } from '../compile/serializer.ts'
import { PIPELINE_PHASES } from '../contracts/hook.ts'
import { declaredSlots } from '../registry/slot-registry.ts'
import { utf8Length } from '../primitives/utf8.ts'

/**
 * EXPLAIN ANALYZE for HTTP — the instrumentation half (§8.5).
 *
 * `explainRoute` prints a route's *plan*. When a request is slow or
 * surprising, the question is about the *actuals*: which hook answered, what
 * a step staged or set, which representation won, where the time went, which
 * fields the serializer dropped. This wraps every member of one route's
 * pipeline spec with an observer that records them, and the application runs
 * the request once through a pipeline compiled from the wrapped spec — the
 * interpreted twin, which is the definition of a pipeline (§8.4) and whose
 * equivalence to the compiled one the differential suites hold — that is
 * **never installed in the route table**: the request goes through a copy of
 * the table holding it, and the next request to the route runs the
 * production pipeline as before.
 */

export type StepOutcome = 'continue' | 'short-circuit' | 'transform' | 'ok' | 'refused' | 'threw' | 'ran'

export interface TraceEvent {
  /** `onRequest`, `phase`, `around`, `intake`, `validate`, `check`, `handler`, `serialize`, `wire`, … */
  readonly kind: string
  /** `[global]`, `[/api]`, `[route]`, or `''`. */
  readonly scope: string
  readonly name: string
  /** Milliseconds this step took, its own work only for an `around`. */
  ms: number
  outcome: StepOutcome
  /** What it did that is worth a reader's eye: staged headers, set slots, dropped fields. */
  notes: string[]
}

/** The events of one request, in the order their steps began. */
export class Trace {
  readonly events: TraceEvent[] = []

  begin(kind: string, scope: string, name: string): TraceEvent {
    const event: TraceEvent = { kind, scope, name, ms: 0, outcome: 'ran', notes: [] }
    this.events.push(event)
    return event
  }
}

/** What a context exposes to the observers — read, never written. */
interface Observed {
  readonly $resHeaders: ReadonlyArray<readonly [string, unknown, boolean]> | null
  readonly $s: readonly unknown[]
  readonly $negotiated: { readonly media: string } | null
}

/** The per-route lists the dispatcher holds outside the pipeline (§9.4). */
export interface RouteHooksOutside {
  readonly onError: readonly Function[]
  readonly onResponse: readonly Function[]
  readonly onSend: readonly Function[]
  readonly onTimeout: readonly Function[]
}

/**
 * One route's spec and outside hooks, every member wrapped to record into
 * `trace`. The result is handed to `simplePipeline` by the application; it is
 * never compiled into the route table.
 */
export function instrumentRoute(
  record: RouteRecord,
  spec: PipelineSpec,
  outside: RouteHooksOutside,
  trace: Trace,
): { readonly spec: PipelineSpec; readonly outside: RouteHooksOutside } {
  const middleware = record.middleware.filter((m) => m.omitted !== true)
  const steps = spec.steps.map((step, i) => {
    const ref = middleware[i] as MiddlewareRef | undefined
    return { ...step, fn: observeStep(step.kind, step.fn, trace, scopeLabel(ref?.scope ?? ''), step.name) }
  })

  const hooks: Record<string, readonly Function[]> = {}
  const plan = spec.hooks
  for (const phase of PIPELINE_PHASES) {
    const fns = plan?.[phase] ?? []
    const records = record.hooks.get(phase as RequestPhase) ?? []
    hooks[phase] = fns.map((fn, i) => observeHook(phase, fn, trace, records[i]))
  }

  const validators: ValidatorStep[] = spec.validators.map((step) => ({
    source: step.source,
    run: observeValidator(step, trace),
  }))

  const instrumented: PipelineSpec = {
    ...spec,
    steps,
    hooks: hooks as HookPlan,
    validators,
    handler: observeHandler(spec.handler, trace, functionName(record.handler)),
    intake: spec.intake === null ? null : observeIntake(spec.intake, trace),
    serialize: spec.serialize === null ? null : observeSerializers(spec.serialize, trace),
    negotiate: spec.negotiate === undefined || spec.negotiate === null ? spec.negotiate : observeNegotiation(spec.negotiate, trace),
    validateResponse: spec.validateResponse === undefined || spec.validateResponse === null
      ? spec.validateResponse
      : observeResponseValidation(spec.validateResponse as Function, trace),
  }

  const outsideHooks = (phase: 'onError' | 'onResponse' | 'onSend' | 'onTimeout', fns: readonly Function[]): readonly Function[] => {
    const records = record.hooks.get(phase) ?? []
    return fns.map((fn, i) => observeHook(phase, fn, trace, records[i]))
  }

  return {
    spec: instrumented,
    outside: {
      onError: outsideHooks('onError', outside.onError),
      onResponse: outsideHooks('onResponse', outside.onResponse),
      onSend: outsideHooks('onSend', outside.onSend),
      onTimeout: outsideHooks('onTimeout', outside.onTimeout),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Observers
// ─────────────────────────────────────────────────────────────────────────────

const GUARDS: ReadonlySet<string> = new Set(['onRequest', 'onRoute', 'preValidation', 'postValidation', 'preHandler', 'postHandler', 'onError', 'onTimeout'])

/** Time one call, settled or not, and let `after` read what it returned. */
function timed(event: TraceEvent, call: () => unknown, after: (value: unknown) => void): unknown {
  const started = performance.now()
  let result: unknown
  try {
    result = call()
  } catch (error) {
    event.ms = performance.now() - started
    event.outcome = 'threw'
    event.notes.push(errorNote(error))
    throw error
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(
      (value) => { event.ms = performance.now() - started; after(value); return value },
      (error: unknown) => {
        event.ms = performance.now() - started
        event.outcome = 'threw'
        event.notes.push(errorNote(error))
        throw error
      },
    )
  }
  event.ms = performance.now() - started
  after(result)
  return result
}

function observeHook(phase: PipelinePhase | 'onError' | 'onResponse' | 'onSend' | 'onTimeout', fn: Function, trace: Trace, record: HookRecord | undefined): Function {
  const name = record?.name ?? (fn.name === '' ? 'anonymous' : fn.name)
  const scope = scopeLabel(record?.scope ?? '')
  return function observedHook(ctx: Observed, ...rest: unknown[]): unknown {
    const event = trace.begin(phase, scope, name)
    const before = snapshot(ctx)
    return timed(event, () => fn(ctx, ...rest), (value) => {
      event.outcome = GUARDS.has(phase)
        ? (value === undefined ? 'continue' : 'short-circuit')
        : (value === undefined ? 'continue' : 'transform')
      describeEffects(event, before, ctx)
    })
  }
}

function observeStep(kind: 'phase' | 'around' | 'after', fn: Function, trace: Trace, scope: string, name: string): Function {
  if (kind === 'around') {
    return function observedAround(ctx: Observed, next: () => Promise<Reply>): unknown {
      const event = trace.begin('around', scope, name)
      let inner = 0
      const started = performance.now()
      const wrapped = (): Promise<Reply> => {
        const entered = performance.now()
        return next().finally(() => { inner += performance.now() - entered })
      }
      return Promise.resolve(fn(ctx, wrapped)).then(
        (reply) => {
          event.ms = performance.now() - started - inner
          event.outcome = 'continue'
          return reply
        },
        (error: unknown) => {
          event.ms = performance.now() - started - inner
          event.outcome = 'threw'
          event.notes.push(errorNote(error))
          throw error
        },
      )
    }
  }
  if (kind === 'after') {
    return function observedAfter(ctx: Observed, reply: Reply): unknown {
      const event = trace.begin('after', scope, name)
      const before = snapshot(ctx)
      return timed(event, () => fn(ctx, reply), (value) => {
        event.outcome = value === reply ? 'continue' : 'transform'
        describeEffects(event, before, ctx)
      })
    }
  }
  return function observedPhase(ctx: Observed): unknown {
    const event = trace.begin('phase', scope, name)
    const before = snapshot(ctx)
    return timed(event, () => fn(ctx), (value) => {
      event.outcome = value === undefined ? 'continue' : 'short-circuit'
      describeEffects(event, before, ctx)
    })
  }
}

function observeIntake(intake: (ctx: unknown) => Promise<void>, trace: Trace): (ctx: unknown) => Promise<void> {
  return function observedIntake(ctx: unknown): Promise<void> {
    const raw = (ctx as { raw: { header(name: string): string | undefined; body: { length: number | undefined } } }).raw
    const event = trace.begin('intake', '', 'read the body')
    const media = raw.header('content-type')
    const length = raw.body.length
    event.notes.push(`${media === undefined ? 'no content-type' : media.split(';')[0]?.trim() ?? media}${length === undefined ? '' : ` · ${length} B`}`)
    return timed(event, () => intake(ctx), () => { event.outcome = 'ok' }) as Promise<void>
  }
}

function observeValidator(step: ValidatorStep, trace: Trace): ValidatorStep['run'] {
  const kind = step.source === 'check' ? 'check' : 'validate'
  return function observedValidator(ctx: unknown): void | Promise<void> {
    const event = trace.begin(kind, '', step.source)
    const refused = (error: unknown): void => {
      if ((error as { code?: unknown })?.code !== 'ZEN_VALIDATION') return
      event.outcome = 'refused'
      event.notes = [`${(error as { issues?: unknown[] }).issues?.length ?? 0} issue(s)`]
    }
    try {
      const out = timed(event, () => step.run(ctx), () => { event.outcome = 'ok' })
      if (isThenable(out)) return Promise.resolve(out).then(() => undefined, (error: unknown) => { refused(error); throw error })
      return undefined
    } catch (error) {
      refused(error)
      throw error
    }
  }
}

function observeHandler(handler: Function, trace: Trace, name: string): Function {
  return function observedHandler(ctx: unknown, ...deps: unknown[]): unknown {
    const event = trace.begin('handler', '', name)
    let asynchronous = false
    const result = timed(event, () => {
      const out = handler(ctx, ...deps)
      asynchronous = isThenable(out)
      return out
    }, () => { event.outcome = 'ran' })
    if (asynchronous) event.notes.push('async')
    return result
  }
}

function observeNegotiation(negotiate: (ctx: unknown) => void, trace: Trace): (ctx: unknown) => void {
  return function observedNegotiation(ctx: unknown): void {
    const event = trace.begin('negotiate', '', 'Accept')
    timed(event, () => negotiate(ctx), () => {
      event.outcome = 'ok'
      const chosen = (ctx as Observed).$negotiated
      if (chosen !== null) event.notes.push(`chose ${chosen.media}`)
    })
  }
}

function observeResponseValidation(validate: Function, trace: Trace): (ctx: never, reply: Reply) => void | Promise<void> {
  return function observedResponseValidation(ctx: never, reply: Reply): void | Promise<void> {
    const event = trace.begin('validate', '', 'response')
    return timed(event, () => validate(ctx, reply), () => { event.outcome = 'ok' }) as void | Promise<void>
  }
}

/**
 * The serializer, timed, and compared with what it was given: the keys of the
 * value that the serializer did not write are the fields the response schema
 * kept off the wire — the field a developer *almost* leaked (§13.3).
 */
function observeSerializers(table: SerializerTable, trace: Trace): SerializerTable {
  const out = new Map<number, (value: unknown) => string>()
  for (const [status, serialize] of table) {
    out.set(status, function observedSerializer(value: unknown): string {
      const event = trace.begin('serialize', '', String(status))
      const json = timed(event, () => serialize(value), () => { event.outcome = 'ok' }) as string
      event.notes.push(`${new TextEncoder().encode(json).byteLength} B`)
      const dropped: string[] = []
      try {
        droppedKeys(value, JSON.parse(json), '', dropped)
      } catch {
        // A serializer that wrote something other than JSON has nothing to compare.
      }
      if (dropped.length > 0) event.notes.push(`dropped undeclared: ${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? `, and ${dropped.length - 8} more` : ''}`)
      return json
    })
  }
  return out
}

function droppedKeys(given: unknown, written: unknown, prefix: string, out: string[]): void {
  if (typeof given !== 'object' || given === null || typeof written !== 'object' || written === null) return
  if (Array.isArray(given)) {
    if (!Array.isArray(written)) return
    // The first element stands for the rest: one dropped field reported once, not once per row.
    if (given.length > 0 && written.length > 0) droppedKeys(given[0], written[0], `${prefix}[]`, out)
    return
  }
  for (const key of Object.keys(given)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (!(key in (written as Record<string, unknown>))) {
      if ((given as Record<string, unknown>)[key] !== undefined) out.push(path)
      continue
    }
    droppedKeys((given as Record<string, unknown>)[key], (written as Record<string, unknown>)[key], path, out)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Effects
// ─────────────────────────────────────────────────────────────────────────────

interface Before {
  readonly staged: number
  readonly slots: readonly unknown[]
}

function snapshot(ctx: Observed): Before {
  return { staged: ctx.$resHeaders?.length ?? 0, slots: [...ctx.$s] }
}

/** What a step changed: the headers it staged and the slots it set. */
function describeEffects(event: TraceEvent, before: Before, ctx: Observed): void {
  const staged = ctx.$resHeaders ?? []
  for (let i = before.staged; i < staged.length; i++) {
    const entry = staged[i]
    if (entry === undefined) continue
    event.notes.push(`staged ${entry[0]}: ${String(entry[1])}`)
  }
  const slots = declaredSlots()
  for (let i = 0; i < ctx.$s.length; i++) {
    if (ctx.$s[i] === before.slots[i]) continue
    const slot = slots.find((s) => s.index === i)
    event.notes.push(`set ${slot?.name ?? `cell ${i}`}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestExplanation {
  readonly method: string
  readonly url: string
  /** The matched route, or `null` for a request that matched none. */
  readonly route: RouteRecord | null
  readonly status: number
  readonly totalMs: number
  /** The route's budget and what was left of it, when it has one (§4.4). */
  readonly deadline: { readonly budgetMs: number; readonly leftMs: number } | null
  readonly events: readonly TraceEvent[]
  /** The plan with its actuals, rendered — what `zen explain --analyze` will print. */
  readonly text: string
}

export function renderExplanation(explanation: Omit<RequestExplanation, 'text'>, wire: { headers: number; bytes: number | null }): string {
  const lines: string[] = []
  const route = explanation.route
  const head = route === null
    ? `${explanation.method} ${explanation.url} → no route`
    : `${route.method} ${route.path}${route.name === undefined ? '' : ` → ${route.name}`}`
  const budget = explanation.deadline === null
    ? ''
    : `   budget ${explanation.deadline.budgetMs} ms · ${explanation.deadline.leftMs.toFixed(1)} left`
  lines.push(`${head.padEnd(56)}${ms(explanation.totalMs).padStart(10)}${budget}`)

  const kindWidth = Math.max(10, ...explanation.events.map((e) => e.kind.length)) + 2
  const scopeWidth = Math.max(9, ...explanation.events.map((e) => e.scope.length)) + 2
  const nameWidth = Math.max(16, ...explanation.events.map((e) => e.name.length)) + 2
  for (const event of explanation.events) {
    const said = [event.outcome, ...event.notes].join(' · ')
    lines.push(`  ${event.kind.padEnd(kindWidth)}${event.scope.padEnd(scopeWidth)}${event.name.padEnd(nameWidth)}${ms(event.ms).padStart(10)}   ${said}`)
  }
  lines.push(`  ${'wire'.padEnd(kindWidth)}${''.padEnd(scopeWidth)}${String(explanation.status).padEnd(nameWidth)}${''.padStart(10)}   ${wire.headers} headers${wire.bytes === null ? '' : ` · ${wire.bytes} B`}`)
  return lines.join('\n')
}

function ms(value: number): string {
  return `${value.toFixed(3)} ms`
}

function scopeLabel(scope: string): string {
  if (scope === '') return ''
  if (scope === 'root' || scope === 'app') return '[global]'
  if (scope === 'route') return '[route]'
  return `[${scope}]`
}

function functionName(fn: unknown): string {
  const name = (fn as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : 'anonymous'
}

function errorNote(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'thrown'
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/** What `explainRequest` needs from an application — `ZenApp` is one. */
export interface Explainable {
  explainTrace(method: string, url: string, init?: {
    readonly headers?: Record<string, string> | undefined
    readonly body?: unknown
  }): Promise<{
    readonly route: RouteRecord | null
    readonly response: { readonly status: number; readonly reply: Reply }
    readonly events: readonly TraceEvent[]
    readonly totalMs: number
  }>
}

/**
 * `explainRequest(app, method, url, init)` — EXPLAIN ANALYZE for HTTP (§8.5).
 *
 * Runs one request through an instrumented copy of the route's pipeline and
 * returns the plan with its actuals:
 *
 * ```
 * POST /orders → orders.create                                  2.410 ms   budget 2000 ms · 1997.6 left
 *   onRequest   [global]   rateLimit               0.004 ms   continue
 *   phase       [/api]     authenticate            0.310 ms   continue · set auth.user
 *   intake                 read the body           0.021 ms   ok · application/json · 412 B
 *   validate               body                    0.882 ms   ok
 *   handler                createOrder             1.104 ms   ran · async
 *   serialize              201                     0.031 ms   ok · 312 B · dropped undeclared: costCents
 *   wire                   201                                 9 headers · 312 B
 * ```
 *
 * It is a real request: the handler runs, with its side effects. Point it at
 * a test application or an idempotent route. The production pipeline is
 * neither replaced nor slowed — the instrumented one is built for this one
 * request and lives in a copy of the route table nothing else reads.
 */
export async function explainRequest(
  app: Explainable,
  method: string,
  url: string,
  init: { readonly headers?: Record<string, string> | undefined; readonly body?: unknown } = {},
): Promise<RequestExplanation> {
  const { route, response, events, totalMs } = await app.explainTrace(method, url, init)
  const timeout = route?.timeout ?? null
  const deadline = timeout === null ? null : { budgetMs: timeout.ms, leftMs: Math.max(0, timeout.ms - totalMs) }
  const reply = response.reply
  const headers = [...reply.headers.entries()].length
  const body = reply.body
  // Egress sends a short body as the string it was serialized to (§13.7).
  const bytes = body.kind === 'bytes' ? body.value.byteLength : body.kind === 'text' ? utf8Length(body.value) : null
  const explanation = { method: method.toUpperCase(), url, route, status: response.status, totalMs, deadline, events }
  return { ...explanation, text: renderExplanation(explanation, { headers, bytes }) }
}
