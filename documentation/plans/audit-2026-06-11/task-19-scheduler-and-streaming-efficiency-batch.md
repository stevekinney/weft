# Task 19: Scheduler and streaming efficiency batch

**Severity:** low

## Scheduler does 4 concurrent storage prefix scans on every polling tick — timer count scales linearly with workflow count

- **Severity:** low (performance)
- **Files:** `src/core/scheduler/scheduler-class.ts`, `src/core/scheduler/timer-sources.ts`

**Evidence:** src/core/scheduler/scheduler-class.ts:169–184 — `#scanExpiredTimers` opens 4 concurrent scan iterators: `wf-deadline:`, `wf-delayed:`, `schedule-due:`, `wf-cleanup:`. Each scan reads all entries with `lt: resolvePrefixRangeEnd(KEYS.deadline(currentTime, ''))` — i.e., every expired timer of that kind. Lines 186–213 wrap them in TimerSource objects each of which calls `readNextScannedTimerEntry` to pull the first element. The scheduler runs on a setInterval tick (line 73–76, default 1 000 ms). With N sleeping workflows there are N `sleep`-kind timers in the `wf-deadline:` prefix. Each tick's scan start returns a cursor and then reads entries one at a time in a while loop (lines 147–166), awaiting storage per entry. For SQLite this is synchronous under the hood but still serialized. At 10 000 concurrent sleeping workflows, each tick touches up to 10 000 keys.

**Required fix:** Push timer-expiry responsibility into the storage layer: a single SQL query `SELECT value FROM kv WHERE key >= 'wf-deadline:' AND key < 'wf-deadline:{now_padded}' LIMIT 256` is more efficient than 4 separate scan cursors merged in JS. Batch-delete all fired timers in a single DELETE rather than one per timer. Add a `LIMIT` to each scan so one very late tick does not process unbounded timers.

**Verifier note:** The mechanism described is wrong for the SQLite backend. `storage.scan()` in bun-sql.ts calls `statement.all()`, which executes one SQL range-scan and returns all rows as a JS array before any yielding occurs. There are no per-entry storage round-trips. The real gaps are narrower: (1) no LIMIT on the four scan calls means a stalled tick could load unbounded rows into memory; (2) per-timer `storage.batch()` deletes are serialized rather than batched. Both are worth fixing but neither is a hot-path blocker at realistic concurrency. Severity should be low, not high.

## Event-log token-stream tail uses O(n) full prefix scan to find max sequence — reconnects are expensive

- **Severity:** low (performance)
- **Files:** `src/core/engine/workflow-feed.ts`, `src/core/engine/stream-chunk-loading.ts`

**Evidence:** src/core/engine/workflow-feed.ts:106–115 — `snapshotWorkflowFeedTail` for the `tokens` selector calls `loadStoredStreamChunks(internals.storage, workflowId, TOKENS_STREAM_KEY)` (a full prefix scan of stored chunks) then iterates all results to find the max sequence number, with no head pointer. The comment at line 108 acknowledges this: 'scan is O(n) in stored chunks. The token feed persists each chunk under the `tokens` prefix and keeps no separate tail record'. A client that reconnects issues a full scan of all stored token chunks to find its resume point. Temporal's sticky-queue model avoids this by routing reconnecting clients to a worker that already holds the history in memory.

**Required fix:** Maintain a durable tail pointer (e.g., `stream-tail:{workflowId}:tokens`) updated atomically with each chunk write. This reduces tail-snapshot from O(chunks) to O(1). The comment already flags this as a deliberate tradeoff for short-lived streams — reclassify it as technical debt and fix it for workflows that use ctx.stream extensively.

