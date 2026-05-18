# oxlint Disable Inventory

This file is the registry of every `// oxlint-disable*` directive in `src/`.
Every directive in source carries an inline `-- ID:<name>` token; the ID must
have a matching section in this file. The check is enforced by
`bun run scripts/check-lint-disables.ts`, which runs as part of `bun run lint`.

Sections are sorted alphabetically by ID to minimise merge conflicts when
parallel PRs add or remove entries.

## Done criteria

The oxlint-strict initiative is complete when this file lists **at most 5
permanent suppressions**, each with a one-paragraph rationale and a comment
naming the alternative that was rejected.

## `benchmarks-memory-per-workflow-runner-measure-memory-per-workflow-complexity`

- **File**: `src/benchmarks/memory-per-workflow-runner.ts`
- **Rule**: `complexity`
- **Symbol**: `measureMemoryPerWorkflow`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-bulk-operations-file-length`

- **File**: `src/core/engine/bulk-operations.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Bulk operations and terminal purge share the same workflow-state scan, confirmation, audit, and cleanup helpers. Splitting the file while this surface is still being actively expanded would make the destructive-action review path harder to audit; revisit when retry and recover bulk actions are added.

## `core-engine-cleanup-waiters-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `cleanupWaiters`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-complete-workflow-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `completeWorkflow`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-create-initial-workflow-state-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `createInitialWorkflowState`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-decode-schedule-runtime-fields-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `decodeScheduleRuntimeFields`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-callback-creators-file-length`

- **File**: `src/core/engine/callback-creators.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Callback-bundle factory hub created in PR 32b. Splitting further has diminishing returns; keeping all factories in one place keeps the Engine class shim definitions easy to follow.

## `core-engine-index-file-length`

- **File**: `src/core/engine/index.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Engine class is the public coordinator: ~170 lines of imports from 30+ sibling modules + the Engine class with public-method shims that delegate via getInternals(this) and callback bundles. Splitting the Engine class itself would fragment the public API entrypoint. The file is structurally minimal already — every method body is a one- or two-line shim.

## `core-engine-execute-child-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `executeChild`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-lifecycle-file-length`

- **File**: `src/core/engine/lifecycle.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Lifecycle extraction is temporarily oversized while engine split PRs continue.

## `core-engine-termination-file-length`

- **File**: `src/core/engine/termination.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Termination extraction is temporarily oversized while engine split PRs continue.

## `core-engine-validation-file-length`

- **File**: `src/core/engine/validation.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Pre-existing oversized file; tracked by oxlint-strict initiative for split.

## `core-engine-get-timeline-basic-input-summary-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `getTimelineBasicInputSummary`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-get-timeline-operation-label-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `getTimelineOperationLabel`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-is-workflow-timeline-entry-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `isWorkflowTimelineEntry`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-line-5082-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `line-5082`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-list-complexity`

- **File**: `src/core/engine/listing.ts`
- **Rule**: `complexity`
- **Symbol**: `list`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-bulk-workflow-filter-has-scoped-complexity`

- **File**: `src/core/bulk-workflow-filter.ts`
- **Rule**: `complexity`
- **Symbol**: `hasScopedBulkWorkflowFilter`
- **Reason**: Single safety gate that enumerates every valid bulk scope (status, type, tags, attributes, tenantId, idPrefix length floor). Each branch is a one-liner mapping one filter dimension to "would this narrow the bulk operation enough to be safe?" — splitting the function would fragment the per-dimension contract that the tests assert against a single point of truth.

## `core-engine-aggregate-complexity`

- **File**: `src/core/engine/aggregate.ts`
- **Rule**: `complexity`
- **Symbol**: `aggregate`
- **Reason**: Single function orchestrates validation, watermark gating, candidate resolution, scan-cap enforcement, dimension key extraction, distinct-key cap enforcement, and sort/truncate finalization. Each branch maps to one step of the documented aggregate pipeline; splitting them would scatter the per-step contract.

## `core-engine-matches-list-filter-complexity`

- **File**: `src/core/engine/state-utilities.ts`
- **Rule**: `complexity`
- **Symbol**: `matchesListFilter`
- **Reason**: Single defensive post-filter for the workflow visibility surface — each branch maps to one indexed filter dimension (status, type, tenant, idPrefix, createdAt, updatedAt, executionDeadline, failureCategory). Splitting the function would scatter the per-dimension contract that the index helpers and tests assert against a single point of truth.

## `core-engine-resolve-list-candidate-ids`

