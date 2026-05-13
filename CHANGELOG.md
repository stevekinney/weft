# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — workflow visibility surface

`engine.list` and the `weft.workflows.list` operation now accept a richer
filter shape, and a new `engine.aggregate` / `weft.workflows.aggregate`
surface returns single-dimension group-by counts over the same filter.

- **`ListFilter` extensions.** New optional fields: `idPrefix`
  (restricted to `[A-Za-z0-9_-]+`), `createdAt` / `updatedAt` /
  `executionDeadline` time ranges (each accepts `gte`/`gt`/`lte`/`lt`),
  `tenantId` (string or array), and `failureCategory`. The `status`
  filter now also accepts an array of statuses.
- **`WorkflowSummary` extensions.** Three new optional fields are
  populated when present: `tenantId`, `executionDeadline`,
  `failureCategory`.
- **`engine.aggregate(filter, { groupBy, limit? })`** runs a single
  group-by over the visibility surface. `groupBy` is `status`, `type`,
  `tenant`, `failureCategory`, or `{ attribute: <name> }`. Groups are
  sorted `count desc, key asc`; the response carries `truncated: true`
  when more groups existed than `limit` allowed.
- **REST.** `GET /v1/workflows` accepts `?id_prefix`, `?tenant_id`
  (repeating), `?failure_category` (repeating), `?created_at_{gte,gt,lte,lt}`,
  `?updated_at_{...}`, `?execution_deadline_{...}`, and a list of
  `?status` values. `GET /v1/workflows/aggregate` is the new aggregate
  endpoint; `?group_by` accepts `status|type|tenant|failureCategory|attribute:<name>`.
- **JSON-RPC.** `weft.workflows.list` accepts the structured shape on
  every transport. `weft.workflows.aggregate` is new.
- **Errors.** Filter shape violations map to the existing
  `Unprocessable` fault (HTTP 400 / JSON-RPC -32602). New caps:
  `WorkflowListScanCapExceededError` (1,000,000 candidates) and
  `AggregateDistinctKeyCapExceededError` (100,000 distinct keys) both
  surface as `Unprocessable`. The aggregate cap is a hard error, never
  silently truncated, because scan-order would bias which groups win.

### Changed — `engine.list` ordering contract

Previously `engine.list` returned workflows in undocumented
storage-scan order, which depended on backend and on whether a
constrained-id fast path or full scan ran. The contract is now
**`createdAt` descending with `id` ascending as the tiebreaker**,
applied after filter intersection and before pagination. The prior
behavior was unspecified, so this is a tightening of the contract
rather than a break — but worth flagging for any caller that
unintentionally depended on the old order.

### Added — visibility indexes and backfill

A new family of secondary-index keys (`wf-idx-status:`, `wf-idx-type:`,
`wf-idx-tenant:`, `wf-idx-created:`, `wf-idx-updated:`,
`wf-idx-deadline:`, plus a per-workflow `wf-idx-manifest:`) lets
`engine.list` and `engine.aggregate` narrow candidates through indexes
rather than scanning every workflow.

- **Watermark gate.** The engine reads `wf-idx-meta:version` once per
  query and only consults the indexes when the persisted version
  matches `WORKFLOW_VISIBILITY_INDEX_VERSION`. Pre-watermark, queries
  fall back to the existing slow path with post-filtering — correct,
  just slower. `idPrefix` works in both states via a primary-key
  prefix scan.
- **Runtime lifecycle.** Every state-write chokepoint (start, fork,
  resume, update, tag mutation, completion, delayed-start → running,
  purge) keeps the indexes in sync via
  `buildWorkflowVisibilityIndexTransition`, which derives the
  previous-state keys directly from the prior `WorkflowState` so
  there is no extra storage read on the hot path.
- **Backfill.** `scripts/rebuild-workflow-visibility-indexes.ts`
  builds the indexes for an existing database. Conditional-batch
  pre-image guards against racing runtime writes; the watermark
  advances only on a zero-conflict pass. `--drop` removes the
  watermark first, then sweeps every `wf-idx-*` row, then clears the
  cursor — reversing the order would leave a window where the engine
  trusts a watermark for indexes that no longer exist. Storage
  backends without `conditionalBatch` must run the engine offline
  during the backfill.

