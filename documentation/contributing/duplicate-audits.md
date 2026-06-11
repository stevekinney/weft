# Duplicate Audit Classification

Use `jscpd` cleanup audits to find hand-authored code that should share one owner. Do not treat every duplicate group as cleanup debt.

Generated artifacts are allowed to repeat schema fragments when the generator output is the artifact under test. Examples include `src/cli/generated/operation-catalog.snapshot.json` and generated declaration snapshots. Verify those duplicates by checking the generator and drift checks, not by editing the generated file by hand.

Reference documentation can mirror public declarations when the documentation is the consumer-facing source for generated API references. If the mirror changes, run the documentation verification command that owns the generated reference output.

Script cross-checks may intentionally duplicate a small parsing helper when the duplicate is the independence mechanism. `scripts/audit-jsdoc-manifest.ts` duplicates `pickTypesField()` and `distToSource()` from `scripts/lib/jsdoc-manifest.ts` so the audit can catch mistakes in the manifest builder. Do not extract that pair unless the audit gets another independent denominator.

Hand-authored production TypeScript under `src/` remains actionable by default. Do not add a broad `src/` or `documentation/` ignore to make a cleanup audit quiet.
