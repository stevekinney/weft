# Task 05: TursoStorage SQLITE_BUSY conflation and schedule orphan

**Severity:** critical

## TursoStorage.conditionalBatch returns false on SQLITE_BUSY, conflating infrastructure failure with CAS precondition mismatch

- **Severity:** critical (durability)
- **Files:** `src/storage/turso.ts`

**Evidence:** turso.ts:351-373: beginWriteTransaction returns null on SQLITE_BUSY and conditionalBatch returns false in that case. false from conditionalBatch means 'precondition not met' — the engine interprets this as a conflicting run already existing. Under lock contention, the real start is silently swallowed. NeonStorage correctly throws after retry exhaustion; Turso silently conflates contention with semantic CAS failure.

**Required fix:** On SQLITE_BUSY, retry with backoff (up to MAX_RETRIES) then throw if retries are exhausted — mirroring the NeonStorage pattern. Never return false for infrastructure failures: false is a semantic result (precondition not satisfied), throw is for infrastructure failures.

## Schedule state and next-tick timer written in two separate batches — crash orphans the schedule

- **Severity:** high (durability)
- **Files:** `src/core/engine/schedule-timer.ts`, `src/core/engine/storage-io.ts`

**Evidence:** schedule-timer.ts:36-53: processScheduleTimerOccurrences writes each occurrence with includeTimer:false, then writeScheduleState with the timer is called after the loop at lines 46-50. Crash between last per-occurrence write and line 46-50 leaves schedule record active (stale nextFireAt) but with no schedule-due: key in storage. Scheduler only fires timers found in the schedule-due: prefix scan — no key, no firing. No compensating startup scan recovers orphaned active schedules.

**Required fix:** Write the final nextFireAt timer atomically with the last occurrence's state update (always pass includeTimer:true on the final writeScheduleState call, or restructure to one call). Add a schedule-recovery scan on engine startup that detects active schedules with nextFireAt in the past and no matching schedule-due: key, and re-arms them.
