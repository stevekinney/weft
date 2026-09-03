# Error Codes

Weft exposes two stable string-code families:

- `WeftErrorCode` is the in-process error-class discriminator. It is the `code` property on public `WeftError` subclasses exported from `@lostgradient/weft`.
- `FaultCode` is the server operation fault discriminator. REST maps it to an HTTP status, and JSON-RPC carries it as `error.data.weftCode`.

Use codes instead of parsing human-readable messages. Messages are for people; codes are for routing.

## WeftErrorCode

`WeftErrorCode` values equal their public error class names.

| Code                                        | Class                                       | Triggering scenario                                                                                                                                                                 | Operational outcome                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowAlreadyExistsError`                | `WorkflowAlreadyExistsError`                | `Engine.start()` is asked to create a workflow id that already exists and no idempotent or terminal-reuse policy applies.                                                           | Catchable operation conflict                                                                                                                                                                                                                                  |
| `BulkDeleteRequiresTerminalWorkflowsError`  | `BulkDeleteRequiresTerminalWorkflowsError`  | `Engine.deleteAll()` would delete at least one non-terminal workflow.                                                                                                               | Catchable validation error                                                                                                                                                                                                                                    |
| `BulkOperationConfirmationError`            | `BulkOperationConfirmationError`            | A committed bulk operation uses a stale or mismatched dry-run confirmation token.                                                                                                   | Catchable validation error                                                                                                                                                                                                                                    |
| `WorkflowTypeNotRegisteredForRecoveryError` | `WorkflowTypeNotRegisteredForRecoveryError` | Recovery finds running workflows whose workflow type is not registered on the engine.                                                                                               | Boot/recovery blocker until registration is fixed or explicitly acknowledged                                                                                                                                                                                  |
| `EngineCreateNameMismatchError`             | `EngineCreateNameMismatchError`             | `Engine.create()` receives a workflow or activity map key that does not match the definition's runtime name.                                                                        | Boot/configuration blocker                                                                                                                                                                                                                                    |
| `EngineDisposedError`                       | `EngineDisposedError`                       | A pending workflow result waiter is rejected because the engine was disposed before completion.                                                                                     | Catchable shutdown error                                                                                                                                                                                                                                      |
| `EngineDisposalError`                       | `EngineDisposalError`                       | Queued inline work failed during shutdown; inspect `leaseReleased` and `cause` for the release result and drain failure.                                                            | Catchable shutdown error                                                                                                                                                                                                                                      |
| `WorkflowNotFoundError`                     | `WorkflowNotFoundError`                     | An engine or handle operation targets a workflow id that is not present in storage.                                                                                                 | Catchable not-found error                                                                                                                                                                                                                                     |
| `WorkflowNotRegisteredError`                | `WorkflowNotRegisteredError`                | A start, schedule, or registry-driven path names an unregistered workflow type.                                                                                                     | Catchable configuration error                                                                                                                                                                                                                                 |
| `WorkflowConcurrencyLimitExceededError`     | `WorkflowConcurrencyLimitExceededError`     | A workflow definition's `concurrency` policy has no free slot for the requested workflow type or partition key.                                                                     | Catchable start-admission rejection                                                                                                                                                                                                                           |
| `WorkflowSuspendNotSupportedError`          | `WorkflowSuspendNotSupportedError`          | `suspend()` is requested for worker execution mode, where suspension is not supported.                                                                                              | Catchable unsupported-operation error                                                                                                                                                                                                                         |
| `ActivityResolutionError`                   | `ActivityResolutionError`                   | Activity dispatch cannot resolve the requested activity from the workflow-scoped or global activity registry.                                                                       | Fails the current workflow turn/run                                                                                                                                                                                                                           |
| `BranchTopologyChangedError`                | `BranchTopologyChangedError`                | `ctx.all`, `ctx.race`, or `ctx.runAll` branch count or ordered keys differ from the cached retry entry.                                                                             | Fails the current workflow as non-deterministic                                                                                                                                                                                                               |
| `PersistedDataIncompatibleError`            | `PersistedDataIncompatibleError`            | Stored Weft data carries an older persisted-data schema version than this engine accepts.                                                                                           | Boot/storage blocker                                                                                                                                                                                                                                          |
| `PersistedDataCorruptError`                 | `PersistedDataCorruptError`                 | Stored Weft data cannot be decoded or violates the persisted record shape expected for its key.                                                                                     | Boot/storage blocker until the corrupt record is repaired or removed                                                                                                                                                                                          |
| `WorkflowTimeoutError`                      | `WorkflowTimeoutError`                      | A workflow exceeds its execution or run timeout, or the history circuit breaker force-terminates it.                                                                                | Terminal workflow failure with optional `terminationReason`                                                                                                                                                                                                   |
| `HttpClientError`                           | `HttpClientError`                           | `HttpClient` receives a non-OK REST response, a JSON-RPC error envelope, or an invalid JSON-RPC response.                                                                           | Catchable client transport error                                                                                                                                                                                                                              |
| `WorkerProtocolIncompatibleError`           | `WorkerProtocolIncompatibleError`           | A remote worker advertises a protocol version the server cannot accept.                                                                                                             | Worker registration failure                                                                                                                                                                                                                                   |
| `UpdateTimeoutError`                        | `UpdateTimeoutError`                        | `engine.update()` or `handle.update()` does not receive a response within the configured timeout.                                                                                   | Catchable request timeout                                                                                                                                                                                                                                     |
| `UpdateValidationError`                     | `UpdateValidationError`                     | A workflow update is rejected by its pre-acceptance validator before durable write.                                                                                                 | Catchable validation error                                                                                                                                                                                                                                    |
| `WorkflowTerminalError`                     | `WorkflowTerminalError`                     | An update is sent to a workflow that is already completed, failed, cancelled, or timed out.                                                                                         | Catchable terminal-state error                                                                                                                                                                                                                                |
| `WorkflowBuilderError`                      | `WorkflowBuilderError`                      | The fluent workflow builder is used in an invalid order or with duplicate/incompatible builder calls.                                                                               | Definition-time configuration error                                                                                                                                                                                                                           |
| `VersionMismatchError`                      | `VersionMismatchError`                      | Recovery sees a stored workflow version that differs from the registered workflow version.                                                                                          | Isolated to that one workflow by default (see [Version drift](../guides/recovery-and-deploys.md#version-drift-versionmismatchpolicy)); `recoverAll({ versionMismatchPolicy: 'throw' })` rejects at the first mismatch and leaves later scan entries unresumed |
| `EffectReplayConflictError`                 | `EffectReplayConflictError`                 | An effect-log record was in flight at crash and cannot prove whether the external effect completed.                                                                                 | Requires operator or domain-specific reconciliation                                                                                                                                                                                                           |
| `ReviewTimeoutError`                        | `ReviewTimeoutError`                        | A human review request exceeds its configured timeout or escalation budget.                                                                                                         | Workflow-visible timeout error                                                                                                                                                                                                                                |
| `AtomicStateConflictError`                  | `AtomicStateConflictError`                  | A storage-backed atomic state update cannot commit after its retry budget.                                                                                                          | Catchable compare-and-swap conflict                                                                                                                                                                                                                           |
| `StandardSchemaValidationError`             | `StandardSchemaValidationError`             | Standard Schema validation rejects an operation field at a boundary that opts into runtime validation.                                                                              | Catchable validation error                                                                                                                                                                                                                                    |
| `ActivityReconciliationCapabilityError`     | `ActivityReconciliationCapabilityError`     | Keyed activity reconciliation is used with storage that lacks `conditionalBatch`.                                                                                                   | Configuration/storage-capability blocker                                                                                                                                                                                                                      |
| `ActivityReconciliationConflictError`       | `ActivityReconciliationConflictError`       | A keyed activity reconciliation marker changes between read and compare-and-set transition.                                                                                         | Retryable workflow-turn conflict                                                                                                                                                                                                                              |
| `ActivityReconciliationIndeterminateError`  | `ActivityReconciliationIndeterminateError`  | A keyed activity has a prior dispatch marker but the engine cannot prove the external outcome.                                                                                      | Requires external reconciliation                                                                                                                                                                                                                              |
| `DurableActivityScopeError`                 | `DurableActivityScopeError`                 | `durableActivity()` is called outside an active inline `ctx.memo()` scope, after scope closure, or without awaiting.                                                                | Workflow-visible helper usage error                                                                                                                                                                                                                           |
| `DurableActivityUnsupportedError`           | `DurableActivityUnsupportedError`           | A helper-launched activity uses a feature that is unsafe in a plain async memo scope, such as `completeAsync()`.                                                                    | Workflow-visible unsupported-boundary error                                                                                                                                                                                                                   |
| `AsyncActivityTokenNotFoundError`           | `AsyncActivityTokenNotFoundError`           | Async activity completion/failure names an unknown, already-used, or wrong-engine token.                                                                                            | Catchable callback-token error                                                                                                                                                                                                                                |
| `ActivityScheduleToCloseTimeoutError`       | `ActivityScheduleToCloseTimeoutError`       | An activity retry cannot fit inside its `scheduleToCloseTimeout` budget, or the budget has elapsed.                                                                                 | Timeout-classified activity failure                                                                                                                                                                                                                           |
| `ActivityPerAttemptTimeoutError`            | `ActivityPerAttemptTimeoutError`            | An inline activity attempt exceeds its per-attempt `timeout` wall-clock cap before it settles.                                                                                      | Timeout-classified activity failure; retryable when policy permits                                                                                                                                                                                            |
| `PayloadSizeExceededError`                  | `PayloadSizeExceededError`                  | Workflow input, signal payload, or activity result exceeds `payloadSize.maxBytes` before durable write.                                                                             | Admission failure for that payload                                                                                                                                                                                                                            |
| `StartOrSignalConflictError`                | `StartOrSignalConflictError`                | `engine.startOrSignal()` targets a terminal workflow without restart enabled, so the run cannot accept the signal.                                                                  | Catchable conflict                                                                                                                                                                                                                                            |
| `WorkflowTeardownPendingError`              | `WorkflowTeardownPendingError`              | A restart under the same workflow id is refused while the prior terminal run still owes engine-driven finalizer teardown.                                                           | Transient conflict; retry after teardown                                                                                                                                                                                                                      |
| `IdempotencyKeyPurgedError`                 | `IdempotencyKeyPurgedError`                 | A start idempotency key maps to a workflow record that was purged or deleted while the key intentionally survived.                                                                  | Catchable spent-key conflict                                                                                                                                                                                                                                  |
| `WorkerManifestBuildError`                  | `WorkerManifestBuildError`                  | `buildWorkerManifestFromRegistry()` is asked to advertise a workflow or activity name the source `Engine` has not registered.                                                       | Build-time blocker; fix the declared `workflows` map or register the missing definition                                                                                                                                                                       |
| `OwnershipModeMismatchError`                | `OwnershipModeMismatchError`                | Engine construction under `ownership: 'lease'` or `'workflow-lease'` finds the store's `ownership-mode-marker` naming a different fencing mode than this engine is configured with. | Boot/configuration blocker; stop every engine pointed at the store, agree on one fencing mode, then restart                                                                                                                                                   |
| `WorkflowCatalogConflictError`              | `WorkflowCatalogConflictError`              | `engine.workflows.install()` is asked to install `(name, revision)` that is already durably installed with different contract content.                                              | Catchable conflict; install a genuinely different revision instead of reusing this one                                                                                                                                                                        |
| `WorkflowRevisionNotInstalledError`         | `WorkflowRevisionNotInstalledError`         | `engine.workflows.activate()` is asked to activate a `(name, revision)` that was never installed.                                                                                   | Catchable not-found; install the revision first                                                                                                                                                                                                               |

`WorkflowClaimUnavailableError` intentionally carries no stable `WeftErrorCode` and so does not appear in the table above; like the other uncoded lease errors it is documented through its own JSDoc. It is thrown when an explicit single-workflow caller such as `engine.resume(id)` loses the per-workflow ownership-claim CAS under `ownership: 'workflow-lease'` because another engine still holds a live claim; never thrown from background scanning. Match it by `instanceof` rather than `.code`.

## FaultCode

REST operation handlers map each `FaultCode` to the HTTP status below. The additive REST body is `{ "error": "<message>", "weftCode": "<optional fine-grained code>", "data": { ... } }`; `weftCode` and `data` are omitted when unavailable. `EngineFailure` remains byte-identically masked to `{ "error": "Internal server error" }`. JSON-RPC transports always return HTTP 200 for a valid JSON-RPC envelope and put the HTTP-equivalent status plus the symbolic code in `error.data`.

REST fault example:

```json
{
  "error": "Workflow \"checkout-42\" not found",
  "weftCode": "WorkflowNotFoundError",
  "data": {
    "resource": "workflow",
    "identifier": "checkout-42"
  }
}
```

REST exposes a smaller, audited data projection than JSON-RPC:

| FaultCode              | REST `data` fields                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `Unauthorized`         | omitted                                                                             |
| `Forbidden`            | omitted                                                                             |
| `NotFound`             | `{ resource, identifier? }`                                                         |
| `Conflict`             | `{ missingTypes?, missingWorkflowCount?, samplesTruncated? }`                       |
| `Unprocessable`        | omitted                                                                             |
| `Timeout`              | `{ operationName? }`, omitted when absent                                           |
| `PayloadTooLarge`      | `{ maxBytes }`                                                                      |
| `NotImplemented`       | omitted                                                                             |
| `UnsupportedTransport` | `{ transport, supported }`                                                          |
| `SubscriptionOverflow` | `{ droppedCount }`                                                                  |
| `InvalidParams`        | `{ issues }` when non-empty; each issue is limited to `path`, `message`, and `code` |
| `MethodNotFound`       | `{ method }`                                                                        |
| `EngineFailure`        | omitted; the whole response remains the fixed masked body shown above               |

The projection deliberately withholds authentication and authorization reasons, generic internal reasons, subscription identifiers, raw causes, stack traces, credentials, storage details, file paths, and workflow identifiers beyond the caller-supplied `NotFound.identifier`. Recovery conflicts may expose registered workflow type names and counts, but never the affected workflow IDs.

`POST /v1/recover` places `missingTypes`, `missingWorkflowCount`, and `samplesTruncated` under `data` for uniform `HttpClientError.data` handling.

The flat REST body does not add the coarse `FaultCode`; use the HTTP status plus the documented `data` shape, and use top-level `weftCode` only when present. JSON-RPC continues to carry the coarse code in `error.data.weftCode`.

JSON-RPC error envelope:

```json
{
  "jsonrpc": "2.0",
  "id": "request-id",
  "error": {
    "code": -32020,
    "message": "Workflow not found",
    "data": {
      "weftCode": "NotFound",
      "httpStatus": 404
    }
  }
}
```

| FaultCode              | HTTP status | JSON-RPC code | JSON-RPC data payload                                                                       |
| ---------------------- | ----------- | ------------- | ------------------------------------------------------------------------------------------- |
| `Unauthorized`         | `401`       | `-32010`      | `{ reason, weftCode, httpStatus }`                                                          |
| `Forbidden`            | `403`       | `-32011`      | `{ reason, weftCode, httpStatus }`                                                          |
| `NotFound`             | `404`       | `-32020`      | `{ resource, identifier?, weftCode, httpStatus }`                                           |
| `Conflict`             | `409`       | `-32021`      | `{ reason, missingTypes?, missingWorkflowCount?, samplesTruncated?, weftCode, httpStatus }` |
| `Unprocessable`        | `422`       | `-32022`      | `{ reason, weftCode, httpStatus }`                                                          |
| `Timeout`              | `408`       | `-32023`      | `{ operationName?, weftCode, httpStatus }`                                                  |
| `PayloadTooLarge`      | `413`       | `-32024`      | `{ maxBytes, weftCode, httpStatus }`                                                        |
| `NotImplemented`       | `501`       | `-32025`      | `{ weftCode, httpStatus }`                                                                  |
| `UnsupportedTransport` | `501`       | `-32030`      | `{ transport, supported, weftCode, httpStatus }`                                            |
| `SubscriptionOverflow` | `500`       | `-32031`      | `{ subscriptionId, droppedCount, weftCode, httpStatus }`                                    |
| `InvalidParams`        | `400`       | `-32602`      | `{ issues, weftCode, httpStatus }`                                                          |
| `MethodNotFound`       | `404`       | `-32601`      | `{ method, weftCode, httpStatus }`                                                          |
| `EngineFailure`        | `500`       | `-32099`      | `{ weftCode, httpStatus }`                                                                  |

`InvalidParams` and `MethodNotFound` use the JSON-RPC 2.0 reserved numeric codes. All other Weft operation faults use the `-32010..-32099` application-defined range.

## Error Helpers

Use `isWeftError()` when you are catching errors from the same loaded copy of Weft and want class-instance narrowing. Use `isWeftErrorLike()` when the error may cross a realm, worker, RPC boundary, or duplicate-module boundary. Use `isWeftErrorCode()` for a bare unknown code string, not for a caught error object.

The full `isWeftFault`/`isWeftError`/`isWeftErrorCode`/`isWeftErrorLike`/`WeftError`/`WeftErrorCode` family is exported from both `@lostgradient/weft` and `@lostgradient/weft/client`, so browser client code can classify errors without importing the root barrel (which also re-exports server-only, Node-dependent code).

```ts
import {
  isWeftError,
  isWeftErrorCode,
  isWeftErrorLike,
  type WeftErrorCode,
} from '@lostgradient/weft';