**Verifier note:** The behavior is real and the code comment confirms it is acknowledged debt. However, severity should be low, not medium. The O(n) scan fires once per subscription setup (not per event), only for the `tokens` selector (the `events` selector uses an in-memory head cache for O(1)), and only affects workflows that use `ctx.stream` extensively. The "reconnects are expensive" framing overstates impact: chunk count for typical short-lived token streams is small, and the cost amortizes over the entire subscription lifetime. The Temporal comparison is inapt — Temporal reconnects also trigger full history fetches; sticky queues improve execution locality, not tail-sequence lookup. The proposed tail-pointer fix is valid technical debt to track but carries its own cost (one extra storage write per chunk commit). This belongs on a deferred optimization track, not flagged as a meaningful gap for Temporal feature/performance parity.

## Bulk operations are sequential (no parallelism), causing O(N) latency for large batches

- **Severity:** low (performance)
- **Files:** `src/core/engine/bulk-operations.ts`, `src/core/engine/listing.ts`

**Evidence:** src/core/engine/bulk-operations.ts runBulkCancellation (lines 87-101) iterates with a for-of and awaits each engine.cancel sequentially. signalAll (lines 186-199) does the same. Even the delete path (lines 221-243) loops sequentially over batches. The BULK_OPERATION_BATCH_SIZE from src/core/engine/listing.ts caps iteration size but does not add concurrency. For 10,000 workflows, cancellation is 10,000 sequential awaits.

**Required fix:** Parallelize the inner loop using Promise.allSettled with a configurable concurrency limit (e.g., 50 concurrent operations). Replace the sequential for-of with a pool: chunk workflowIds into groups of concurrencyLimit, then await Promise.allSettled on each chunk. This maintains correctness (each operation is independent) while cutting wall-clock time by ~50x for large batches. Errors per-workflow are still collected. Add a bulkConcurrency option to BulkOperationOptions.

**Verifier note:** The finding is real but the severity should be low, not medium. For the default BunSQLiteStorage backend (bun-sql.ts), get/put/batch are synchronous SQLite prepared-statement calls wrapped in async functions. Promise.allSettled parallelism would not reduce wall-clock latency here because operations serialize on Bun's single JS thread with no actual I/O concurrency. The performance gap only matters when using a genuinely async remote storage adapter (Neon, HTTP, LMDB, IndexedDB). If the project adds Neon or HTTP storage as primary backends, revisiting bulk operation concurrency becomes worthwhile. A configurable bulkConcurrency option defaulting to 1 (keeping current behavior as default) would be a reasonable future enhancement, but it would not provide meaningful benefit to typical single-process SQLite deployments.

## Per-timer index lookup for schedule-kind timer cleanup — extra storage read per fired schedule timer

- **Severity:** low (performance)
- **Files:** `src/core/scheduler/scheduler-class.ts`

**Evidence:** src/core/scheduler/scheduler-class.ts:260–276 — `#buildScheduleTimerIndexDeleteOperation` calls `await this.#storage.get(indexKey)` for every fired schedule timer. This is an extra round-trip beyond the already-paid scan. Non-schedule timers skip this (line 255–257 `shouldDeleteTimerIndexWithoutLookup`). In a deployment with many cron schedules this adds one extra storage read per tick per active schedule.

**Required fix:** Store the timer data key directly in the scan entry value (or encode the index key inline in the scan key) so the index lookup can be eliminated. The scan already yields the timer payload; include a `indexKey` field in the serialized `TimerEntry` to make the cleanup batch self-contained.

**Verifier note:** The finding is real but the severity should be low rather than medium. The extra read fires once per schedule timer tick (i.e., once per cron fire event), not per workflow step or activity. A deployment would need hundreds of concurrently active cron schedules firing simultaneously before this round-trip becomes measurable. The proposed fix (embed the scan key in the `TimerEntry` payload) is architecturally sound but requires a breaking schema change to `TimerEntry` plus ensuring the re-arm write updates both the index and the embedded key atomically — non-trivial. The current code is correct and the overhead is proportional to cron schedule volume, not general workflow throughput. For Temporal parity, this is not a blocking gap.
