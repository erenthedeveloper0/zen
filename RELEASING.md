# Releasing

How Zen's six packages get to npm. Why they get there this way — prereleases,
exact internal pins, trusted publishing — is [at the end](#why-it-works-this-way).

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
| Author | Eren Sümer — the copyright holder in `LICENSE` and every package's `author` |

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
tarball was built — so the first version carries none, and neither does a later
one published this way because trusted publishing was not yet configured
(below). A release the workflow publishes does.

## One-time setup, before `0.1.0-alpha.2`

npm can only attach a trusted publisher to a package that already exists, which
is why the first release is published by hand. Once all six exist:

1. **A protected environment.** Repository → Settings → Environments → new
   environment `npm-publish`, with yourself (or the release team) as a
   required reviewer. Every publish then waits for a human.
2. **Trusted publishing.** For each of the six packages, one trusted
   publisher: GitHub Actions, repository `erenthedeveloper0/zen`, workflow
   `release.yml`, environment `npm-publish` — and **allowed to publish**. npm
   now gives every trusted publisher explicit permissions (`npm publish`,
   `npm stage publish`, or both), and one without *publish* cannot run this
   workflow's `npm publish`. From a terminal, with npm ≥ 11.15 — one 2FA
   prompt, whose "skip for five minutes" option covers the other five:

   ```bash
   for p in zen-core zen-router zen-adapter-node zen-openapi zen-middleware zen; do
     npm trust github "@erenthedeveloper0/$p" --file release.yml \
       --repository erenthedeveloper0/zen --environment npm-publish --allow-publish --yes
     sleep 2
   done
   npm trust list @erenthedeveloper0/zen-core    # what npm holds, for any of them
   ```

   Or on npmjs.com: the package → Settings → Trusted Publisher → GitHub
   Actions, the same four values, with *npm publish* allowed. A package holds
   one trusted publisher; to change it, `npm trust revoke --id <id>` first.
   Then, on the same settings page, set publishing access to *require
   two-factor authentication and disallow tokens*. From here on no long-lived
   publish credential exists anywhere, and the workflow reads none.

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

**Until trusted publishing is configured** on all six packages, the workflow
has no credential to publish with, and its publish step fails after approval —
now with an annotation on the run that names the package and this section.
That is what `0.1.0-alpha.2`'s first run did, on 2026-09-28: approved, then the
first `npm publish` failed, so nothing was published; the tag was moved to the
release commit that did go out. Configure the trusted publishers, then re-run
the failed job. A re-run uses the workflow file of the tagged commit, not of
`main`.

If trusted publishing cannot be made to work, publish by hand instead — the
loop in [The first publish](#the-first-publish-from-the-command-line), from a
worktree of the tag — wait until `npm view @erenthedeveloper0/zen@<version>`
answers, then approve the waiting run or re-run it: it finds every package
already published, skips them, and creates the GitHub release (or leaves the
one that exists). A version published that way carries no provenance.

## After a release

```bash
npm view @erenthedeveloper0/zen dist-tags   # alpha → the new version
npm install @erenthedeveloper0/zen@alpha    # what a user types
npm audit signatures                        # provenance verifies, if the workflow published it
```

**`latest` follows the first publish, then stays put.** npm points `latest` at a
package's first version whatever `--tag` says, because every package must have
one — so `0.1.0-alpha.1` went out as both `alpha` and `latest`, and
`npm install @erenthedeveloper0/zen` with no tag installs it. Later prereleases
move `alpha` only, which leaves the bare name on `0.1.0-alpha.1` until something
moves it. To have it follow the alphas, run
`npm dist-tag add @erenthedeveloper0/<package>@<version> latest` for all six
after a release; to keep the bare name on a version you chose, do nothing.

The registry's package document can also lag a first publish by several
minutes — the tarballs download, while `npm view` still answers 404 from a
cached miss. Wait for it before pushing the tag: the workflow's "already
published?" check reads that document.

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

## Why it works this way

- **Prerelease versions.** `0.1.0-alpha.N` is a semver prerelease, so a range
  such as `^0.1.0` never matches it and nobody receives one by accident. The
  workflow derives the dist-tag from the version and refuses a prerelease it
  does not recognise rather than defaulting it to `latest`.
- **Lockstep versions, exact internal pins.** The six packages always release
  together and depend on each other by exact version, so "which core does this
  adapter want" has one answer. `npm version --workspaces` bumps the versions
  and leaves every internal pin behind; `scripts/version.ts` bumps both, and
  `scripts/check-release.ts` refuses a tag that disagrees with either.
- **Dependency order.** `npm publish --workspaces` publishes in no particular
  order, and a meta-package published before a dependency it pins installs
  broken. So the loop is explicit, and the workflow waits for each version to
  be visible on the registry before publishing the next.
- **What ships is checked, not assumed.** `scripts/check-pack.ts` runs in CI:
  no build cache (a `.tsbuildinfo` holds absolute paths from the build
  machine), every source map ships with the source it points at, `README.md`
  and `LICENSE` are present — then all six tarballs are installed outside the
  workspace, serve a request, and a consumer is type-checked on TypeScript 5.0,
  the oldest the manifests accept.
- **Trusted publishing and a human gate.** GitHub Actions authenticates to npm
  with OIDC, so no long-lived publish token exists to be stolen, and npm
  records provenance — which workflow, repository and commit built each
  tarball — for `npm audit signatures` to verify. The `npm-publish` environment
  requires a reviewer: the one control that stops a compromised dependency in
  the build from shipping a release on its own.
- **A publish job that trusts as little as it can.** The actions it runs are
  pinned to commits, not tags, because a tag can be moved to other code; npm is
  an exact version rather than a range, for the same reason; and it restores
  nothing from the Actions cache, which other runs write.
- **`npm publish`, not `npm stage publish`.** npm can also *stage* a CI
  publish and hold each package until a maintainer approves it with 2FA on
  npmjs.com — proof of presence per package. The `npm-publish` environment
  already puts a person between a tag and the registry, so the trusted
  publishers allow `npm publish`. Moving the approval to npm is
  `--allow-stage-publish` on the trusted publishers and `npm stage publish` in
  the workflow's loop.
- **Nothing is unpublished.** npm allows it only within 72 hours, and only if
  nothing depends on the version. A bad version is deprecated instead (above).
