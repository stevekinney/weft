# Task 35: Scheduler tick: scan LIMITs and batched timer deletes

**Severity:** low

## Finding: Scheduler does 4 concurrent storage prefix scans on every polling tick — timer count scales linearly with workflow count

- **Severity:** low (performance)
- **Files (audit snapshot):** `src/core/scheduler/scheduler-class.ts`, `src/core/scheduler/timer-sources.ts`

### Evidence

src/core/scheduler/scheduler-class.ts:169–184 — `#scanExpiredTimers` opens 4 concurrent scan iterators: `wf-deadline:`, `wf-delayed:`, `schedule-due:`, `wf-cleanup:`. Each scan reads all entries with `lt: resolvePrefixRangeEnd(KEYS.deadline(currentTime, ''))` — i.e., every expired timer of that kind. Lines 186–213 wrap them in TimerSource objects each of which calls `readNextScannedTimerEntry` to pull the first element. The scheduler runs on a setInterval tick (line 73–76, default 1 000 ms). With N sleeping workflows there are N `sleep`-kind timers in the `wf-deadline:` prefix. Each tick's scan start returns a cursor and then reads entries one at a time in a while loop (lines 147–166), awaiting storage per entry. For SQLite this is synchronous under the hood but still serialized. At 10 000 concurrent sleeping workflows, each tick touches up to 10 000 keys.

### Required fix

Push timer-expiry responsibility into the storage layer: a single SQL query `SELECT value FROM kv WHERE key >= 'wf-deadline:' AND key < 'wf-deadline:{now_padded}' LIMIT 256` is more efficient than 4 separate scan cursors merged in JS. Batch-delete all fired timers in a single DELETE rather than one per timer. Add a `LIMIT` to each scan so one very late tick does not process unbounded timers.

### Verifier note

The mechanism described is wrong for the SQLite backend. `storage.scan()` in bun-sql.ts calls `statement.all()`, which executes one SQL range-scan and returns all rows as a JS array before any yielding occurs. There are no per-entry storage round-trips. The real gaps are narrower: (1) no LIMIT on the four scan calls means a stalled tick could load unbounded rows into memory; (2) per-timer `storage.batch()` deletes are serialized rather than batched. Both are worth fixing but neither is a hot-path blocker at realistic concurrency. Severity should be low, not high.

## Resolved scope (implement, narrowly)

Per the verifier, the SQLite mechanism claim in the original finding was wrong — implement ONLY the two confirmed gaps: (1) a per-tick LIMIT on each of the four expired-timer scans so a stalled tick cannot load unbounded rows (remaining expired timers fire on subsequent ticks); (2) batch fired-timer deletions into a single storage batch per tick instead of per-timer batches. The per-timer schedule index lookup finding was DROPPED by the committee (requires a breaking TimerEntry schema change for negligible gain) — do not implement it.

## Acceptance criteria (all required — completion is binary)

- [ ] Each timer source scan carries a documented per-tick LIMIT; a backlog larger than the limit drains across ticks without loss (test).
- [ ] Fired-timer cleanup issues one batch per tick; existing scheduler/timer tests stay green.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.
