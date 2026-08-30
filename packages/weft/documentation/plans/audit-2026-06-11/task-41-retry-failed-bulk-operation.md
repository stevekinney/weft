# Task 41: retryFailedAll bulk operation (resolve the declared-but-unimplemented recover action)

**Severity:** low

## Finding: No dead-letter queue / explicit failed workflow recovery routing

- **Severity:** low (feature-gap)
- **Files (audit snapshot):** `src/core/types/bulk.ts`, `src/core/engine/bulk-operations.ts`, `src/core/types/state.ts`

### Evidence

src/core/types/state.ts shows WorkflowState with status 'failed'. src/core/engine/bulk-operations.ts has cancelAll, signalAll, deleteAll, tagAll but no recoverAll or route-to-dlq operation. src/core/types/bulk.ts line 25 shows BulkOperationAction includes 'recover' but src/core/engine/bulk-operations.ts does not export a recoverAll function — the 'recover' action appears in the type but the implementation is absent. There is no mechanism to automatically route failed workflows to a designated error-handling workflow, no DLQ sink, and no policy to retry failed workflows as a group.

### Required fix

Replace the unimplemented `'recover'` literal in the BulkOperationAction union with `'retry-failed'`, then implement it as a bulk retry-failed operation: `engine.retryFailedAll(filter, options)` re-starts failed workflows. The retry-source decision rule is fixed: if a checkpoint exists for the failed run, resume from that checkpoint; if no checkpoint exists, restart from scratch with the same persisted input. See the resolved naming section below for the full contract. No onFailure hook and no DLQ routing are part of this task.

### Verifier note

The finding is real but overstates severity and misdescribes what's missing. The actual gap is narrow: the `'recover'` literal in the exported `BulkOperationAction` union (src/core/types/bulk.ts:25) has no corresponding bulk engine operation — there is no `engine.recoverAll({ status: 'failed' })` equivalent. A DLQ sink / onFailure hook is also absent, but that is a separate product-design question, not a type-implementation mismatch.

The finding incorrectly implies `engine.recoverAll()` doesn't exist — it does, at src/core/engine/index.ts:1331, serving crash-recovery (resuming non-terminal workflows after restart), also exposed at `POST /v1/recover`. That is unrelated to the bulk-recover-failed-workflows gap.

A manual partial workaround exists today: callers can iterate failed workflow IDs from `engine.list({ status: 'failed' })` and call `engine.start(type, input, { id, onTerminalConflict: 'start-new' })` per workflow. This lacks atomicity, audit tracking, dry-run preview, and confirmation tokens that other bulk operations provide.

The severity should be low rather than medium. Temporal's "reset workflow" feature (reset to a prior event ID) is a more powerful primitive than simply re-running from scratch, but Weft's checkpoint model means "reset" semantics would be architecturally different anyway. The missing capability is real but the type stub is the most concrete evidence — there is no committed plan in documentation or roadmap to ship it.

## Resolved naming

The committee flagged the original fix's `engine.recoverAll(filter, options)` as a collision: `engine.recoverAll()` already exists for crash recovery (POST /v1/recover). REQUIRED: name the new bulk operation `engine.retryFailedAll(filter, options)`. Decision rule for the retry source: if a checkpoint exists for the failed run, resume from it; if no checkpoint exists, restart from scratch with the same persisted input. The operation carries the same dry-run preview + confirmation-token gate and durable audit events as the other bulk operations. Reconcile the `BulkOperationAction` type by renaming the `'recover'` literal to `'retry-failed'` — the literal was declared but never implemented, so no wire or audit record ever carried it and the rename is safe; note that reasoning in the PR body. The onFailure/DLQ-hook idea from the original finding is OUT of scope — note it in the PR body as deliberately not implemented.

## Acceptance criteria (all required — completion is binary)

- [ ] engine.retryFailedAll exists with dry-run preview, confirmation token, audit events, and REST/JSON-RPC parity consistent with the other bulk operations; the BulkOperationAction union no longer declares an unimplemented action.
- [ ] Tests cover checkpoint-resume retry, from-scratch retry, filter scoping, and the preview/confirm gate.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
