# Migration Guide

This is the canonical location for per-release migration guidance. When a release changes a public API, storage layout, or wire contract in a backward-incompatible way, the steps for moving existing call sites and data live here, organized by release. See [Breaking Changes](../contributing/breaking-changes.md) for the policy that governs what counts as breaking and what each release must document.

> [!NOTE]
> Weft is pre-1.0, so breaking changes can land between releases without the stability guarantees a 1.0 line would carry. Each release that ships one documents its migration steps here, organized by release.

## Unreleased

### `GET /v1/registry` advances to `registryVersion: 2` (WFT-6)

`weft.system.registry` / `GET /v1/registry`'s response shape changed. `workflows` was a flat `Record<name, entry>`; it is now an array of `WorkflowRevisionManifest` (WFT-5's canonical vocabulary), sorted by `(name, revision)`, and a new `activeRevisions: Record<name, revision>` field points each workflow name at its currently active manifest in that array. A new `generatedAt` field reports an informational ISO-8601 timestamp. `activities` is unchanged.

If you consume this endpoint directly (rather than through `weft codegen` or the bundled Console, both already updated), resolve a workflow's active entry as:

```ts partial
const snapshot = await fetch('/v1/registry').then((response) => response.json());
const activeRevision = snapshot.activeRevisions['checkout'];
const manifest = snapshot.workflows.find(
  (candidate: { name: string; revision: string }) =>
    candidate.name === 'checkout' && candidate.revision === activeRevision,
);
const contract = manifest?.contract; // { name, workflowVersion, inputSchema, outputSchema, ... }
```

`registryVersion: 1` is rejected outright — there is no compatibility layer. A vendored `--from` snapshot for `weft codegen` must be regenerated against a `registryVersion: 2` server; `weft codegen --from old-snapshot.json ...` now fails with `codegen: registryVersion 1 is not supported (expected 2); upgrade or regenerate the snapshot`.

Two smaller, related behavior changes: a workflow's `tags` now come back alphabetically sorted rather than in registration order, and a registered workflow whose contract exceeds a WFT-5 hostile-input limit (an identifier over 512 bytes, more than 512 signal/update/query/activity entries, schema nesting past 64 levels, or a normalized contract over 256 KiB) now fails the entire registry snapshot with a masked `500` — none of those bounds are enforced at registration time, so a registration the engine previously accepted without incident can now break `GET /v1/registry` until the offending field is shortened.

No persisted-data schema change: `GET /v1/registry` is a derived, non-persisted introspection snapshot, not stored state.

### `buildWorkerManifestFromRegistry()` digest values changed (WFT-5)

`contractHash` and `workflowRevision` on `WorkerWorkflowContract`, and `contractHash` on `WorkerActivityContract`, now route through the canonical `contractHash()`/`deriveWorkflowRevision()`/`activityContractHash()` functions (`core/contract`) instead of `registry-contract-builder.ts`'s own ad hoc hashing. The formula folds in a `contractVersion` domain separator the old one never had, so the digest **strings** for an otherwise-unchanged registration differ from prior 0.23.x output.

No action required unless you pin literal digest strings in your own tests or fixtures — regenerate them against the new output. Nothing decodes or replays by recomputing an old digest and comparing it to a stored value using this formula (`WorkerExecutionIdentity`/task-ledger provenance records store already-computed digest strings as immutable history), so this is not a persisted-data schema change and does not require a fresh store.

### Unversioned workflow registration now defaults to `'0.0.0'`

`engine.register()` previously defaulted an unversioned workflow's stored `version` to the literal `'1'`. It now defaults to `DEFAULT_WORKFLOW_VERSION` (`'0.0.0'`), matching what `weft version:check`, the internal worker realm, and `RemoteWorkerOptions` already assumed the unversioned default was.

If you have a workflow still running (or parked, pending recovery) that was started unversioned under an older release, its stored version is `'1'`. Recovering it against a still-unversioned re-registration on this release now compares stored `'1'` against registered `'0.0.0'` and is rejected as a version mismatch (`VersionMismatchError`). Before upgrading, either:

- let those in-flight runs drain (complete or terminate) on the prior release first, or
- pin an explicit `version: '1'` on the affected `workflow({ ... })` registration until they have drained, then remove the pin.

New, freshly started unversioned workflows are unaffected — they simply record `'0.0.0'` instead of `'1'`.

## Migrating from 0.2.x or 0.1.x to 0.3.0

### Remove built-in multi-tenancy

Weft 0.3.0 removed the built-in tenant policy and quota layer. The open-source core is now single-tenant and exposes generic prefix-scoping primitives instead.

