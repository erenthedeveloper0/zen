## What and why

<!-- The problem this solves. Link the issue or the ARCHITECTURE.md section. -->

## How it was verified

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `node scripts/smoke.ts` (anything touching the adapter, egress or shutdown)
- [ ] `npm run openapi:check`
- [ ] `npm run controls` — and a new control in `scripts/negative-controls.ts` if this adds a behaviour
- [ ] the relevant `benchmarks/*` run, if this touches a hot path or a zero-cost gate

## Conventions (CONTRIBUTING.md)

- [ ] A compiled subsystem changed → its interpreted twin changed the same way
- [ ] A context field added → added to both twins, in the same position (I2)
- [ ] `@visionpilot/zen-core` still imports nothing from `node:` and has no runtime dependency
- [ ] Docs updated: ARCHITECTURE.md where the design changed, TASKS.md where status changed, CHANGELOG.md

Commits are signed off (`git commit -s`) — see CONTRIBUTING.md.