- **File**: `src/core/engine/listing.ts`
- **Rule**: `complexity`
- **Symbol**: `resolveListCandidateIds`
- **Reason**: Single dispatcher that fans every supported ListFilter dimension out to its visibility-index query helper, then intersects the resulting sets with the existing tag/attribute resolution. Each branch is a one-liner mapping one filter field to one query — splitting them would only move the same branching one frame down the stack and obscure the watermark short-circuit.

## `core-engine-matches-schedule-filter-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `matchesScheduleFilter`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-normalize-schedule-filter-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `normalizeScheduleFilter`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-register-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `register`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-resolve-engine-options-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `resolveEngineOptions`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `core-engine-start-workflow-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `startWorkflow`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `dashboard-api-client-build-workflow-filter-params`

- **File**: `src/dashboard/api-client.ts`
- **Rule**: `complexity`
- **Symbol**: `buildWorkflowFilterSearchParams`
- **Reason**: Shared serializer for every supported ListFilter dimension. Each branch is a one-liner mapping one field to its query-parameter shape — splitting the function would fragment the per-field contract that the API-client tests assert against a single point of truth.

## `dashboard-build-workflow-list-filter`

- **File**: `src/dashboard/utilities/workflow-list-data.ts`
- **Rule**: `complexity`
- **Symbol**: `buildWorkflowListFilter`
- **Reason**: Mirrors `buildWorkflowFilterSearchParams` on the application side — one branch per `WorkflowListFilters` field deciding whether to round-trip it. Splitting would not reduce branch count, just move it elsewhere.

## `dashboard-fragments-workflow-execution-timeline-collect-value-diffs-complexity`

- **File**: `src/dashboard/fragments/workflow-execution-timeline.ts`
- **Rule**: `complexity`
- **Symbol**: `collectValueDiffs`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `dashboard-fragments-workflow-execution-timeline-format-timeline-diff-value-complexity`

- **File**: `src/dashboard/fragments/workflow-execution-timeline.ts`
- **Rule**: `complexity`
- **Symbol**: `formatTimelineDiffValue`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `dashboard-utilities-format-duration-format-duration-complexity`

- **File**: `src/dashboard/utilities/format-duration.ts`
- **Rule**: `complexity`
- **Symbol**: `formatDuration`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `dashboard-utilities-workflow-detail-timeline-synchronize-workflow-timeline-inspection-state-complexity`

- **File**: `src/dashboard/utilities/workflow-detail-timeline.ts`
- **Rule**: `complexity`
- **Symbol**: `synchronizeWorkflowTimelineInspectionState`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

- **File**: `src/observability/index.ts`
- **Rule**: `complexity`
- **Symbol**: `createObservabilityInterceptors`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

- **File**: `src/observability/index.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Pre-existing oversized file; tracked by oxlint-strict initiative for split.

- **File**: `src/observability/index.ts`
- **Rule**: `complexity`
- **Symbol**: `handleEvent`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-index-classify-connection-complexity`

- **File**: `src/server/runtime/websocket-upgrade.ts`
- **Rule**: `complexity`
- **Symbol**: `classifyConnection`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-index-dispatch-task-impl-complexity`

- **File**: `src/server/runtime/task-dispatch.ts`
- **Rule**: `complexity`
- **Symbol**: `dispatchTaskImpl`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

- **File**: `src/server/index.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Pre-existing oversized file; tracked by oxlint-strict initiative for split.

## `server-index-handle-task-result-request-complexity`

- **File**: `src/server/runtime/task-polling.ts`
- **Rule**: `complexity`
- **Symbol**: `handleTaskResultRequest`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-index-handle-worker-web-socket-message-complexity`

- **File**: `src/server/runtime/websocket-worker.ts`
- **Rule**: `complexity`
- **Symbol**: `handleWorkerWebSocketMessage`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-index-serve-complexity`

- **File**: `src/server/index.ts`
- **Rule**: `complexity`
- **Symbol**: `serve`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-operations-bulk-filter-helpers-parse-bulk-list-filter-from-body-complexity`

- **File**: `src/server/operations/bulk-filter-helpers.ts`
- **Rule**: `complexity`
- **Symbol**: `parseBulkListFilterFromBody`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-operations-create-schedule-invoke-complexity`

- **File**: `src/server/operations/create-schedule.ts`
- **Rule**: `complexity`
- **Symbol**: `invoke`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-operations-fork-workflow-invoke-complexity`

- **File**: `src/server/operations/fork-workflow.ts`
- **Rule**: `complexity`
- **Symbol**: `invoke`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-operations-list-schedules-validation-complexity`