- Remove imports of `tenantFromInputField`, `TenantContext`, `TenantResolver`, `QuotaExceededError`, `TenantQuotaOptions`, `TenantQuotaUsage`, `TenantQuotaMetricUsage`, `TenantWorkflowCreationRateLimit`, and `TenantWorkflowCreationRateUsage`.
- Remove `EngineOptions.tenantResolver`, `EngineOptions.quotas`, `engine.getQuotaUsage()`, `ctx.tenant`, `ctx.state.tenant()`, `ListFilter.tenantId`, and aggregate `groupBy: 'tenant'` call sites.
- Replace `ctx.state.workflow(tenantId, ...)` and `engine.state.workflow(tenantId, ...)` with the tenant-free workflow state factories. If you still need partitioning, wrap storage with `ScopedStorage` or carry the partition key in your own workflow input, state, and search attributes.
- Remove calls to `GET /v1/tenants/:id/quota`, the `quota:read` authorization scope, the `RateLimited` fault-code branch, and JWT tenant-claim checks in server integrations.
- Plan operator-owned data movement for old `state:workflow:<tenantId>:` or `state:tenant:<tenantId>:` keyspaces. Weft 0.3.0 still decodes older workflow and schedule records that contain a `tenant` field, but it drops that field on read and does not migrate tenant-scoped state into the new `state:workflow-scope:` namespace.

### Update renamed engine options

Rename `EngineOptions.workerExecution.concurrency` to `EngineOptions.workerExecution.poolSize`. The activity worker option already used `poolSize`; 0.3.0 made the workflow worker option match it.

### Remove non-functional and internal exports

Several public names were removed because they were non-functional, internal, or tied to the removed agent language:

- Delete `EngineOptions.suspendOnLlmWait`; `true` always threw and `false` was a no-op.
- Stop importing `countLiteralSegments`, `countPathParameters`, and `shouldPreferLegacyRoute` from `weft/server/handler`; direct meta and discovery routes no longer use those internal precedence helpers.
- Replace `AgentCompressionOptions` and compressed-storage option fields `agentWorkflowIds`, `agentAlgorithm`, and `agentThreshold` with the storage-level `CompressionOptions` shape.

### Move to builder-based registration

The deprecated registration overloads and module augmentation bridge were removed. Use the chained builder form everywhere:

- Replace `engine.register(name, handler)` with `engine.register(workflow({ name }).execute(handler))`.
- Replace `engine.register(name, registrationObject)` with `workflow({ name, version, description, tags, inputSchema, outputSchema }).searchAttributes(...).execute(handler)`.
- Replace bare `workflow(handler)` and `workflow({ ..., handler })` forms with `workflow(options).execute(handler)`.
- Replace the removed `WorkflowRegistration` and `WorkflowDefinitionOptions` types with `BuiltWorkflowDefinition` or the builder return type.
- Replace global `interface ActivityTypes` augmentation and `ctx.run<'activityName'>(...)` with per-workflow `.activities({ ... })` typing. `weft codegen` now emits `WorkflowRegistry` only.

### Remove the 0.1.x agent surface

Weft no longer ships an AI agent surface. Agent loops, declarations, and coordination primitives must move to an external agent framework or to application code built on top of `ctx.run()` and `ctx.review()`.

- Remove calls to `executeAgentLoop`, `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()`, `debate`, `handoff`, `supervise`, and `createChildHeaders`.
- Remove imports of the old agent and tool types, including `AgentOptions`, `AgentResult`, `AgentTool`, `ToolCall`, `ToolDefinition`, `ToolResult`, `TokenUsage`, `AgentDefinition`, `AgentToolDefinition`, `Message`, `MessageRole`, and `ConversationHistory`.
- Remove imports of agent lifecycle events such as `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`, `AgentToolReturnedEvent`, `AgentCheckpointResumedEvent`, `AgentCheckpointSizeWarningEvent`, and `WeftAgentEventMap`.
- Rebuild agent orchestration outside Weft. Keep Weft responsible for durable execution boundaries, activity dispatch, and human review.

### Apply 0.1.x primitive renames

The generic primitives that survived the agent removal were renamed:

- `ToolEffectLog` became `EffectLog`.
- `ToolCallReplayConflictError` became `EffectReplayConflictError`.
- `EffectLog` constructor option `agentId` became `operationId`.
- `EffectRecord.toolName` became `EffectRecord.effectName`.
- `HumanReviewRequestedEvent` became `ReviewRequestedEvent`; `HumanReviewCompletedEvent` became `ReviewCompletedEvent`.
- `WeftAgentEventMap` became `WeftReviewEventMap`.
- `ctx.humanReview()` became `ctx.review()`.
- Remove `HumanReviewOptions.conversation`.

Persisted review event type strings remain `human-review:requested` and `human-review:completed`, so historical event records replay without a data migration.
