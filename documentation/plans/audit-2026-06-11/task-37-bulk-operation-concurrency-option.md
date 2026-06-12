# Task 37: Opt-in concurrency for bulk operations

**Severity:** low

## Finding: Bulk operations are sequential (no parallelism), causing O(N) latency for large batches

- **Severity:** low (performance)
- **Files (audit snapshot):** `src/core/engine/bulk-operations.ts`, `src/core/engine/listing.ts`

### Evidence

src/core/engine/bulk-operations.ts runBulkCancellation (lines 87-101) iterates with a for-of and awaits each engine.cancel sequentially. signalAll (lines 186-199) does the same. Even the delete path (lines 221-243) loops sequentially over batches. The BULK_OPERATION_BATCH_SIZE from src/core/engine/listing.ts caps iteration size but does not add concurrency. For 10,000 workflows, cancellation is 10,000 sequential awaits.

### Required fix

Parallelize the inner loop using Promise.allSettled with a configurable concurrency limit (e.g., 50 concurrent operations). Replace the sequential for-of with a pool: chunk workflowIds into groups of concurrencyLimit, then await Promise.allSettled on each chunk. This maintains correctness (each operation is independent) while cutting wall-clock time by ~50x for large batches. Errors per-workflow are still collected. Add a bulkConcurrency option to BulkOperationOptions.

### Verifier note

The finding is real but the severity should be low, not medium. For the default BunSQLiteStorage backend (bun-sql.ts), get/put/batch are synchronous SQLite prepared-statement calls wrapped in async functions. Promise.allSettled parallelism would not reduce wall-clock latency here because operations serialize on Bun's single JS thread with no actual I/O concurrency. The performance gap only matters when using a genuinely async remote storage adapter (Neon, HTTP, LMDB, IndexedDB). If the project adds Neon or HTTP storage as primary backends, revisiting bulk operation concurrency becomes worthwhile. A configurable bulkConcurrency option defaulting to 1 (keeping current behavior as default) would be a reasonable future enhancement, but it would not provide meaningful benefit to typical single-process SQLite deployments.

## Acceptance criteria (all required — completion is binary)

- [ ] BulkOperationOptions accepts bulkConcurrency (default 1 preserving current sequential behavior); >1 processes chunks with bounded parallelism, per-workflow errors still collected identically.
- [ ] Tests cover default unchanged-behavior and a concurrent run with mixed success/failure.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
