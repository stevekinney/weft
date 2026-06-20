# Error Codes

Weft exposes two stable string-code families:

- `WeftErrorCode` is the in-process error-class discriminator. It is the `code` property on public `WeftError` subclasses exported from `@lostgradient/weft`.
- `FaultCode` is the server operation fault discriminator. REST maps it to an HTTP status, and JSON-RPC carries it as `error.data.weftCode`.

Use codes instead of parsing human-readable messages. Messages are for people; codes are for routing.

## WeftErrorCode

`WeftErrorCode` values equal their public error class names.

| Code                                        | Class                                       | Triggering scenario                                                                                                       | Operational outcome                                                          |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `WorkflowAlreadyExistsError`                | `WorkflowAlreadyExistsError`                | `Engine.start()` is asked to create a workflow id that already exists and no idempotent or terminal-reuse policy applies. | Catchable operation conflict                                                 |
| `BulkDeleteRequiresTerminalWorkflowsError`  | `BulkDeleteRequiresTerminalWorkflowsError`  | `Engine.deleteAll()` would delete at least one non-terminal workflow.                                                     | Catchable validation error                                                   |
| `BulkOperationConfirmationError`            | `BulkOperationConfirmationError`            | A committed bulk operation uses a stale or mismatched dry-run confirmation token.                                         | Catchable validation error                                                   |
| `WorkflowTypeNotRegisteredForRecoveryError` | `WorkflowTypeNotRegisteredForRecoveryError` | Recovery finds running workflows whose workflow type is not registered on the engine.                                     | Boot/recovery blocker until registration is fixed or explicitly acknowledged |
| `EngineCreateNameMismatchError`             | `EngineCreateNameMismatchError`             | `Engine.create()` receives a workflow or activity map key that does not match the definition's runtime name.              | Boot/configuration blocker                                                   |
| `EngineDisposedError`                       | `EngineDisposedError`                       | A pending workflow result waiter is rejected because the engine was disposed before completion.                           | Catchable shutdown error                                                     |
| `WorkflowNotFoundError`                     | `WorkflowNotFoundError`                     | An engine or handle operation targets a workflow id that is not present in storage.                                       | Catchable not-found error                                                    |
| `WorkflowNotRegisteredError`                | `WorkflowNotRegisteredError`                | A start, schedule, or registry-driven path names an unregistered workflow type.                                           | Catchable configuration error                                                |
| `WorkflowConcurrencyLimitExceededError`     | `WorkflowConcurrencyLimitExceededError`     | A workflow definition's `concurrency` policy has no free slot for the requested workflow type or partition key.           | Catchable start-admission rejection                                          |
| `WorkflowSuspendNotSupportedError`          | `WorkflowSuspendNotSupportedError`          | `suspend()` is requested for worker execution mode, where suspension is not supported.                                    | Catchable unsupported-operation error                                        |
| `ActivityResolutionError`                   | `ActivityResolutionError`                   | Activity dispatch cannot resolve the requested activity from the workflow-scoped or global activity registry.             | Fails the current workflow turn/run                                          |
| `BranchTopologyChangedError`                | `BranchTopologyChangedError`                | `ctx.all`, `ctx.race`, or `ctx.runAll` branch count or ordered keys differ from the cached retry entry.                   | Fails the current workflow as non-deterministic                              |
| `PersistedDataIncompatibleError`            | `PersistedDataIncompatibleError`            | Stored Weft data carries an older persisted-data schema version than this engine accepts.                                 | Boot/storage blocker                                                         |
| `WorkflowTimeoutError`                      | `WorkflowTimeoutError`                      | A workflow exceeds its execution or run timeout, or the history circuit breaker force-terminates it.                      | Terminal workflow failure with optional `terminationReason`                  |
| `HttpClientError`                           | `HttpClientError`                           | `HttpClient` receives a non-OK REST response, a JSON-RPC error envelope, or an invalid JSON-RPC response.                 | Catchable client transport error                                             |
| `WorkerProtocolIncompatibleError`           | `WorkerProtocolIncompatibleError`           | A remote worker advertises a protocol version the server cannot accept.                                                   | Worker registration failure                                                  |
| `UpdateTimeoutError`                        | `UpdateTimeoutError`                        | `engine.update()` or `handle.update()` does not receive a response within the configured timeout.                         | Catchable request timeout                                                    |
| `UpdateValidationError`                     | `UpdateValidationError`                     | A workflow update is rejected by its pre-acceptance validator before durable write.                                       | Catchable validation error                                                   |
| `WorkflowTerminalError`                     | `WorkflowTerminalError`                     | An update is sent to a workflow that is already completed, failed, cancelled, or timed out.                               | Catchable terminal-state error                                               |
| `WorkflowBuilderError`                      | `WorkflowBuilderError`                      | The fluent workflow builder is used in an invalid order or with duplicate/incompatible builder calls.                     | Definition-time configuration error                                          |
| `VersionMismatchError`                      | `VersionMismatchError`                      | Recovery sees a stored workflow version that differs from the registered workflow version.                                | Recovery blocker for that workflow                                           |
| `EffectReplayConflictError`                 | `EffectReplayConflictError`                 | An effect-log record was in flight at crash and cannot prove whether the external effect completed.                       | Requires operator or domain-specific reconciliation                          |
| `ReviewTimeoutError`                        | `ReviewTimeoutError`                        | A human review request exceeds its configured timeout or escalation budget.                                               | Workflow-visible timeout error                                               |
| `AtomicStateConflictError`                  | `AtomicStateConflictError`                  | A storage-backed atomic state update cannot commit after its retry budget.                                                | Catchable compare-and-swap conflict                                          |
| `StandardSchemaValidationError`             | `StandardSchemaValidationError`             | Standard Schema validation rejects an operation field at a boundary that opts into runtime validation.                    | Catchable validation error                                                   |
| `ActivityReconciliationCapabilityError`     | `ActivityReconciliationCapabilityError`     | Keyed activity reconciliation is used with storage that lacks `conditionalBatch`.                                         | Configuration/storage-capability blocker                                     |
| `ActivityReconciliationConflictError`       | `ActivityReconciliationConflictError`       | A keyed activity reconciliation marker changes between read and compare-and-set transition.                               | Retryable workflow-turn conflict                                             |
| `ActivityReconciliationIndeterminateError`  | `ActivityReconciliationIndeterminateError`  | A keyed activity has a prior dispatch marker but the engine cannot prove the external outcome.                            | Requires external reconciliation                                             |
| `AsyncActivityTokenNotFoundError`           | `AsyncActivityTokenNotFoundError`           | Async activity completion/failure names an unknown, already-used, or wrong-engine token.                                  | Catchable callback-token error                                               |
| `ActivityScheduleToCloseTimeoutError`       | `ActivityScheduleToCloseTimeoutError`       | An activity retry cannot fit inside its `scheduleToCloseTimeout` budget, or the budget has elapsed.                       | Timeout-classified activity failure                                          |
| `ActivityPerAttemptTimeoutError`            | `ActivityPerAttemptTimeoutError`            | An inline activity attempt exceeds its per-attempt `timeout` wall-clock cap before it settles.                            | Timeout-classified activity failure; retryable when policy permits           |
| `PayloadSizeExceededError`                  | `PayloadSizeExceededError`                  | Workflow input, signal payload, or activity result exceeds `payloadSize.maxBytes` before durable write.                   | Admission failure for that payload                                           |
| `StartOrSignalConflictError`                | `StartOrSignalConflictError`                | `engine.startOrSignal()` targets a terminal workflow without restart enabled, so the run cannot accept the signal.        | Catchable conflict                                                           |
| `WorkflowTeardownPendingError`              | `WorkflowTeardownPendingError`              | A restart under the same workflow id is refused while the prior terminal run still owes engine-driven finalizer teardown. | Transient conflict; retry after teardown                                     |
| `IdempotencyKeyPurgedError`                 | `IdempotencyKeyPurgedError`                 | A start idempotency key maps to a workflow record that was purged or deleted while the key intentionally survived.        | Catchable spent-key conflict                                                 |

## FaultCode

REST operation handlers map each `FaultCode` to the HTTP status below. Most REST operation faults return `{ "error": "<message>" }`; `EngineFailure` is masked to `{ "error": "Internal server error" }`. JSON-RPC transports always return HTTP 200 for a valid JSON-RPC envelope and put the HTTP-equivalent status plus the symbolic code in `error.data`.

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

`HttpClientError` carries the server-side `FaultCode` when the response includes a recognized structured fault:

```ts
import { HttpClientError } from '@lostgradient/weft';

function retryableServerFault(error: unknown): boolean {
  return error instanceof HttpClientError && error.faultCode === 'Timeout';
}

void retryableServerFault;
```
