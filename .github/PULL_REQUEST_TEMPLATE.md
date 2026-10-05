## What and why

<!-- The problem this solves. Link the issue or the ARCHITECTURE.md section. -->

## How it was verified

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `node scripts/smoke.ts` (anything touching the adapter, egress or shutdown)
- [ ] `npm run openapi:check`
- [ ] `npm run controls` — and a new control in `scripts/negative-controls.ts` if this adds a behaviour
- [ ] `node scripts/claims.ts` — and a `<!-- claim: id -->` with its probe for anything this makes "built"
- [ ] `node scripts/check-strata.ts` and `node scripts/check-regex.ts`
- [ ] the relevant `benchmarks/*` run, if this touches a hot path or a zero-cost gate
- [ ] `packages/core/test/fixtures/generated.snap` regenerated and its diff read, if this changes emitted code

## Conventions (CONTRIBUTING.md)

- [ ] A compiled subsystem changed → its interpreted twin changed the same way
- [ ] A context field added → added to both twins, in the same position (I2)
- [ ] `@erenthedeveloper0/zen-core` still imports nothing from `node:` and has no runtime dependency
- [ ] Docs updated: ARCHITECTURE.md where the design changed, the README's Status section where status changed, CHANGELOG.md — and a gap that closed moved from `<!-- gap -->` to `<!-- claim -->`

Commits are signed off (`git commit -s`) — see CONTRIBUTING.md.
