# Duplicate Audit Classification

Use `jscpd` cleanup audits to find hand-authored code that should share one owner. Do not treat every duplicate group as cleanup debt.

Generated artifacts are allowed to repeat schema fragments when the generator output is the artifact under test. Examples include `src/cli/generated/operation-catalog.snapshot.json` and generated declaration snapshots. Verify those duplicates by checking the generator and drift checks, not by editing the generated file by hand.

Reference documentation can mirror public declarations when the documentation is the consumer-facing source for generated API references. If the mirror changes, run the documentation verification command that owns the generated reference output.

Type-entrypoint `.test-d.ts` suites may duplicate small assertion blocks when each file proves a different import surface. For example, `src/core/type-ergonomics.test-d.ts` validates source-entry typing while `tests/package-root-type-ergonomics.test-d.ts` validates the published [`@lostgradient/weft`](https://www.npmjs.com/package/@lostgradient/weft) package-root surface. Shared helpers can hide the import boundary those tests exist to prove. Duplicated event-listener assertions are acceptable when both suites keep their imports independent.

Markdown guide scans can report token-level matches between unrelated examples whose prose and code are page-specific. As of the latest transport documentation audit, the matches between `documentation/contributing/development-setup.md`, `documentation/getting-started/transports.md`, `documentation/guides/server.md`, and `documentation/guides/service-worker.md` are intentional page-local guidance: development setup lists repository gates, transports demonstrates a full [JSON-RPC](https://www.jsonrpc.org/specification) client, the server guide documents server-owned mounting, and the Service Worker guide owns browser activity/manual-worker setup. Re-run that classification when one of those pages changes; do not collapse those pages unless the repeated content is a literal reusable snippet with one canonical owner.

Script cross-checks may intentionally duplicate a small parsing helper when the duplicate is the independence mechanism. `scripts/audit-jsdoc-manifest.ts` duplicates `pickTypesField()` and `distToSource()` from `scripts/lib/jsdoc-manifest.ts` so the audit can catch mistakes in the manifest builder. Do not extract that pair unless the audit gets another independent implementation to compare against.

Hand-authored production TypeScript under `src/` remains actionable by default. Do not add a broad `src/` or `documentation/` ignore to make a cleanup audit quiet.
