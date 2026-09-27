import { definePlugin } from '@visionpilot/zen'
import type { Plugin } from '@visionpilot/zen'

/**
 * A plugin that declares what it needs from configuration — rfcs/0001 §16.1
 * layer 2, §16.2, §10.
 *
 * Two declarations, both on the **manifest** rather than made inside `setup`,
 * and the reason is the same one that puts `dependsOn` on the manifest: §16.2
 * requires the environment to be validated *before anything else boots*, so a
 * declaration only reachable by executing the plugin cannot participate in a
 * check that runs before any plugin has executed. Data before behaviour.
 *
 *   - `defaults` land at layer 2, under `mailer`, so `config.mailer.from` has a
 *     value in an application that never mentions mail — and the application's
 *     own `mailer: { from: … }` beats it field by field, leaving the rest.
 *   - `env` populates §16.2's `used by:` line. Unset `SMTP_URL` and the boot
 *     error says which plugin will not work, which is the difference between a
 *     message a developer can act on and one they have to grep for.
 *
 * The fifth lesson of §23.4 applies unchanged: a plugin that owns a resource
 * owns the statement about that resource, and the composition root owns only
 * whether to depend on it. `app.ts` writes one line — `.use(mailerPlugin)` —
 * and never mentions SMTP.
 */
export const mailerPlugin: Plugin<void, {}> = definePlugin<void, {}>({
  name: 'mailer',
  version: '1.0.0',

  config: {
    namespace: 'mailer',
    defaults: {
      from: 'orders@example.com',
      retries: 3,
      // A default that the application below deliberately overrides, so the
      // per-field merge is visible in `npm run explain`.
      timeout: '10s',
    },
    env: ['SMTP_URL'],
  },

  setup(app) {
    // A plugin reads its own namespace through the same object everything else
    // does. Nothing here parses an environment variable: by the time `setup`
    // runs, `SMTP_URL` has been validated, and if it had not been this function
    // would not have been called.
    app.decorate('mailer', () => ({
      send(to: string, subject: string) {
        return { queued: true, to, subject }
      },
    }))
  },
})
