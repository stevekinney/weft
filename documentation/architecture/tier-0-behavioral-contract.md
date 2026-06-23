# Tier-0 Behavioral Contract

This contract gates the Tier-0 implementation work for activity result reconciliation, signal idempotency, concurrent-resume checkpoint ownership, and persisted-format rolling-upgrade support. It is intentionally stricter than the current implementation. Sections labeled "current behavior" describe Weft 0.1.0 behavior observed in source; sections labeled "Tier-0 required behavior" define what the follow-up implementation tasks must make true.

The goal is not blanket exactly-once execution. Weft can reconcile durable records it has committed. It cannot undo an external side effect that completed before the engine durably recorded the result. Activities that talk to payment processors, queues, email providers, or databases still need user-supplied idempotency keys for those external systems.

## Activity Result Reconciliation

### Current Behavior

Activity operations carry an `operationId` and `activityName`, but the execution path always passes `attempt: 1` to worker dispatch and interceptor metadata. `ActivityDefinition` exposes `idempotent`, `verify`, `visibilityTimeout`, `compensate`, `resourceScope`, and function-form `idempotencyKey`, but the checkpoint commit path does not persist a separate activity-reconciliation record. If an activity finishes and the process crashes before the checkpoint commit records its result, recovery has no durable activity result to replay.

### Tier-0 Required Behavior

Activity idempotency is result reconciliation scoped to one scheduled operation, not global deduplication by activity name. A reconciled activity key is scoped by:

