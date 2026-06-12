# Task 15: Schedule missed-fire observability

**Severity:** medium

## Schedule missed-fire occurrences are silently dropped with no operator signal after downtime

## Context

When the engine restarts after downtime, `planScheduleTimerWork` in `src/core/engine/schedule-timer.ts` silently discards any occurrences that fired more than 1 second in the past (`SCHEDULE_LATE_GRACE_MILLISECONDS = 1000`, line 7). There is no log, no event, no observable state change.

## Evidence

- `schedule-timer.ts:76`: `!state.backfill && now - state.nextFireAt > SCHEDULE_LATE_GRACE_MILLISECONDS` returns `{ occurrencesToProcess: [], skipMissedOccurrences: true }`.
- Subsequent code at line 97-98 advances `nextFireAt` past `now`.
- `lastFireAt` retains the last FIRED timestamp — after downtime it remains stale, making it impossible to distinguish planned downtime from a stuck or missed-fire schedule.
- The 1-second grace window and skip-all-missed semantics are not documented in `ScheduleOptions.backfill` JSDoc or in the schedule guide.

## Impact

A schedule for financial reports or SLA-gated operations will silently miss occurrences after any downtime exceeding 1 second. Operators have no way to know how many occurrences were skipped or when the window was.

## Proposed Design

1. When `skipMissedOccurrences` is true, update `lastFireAt` to the last missed occurrence timestamp (not the last fired timestamp).
2. Persist a `missedOccurrences` counter or a structured miss-event on the schedule state so operators can observe skipped runs.
3. Emit a `ScheduleMissedFireEvent` (or structured log warning) including: schedule ID, number of missed occurrences, window start (`nextFireAt` at skip time), window end (`now`).
4. Document the 1-second grace period in `ScheduleOptions.backfill` JSDoc and make the grace period configurable via `ScheduleOptions`.

## Acceptance Criteria

- After an engine restart with downtime > 1 second, at least one observable signal (event, log, or state field) tells operators how many occurrences were skipped and over what time window.
- `lastFireAt` reflects the last missed occurrence, not the last fired occurrence, after a skip.
- The 1-second grace constant is documented in `ScheduleOptions` and configuration.md.
