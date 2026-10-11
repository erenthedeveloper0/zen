/**
 * Every boot diagnostic carries `file:line` — held across every suite.
 *
 * `npm test` loads this before each test file (`--import`). It wraps
 * `ZenApp.prototype.ready`, so whichever suite boots an application — core's,
 * a package's, an example's, through `ready()`, `inject()` or `listen()` — a
 * `BootError` with a diagnostic that names no line fails that test, with the
 * code and message that has none, instead of waiting for a reader to notice a
 * line that points nowhere (rfcs/0001 §5.1). A gate `0.2.0-alpha` set
 * itself, held by the build rather than by a sentence.
 */
import { BootError, ZenApp } from '@erenthedeveloper0/zen-core'

const ready = ZenApp.prototype.ready

ZenApp.prototype.ready = function placedReady(this: ZenApp<never>) {
  return ready.call(this).catch((error: unknown) => {
    assertPlaced(error)
    throw error
  }) as ReturnType<typeof ready>
}

function assertPlaced(error: unknown): void {
  if (!(error instanceof BootError)) return
  for (const diagnostic of error.diagnostics) {
    const origins = diagnostic.origins ?? []
    const usable = origins.length > 0 &&
      origins.every((o) => typeof o.file === 'string' && o.file !== '' && Number.isInteger(o.line) && o.line > 0)
    if (!usable) {
      throw new Error(
        `Boot diagnostic ${diagnostic.code} has no file:line — "${diagnostic.message}". ` +
          'Every boot diagnostic names the line that registered what it is about (§5.1).',
      )
    }
  }
}
