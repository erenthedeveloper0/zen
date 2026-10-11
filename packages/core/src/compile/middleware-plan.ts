import type { MiddlewareRef } from '../contracts/route.ts'
import type { MiddlewareCondition } from '../contracts/middleware.ts'
import { ZenError } from '../errors/zen-error.ts'
import { Codes } from '../errors/codes.ts'
import { classifySync, markSync, type PipelineStep } from './pipeline-compiler.ts'

/**
 * The steps a route's middleware compiles to, with §8.7 applied.
 *
 * A step whose boot-time `when.env` answered `false` is not here at all — the
 * pipeline holds no line for it, which is what makes the condition free. A
 * step with a request-time `when.request` is its function behind the
 * predicate: a guarded call, and the only cost the condition has. Everything
 * else is the function as registered, so a route that uses no condition
 * compiles byte for byte as it did before conditions existed.
 *
 * Shared by the pipeline compiler and `explainRoute`'s sync-path line, so the
 * line cannot describe a pipeline other than the one that runs (§8.4).
 */
export function pipelineSteps(middleware: readonly MiddlewareRef[]): PipelineStep[] {
  const out: PipelineStep[] = []
  for (const ref of middleware) {
    if (ref.omitted === true) continue
    const guard = ref.when?.request
    out.push({
      kind: ref.kind,
      name: ref.name,
      fn: guard === undefined ? ref.fn : guarded(ref.kind, ref.fn, guard as (ctx: unknown) => unknown),
    })
  }
  return out
}

/**
 * The step behind its predicate. Only `true` runs it: a truthy string or a
 * promise is not an answer, and reading either as "yes" is how a step its
 * author meant to skip would run on every request.
 *
 * A step marked synchronous stays synchronous behind its guard, because a
 * guard answers synchronously or it is not one. Anything else is a plain
 * function, which the compiler treats as a speculation point (§8.4): it
 * returns whatever the step returned, or nothing when the guard said no.
 */
function guarded(kind: MiddlewareRef['kind'], fn: Function, guard: (ctx: unknown) => unknown): Function {
  let wrapped: Function
  if (kind === 'around') {
    const step = fn as (ctx: unknown, next: () => unknown) => unknown
    wrapped = function guardedAround(ctx: unknown, next: () => unknown): unknown {
      return guard(ctx) === true ? step(ctx, next) : next()
    }
  } else if (kind === 'after') {
    const step = fn as (ctx: unknown, reply: unknown) => unknown
    wrapped = function guardedAfter(ctx: unknown, reply: unknown): unknown {
      return guard(ctx) === true ? step(ctx, reply) : reply
    }
  } else {
    const step = fn as (ctx: unknown) => unknown
    wrapped = function guardedPhase(ctx: unknown): unknown {
      return guard(ctx) === true ? step(ctx) : undefined
    }
  }
  return classifySync(fn) === 'sync' ? markSync(wrapped) : wrapped
}

/**
 * A registration's `when`, checked where it is written — §8.7.
 *
 * Two explicit forms, `{ env }` and `{ request }`, and nothing inferred from a
 * function's parameter: the roadmap's decision, because a condition that costs
 * nothing and one that costs a call per request should not be told apart by
 * what a parameter happens to be named. A bare function is refused with the
 * spelling that was meant.
 */
export function conditionOf(when: unknown, where: string): MiddlewareCondition<never> | undefined {
  if (when === undefined) return undefined
  if (typeof when === 'function') {
    throw new ZenError(
      Codes.CONFIG_INVALID,
      `The \`when\` of ${where} is a function. Say which kind of condition it is: ` +
        '`when: { env: (env) => … }` is decided once, at boot, and `when: { request: (ctx) => … }` on every request.',
      { status: 500, expose: false },
    )
  }
  if (typeof when !== 'object' || when === null) {
    throw new ZenError(
      Codes.CONFIG_INVALID,
      `The \`when\` of ${where} is ${when === null ? 'null' : `a ${typeof when}`}; it takes { env } and/or { request }.`,
      { status: 500, expose: false },
    )
  }
  const { env, request } = when as { env?: unknown; request?: unknown }
  for (const [key, value] of [['env', env], ['request', request]] as const) {
    if (value !== undefined && typeof value !== 'function') {
      throw new ZenError(
        Codes.CONFIG_INVALID,
        `\`when.${key}\` of ${where} must be a function returning a boolean; got ${typeof value}.`,
        { status: 500, expose: false },
      )
    }
  }
  if (env === undefined && request === undefined) return undefined
  return {
    ...(env === undefined ? {} : { env: env as (env: Readonly<Record<string, unknown>>) => boolean }),
    ...(request === undefined ? {} : { request: request as (ctx: never) => boolean }),
  }
}
