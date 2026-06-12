# Task 30: Schedule missed-fire observability

**Severity:** medium

## Context

When the engine restarts after downtime, `planScheduleTimerWork` in `src/core/engine/schedule-timer.ts` silently discards any occurrences that fired more than 1 second in the past (`SCHEDULE_LATE_GRACE_MILLISECONDS = 1000`, line 7). There is no log, no event, no observable state change.

## Evidence

- `schedule-timer.ts:76`: `!state.backfill && now - state.nextFireAt > SCHEDULE_LATE_GRACE_MILLISECONDS` returns `{ occurrencesToProcess: [], skipMissedOccurrences: true }`.
- Subsequent code at line 97-98 advances `nextFireAt` past `now`.
- `lastFireAt` retains the last FIRED timestamp — after downtime it remains stale, making it impossible to distinguish planned downtime from a stuck or missed-fire schedule.
- The 1-second grace window and skip-all-missed semantics are not documented in `ScheduleOptions.backfill` JSDoc or in the schedule guide.

## Impact

A schedule for financial reports or SLA-gated operations will silently miss occurrences after any downtime exceeding 1 second. Operators have no way to know how many occurrences were skipped or when the window was.

## Required fix

`lastFireAt` is NOT repurposed — the review committee rejected that: it continues to mean "last occurrence that actually fired," everywhere, unchanged. Missed-fire observability gets its own dedicated fields and event:

1. When `skipMissedOccurrences` is true, set `lastMissedFireAt` (timestamp of the most recent skipped occurrence) and increment `missedFireCount` on schedule state. Do not touch `lastFireAt`.
2. Emit a `ScheduleMissedFireEvent` engine event including: schedule ID, number of missed occurrences, window start (`nextFireAt` at skip time), window end (`now`).
3. Document the 1-second grace period (`SCHEDULE_LATE_GRACE_MILLISECONDS`) in `ScheduleOptions.backfill` JSDoc and the schedule guide.

## Acceptance criteria (all required — completion is binary)

- [ ] Skipped occurrences after downtime set lastMissedFireAt and missedFireCount and emit a ScheduleMissedFireEvent carrying schedule ID, skip count, and the missed window; lastFireAt semantics are unchanged (pinned by test).
- [ ] Schedule guide and ScheduleOptions.backfill JSDoc document the grace period and the new fields.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
