# Task 09: Idempotent activity reconciliation atomicity and missing docs

**Severity:** medium

## Idempotent-activity reconciliation: started→completed transition is a separate write after activity executes

- **Severity:** medium (durability)
- **Files:** `src/core/engine/operations-activity.ts`, `src/core/engine/activity-reconciliation.ts`

**Evidence:** operations-activity.ts:367-396: executeActivity runs (line 367), finalizeActivityResult (line 375, no storage write), then writeActivityReconciliationTransition (line 391) — a separate storage write. Crash between activity execution and this write leaves the reconciliation record at status:'started'. On recovery with no verify function, resolveStartedActivityReconciliationRecord throws ActivityReconciliationIndeterminateError permanently blocking the workflow. The feature encourages using idempotencyKey without requiring verify, but the failure mode is permanent.

**Required fix:** Fold writeActivityReconciliationTransition operations into the same batch() call as the checkpoint write in commitCheckpoint (via appendAttributeOperations-style threading), making the reconciliation transition atomic with the checkpoint commit. Add a clear warning in the activities guide that idempotencyKey without a verify function results in a permanently-blocked workflow on crash in the activity execution window.
