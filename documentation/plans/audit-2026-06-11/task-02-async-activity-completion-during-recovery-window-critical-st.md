# Task 02: Async activity completion during recovery window (critical strand)

**Severity:** critical

## Async activity token consumed before generator adopted — workflow permanently stranded

- **Severity:** critical (durability)
- **Files:** `src/core/engine/async-activity-completion.ts`, `src/core/engine/index.ts`, `src/core/inline-execution-strategy.ts`

**Evidence:** async-activity-completion.ts:260-267 JSDoc explicitly documents the race: token is durably deleted (line 285) before the generator is adopted, feedOperationResult silently no-ops (inline-execution-strategy.ts:215: if (!generator) return). The comment at line 267 defers this as 'a proper deferred-resume queue is a follow-up concern' — no fix is in place. Workflow is permanently stranded in 'running' state. activities.md has no warning to await recoverAll() before calling completeAsyncActivity after restart.

**Required fix:** Implement a deferred-resume queue: buffer completeAsyncActivity/failAsyncActivity outcomes (keyed by workflowId) when the generator is not yet adopted, and drain the buffer after recoverAll() fully adopts all generators. As immediate mitigation, add a warning to activities.md and the completeAsyncActivity JSDoc directing callers to await engine.recoverAll() settlement before resuming async activities.
