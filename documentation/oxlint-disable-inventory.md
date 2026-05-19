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
- **Current size**: ~1464 lines after this pass extracted construction helpers and local types to `src/core/engine/construction.ts` (~197 lines). The remaining bulk is the `Engine` class itself (~960 lines).
- **Rejected alternatives**:
  - Splitting the `Engine` class via `interface` declaration merging: loses generic preservation across `withWorkflow`/`withActivity` builders, breaks the chained-builder type inference that is the whole point of the typed registry.
  - Splitting the `Engine` class via prototype assignment in sibling modules: alters generated `.d.ts` output and JSDoc attachment for the public class, downgrades inference on static `Engine.create` overloads, and creates a runtime ordering hazard.
  - Lowering the `max-lines` threshold or raising it just for this file: lint policy is enforced globally; per-file overrides are not the project's pattern (see how `.oxlintrc.json` handles test files only via glob, not per-file allowlists).
- **Reason**: the class itself is ~960 lines of public method shims and type plumbing; everything separable from it has been extracted. No further extraction is possible without splitting the public class declaration, which the rejected alternatives above show is not viable.

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

## `core-engine-start-workflow-complexity`

- **File**: `src/core/engine/index.ts`
- **Rule**: `complexity`
- **Symbol**: `startWorkflow`
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

## `worker-protocol-contract-file-length`

- **File**: `src/worker/protocol.ts`
- **Rule**: `max-lines`
- **Symbol**: `(whole file)`
- **Reason**: Canonical RemoteWorker protocol module owns the public v1 constants, message unions, deterministic JSON Schema exports, and parser guards that must stay together for SDK authors importing `weft/worker-protocol`. The schema declarations and the field-by-field parsers reference one another by structural shape, and keeping them adjacent is what lets a reviewer verify that an accepted message matches the documented contract without crossing files. Rejected alternative: splitting the schemas, exports, and parsers across sibling modules (`protocol-schemas.ts`, `protocol-parsers.ts`, `protocol-exports.ts`); rejected because the schema/parser cross-references would be cut by the file boundary, harming SDK auditability and making schema drift harder to spot in review.

## `worker-protocol-parse-register-message-complexity`

- **File**: `src/worker/protocol.ts`
- **Rule**: `complexity`
- **Symbol**: `parseRegisterMessage`
- **Reason**: Registration parsing is the protocol trust boundary for version, worker identity, activity list, concurrency, and queue validation. Keeping the checks linear makes the rejection reason deterministic and mirrors the exported register-message schema field-by-field; a reviewer auditing trust-boundary behavior reads the parser top-to-bottom and matches each guard against the corresponding schema field. Rejected alternative: extracting per-field helpers (`validateRegisterIdentity`, `validateRegisterCapability`, `validateRegisterRuntime`) into `protocol-parsers.ts`; rejected because it scatters trust-boundary validation order across helpers, hides field-precedence in helper call order rather than source order, and obscures the parser's one-to-one correspondence with the schema.

## `worker-protocol-parse-task-message-complexity`

- **File**: `src/worker/protocol.ts`
- **Rule**: `complexity`
- **Symbol**: `parseTaskMessage`
- **Reason**: Task parsing validates every server-to-worker field before a worker SDK acts on it. The field checks intentionally mirror the exported task schema rather than hiding validation in smaller helpers, so a reviewer can confirm one-pass that each schema field has a corresponding guard. Rejected alternative: extracting per-field helpers into `protocol-parsers.ts`; rejected because it would scatter the trust-boundary validation order across helpers and break the linear schema-to-guard correspondence that makes drift visible at review time.

## `worker-protocol-parse-task-result-message-complexity`

- **File**: `src/worker/protocol.ts`
- **Rule**: `complexity`
- **Symbol**: `parseTaskResultMessage`
- **Reason**: `taskResult` is a discriminated union with completed, failed, and cancelled variants. Keeping the variant checks together makes malformed result handling deterministic at the server trust boundary, and the linear shape lets a reviewer audit the full set of accepted-vs-rejected shapes from a single source location. Rejected alternative: extracting per-variant helpers (`parseCompletedResult`, `parseFailedResult`, `parseCancelledResult`); rejected because it scatters the discriminator-to-variant dispatch across files and makes it harder to verify that a malformed variant is rejected before its body is read.

## `server-operations-extract-list-filter-from-query`

- **File**: `src/server/operations/list-filter-query-extractor.ts`
- **Rule**: `complexity`
- **Symbol**: `extractListFilterFromQuery`
- **Reason**: Single shared dispatcher that parses every supported `ListFilter` dimension from REST query parameters (status, type, tags, attributes, idPrefix, tenantId, failureCategory, createdAt, updatedAt, executionDeadline). Each branch is a one-liner mapping one filter field to one parser — splitting would scatter the per-dimension contract that both `list-workflows` and `aggregate-workflows` rely on.