- **File**: `src/server/operations/list-schedules.ts`
- **Rule**: `complexity` (via `eslint(complexity)`)
- **Symbol**: `(list-schedules invoke boundary)`
- **Reason**: Pre-existing complexity violation; preserves the legacy query-validation order at one transport-neutral invoke boundary.

## `server-operations-start-workflow-invoke-complexity`

- **File**: `src/server/operations/start-workflow.ts`
- **Rule**: `complexity`
- **Symbol**: `invoke`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-operations-submit-review-decision-invoke-complexity`

- **File**: `src/server/operations/submit-review-decision.ts`
- **Rule**: `complexity`
- **Symbol**: `invoke`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `storage-indexeddb-delete-prefix-complexity`

- **File**: `src/storage/indexeddb.ts`
- **Rule**: `complexity`
- **Symbol**: `deletePrefix`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `worker-protocol-contract-file-length`

- **File**: `src/worker/protocol.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Canonical RemoteWorker protocol module owns the public v1 constants, message unions, deterministic JSON Schema exports, and parser guards that must stay together for SDK authors importing `weft/worker-protocol`. Splitting the contract would make schema drift harder to audit.

## `worker-protocol-parse-register-message-complexity`

- **File**: `src/worker/protocol.ts`
- **Rule**: `complexity`
- **Symbol**: `parseRegisterMessage`
- **Reason**: Registration parsing is the protocol trust boundary for version, worker identity, activity list, concurrency, and queue validation. Keeping the checks linear makes the rejection reason deterministic and mirrors the schema fields.

## `worker-protocol-parse-task-message-complexity`

- **File**: `src/worker/protocol.ts`
- **Rule**: `complexity`
- **Symbol**: `parseTaskMessage`
- **Reason**: Task parsing validates every server-to-worker field before a worker SDK acts on it. The field checks intentionally mirror the exported task schema rather than hiding validation in smaller helpers.

## `worker-protocol-parse-task-result-message-complexity`

- **File**: `src/worker/protocol.ts`
- **Rule**: `complexity`
- **Symbol**: `parseTaskResultMessage`
- **Reason**: `taskResult` is a discriminated union with completed, failed, and cancelled variants. Keeping the variant checks together makes malformed result handling deterministic at the server trust boundary.

## `worker-registry-find-worker-complexity`

- **File**: `src/worker/registry.ts`
- **Rule**: `complexity`
- **Symbol**: `findWorker`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `worker-registry-tracks-routing-drain-and-summary-state`

- **File**: `src/worker/registry.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: WorkerRegistry owns the shared in-memory routing surface for registration identity, capacity, in-flight visibility bookkeeping, fair-share counters, drain state, and operator summaries. Splitting the drain state into a separate coordinator would add cross-object synchronization around every assignment and completion path, so the current file remains the smallest auditable owner of those invariants.

## `worker-registry-pick-fair-share-complexity`

- **File**: `src/worker/registry.ts`
- **Rule**: `complexity`
- **Symbol**: `pickFairShare`
- **Reason**: Pre-existing complexity violation; tracked by oxlint-strict initiative for refactor.

## `server-task-queue-includes-snapshot-projection`

- **File**: `src/server/task-queue.ts`
- **Rule**: `max-lines`
- **Symbol**: entire module
- **Reason**: `TaskQueue` carries its data structures plus a stable snapshot projection (`getQueueSummaries`) used by the public `weft.task.queues.list` operation. Keeping the projection beside the state it reads is more honest than exposing private fields through a sibling module.

## `dashboard-api-client-max-lines`

- **File**: `src/dashboard/api-client.ts`
- **Rule**: `max-lines`
- **Symbol**: entire module
- **Reason**: Single typed fetch wrapper for the Weft REST API. The file is dominated by interface/type declarations describing the API surface; splitting them across multiple files would scatter the contract that dashboard call sites import from one place. Method bodies are short and the file is read top-to-bottom as a directory of REST routes.

## `server-operations-extract-list-filter-from-query`

- **File**: `src/server/operations/list-filter-query-extractor.ts`
- **Rule**: `complexity`
- **Symbol**: `extractListFilterFromQuery`
- **Reason**: Single shared dispatcher that parses every supported `ListFilter` dimension from REST query parameters (status, type, tags, attributes, idPrefix, tenantId, failureCategory, createdAt, updatedAt, executionDeadline). Each branch is a one-liner mapping one filter field to one parser — splitting would scatter the per-dimension contract that both `list-workflows` and `aggregate-workflows` rely on.
