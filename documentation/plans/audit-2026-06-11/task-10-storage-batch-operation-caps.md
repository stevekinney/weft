# Task 10: Operation-count caps on storage batch and conditionalBatch

**Severity:** medium

## Finding: Storage batch and conditional-batch have no operation-count cap

- **Severity:** medium (security)
- **Files (audit snapshot):** `src/server/operations/storage.ts`

### Evidence

storageBatchInput at line 72 and storageConditionalBatchInput at lines 74-77 have no .max() on their arrays. An authenticated storage:admin caller can submit tens of thousands of batch operations in one request. Storage batch endpoints use HTTP-only REST bindings (jsonRpcHttp: false) so the 1 MB JSON-RPC body cap does not apply.

### Required fix

Add .max(MAX_BATCH_OPERATIONS) to both operations and conditions arrays. Also add .max(MAX_SCAN_LIMIT) (10,000) to the limit field in storageScanInput. Document the caps in configuration.md and surface in the OpenRPC schema.

## Naming requirement

Use one explicit named constant, `MAX_BATCH_OPERATIONS = 10_000`, applied consistently in both the API-side Zod `.max()` validations and the central dispatch-layer enforcement before any adapter work, raising a typed error naming the cap and the offending size. The cap is a guardrail against pathological internal callers and hostile API-side inputs that fan out into batches — it must be far above any legitimate engine batch (checkpoint commits batch tens of operations, purge batches hundreds).

## Acceptance criteria (all required — completion is binary)

- [ ] One named, documented constant (`MAX_BATCH_OPERATIONS = 10_000`) caps operation counts for batch and conditionalBatch at both the API schema layer and the shared dispatch layer; exceeding it raises a typed error that names the cap.
- [ ] Regression test proves the cap fires and that the largest legitimate engine batches (purge + create folds) stay well under it.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
