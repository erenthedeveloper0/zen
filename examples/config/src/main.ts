import { makeApp } from './app.ts'

/**
 * `npm run example:config`
 *
 * The walkthrough, and the order is the demonstration:
 *
 *   curl -s localhost:3000/orders | jq '.pageSize'       # 25, from PAGE_SIZE
 *   curl -s localhost:3000/_typed | jq
 *   curl -s localhost:3000/_config                       # the provenance table
 *
 *   # Layer 6 beats layer 5. Restart with the variable set and watch the
 *   # `←` column change from `.env.example:19` to `process.env`.
 *   PAGE_SIZE=5 npm run example:config
 *   curl -s localhost:3000/orders | jq '.pageSize'
 *
 *   # A bound stated once, in the schema, enforced at boot rather than on the
 *   # first slow report. The `expected:` line is read back off the schema, so
 *   # nobody wrote that sentence.
 *   PAGE_SIZE=1000 npm run example:config
 *
 *   # The one that matters. A missing secret is a boot failure in the first few
 *   # milliseconds — not an `undefined` that becomes an empty signing key.
 *   DATABASE_URL= npm run example:config
 *
 *   # …and a secret that is *present but wrong* is reported without printing
 *   # it, which is the difference between a boot log you can paste into a
 *   # ticket and one you cannot.
 *   SMTP_URL=1 npm run example:config
 *
 * The last two are the whole argument for §16 over a plain module. The other
 * five examples in this repo each read `process.env` by hand and each carry a
 * comment saying so; every one of them fails those two cases silently.
 */
const app = makeApp()

// No arguments. The address comes from `config.server`, which is what makes
// this the correct call in a deployed service rather than a placeholder
// somebody has to remember to replace (§16.1 layer 1, §21.2).
const handle = await app.listen()

console.log(`
  listening on ${handle.url}      (${app.config.mode})

    GET  /orders?page=1&pageSize=10
    GET  /_typed                       ctx.config, typed, no cast
    GET  /_config                      the provenance table (debug only)

  page size   ${app.config.pagination.pageSize}   ceiling ${app.config.pagination.maxPageSize}
  database    ${JSON.stringify(app.config.database)}
  mailer      ${JSON.stringify((app.config as { mailer?: unknown }).mailer)}

  The database line is the point: it went through JSON.stringify and the URL is
  not in it. Reading app.config.database.url by name still gives the real value
  — the object redacts when it is *serialised*, not when it is read (§16.2).
`)

// SIGTERM and SIGINT drain and exit on their own: `zen()` installs the process
// lifecycle when the app starts listening (§4.5, §12.8).
