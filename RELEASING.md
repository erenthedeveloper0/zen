# Releasing

How Zen's six packages get to npm. The background — why prereleases, why exact
internal pins, why trusted publishing — is in [npm-registry.md](./npm-registry.md).

The packages, in the order they must be published:

| Order | Package | Depends on |
| --- | --- | --- |
| 1 | `@visionpilot/zen-core` | — |
| 2 | `@visionpilot/zen-router` | core |
| 3 | `@visionpilot/zen-adapter-node` | core |
| 4 | `@visionpilot/zen-openapi` | core |
| 5 | `@visionpilot/zen-middleware` | core |
| 6 | `@visionpilot/zen` | core, router, adapter-node, middleware |

They always publish together, at one version, and pin each other exactly.

## One-time setup

1. **npm.** Sign in as the account that will own the packages and turn on 2FA:
   `npm profile enable-2fa auth-and-writes`. The `visionpilot` organisation
   exists on the registry as of 2026-09-26 — confirm it is yours with
   `npm org ls visionpilot`, and create it (`npm org create visionpilot`, free
   for public packages) only if it is not there. Nothing may be published under
   `@visionpilot` by anyone else.
2. **GitHub.** Push this repository to `github.com/VisionPilot/Zen.js` —
   `git remote set-url origin https://github.com/VisionPilot/Zen.js.git` first,
   if the clone still points at the original author's fork. The `repository`
   field of every package points there, npm provenance verifies it, and the
   README's images, every problem document's `type` and the badges resolve
   against it.
3. **A protected environment.** Repository → Settings → Environments → new
   environment `npm-publish`, with yourself (or the release team) as a
   required reviewer. Every publish then waits for a human.
4. **The first publish.** npm can only attach a trusted publisher to a package
   that already exists, so the first release is bootstrapped with a token:
   - create a *granular* access token on npmjs.com with read-and-write access
     to the `@visionpilot` organisation, expiring in a day or two;
   - add it to the `npm-publish` environment as the secret `NPM_TOKEN`;
   - release `0.1.0-alpha.1` as described below.
5. **Trusted publishing.** For each of the six packages: npmjs.com → the
   package → Settings → Trusted Publisher → GitHub Actions, with organisation
   `VisionPilot`, repository `Zen.js`, workflow `release.yml`, environment
   `npm-publish`. Then **delete the `NPM_TOKEN` secret** and revoke the token.
   From here on no long-lived credential exists anywhere.

## Every release

```bash
node scripts/version.ts 0.1.0-alpha.2     # every package and every internal pin
npm install                               # refresh package-lock.json
# write the CHANGELOG.md entry
npm run verify                            # typecheck, tests, smoke, API gate (Node 22 and the latest LTS)
npm run controls                          # are the tests load-bearing?
npm run check:pack                        # what ships, installed and run from the tarballs
git commit -am "release: v0.1.0-alpha.2"
git tag v0.1.0-alpha.2
git push --follow-tags
```

Pushing the tag starts `.github/workflows/release.yml`. It runs every CI gate,
refuses a tag that disagrees with the package versions, checks the tarballs
again, and then waits for approval on the `npm-publish` environment. Once
approved it publishes the six packages in order, with provenance, on the
dist-tag the version implies — `alpha`, `beta`, `next` for `-rc`, `latest` only
for a plain version — and creates a GitHub release. A package already
published at that version is skipped, so a run that failed half way can simply
be re-run.

## After a release

```bash
npm view @visionpilot/zen dist-tags        # { alpha: '0.1.0-alpha.2' } — and no `latest` before 1.0
npm install @visionpilot/zen@alpha         # what a user types
npm audit signatures                       # provenance verifies
```

A bad version is deprecated, never unpublished:

```bash
for p in zen-core zen-router zen-adapter-node zen-openapi zen-middleware zen; do
  npm deprecate "@visionpilot/$p@0.1.0-alpha.2" "Broken — use 0.1.0-alpha.3"
done
```

## Rehearsing

The first time, or after changing the release workflow, rehearse against a
local registry — it exercises the publish order and the internal pins, which
nothing else does:

```bash
npx verdaccio &                            # http://localhost:4873
npm adduser --registry http://localhost:4873
for p in core router adapter-node openapi middleware zen; do
  npm publish --workspace "packages/$p" --registry http://localhost:4873 --tag alpha
done
mkdir /tmp/zen-rehearsal && cd /tmp/zen-rehearsal && npm init -y
npm install --registry http://localhost:4873 @visionpilot/zen@alpha
```