function routeError(error: unknown): 'missing' | 'conflict' | 'weft' | 'unknown' {
  if (isWeftErrorLike(error)) {
    if (error.code === 'WorkflowNotFoundError') return 'missing';
    if (error.code === 'WorkflowAlreadyExistsError') return 'conflict';
    return 'weft';
  }
  return 'unknown';
}

function normalizeCode(value: unknown): WeftErrorCode | undefined {
  return isWeftErrorCode(value) ? value : undefined;
}

function sameRealmMessage(error: unknown): string | undefined {
  return isWeftError(error) ? `${error.code}: ${error.message}` : undefined;
}

void routeError;
void normalizeCode;
void sameRealmMessage;
```

Use `isWeftFault(error, code)` to branch on a specific `WeftErrorCode` without caring whether the error came from `LocalClient` (an in-process typed error) or `HttpClient`'s REST-backed methods (`start`, `get`, `signal`, `update`, and the other ergonomic methods in `src/client/http-client.ts`, which throw an `HttpClientError` carrying `weftCode` whenever the fault's `data.weftCode` was populated server-side):

```ts
import { isWeftFault } from '@lostgradient/weft/client';

// The same branch holds for LocalClient and HttpClient's REST-backed methods.
function rethrowUnlessMissing(error: unknown): void {
  if (!isWeftFault(error, 'WorkflowNotFoundError')) {
    throw error;
  }
}

