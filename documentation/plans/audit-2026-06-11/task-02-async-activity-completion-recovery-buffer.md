# Task 02: Buffer async activity completions that arrive before generator adoption

**Severity:** critical

## Finding: Async activity token consumed before generator adopted — workflow permanently stranded

- **Severity:** critical (durability)
- **Files (audit snapshot):** `src/core/engine/async-activity-completion.ts`, `src/core/engine/index.ts`, `src/core/inline-execution-strategy.ts`

### Evidence

async-activity-completion.ts:260-267 JSDoc explicitly documents the race: token is durably deleted (line 285) before the generator is adopted, feedOperationResult silently no-ops (inline-execution-strategy.ts:215: if (!generator) return). The comment at line 267 defers this as 'a proper deferred-resume queue is a follow-up concern' — no fix is in place. Workflow is permanently stranded in 'running' state. activities.md has no warning to await recoverAll() before calling completeAsyncActivity after restart.

### Required fix

Implement a deferred-resume queue: buffer completeAsyncActivity/failAsyncActivity outcomes (keyed by workflowId) when the generator is not yet adopted, and drain the buffer after recoverAll() fully adopts all generators. As immediate mitigation, add a warning to activities.md and the completeAsyncActivity JSDoc directing callers to await engine.recoverAll() settlement before resuming async activities.

## Scope clarification

Both halves below are REQUIRED — this task is not complete with only the documentation half. The deferred-resume queue is the fix; the documentation is the contract statement, not a substitute.

## Acceptance criteria (all required — completion is binary)

- [ ] completeAsyncActivity and failAsyncActivity outcomes that arrive after the token is spent but before the generator is adopted are buffered (keyed by workflowId) and drained after recovery adopts the generator — for both completion and failure paths.
- [ ] Regression tests: a completion delivered before adoption resumes the workflow after adoption (no stranding); same for a failure outcome.
- [ ] documentation/guides/activities.md and the completeAsyncActivity/failAsyncActivity JSDoc document the recovery-window ordering contract.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
