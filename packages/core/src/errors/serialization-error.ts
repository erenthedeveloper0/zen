import { FrameworkError } from './zen-error.ts'
import { Codes } from './codes.ts'

/**
 * A response did not satisfy its declared schema — rfcs/0001 §13.3.4.
 *
 * Always `expose: false`. The client asked for a resource and got a broken
 * server; the *shape* of the server's internal contract violation is not
 * theirs to see, and a leaked path like `$.user.passwordHash` would be a
 * particularly unfortunate thing to leak from the subsystem whose entire
 * purpose is to not leak fields.
 *
 * Raised only when `serialization.strict` is on (the default in dev). In
 * production the same condition degrades: a missing property is omitted, a
 * mistyped one is coerced, and neither takes the response down — because a
 * 500 for a nullable field the schema forgot is a worse outcome than a
 * slightly-off body.
 */
export class SerializationError extends FrameworkError {
  /** Where in the response value the contract broke, e.g. `$.roles[]`. */
  readonly path: string

  constructor(message: string, path: string) {
    super(Codes.SERIALIZATION, `${message} (at ${path})`, { meta: { path } })
    this.path = path
  }
}