void rethrowUnlessMissing;
```

> [!WARNING] JSON-RPC-backed `HttpClient.call()` / `client.operations.*` entries do not currently carry `weftCode`
> Most generated operations use JSON-RPC over HTTP. The JSON-RPC error envelope's `data.weftCode` carries the coarse `FaultCode` (e.g. `NotFound`, `Conflict`), not the fine-grained `WeftErrorCode` — a pre-existing gap, not something this change addresses. `HttpClientError.weftCode` therefore stays `undefined` for errors thrown by those entries, so `isWeftFault(error, code)` returns `false` even for a genuine match. Ordinary REST-only entries use their generated REST binding metadata and retain the same REST error shaping as ergonomic methods. Branch on `HttpClientError.faultCode` (a `FaultCode`) for JSON-RPC-backed `client.operations.*` calls.
>
> REST responses are not guaranteed to carry `weftCode`: `shapeRestFault` writes it only when the underlying fault has a fine-grained public code. Audited REST `data` is independent of that field, so callers can still use `HttpClientError.data` for validation and resource context when `HttpClientError.weftCode` is `undefined`.

`HttpClientError` carries the server-side `FaultCode` when the response includes a recognized structured fault:

```ts
import { HttpClientError } from '@lostgradient/weft';

function retryableServerFault(error: unknown): boolean {
  return error instanceof HttpClientError && error.faultCode === 'Timeout';
}

void retryableServerFault;
```
