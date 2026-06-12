# Task 23: Feature batch: bulk recover-failed, attribute OR filters, schedule jitter

**Severity:** medium

## No dead-letter queue / explicit failed workflow recovery routing

- **Severity:** low (feature-gap)
- **Files:** `src/core/types/bulk.ts`, `src/core/engine/bulk-operations.ts`, `src/core/types/state.ts`

**Evidence:** src/core/types/state.ts shows WorkflowState with status 'failed'. src/core/engine/bulk-operations.ts has cancelAll, signalAll, deleteAll, tagAll but no recoverAll or route-to-dlq operation. src/core/types/bulk.ts line 25 shows BulkOperationAction includes 'recover' but src/core/engine/bulk-operations.ts does not export a recoverAll function — the 'recover' action appears in the type but the implementation is absent. There is no mechanism to automatically route failed workflows to a designated error-handling workflow, no DLQ sink, and no policy to retry failed workflows as a group.

**Required fix:** Implement the 'recover' BulkOperationAction already declared in BulkOperationAction type: engine.recoverAll(filter, options) that re-starts failed workflows from their last checkpoint or from scratch with the same input. Additionally add an onFailure hook to EngineOptions: { onFailure: (state: WorkflowState) => void | { recoveryWorkflow: string, input: unknown } } that fires after terminal failure and can route to a DLQ workflow. This leverages the existing engine event system (WorkflowFailedEvent).

**Verifier note:** The finding is real but overstates severity and misdescribes what's missing. The actual gap is narrow: the `'recover'` literal in the exported `BulkOperationAction` union (src/core/types/bulk.ts:25) has no corresponding bulk engine operation — there is no `engine.recoverAll({ status: 'failed' })` equivalent. A DLQ sink / onFailure hook is also absent, but that is a separate product-design question, not a type-implementation mismatch.

The finding incorrectly implies `engine.recoverAll()` doesn't exist — it does, at src/core/engine/index.ts:1331, serving crash-recovery (resuming non-terminal workflows after restart), also exposed at `POST /v1/recover`. That is unrelated to the bulk-recover-failed-workflows gap.

A manual partial workaround exists today: callers can iterate failed workflow IDs from `engine.list({ status: 'failed' })` and call `engine.start(type, input, { id, onTerminalConflict: 'start-new' })` per workflow. This lacks atomicity, audit tracking, dry-run preview, and confirmation tokens that other bulk operations provide.

The severity should be low rather than medium. Temporal's "reset workflow" feature (reset to a prior event ID) is a more powerful primitive than simply re-running from scratch, but Weft's checkpoint model means "reset" semantics would be architecturally different anyway. The missing capability is real but the type stub is the most concrete evidence — there is no committed plan in documentation or roadmap to ship it.

## Search attribute filtering is equality/range only; no full-text, boolean expression, or SQL-like query language

- **Severity:** medium (feature-gap)
- **Files:** `src/core/types/list-options.ts`, `src/core/engine/workflow-visibility-queries.ts`, `src/core/engine/listing.ts`

**Evidence:** src/core/types/list-options.ts AttributeFilter (lines 119-145) supports equality (value) and range (gt/gte/lt/lte) per attribute, composed as AND across attributes. src/core/engine/workflow-visibility-queries.ts implements queryWorkflowStatusIndex, queryWorkflowTypeIndex, queryWorkflowTimeRangeIndex, and queryWorkflowIdPrefixCandidates. There is no OR across attribute values, no NOT filter, no nested boolean expression, no LIKE/contains operator, and no Temporal-style SQL-like visibility query string. Advanced visibility queries in Temporal (e.g. 'Status="Running" AND CustomAttr > 5 OR WorkflowType="foo"') are not expressible.

**Required fix:** Extend AttributeFilter to support OR within a single attribute (value: string[] for 'any of these values') as a low-cost immediate improvement. For a full expression language, add a FilterExpression type: { and: FilterExpression[] } | { or: FilterExpression[] } | { not: FilterExpression } | AttributeFilter. The index-based query helpers already return Set<string> that can be intersected/unioned; a recursive resolver over FilterExpression would compose these sets.

**Verifier note:** The finding is accurate as stated, with one nuance to add: OR filtering IS already supported for the built-in `status` and `failureCategory` fields (both accept arrays), so the gap is specifically confined to the custom `attributes` array in `ListFilter`. A single `AttributeFilter` entry can only match one equality value or a range — multi-value OR like `attribute X in [v1, v2]` is not expressible. Additionally, the finding does not mention that `matchesListFilter` in `src/core/engine/state-utilities.ts` (lines 313-326) never applies `filter.attributes` at the post-filter stage; attribute filtering exists only in the index-query/constrained-ID path. This means on a stale visibility watermark that falls back to a full `wf:` scan, custom attribute filters are silently skipped — a related gap worth noting alongside the OR/boolean-expression gap.

## Cron schedule timezone is supported but jitter/offset is missing

- **Severity:** low (feature-gap)
- **Files:** `src/core/types/schedules.ts`, `src/core/schedule/cron-types.ts`, `src/core/schedule/cron-occurrence.ts`

**Evidence:** src/core/schedule/cron-occurrence.ts line 1-4 imports getDefaultTimeZone and getZonedParts, confirming timezone-aware cron is implemented. src/core/types/schedules.ts ScheduleOptions (lines 70-74) has only id, overlap, backfill — no jitter field. src/core/schedule/cron-types.ts CronOccurrenceOptions (lines 37-40) has timeZone and maxOccurrences but no jitter. Temporal supports jitter on schedules to spread load when many workflows fire at the same cron tick.

**Required fix:** Add jitter?: Duration to ScheduleOptions and ScheduleDefinition. In the schedule timer firing path (src/core/engine/schedule-timer.ts), apply a deterministic jitter offset: use a seeded hash of schedule-id + fire-sequence to generate a stable pseudo-random offset in [0, jitter) milliseconds added to nextFireAt. Deterministic seeding ensures the same jitter per occurrence on replay without storing extra state.

**Verifier note:** The gap is real and the evidence is accurate. The severity should be lowered from medium to low: schedule jitter is a load-distribution nicety, not a correctness or reliability gap. Most users with one schedule per workflow type don't need it; it matters primarily at scale (hundreds of schedules firing simultaneously). Weft's current positioning doesn't suggest that scale is a primary target, and the fix is straightforward when the need arises. The proposed fix's "fire-sequence" seed framing is slightly imprecise — `ScheduleState` has no sequence counter, so the correct deterministic seed for replay safety is `scheduleId + nominalFireTimestamp` (the pre-jitter `nextFireAt`), which is already available without schema changes. The nominal fire timestamp is stable across replays because it is stored in `ScheduleState.nextFireAt` before any jitter offset is applied.
