# Security policy

Zen is a web framework: its bugs become other people's vulnerabilities. Reports
are welcome and are handled as the first priority of the project.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:

<https://github.com/erenthedeveloper0/zen/security/advisories/new>

Include what you can of the following — a partial report is still useful:

- the package and version (`npm ls @erenthedeveloper0/zen-core`),
- the Node.js version and operating system,
- a minimal reproduction: the route definitions and the request that triggers it,
- what you expected, what happened, and the impact you believe it has.

## What happens next

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 3 working days |
| First assessment (confirmed or not, severity) | within 10 working days |
| Fix released | as fast as severity requires; coordinated with you |
| Public advisory | when the fix is available, or at 90 days — whichever comes first |

We follow **coordinated disclosure with a 90-day window** (RFC 0001 §19.8). Every
fix is published with a GitHub Security Advisory and a CVE where one applies,
and you are credited unless you ask not to be.

## Supported versions

Zen is **pre-alpha**. Until `1.0`, only the most recent published prerelease
receives security fixes; upgrade to it before reporting if you can.

| Version | Supported |
| --- | --- |
| latest `0.x` prerelease | ✅ |
| anything older | ❌ |

From `1.0`, the policy in RFC 0001 §25.2 applies: security backports to the last
two minor versions.

## Scope

The threat model is RFC 0001 [§19.1](./ARCHITECTURE.md#191-threat-model). In
short, in scope: malformed or malicious HTTP input, resource exhaustion through
request shape, response injection, over-serialization (a field reaching the
wire that its schema does not declare), path traversal in file responses, and
insecure defaults. Out of scope: the correctness of an application's own
authorization logic, SQL injection in an application's queries, and TLS
termination.

## Supply chain

`@erenthedeveloper0/zen-core` has **zero runtime dependencies**, enforced in
CI. Releases are published from GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
`npm audit signatures` can verify which workflow, commit and repository built
the tarball you installed. The one exception is the first, `0.1.0-alpha.1`:
npm can attach a trusted publisher only to a package that already exists, so it
is published by the maintainer from the tagged commit and carries no
provenance.
