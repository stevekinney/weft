# Task 05: Retry worker task-result storage writes; dead-letter on exhaustion instead of silent re-dispatch

**Severity:** high

## Finding: Storage-write failure after in-memory task completion leaves orphaned inflight record causing double-execution

- **Severity:** high (durability)
- **Files (audit snapshot):** `src/server/runtime/websocket-worker.ts`, `src/server/runtime/task-reconciliation.ts`

### Evidence

websocket-worker.ts:242-265: completeTask() and deadlineTracker.remove() execute synchronously before async transitionInflightToResolved. The entire async block is fire-and-forget via void (async () => {...})().catch(). On storage write failure, the inflight record survives; next reconciliation scan finds a stale record past its deadline and calls reassignOrExpireTask, dispatching the activity a second time. The heartbeat path at line 293 already uses withRetry for the same kind of storage write — the omission here is inconsistent.

### Required fix

Retry transitionInflightToResolved with the existing withRetry helper (already used at line 293 for heartbeat storage updates). If all retries are exhausted, emit an application-level event or mark the operationId in a dead-letter set so the reconciliation scan does not re-dispatch it.

## Required behavior (no weaker alternative)

The committee resolved the either/or in the original fix: BOTH halves are required. (1) `transitionInflightToResolved` is retried with the existing `withRetry` helper. (2) If retries are exhausted, the operationId is recorded in a durable dead-letter set; the reconciliation scan checks that set and does NOT re-dispatch dead-lettered tasks; an operator-visible diagnostic (engine event and bounded diagnostics endpoint, consistent with existing low-cardinality metric policy) reports the entry. The operator surface is fixed by this plan (do not redesign it): dead-letter entries are listed via a bounded REST diagnostics endpoint (consistent with the existing bounded high-cardinality diagnostic endpoints) and cleared per-entry via an explicit REST action on the same diagnostics surface; an engine event fires when an entry is created. Both are documented in the operator-facing server documentation.

## Acceptance criteria (all required — completion is binary)

- [ ] transitionInflightToResolved retries via withRetry with the same policy as the heartbeat path.
- [ ] On retry exhaustion the operationId lands in a durable dead-letter record; the reconciliation scan skips dead-lettered records and never silently re-dispatches them.
- [ ] Operators list dead-letter entries via a bounded REST diagnostics endpoint and clear individual entries via an explicit REST action on that surface; an engine event fires when an entry is created; both are documented.
- [ ] Regression tests cover: transient storage failure (retry succeeds, no double-dispatch) and permanent failure (dead-letter, reconciliation skip, event emitted).

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
