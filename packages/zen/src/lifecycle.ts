import type { HostControl, HostLifecycle } from '@erenthedeveloper0/zen-core'

export interface ProcessLifecycleOptions {
  /**
   * Signals that start a graceful shutdown. `SIGTERM` is what Kubernetes, ECS,
   * systemd and `docker stop` send; `SIGINT` is Ctrl+C.
   */
  readonly signals?: readonly string[] | undefined
  /**
   * Exit once shutdown finishes — 0 after a signal, 1 after a crash. On by
   * default, because a process whose server has closed and whose pools are
   * disposed has nothing left to do, and one that lingers holds its container.
   */
  readonly exit?: boolean | undefined
  /**
   * §12.8: on an uncaught exception or unhandled rejection, log it at `fatal`
   * and shut down with exit code 1. On by default.
   */
  readonly crashes?: boolean | undefined
  /** Called when a shutdown signal arrives, before anything closes. */
  readonly onSignal?: ((signal: string) => void) | undefined
}

type Signal = Parameters<NodeJS.Process['on']>[0]

/**
 * The Node process's side of the lifecycle — rfcs/0001 §4.5, §12.8.
 *
 * `zen()` installs this by default when the app starts listening. Before it
 * existed, §4.5 described what happens "on SIGTERM" and nothing listened for
 * one: Node's default action ended the process on the spot, so readiness never
 * went red, the drain window never opened, and `onClose` never ran — on every
 * rolling deploy, which is the exact situation §4.5 exists for. Every example
 * in this repository wrote the same four lines to fill the gap, and two did
 * not.
 *
 *   - **First signal:** run `app.close()` — readiness drains, the socket
 *     closes, in-flight requests finish, `onClose` runs, services dispose — then
 *     exit 0.
 *   - **Second signal while that is in progress:** exit now. Ctrl+C twice
 *     means "stop waiting", and a shutdown stuck behind a hung connection
 *     should not be un-killable from a terminal.
 *   - **An uncaught exception or unhandled rejection:** log it at `fatal`, then
 *     the same graceful shutdown with exit 1. Zen does not keep serving from a
 *     process whose state is unknown (§12.8) — that instinct is how corrupted
 *     data gets written — but it does let requests already in flight finish.
 */
export function processLifecycle(options: ProcessLifecycleOptions = {}): HostLifecycle {
  const signals = options.signals ?? ['SIGTERM', 'SIGINT']
  const exit = options.exit ?? true
  const crashes = options.crashes ?? true

  return {
    install(control: HostControl): () => void {
      const proc = (globalThis as { process?: NodeJS.Process }).process
      if (proc === undefined || typeof proc.on !== 'function') return () => {}

      let stopping = false

      const shutdown = (reason: string, code: number): void => {
        if (stopping) {
          control.log.warn({ reason }, 'second shutdown request while shutting down; exiting now')
          proc.exit(code === 0 ? 130 : code)
          return
        }
        stopping = true
        control.close(reason).then(
          () => { if (exit) proc.exit(code) },
          (error: unknown) => {
            control.log.fatal({ err: error }, 'shutdown failed')
            proc.exit(1)
          },
        )
      }

      const onSignal = (signal: string): void => {
        options.onSignal?.(signal)
        shutdown(signal, 0)
      }
      const onException = (error: unknown): void => {
        control.log.fatal({ err: error }, 'uncaught exception; shutting down')
        shutdown('uncaughtException', 1)
      }
      const onRejection = (reason: unknown): void => {
        control.log.fatal({ err: reason }, 'unhandled promise rejection; shutting down')
        shutdown('unhandledRejection', 1)
      }

      for (const signal of signals) proc.on(signal as Signal, onSignal)
      if (crashes) {
        proc.on('uncaughtException', onException)
        proc.on('unhandledRejection', onRejection)
      }

      return () => {
        for (const signal of signals) proc.off(signal as Signal, onSignal)
        if (crashes) {
          proc.off('uncaughtException', onException)
          proc.off('unhandledRejection', onRejection)
        }
      }
    },
  }
}
