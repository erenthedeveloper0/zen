# Contributing to Zen

Thank you for considering it. Zen is built on an unusual premise — *a web
framework is a compiler with an HTTP server attached* — and the conventions below
exist because that premise is easy to erode one reasonable-looking change at a
time. Please read this page, then [ARCHITECTURE.md](./ARCHITECTURE.md) §1.1 (the
nine invariants) before opening a non-trivial pull request.

## Getting set up

Requirements: **Node.js ≥ 22.18** and npm. The repository runs straight from
TypeScript through Node's type stripping — no bundler, no ts-node — and 22.18 is
the first 22.x where that needs no flag. (The *published* packages are compiled
and need Node ≥ 22.6.) `.nvmrc` pins the 22 line; CI runs 22, 24 and 26.

```bash
git clone https://github.com/erenthedeveloper0/zen.git
cd zen
npm ci
npm run typecheck      # builds all six packages, then type-checks the ten examples
npm test               # ~1,110 tests: unit, integration, differential and property suites
```

**Tests import each package's built `dist/`, not its source.** After editing
anything under `packages/*/src`, run `npx tsc -b` (or `npm run typecheck`) before
running tests, or you will be testing the previous build.

## Before you open a pull request

```bash
npm run typecheck
npm test
node scripts/smoke.ts          # real sockets: what inject() cannot see
npm run openapi:check          # the API compatibility gate
npm run controls               # negative controls: are the tests load-bearing?
```

If you touched a subsystem with a benchmark in `benchmarks/`, run it — several
are CI gates that assert on generated code rather than on timings.

## The conventions

These are not style preferences. A pull request that breaks one needs an
argument in its description, not a workaround.

1. **Every compiled subsystem has an interpreted twin**, and a differential test
   asserts they agree. A fuzzer also asserts its own coverage: two
   implementations that agree because neither ran anything prove nothing.
2. **Build the reader, not just the writer.** A new feature is not done until
   something *consumes* it — an example, `explainRoute`, the OpenAPI generator.
   Readers are how this codebase has found most of its defects.
3. **A test that passes against the bug is not a test.** Break the thing your
   test covers and watch it fail. When you add a feature, add a control to
   `scripts/negative-controls.ts`: a name, a file, a string to replace, a suite,
   and the assertion that ought to notice.
4. **Performance claims need numbers**, and losses are published as prominently
   as wins. Prefer a structural assertion ("the generated source is byte
   identical") to a timing ("the difference was inside the noise").
5. **`@erenthedeveloper0/zen-core` imports nothing from `node:` and has zero runtime
   dependencies.** Both are CI checks. Platform code belongs in an adapter.
6. **Boot diagnostics are aggregated, and each has a fix.** A `Diagnostic` has a
   `hint` (rendered `fix:`) and, where it helps, a `consequence` (`also:`).
7. **Monomorphism (I2).** The generated context class and `PlainContext` declare
   the same fields in the same order. Add a field to one, add it to the other in
   the same position.

## Code style

- TypeScript with `strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess` and `erasableSyntaxOnly`: no enums, no parameter
  properties, no namespaces.
- Match the comment density of the file you are in. Comments explain *why* —
  usually by naming the failure the code prevents — not what the next line does.
- Do not write source files through shell heredocs or `echo -e`; escapes inside
  string literals get mangled.

## Commits and sign-off

Zen uses the [Developer Certificate of Origin](https://developercertificate.org/)
rather than a CLA (RFC 0001 §25.2). Sign off every commit:

```bash
git commit -s -m "router: refuse <int> values past 2^53"
```

The sign-off certifies that you wrote the change, or otherwise have the right to
submit it under the project's MIT licence.

## Reporting bugs and proposing changes

- **Bugs:** open an issue with a minimal reproduction — the route definitions and
  the request that misbehaves.
- **Security issues:** never in a public issue. See [SECURITY.md](./SECURITY.md).
- **Design changes:** a change to anything ARCHITECTURE.md specifies starts as an
  issue describing the problem, and the alternatives that lose. §27 shows the
  format.

When your first pull request is merged, add yourself to
[CONTRIBUTORS.md](./CONTRIBUTORS.md).

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