### Changed — bulk filter scoping

`hasScopedBulkWorkflowFilter` (which gates destructive
`cancelAll` / `deleteAll` / `signalAll` / `mutateTagsAll` bulk
operations) now recognizes two new valid scopes:

- `tenantId` (non-empty after normalization, single or array).
- `idPrefix` (length ≥ 3 — short prefixes match too much to be safe).

`failureCategory` alone is **not** a valid scope: the engine doesn't
enforce the "failureCategory implies failed status" invariant, so
deleting on the attribute alone would be a footgun. Combine it with
`status` for a safe scope. Time ranges (`createdAt`, `updatedAt`,
`executionDeadline`) likewise need a non-temporal scope to qualify.

The error message returned when a bulk filter is too broad now
enumerates the new valid scopes.

### Removed (breaking)

The `weft/server/handler` subpath no longer exports the internal legacy route
precedence helpers `countLiteralSegments`, `countPathParameters`, or
`shouldPreferLegacyRoute`. Direct meta and discovery endpoints are now modeled
as reserved direct HTTP routes instead of legacy fallbacks.

The `weft/storage/compressed` subpath no longer exports
`AgentCompressionOptions`, and `CompressedStorage` no longer accepts
agent-specific compression option names (`agentWorkflowIds`, `agentAlgorithm`,
or `agentThreshold`). Compression now has one storage-level configuration path:
`CompressionOptions`.

## [0.1.0] - 2026-05-11

### Removed (breaking)

Weft no longer ships an AI agent surface. All agent loops, declarations, and
coordination primitives now live outside Weft — in an external agent
framework or in your own loop on top of `ctx.run()` and `ctx.review()`.

Removed exports:

- `executeAgentLoop`, `AgentLoopSuspendedError`
- `AgentOptions`, `AgentResult`, `AgentTool`, `PendingProviderResumeState`,
  `PersistedAgentLoopState`, `TurnUsageEntry`, `VerificationRecorder`
- `AgentBureauConversationHistory`, `ChatOptions`, `ChatResponse`,
  `ChatResumeContext`, `ChatResumeHint`, `ConversationHistoryMessage`,
  `LLMProvider`, `NormalizedChatResponse`
- `ToolCall`, `ToolCallInput`, `ToolDefinition`, `ToolDescriptor`,
  `ToolResult`, `ToolResultInput`, `ToolErrorShape`, `ToolActionShape`,
  `ToolErrorCategory`, `TokenUsage`
- `debate`, `handoff`, `supervise`, `createChildHeaders`
- `agent`, `isAgentDefinition`, `AgentDefinition`, `AgentToolDefinition`,
  `ToolIdentityResult`, `AgentRegistrationOptions`
- `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`,
  `AgentToolReturnedEvent`, `AgentCheckpointResumedEvent`,
  `AgentCheckpointSizeWarningEvent`, `WeftAgentEventMap`
- `Message`, `MessageRole`, `ConversationHistory`
- `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()` removed
  from `Context`

### Renamed (breaking)

The following generic primitives were promoted out of `src/ai/` and renamed:

- `ToolEffectLog` → `EffectLog` (class)
- `ToolCallReplayConflictError` → `EffectReplayConflictError`
- `EffectLog` constructor parameter `agentId` → `operationId`
- `EffectRecord.toolName` → `EffectRecord.effectName` (no observed
  persisted-data impact — Phase 0 inventory found zero stored records with
  the field)
- `HumanReviewRequestedEvent` → `ReviewRequestedEvent` (TypeScript symbol only)
- `HumanReviewCompletedEvent` → `ReviewCompletedEvent` (TypeScript symbol only)
- `WeftAgentEventMap` → `WeftReviewEventMap`
- `ctx.humanReview()` → `ctx.review()`
- `HumanReviewOptions.conversation` field removed

### Wire format

Persisted event `type` strings remain unchanged: `'human-review:requested'`
and `'human-review:completed'`. Historical event records replay without
migration.

### Migration

Weft now focuses on durable execution and human-in-the-loop review. If you
were using Weft's agent loop or coordination primitives, migrate to an
external agent framework or build your loop on top of `ctx.run()` and
`ctx.review()`.

---
