import type { ConfigFrom, EnvFrom } from 'zen'
import type config from './zen.config.ts'

/**
 * The application's configuration type, derived rather than restated — the
 * same projection `examples/config` explains at length.
 *
 * A handler registered on the app object needs neither of these: `ctx.config`
 * is typed there. They exist for the feature files, which are written against
 * a `Collection` handed to `app.collection()` before the app object exists.
 */
export type AppConfig = ConfigFrom<typeof config>

export type AppEnv = EnvFrom<typeof config>
