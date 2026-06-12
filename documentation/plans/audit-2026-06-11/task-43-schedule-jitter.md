# Task 43: Deterministic schedule jitter

**Severity:** low

## Finding: Cron schedule timezone is supported but jitter/offset is missing

- **Severity:** low (feature-gap)
- **Files (audit snapshot):** `src/core/types/schedules.ts`, `src/core/schedule/cron-types.ts`, `src/core/schedule/cron-occurrence.ts`

### Evidence

src/core/schedule/cron-occurrence.ts line 1-4 imports getDefaultTimeZone and getZonedParts, confirming timezone-aware cron is implemented. src/core/types/schedules.ts ScheduleOptions (lines 70-74) has only id, overlap, backfill — no jitter field. src/core/schedule/cron-types.ts CronOccurrenceOptions (lines 37-40) has timeZone and maxOccurrences but no jitter. Temporal supports jitter on schedules to spread load when many workflows fire at the same cron tick.

### Required fix

Add jitter?: Duration to ScheduleOptions and ScheduleDefinition. In the schedule timer firing path (src/core/engine/schedule-timer.ts), apply a deterministic jitter offset: use a seeded hash of `scheduleId + nominalFireTimestamp` (the pre-jitter nextFireAt, which is already persisted in ScheduleState) to generate a stable pseudo-random offset in [0, jitter) milliseconds applied to the effective dispatch time only. The persisted `ScheduleState.nextFireAt` always stays the nominal pre-jitter fire time — it is the seed input, so writing a jittered value back to it would change the seed across replays and break determinism. Deterministic seeding ensures the same jitter per occurrence on replay without storing extra state — see the seed correction below; ScheduleState has no fire-sequence counter, so the nominal fire timestamp is the seed.

### Verifier note

The gap is real and the evidence is accurate. The severity should be lowered from medium to low: schedule jitter is a load-distribution nicety, not a correctness or reliability gap. Most users with one schedule per workflow type don't need it; it matters primarily at scale (hundreds of schedules firing simultaneously). Weft's current positioning doesn't suggest that scale is a primary target, and the fix is straightforward when the need arises. The proposed fix's "fire-sequence" seed framing is slightly imprecise — `ScheduleState` has no sequence counter, so the correct deterministic seed for replay safety is `scheduleId + nominalFireTimestamp` (the pre-jitter `nextFireAt`), which is already available without schema changes. The nominal fire timestamp is stable across replays because it is stored in `ScheduleState.nextFireAt` before any jitter offset is applied.

## Seed correction

Per the verifier: ScheduleState has no fire-sequence counter — the deterministic seed is `scheduleId + nominalFireTimestamp` (the pre-jitter nextFireAt). Same occurrence ⇒ same jitter on replay, no new persisted state.

## Acceptance criteria (all required — completion is binary)

- [ ] ScheduleOptions.jitter applies a stable pseudo-random offset in [0, jitter) to each occurrence's effective dispatch time, deterministic for a given scheduleId + nominal fire time (test recomputes and matches); the persisted ScheduleState.nextFireAt remains the nominal pre-jitter time (pinned by test); overlap policies and backfill interact correctly (jitter applies after occurrence selection).
- [ ] Schedule docs cover jitter and its determinism contract.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
