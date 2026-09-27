# Releasing

How Zen's six packages get to npm. The background — why prereleases, why exact
internal pins, why trusted publishing — is in [npm-registry.md](./npm-registry.md).

The packages, in the order they must be published:

| Order | Package | Depends on |
| --- | --- | --- |
| 1 | `@erenthedeveloper0/zen-core` | — |
| 2 | `@erenthedeveloper0/zen-router` | core |
| 3 | `@erenthedeveloper0/zen-adapter-node` | core |
| 4 | `@erenthedeveloper0/zen-openapi` | core |
| 5 | `@erenthedeveloper0/zen-middleware` | core |
| 6 | `@erenthedeveloper0/zen` | core, router, adapter-node, middleware |

They always publish together, at one version, and pin each other exactly.

## Where things live

| | |
| --- | --- |
| npm scope | `@erenthedeveloper0` — an npm **organisation**, owned by the npm user `erenthedeveloper` (`npm org ls erenthedeveloper0`) |
| Repository | [`github.com/erenthedeveloper0/zen`](https://github.com/erenthedeveloper0/zen) — every manifest's `repository`, every problem document's `type`, the badges and the npm pages' images resolve against it |
| Copyright | VisionPilot (`LICENSE`); Eren Sümer is credited as creator in [CONTRIBUTORS.md](./CONTRIBUTORS.md) and every package's `contributors` |

The organisation and the user have different names — the user is
`erenthedeveloper`, the organisation `erenthedeveloper0`, matching the GitHub
account. `npm whoami` prints the user; the packages belong to the organisation.

## The first publish, from the command line

`0.1.0-alpha.1` is published by the organisation's owner from a clean checkout
of the `v0.1.0-alpha.1` tag, once every gate below has passed locally and CI is
green on the pushed commit:

```bash
npm run clean && npm run typecheck        # dist/ built from the tagged tree, nothing stale
for p in core router adapter-node openapi middleware zen; do
  npm publish --workspace "packages/$p" --tag alpha --access public
done
```

**npm refuses a publish from an account without two-factor authentication**
(`E403 … Two-factor authentication or granular access token with bypass 2fa
enabled is required to publish packages`), so 2FA comes first — npmjs.com →
Account → Two-Factor Authentication — and each publish then asks for it, in the
browser or as a code from an authenticator app. Run the loop in an interactive
terminal for that reason.

A local publish has no **provenance** — only a CI run can attest to where a
tarball was built — so the first version carries none. Every later release goes
through the workflow below and does.

## One-time setup, before `0.1.0-alpha.2`

npm can only attach a trusted publisher to a package that already exists, which
is why the first release is published by hand. Once all six exist:

1. **A protected environment.** Repository → Settings → Environments → new
   environment `npm-publish`, with yourself (or the release team) as a
   required reviewer. Every publish then waits for a human.
2. **Trusted publishing.** For each of the six packages: npmjs.com → the
   package → Settings → Trusted Publisher → GitHub Actions, with
   organisation or user `erenthedeveloper0`, repository `zen`, workflow
   `release.yml`, environment `npm-publish`. Then, on the same page, set
   publishing access to *require two-factor authentication and disallow
   tokens*. From here on no long-lived publish credential exists anywhere, and
   the workflow needs no `NPM_TOKEN` secret.

## Every release

```bash
node scripts/version.ts 0.1.0-alpha.2     # every package and every internal pin
npm install                               # refresh package-lock.json
# write the CHANGELOG.md entry: "## [0.1.0-alpha.2] — <date>"
npm run verify                            # typecheck, tests, smoke, API gate (Node 22 and the latest LTS)
npm run controls                          # are the tests load-bearing?
npm run check:pack                        # what ships, installed and run from the tarballs
git commit -am "release: v0.1.0-alpha.2"
git tag -a v0.1.0-alpha.2 -m v0.1.0-alpha.2     # annotated: --follow-tags pushes no other kind
git push --follow-tags
```

Pushing the tag starts `.github/workflows/release.yml`. It runs every CI gate,
refuses a tag that disagrees with the package versions or has no dated
CHANGELOG entry, checks the tarballs again, and then waits for approval on the
`npm-publish` environment. Once approved it publishes the six packages in order,
with provenance, on the dist-tag the version implies — `alpha`, `beta`, `next`
for `-rc`, `latest` only for a plain version — and creates a GitHub release
whose notes are that CHANGELOG entry, under the install line. A package
already published at that version is skipped, so a run that failed half way can
simply be re-run.

## After a release

```bash
npm view @erenthedeveloper0/zen dist-tags   # alpha → the new version
npm install @erenthedeveloper0/zen@alpha    # what a user types
npm audit signatures                        # provenance verifies (from 0.1.0-alpha.2 on)
```

A bad version is deprecated, never unpublished:

```bash
for p in zen-core zen-router zen-adapter-node zen-openapi zen-middleware zen; do
  npm deprecate "@erenthedeveloper0/$p@0.1.0-alpha.2" "Broken — use 0.1.0-alpha.3"
done
```

## Rehearsing

The first time, or after changing the release workflow, rehearse against a
local registry — it exercises the publish order and the internal pins, which
nothing else does:

```bash
npx verdaccio &                                 # http://localhost:4873
npm adduser --registry http://localhost:4873
for p in core router adapter-node openapi middleware zen; do
  npm publish --workspace "packages/$p" --registry http://localhost:4873 --tag alpha
done
mkdir /tmp/zen-rehearsal && cd /tmp/zen-rehearsal && npm init -y
npm install --registry http://localhost:4873 @erenthedeveloper0/zen@alpha
```
