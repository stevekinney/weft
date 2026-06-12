# Task 08: Write schedule state and next-tick timer in one atomic batch

**Severity:** high

## Finding: Schedule state and next-tick timer written in two separate batches — crash orphans the schedule

- **Severity:** high (durability)
- **Files (audit snapshot):** `src/core/engine/schedule-timer.ts`, `src/core/engine/storage-io.ts`

### Evidence

schedule-timer.ts:36-53: processScheduleTimerOccurrences writes each occurrence with includeTimer:false, then writeScheduleState with the timer is called after the loop at lines 46-50. Crash between last per-occurrence write and line 46-50 leaves schedule record active (stale nextFireAt) but with no schedule-due: key in storage. Scheduler only fires timers found in the schedule-due: prefix scan — no key, no firing. No compensating startup scan recovers orphaned active schedules.

### Required fix

Write the final nextFireAt timer atomically with the last occurrence's state update (always pass includeTimer:true on the final writeScheduleState call, or restructure to one call). Add a schedule-recovery scan on engine startup that detects active schedules with nextFireAt in the past and no matching schedule-due: key, and re-arms them.

## Acceptance criteria (all required — completion is binary)

- [ ] Schedule state and its next-occurrence timer land in one storage batch on create, fire/re-arm, and update paths.
- [ ] Regression test: failing the batch leaves the prior consistent pair intact; no path can persist one without the other.
- [ ] A startup scan detects active schedules with nextFireAt in the past and no matching schedule-due: key, re-arms them, and is pinned by a test that simulates the orphaned-schedule crash scenario.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
