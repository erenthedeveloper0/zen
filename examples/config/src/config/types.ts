import type { ConfigFrom, EnvFrom } from '@erenthedeveloper0/zen'
import type config from './zen.config.ts'

/**
 * The application's configuration type, **derived rather than restated**.
 *
 * `defineConfig` resolves the thunks at the type level — `port: env => env.PORT`
 * becomes `port: number` — and `ConfigFrom` reads that result back off the
 * definition. So this is a projection of the declaration, not a second
 * description of it: add a namespace to `zen.config.ts` and it appears here;
 * delete one and every reader stops compiling.
 *
 * The alternative is an `interface AppConfig` written by hand next to the
 * `defineConfig` call, which is the shape most projects end up with and is the
 * same class of duplication §29.1 refuses for OpenAPI: two descriptions of one
 * thing, only one of which is enforced.
 *
 * A handler registered on the app object needs neither import — `ctx.config` is
 * typed there, because `zen({ config })` carries the resolved type on the app's
 * extension type (§10.4's channel, used by the composition root instead of by a
 * plugin). These aliases exist for the feature files, which are written against
 * a `Collection` that is handed to `app.collection()` before the app object
 * exists. `test/config.test.ts` asserts both halves.
 */
export type AppConfig = ConfigFrom<typeof config>

/** The validated environment, for the rare code that wants a raw variable. */
export type AppEnv = EnvFrom<typeof config>
