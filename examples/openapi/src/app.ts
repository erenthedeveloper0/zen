// Registering the Zod converter is a side effect, and it must happen before any
// schema is read. Importing it first, at the composition root, is the one place
// that ordering is obvious.
import './shared/zod.ts'

import { zen, type ZenApp, type ZenAppOptions } from '@visionpilot/zen'
import { openapiPlugin } from '@visionpilot/zen-openapi'

import { loadConfig, openapiOptions, type AppConfig } from './config/zen.config.ts'
import { ClockToken, fixedClock } from './shared/clock.ts'
import { requestId } from './plugins/request-id.ts'
import { UserRepoToken, inMemoryUserRepo, registerUsers } from './features/users/index.ts'
import { OrderRepoToken, inMemoryOrderRepo, registerOrders } from './features/orders/index.ts'

/**
 * The composition root — rfcs/0001 §23.4.
 *
 * Read top to bottom: config, plugins, services, features. Nothing is
 * discovered by scanning the filesystem, nothing is registered by importing a
 * module for its side effects (except the converter above, which says so), and
 * the whole application is available as data through `app.graph()` — which is
 * exactly what the OpenAPI plugin reads.
 */
export function build(
  options: ZenAppOptions = {},
  config: AppConfig = loadConfig(),
): ZenApp {
  const app = zen({ dev: config.dev, ...options })

  app.use(requestId, { header: 'x-request-id' })
  app.use(openapiPlugin, openapiOptions)

  app
    .provide(ClockToken, { factory: fixedClock(config.seededAt), lifetime: 'singleton' })
    .provide(UserRepoToken, {
      deps: [ClockToken] as never,
      factory: inMemoryUserRepo as never,
      lifetime: 'singleton',
      eager: true,
    })
    .provide(OrderRepoToken, {
      deps: [ClockToken, UserRepoToken] as never,
      factory: inMemoryOrderRepo as never,
      lifetime: 'singleton',
      eager: true,
    })

  registerUsers(app)
  registerOrders(app)

  return app
}