| Field            | Source                                                                  | Required behavior                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`     | The owning workflow identifier.                                         | Required. Encoded with the same component escaping used by storage keys.                                                                                                                                              |
| `activityName`   | The activity dispatch name.                                             | Required. This is the registered activity name, not the function display name.                                                                                                                                        |
| `operationId`    | The scheduled operation identifier from the workflow operation request. | Required. If no stable operation identifier exists, the activity is non-reconcilable and no reconciliation record may be written. Parallel and named-branch operations use their deterministic operation identifiers. |
| `idempotencyKey` | The per-call option or activity definition function result.             | Optional. When absent, the activity is non-reconcilable across the hard crash window and must behave like current at-least-once dispatch.                                                                             |

The implementation task must add a record equivalent to:

| Field            | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `version`        | Record schema version, starting at `1`.                                           |
| `workflowId`     | Owning workflow identifier.                                                       |
| `activityName`   | Registered activity name.                                                         |
| `operationId`    | Scheduled operation identifier.                                                   |
| `idempotencyKey` | User-provided or definition-derived key, when present.                            |
| `status`         | `completed`, `failed`, `cancelled`, `timed-out`, or `indeterminate`.              |
| `result`         | Encoded activity result when `status` is `completed` and the result is available. |
| `error`          | Encoded failure category/message when the activity ended unsuccessfully.          |
| `createdAt`      | First accepted dispatch timestamp.                                                |
| `updatedAt`      | Last reconciliation update timestamp.                                             |

The exact storage key is an implementation detail for the follow-up task, but it must be independent from `op:{queue}:{scheduled}:{id}` task queue keys and must not collide across workflows, activity names, operation identifiers, or idempotency keys.

`verify` must return one of these states, not a boolean:

| Verify state                   | Meaning                                                                                    | Workflow behavior                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `not-completed`                | The external system reports no completed side effect for the idempotency key.              | Dispatch the activity.                                                                                   |
| `completed-with-result`        | The external system reports completion and can return the result required by the workflow. | Persist the reconciliation result and resume the workflow with that result.                              |
| `completed-result-unavailable` | The side effect completed, but the result cannot be reconstructed.                         | Fail the activity with a deterministic reconciliation error. Do not redispatch.                          |
| `indeterminate`                | The verifier cannot determine whether the side effect completed.                           | Fail the activity with a retryable-or-operator-visible reconciliation error. Do not silently redispatch. |

Activity outcomes must be handled as follows:

| Outcome                                     | Persisted record                                                                    | Workflow behavior                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Success                                     | `status: completed` with `result`.                                                  | Resume with the recorded result.                                         |
| Failure before external side effect         | `status: failed` with error metadata when known.                                    | Apply retry policy or fail according to the activity contract.           |
| Failure after possible external side effect | `status: indeterminate` unless `verify` proves a more specific state.               | Use `verify`; do not assume safe redispatch.                             |
| Cancellation                                | `status: cancelled` when cancellation was observed before completion.               | Throw cancellation into the workflow; do not record a successful result. |
| Timeout                                     | `status: timed-out` unless `verify` proves completion.                              | Use `verify` before redispatching a keyed activity.                      |
| Retryable failure                           | Preserve the latest failure metadata and retry only when `verify` permits dispatch. | Retry policy still bounds attempts.                                      |
| Retry exhaustion                            | Preserve final failure metadata.                                                    | Fail the workflow operation deterministically.                           |
| Verifier unavailable                        | No successful result record.                                                        | Treat as `indeterminate`; surface a retryable-or-operator-visible error. |
| Verifier contradiction                      | Preserve diagnostic metadata.                                                       | Fail closed; do not choose an arbitrary result.                          |

### Implementation Verification Target

The activity task must include crash-and-resume tests for every `verify` state, plus regression coverage that a no-key activity keeps current at-least-once behavior and does not claim reconciliation. Tests must prove that an external side effect completed before checkpoint commit is never represented as a successful workflow result unless a durable reconciliation record or verifier-provided result exists.

## Signal Idempotency

### Current Behavior

Signals are persisted under `sig:{workflowId}:{encodedSignalName}:{id}`. The current engine generates `id` with `crypto.randomUUID()` for every delivery. Public signal APIs do not accept `signalId`, and a retried caller without its own stable identifier can enqueue the same logical signal more than once.

### Tier-0 Required Behavior

`signalId` is an optional request-body field on REST, JSON-RPC, and generated client surfaces that deliver a signal. It is client-generated and recommended for any caller that may retry after timeout, disconnect, or ambiguous network failure. Existing callers without `signalId` remain valid, but their generated identifiers are fresh per accepted request and therefore are not idempotent across retries.

Signal idempotency is scoped by:

| Field        | Source                                 | Required behavior                       |
| ------------ | -------------------------------------- | --------------------------------------- |
| `workflowId` | Target workflow identifier.            | Required.                               |
| `signalName` | Signal definition name or string name. | Required.                               |
| `signalId`   | Client-provided request-body field.    | Required for idempotent retry behavior. |

Validation rules:

| Rule                           | Behavior                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Missing `signalId`             | Accept the request and generate a fresh identifier, preserving current non-idempotent retry behavior. |
| Empty or non-string `signalId` | Reject before signal persistence with the existing validation fault shape for that transport.         |
| Oversize `signalId`            | Reject before signal persistence when the UTF-8 encoded value exceeds 128 bytes.                      |
| Duplicate tuple                | Return the original accepted response when retained; do not enqueue another signal.                   |

`signalId` is a case-sensitive string. It must not be normalized by Unicode form, case, or trimming. Before any storage-key construction, implementations must pass it through the same key-component escaping used for workflow identifiers or through a fixed reversible byte encoding such as URL-safe base64. Two different UTF-8 byte sequences must never map to the same storage key, and the signal implementation task must include a collision regression for reserved characters such as `:`.

The implementation task must persist an accepted-response record equivalent to:

| Field              | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `version`          | Record schema version, starting at `1`.                               |
| `workflowId`       | Target workflow identifier.                                           |
| `signalName`       | Signal name.                                                          |
| `signalId`         | Client-generated signal identifier.                                   |
| `signalStorageKey` | The signal payload key accepted by the first request.                 |
| `response`         | Canonical accepted result metadata; see `AcceptedSignalResult` below. |
| `acceptedAt`       | First accepted timestamp.                                             |
| `expiresAt`        | Retention expiry timestamp.                                           |

`AcceptedSignalResult` is transport-independent. It records the accepted signal outcome, not a full HTTP or JSON-RPC envelope:

| Field              | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `accepted`         | Always `true` for a stored accepted result.           |
| `workflowId`       | Target workflow identifier.                           |
| `signalName`       | Signal name.                                          |
| `signalId`         | Client-generated signal identifier.                   |
| `acceptedAt`       | First accepted timestamp.                             |
| `signalStorageKey` | The signal payload key accepted by the first request. |

Duplicate retries over REST, JSON-RPC, or the client SDK read this canonical result and then wrap it in that request's transport-native success envelope. JSON-RPC replay must use the duplicate request's current `id`, not the original request's `id`. Tests must assert canonical-result equality, not byte-for-byte equality of transport envelopes.

Duplicate delivery must be atomic insert-or-read: two simultaneous requests with the same `(workflowId, signalName, signalId)` cannot both enqueue a signal. A storage backend without `conditionalBatch` must fail fast for idempotent signal delivery instead of falling back to a race-prone read-then-write path.

Crash windows:

| Crash point                                                   | Durable state                                                            | Retry behavior                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Before signal payload append                                  | No signal payload, no accepted response.                                 | Retry may accept and enqueue once.                                                                         |
| After signal payload append, before accepted-response record  | Signal may be delivered, but duplicate response cannot be reconstructed. | Retry must fail closed with `SignalAcceptanceIndeterminate`; it must not enqueue a second signal.          |
| After accepted-response record, before HTTP/JSON-RPC response | Signal and response metadata are durable.                                | Retry returns a transport-native response built from the original accepted result.                         |
| After response sent                                           | Signal and response metadata are durable.                                | Retry returns a transport-native response built from the original accepted result until retention expiry.  |
| After retention expiry                                        | Accepted-response record removed.                                        | Retry is treated as a new request and may enqueue again unless the implementation adds a tombstone policy. |

### Implementation Verification Target

The `SignalAcceptanceIndeterminate` fault is retryable only after operator inspection or retention cleanup. REST returns `409 Conflict`; JSON-RPC returns the Weft conflict code used for operation conflicts; the client SDK rejects with a typed Weft error whose `code` is `SignalAcceptanceIndeterminate`. The public fault includes `workflowId`, `signalName`, `signalId`, and a generated diagnostic correlation identifier, but never includes the signal payload.

The signal task must test duplicate `signalId` delivery for REST, JSON-RPC, and client SDK paths that expose the field. It must include a concurrent duplicate race test, a durable replay-after-crash test, requests without `signalId` (non-idempotent path), retention-expiry behavior, reserved-character key-collision coverage, canonical accepted-result replay, JSON-RPC duplicate replay with a different request `id`, cross-transport duplicate replay, and `SignalAcceptanceIndeterminate` transport assertions.

## Concurrent Resume And Checkpoint Ownership

This track is the future **`MultiEngine`** capability: safe recovery when more than one engine process may drive the same durable store. It is **not yet implemented**. Until it lands, the supported model is a single engine process per durable store (see [Recovery and Deploys](../guides/recovery-and-deploys.md)), and the requirements below describe what the follow-up work must make true — not current behavior.

There is intentionally **no public option** that claims safe concurrent recovery today. An earlier `requireConcurrentResumeSafety` flag only asserted `conditionalBatch` at the recovery boundary and was removed: it guarded the checkpoint _commit_ against corruption (a guarantee the CAS primitives already provide where it matters) but did nothing about the duplicate _execution_ — two owners both resuming a workflow and both running its next step — which is the actual hazard `MultiEngine` must solve with a fenced ownership claim acquired before execution.

### Current Behavior

`commitCheckpoint()` appends checkpoint, event-log, timeline, and index operations, then commits them with `storage.batch()`. It does not compare the current checkpoint head before writing. Storage adapters report whether `conditionalBatch` is available, and `requireStorageCapability()` can fail fast for features that need it, but checkpoint commit does not currently require CAS.

### Tier-0 Required Behavior

Checkpoint ownership is split into three deployment classes:

| Class                  | Requirement                                                                     | Behavior                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe CAS               | Storage supports `conditionalBatch` and checkpoint commit uses it.              | A commit succeeds only if the current checkpoint step/version still matches the value read by the owner. A losing owner receives a deterministic conflict. |
| Single-owner only      | Deployment guarantees one engine owner per workflow and does not require CAS.   | This is a documented operational constraint. It is valid only when recovery and steady-state ownership are serialized by deployment topology.              |
| Fail-fast CAS required | Configuration requires concurrent owners, but storage lacks `conditionalBatch`. | Engine startup or recovery fails before claiming work.                                                                                                     |

The CAS precondition is the current checkpoint step/version pair and the latest workflow state version observed before executing the operation. The follow-up implementation must define the concrete bytes compared, but it must not rely on an in-memory lock as the correctness mechanism.

Fail-fast enforcement belongs at the engine recovery/start boundary that can claim workflow ownership, not in a server-only wrapper. The implementation task must add a configuration switch equivalent to `checkpointOwnership: "single-owner" | "cas-required"`, defaulting to current single-owner behavior until the CAS task deliberately changes it. A `cas-required` engine using storage that reports `conditionalBatch: false` must throw `CheckpointOwnershipCapabilityError` before claiming ownership, starting recovery loops, or polling task queues. The diagnostic must name `conditionalBatch`, the selected ownership mode, and the storage adapter class name when available.

Mixed-version concurrent ownership is forbidden. Operators must prevent old and new engines from concurrently recovering or driving the same workflow during rollout by draining old owners, disabling recovery on one side, or using a deployment-level single-owner lease. If that precondition is violated before the CAS implementation lands, Weft provides no correctness guarantee.

### Implementation Verification Target

The CAS task must prove that two owners cannot both commit over the same checkpoint on a CAS-capable adapter. It must also test the documented single-owner mode and the `CheckpointOwnershipCapabilityError` fail-fast path for a backend whose `capabilities().conditionalBatch` is `false`.

## Persisted-Format Rolling-Upgrade Contract And Rollback

### Current Behavior

Weft stores hierarchical key-value records such as `wf:{id}`, `wf:{id}:ckpt`, `wf:{id}:ckpt:{step}`, `sig:{workflowId}:{encodedSignalName}:{id}`, `upd:{workflowId}:{updateId}`, and `upr:{updateId}`. Unknown key prefixes are generally ignored by scans that target specific prefixes, but older versions have not been tested against the Tier-0 activity and signal records because those records do not exist yet.

### Tier-0 Required Behavior

The Tier-0 policy is additive records plus rolling-upgrade support, with mixed-version concurrent ownership forbidden.

Rolling-upgrade matrix:

| Scenario                                      | Required behavior                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New writer, new reader                        | Full Tier-0 behavior.                                                                                                                                  |
| Old writer, new reader                        | New reader accepts missing Tier-0 records and applies non-idempotent behavior where no Tier-0 record exists.                                          |
| New writer, old reader during rolling upgrade | Old reader must ignore unknown additive record prefixes and must not corrupt them. It must not concurrently own the same workflow as a new reader.     |
| Downgrade after new records exist             | Downgrade is allowed only after workflows are drained or ownership is forced to old-version single-owner mode with accepted loss of Tier-0 guarantees. |
| Mixed old and new owners on one workflow      | Unsupported. Operators must prevent it; later CAS work may turn this into a deterministic conflict.                                                    |
| Cleanup or garbage collection                 | Retention jobs must delete only Tier-0 records whose owning workflow or response-retention window is complete.                                         |

New record prefixes must be additive: old engines that scan `wf:`, `sig:`, `upd:`, or `op:` must not see a Tier-0 record as a current workflow, signal, update, or operation. If a Tier-0 implementation needs to change an existing record shape, it must add a persisted-format test and update this contract first.

### Implementation Verification Target

Each Tier-0 implementation task must add persisted-format tests for its new records. At minimum, tests must prove that missing records apply non-idempotent behavior, unknown additive records do not break existing scans, and retention removes only records that are safe to remove.

## Storage Capability Requirements

`conditionalBatch` is the only runtime-gated storage capability today. Tier-0 signal idempotency and CAS checkpoint ownership both require it for race-free behavior. Activity result reconciliation also requires it when the implementation must atomically claim or reconcile a record before dispatch. Adapters that report `conditionalBatch: false` must fail fast for these Tier-0 features instead of using read-then-write fallback logic.

`atomicBatch`, `readAfterWrite`, and `scanConsistency` remain trusted correctness contracts. If an adapter lies about them, Weft cannot repair the resulting corruption at runtime. The storage durability-honesty task must keep the adapter matrix in [Storage: Consistency & capabilities](../guides/storage.md#consistency-capabilities) aligned with the claims used by this contract.

## Acceptance Checklist

- Activity section has current behavior, Tier-0 required behavior, implementation verification target, key scope, record shape, verify state table, and outcome matrix.
- Signal section has current behavior, Tier-0 required behavior, implementation verification target, uniqueness scope, validation table, accepted-response shape, concurrent duplicate rule, and crash-window table.
- Concurrent-resume section has current behavior, Tier-0 required behavior, implementation verification target, adapter classes, CAS precondition, fail-fast boundary, and mixed-version rollout precondition.
- Persisted-format section has current behavior, Tier-0 required behavior, implementation verification target, rolling-upgrade matrix, additive-record policy, downgrade behavior, and cleanup rule.
- No runtime source, transport schema, generated-client, or generated-artifact changes are part of this contract task.
