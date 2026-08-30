# Task 01: Atomic checkpoint-commit side effects: signal consume, race/all finalize, and idempotent-activity reconciliation in one batch

**Severity:** critical

## Finding: Signal consumed before checkpoint commit — crash loses signal permanently

- **Severity:** critical (durability)
- **Files (audit snapshot):** `src/core/engine/operations-coordination.ts`, `src/core/engine/signals.ts`, `src/core/engine/checkpoint-io.ts`

### Evidence

operations-coordination.ts:97-99 calls consumeSignal (storage.delete on sig: key) then completeOperation, which drives the generator forward to emit a checkpoint. Crash between storage.delete and persistCheckpoint permanently loses the signal. The comment at line 185 explicitly names this as 'the same adjacency the top-level signal path already has' — the top-level path is the unfixed baseline. Also confirmed as the same root cause in timers-retries-signals auditor finding.

### Required fix

Fold the sig: key delete into the checkpoint batch atomically: accumulate the signal delete as a BatchOperation[] inside processWaitSignalOperation and pass it into createCheckpointCommit's commit.operations, so the write and delete land in one storageConditionalBatch call. Apply the same fix to the bufferedPayload branch at lines 113-119.

## Finding: ctx.race/ctx.all signal consume and checkpoint not atomic — tracked as #479, top-level path untracked

- **Severity:** high (durability)
- **Files (audit snapshot):** `src/core/engine/operations-coordination.ts`, `src/core/engine/deferred-consume-envelope.ts`, `src/core/engine/coordination-branch-executors.ts`

### Evidence

operations-coordination.ts:187-190: finalizeFulfilledSlots calls consumeSignal (destructive durable delete) then writePartialEntry only writes to in-memory accumulatedResults. Comment at line 185 acknowledges 'same adjacency'. GitHub issue #479 tracks race/all; top-level processWaitSignalOperation has the identical gap with no tracking issue.

### Required fix

Same pattern as the top-level fix: accumulate consumeSignal delete operations into a BatchOperation[] that is passed through finalizeFulfilledSlots into the checkpoint commit batch. This closes both #479 and the top-level gap in a single consistent mechanism.

## Finding: Idempotent-activity reconciliation: started→completed transition is a separate write after activity executes

- **Severity:** medium (durability)
- **Files (audit snapshot):** `src/core/engine/operations-activity.ts`, `src/core/engine/activity-reconciliation.ts`

### Evidence

operations-activity.ts:367-396: executeActivity runs (line 367), finalizeActivityResult (line 375, no storage write), then writeActivityReconciliationTransition (line 391) — a separate storage write. Crash between activity execution and this write leaves the reconciliation record at status:'started'. On recovery with no verify function, resolveStartedActivityReconciliationRecord throws ActivityReconciliationIndeterminateError permanently blocking the workflow. The feature encourages using idempotencyKey without requiring verify, but the failure mode is permanent.

### Required fix

Fold writeActivityReconciliationTransition operations into the same batch() call as the checkpoint write in commitCheckpoint (via appendAttributeOperations-style threading), making the reconciliation transition atomic with the checkpoint commit. Add a clear warning in the activities guide that idempotencyKey without a verify function results in a permanently-blocked workflow on crash in the activity execution window.

## Coordination note (why these are one task)

All three findings are the same root cause: a destructive or state-transition storage write happens adjacent to — not inside — the checkpoint commit batch. The required shared abstraction is ONE mechanism: extend the checkpoint commit inputs (the path that builds the `storageConditionalBatch` operations in `createCheckpointCommit` / checkpoint-io) to accept additional `BatchOperation[]` side effects that land atomically with the checkpoint write. Implement that mechanism once, then route all three call sites through it. Do not invent per-site mechanisms. This task closes GitHub issue #479 — reference it in the PR body with `Closes #479`.

## Acceptance criteria (all required — completion is binary)

- [ ] A single extension point on the checkpoint commit path accepts additional atomic storage operations; signal-consume deletes, race/all finalize consumes (including the buffered-payload branch), and idempotent-activity started→completed transitions all compose through it into one `storageConditionalBatch` call.
- [ ] A crash injected between the old consume site and the checkpoint commit (simulated in tests by failing the batch) leaves the signal/reconciliation record intact and redeliverable — regression tests cover the top-level signal path, a race branch, an all branch, and the reconciliation transition.
- [ ] PR body references `Closes #479`.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
