# Task 17: Query-path performance: aggregate batching and watermark caching

**Severity:** high

## N+1 storage reads in aggregate() for attribute-grouped queries

- **Severity:** high (performance)
- **Files:** `src/core/engine/aggregate.ts`, `src/core/engine/listing.ts`

**Evidence:** src/core/engine/aggregate.ts:67–83 — `resolveDimensionKey` is called for every workflow in the candidate set. When `groupBy` is `{ attribute }` it calls `await internals.storage.get(KEYS.attribute(state.id))` serially (line 80), one round-trip per workflow. The outer loop in `accumulateFromConstrainedIds` (lines 202–210) awaits `accumulateAggregateState` which awaits `resolveDimensionKey` — one await chain per workflow with no batching. A query over 10 000 workflows with an attribute groupBy issues 10 000 serial `storage.get` calls. The constrained-ids path in `listing.ts` (lines 85–101) batches a chunk of 64 `storage.get` calls with `Promise.all`, but `aggregate.ts` does NOT use this chunked pattern — each state's attribute is fetched one at a time.

**Required fix:** Apply the same CONSTRAINED_ID_CHUNK_SIZE=64 batching pattern from listing.ts:85–101 to aggregate.ts. Collect all candidate states first, then fan out attribute reads in chunks of 64 with Promise.all before grouping. For very large attribute-grouped aggregates, consider maintaining a dedicated attribute-value index (similar to the existing status/type visibility indexes) so no per-workflow reads are needed at query time.

**Verifier note:** The finding is accurate as written. One precision note: the serial state reads at line 203 affect ALL groupBy types (status, type, failureCategory, and attribute), not just `{ attribute }` groupBy — only the second serial read (attribute bytes at line 80) is gated on the `{ attribute }` groupBy branch. The title "N+1 storage reads" is slightly imprecise (it is unbatched serial reads, not a classic N+1 relational pattern), but the substance is correct. The proposed fix is sound — the same `Promise.all` + 64-chunk pattern from listing.ts should be applied to both the state-fetch loop and the attribute-fetch step in the aggregate constrained-ids path.

## engine.list() falls back to full wf: prefix scan when visibility watermark is stale — O(N) storage reads gated behind a single watermark read per query

- **Severity:** high (performance)
- **Files:** `src/core/engine/list-candidate-resolution.ts`, `src/core/engine/listing.ts`, `src/core/engine/workflow-state-stream.ts`

**Evidence:** src/core/engine/list-candidate-resolution.ts:132–145 — `getWorkflowVisibilityWatermark` is called on every `list()` and `aggregate()` call. When it returns `'stale'` (i.e., the backfill migration has not run) the entire `wf:` prefix is scanned (listing.ts:113: `internals.storage.scan('wf:')`). For new deployments or any deployment that has not explicitly run the backfill, ALL queries are full table scans with no index. The watermark read itself is an additional `storage.get` per query. Additionally, workflow-state-stream.ts:26–37 shows the constrained-ids path issues serial `storage.get` per candidate id rather than a batch, though listing.ts:87–88 uses `Promise.all` per chunk. The full-scan path (listing.ts:124–127) also does a separate per-workflow `storage.get(KEYS.attribute(state.id))` for failed workflows.

**Required fix:** Cache the watermark in engine memory and invalidate it only on backfill completion (the backfill already writes to `wf-idx-meta:version`). Subscribe to that key change via the existing storage event feed, or poll once per minute. This eliminates one `storage.get` per query. More impactfully, set the default deployment posture to automatically run the backfill on `Engine.create()` for new databases so new deployments never enter the stale scan path.

**Verifier note:** The finding is real and accurately evidenced. One nuance worth noting: the constrained-ids path in `listing.ts` (the non-stream `list()` function) DOES use `Promise.all` in 64-element chunks (`CONSTRAINED_ID_CHUNK_SIZE = 64`) at `listing.ts:87-88`, so the claim of serial-per-candidate reads applies specifically to `streamMatchingWorkflowStates` in `workflow-state-stream.ts:26-36`, which is used by bulk streaming operations (`streamWorkflowStateBatches`), not by `list()` itself.

The proposed fix is sound for the watermark caching: adding a `visibilityWatermark: WorkflowVisibilityWatermark | null` field to `EngineInternals` (initialized to `null`, populated on first query, invalidated when the backfill writes the version key) would eliminate the per-query storage read. For auto-setting the watermark on new databases: `Engine.create()` could check whether any `wf:` keys exist on startup; if not, it could atomically write the watermark immediately, bypassing the need for an explicit backfill run on fresh deployments. For existing databases, the external backfill script remains the correct migration path.
