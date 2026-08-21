/**
 * `weft.tasks.get` operation + REST binding (WFT-92).
 *
 * Reads the full durable ledger state for one `operationId` — the wire
 * counterpart to `WeftServer.getTaskResult()`, which is same-process-only
 * (`src/server/runtime/task-result-view.ts`). This operation exposes the
 * complete dispatch envelope and current ledger state so an HTTP/JSON-RPC
 * caller — an operator console, for instance — can render one task's
 * authoritative state without reconstructing it from the bounded
 * `weft.tasks.diagnostics` alerting shape, which deliberately collapses
 * `leased`/`completing`/`cancelling` into one `inflight` value and carries
 * no attempt identity, priority, headers, retry-availability, adoption, or
 * retention evidence.
 *
 * **Excluded fields.** `attemptToken`, `workerSessionId`, and
 * `executionIdentity` are never projected here, matching
 * `TaskResultView`'s own documented exclusion list — they are worker
 * ownership/session internals with no business being public. `headers`
 * are summarized as key names only (`headerKeys`): interceptor headers can
 * carry trace context or auth material, and this is a read surface, not a
 * payload inspector. The task `input` value and a dead-lettered record's
 * pending result `value` are omitted for the same "digest not value"
 * reason `TaskResultView` omits a resolved result's value — the ledger
 * proves which attempt won, it does not re-deliver payloads. `resultDigest`
 * is only projected for `disposition: 'resolved'`: the `cancelled`
 * (mid-attempt) and `retryExhausted` lineages store a synthetic
 * `${disposition}:${operationId}:${attemptToken}` placeholder there instead
 * of a real content hash (`task-ledger-transitions(-cancellation).ts`),
 * which would otherwise leak the excluded `attemptToken` verbatim.
 *
 * **Read-only by design.** This issue deliberately does not add an HTTP
 * path to `adoptTaskResultImpl`. WFT-24 describes adoption as "an explicit
 * caller assertion" that a workflow incorporated a result — a browser
 * operator clicking a button cannot honestly make that assertion. If an
 * HTTP adoption path is ever wanted, it needs its own design discussion,
 * not a bundled addition here.
 *
 * @module server/operations/get-task-detail
 */

import type { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskAttemptFields,
  type RemoteTaskCancelling,
  type RemoteTaskCompleting,
  type RemoteTaskDeadLettered,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskRecord,
  type RemoteTaskTerminal,
} from '../task-ledger.ts';
import {
  executionRequirementSchema,
  getTaskDetailInput,
  getTaskDetailOutputSchema,
  retryPolicySchema,
  type GetTaskDetailInput,
  type GetTaskDetailOutput,
} from './get-task-detail-schema.ts';

export {
  executionRequirementSchema,
  getTaskDetailOutputSchema,
  retryPolicySchema,
  type GetTaskDetailInput,
  type GetTaskDetailOutput,
} from './get-task-detail-schema.ts';

// The ledger only validates that a stored retryPolicy/executionRequirement
// has the right known fields with the right types (isValidRetryPolicy /
// isValidExecutionRequirement) — it never rejects *additive* properties, and
// task-dispatch.ts stores a fresh dispatch's caller-supplied object
// unchanged. Passing that object through this operation's own `.strict()`
// output schema verbatim would fail output validation (EngineFailure) for
// an otherwise completely valid, already-running task the moment its caller
// (a newer producer, or a plain JS object with excess properties — dispatch
// is a same-process API, not Zod-validated) attaches anything extra.
// Projecting only the declared fields keeps the read contract honest without
// making an unrelated task unreadable.
function projectRetryPolicy(
  retryPolicy: NonNullable<RemoteTaskRecord['retryPolicy']>,
): z.infer<typeof retryPolicySchema> {
  return {
    maxAttempts: retryPolicy.maxAttempts,
    initialBackoff: retryPolicy.initialBackoff,
    backoffMultiplier: retryPolicy.backoffMultiplier,
    maxBackoff: retryPolicy.maxBackoff,
    ...(retryPolicy.nonRetryableErrors !== undefined
      ? { nonRetryableErrors: retryPolicy.nonRetryableErrors }
      : {}),
  };
}

function projectExecutionRequirement(
  executionRequirement: NonNullable<RemoteTaskRecord['executionRequirement']>,
): z.infer<typeof executionRequirementSchema> {
  return {
    ...(executionRequirement.deploymentName !== undefined
      ? { deploymentName: executionRequirement.deploymentName }
      : {}),
    ...(executionRequirement.buildId !== undefined
      ? { buildId: executionRequirement.buildId }
      : {}),
    ...(executionRequirement.artifactDigest !== undefined
      ? { artifactDigest: executionRequirement.artifactDigest }
      : {}),
    ...(executionRequirement.workflowRevision !== undefined
      ? { workflowRevision: executionRequirement.workflowRevision }
      : {}),
    ...(executionRequirement.activityContractHash !== undefined
      ? { activityContractHash: executionRequirement.activityContractHash }
      : {}),
  };
}

function baseEnvelopeFields(record: RemoteTaskRecord) {
  return {
    operationId: record.operationId,
    ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
    ...(record.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: record.workflowExecutionToken }
      : {}),
    workflowType: record.workflowType,
    activityName: record.activityName,
    queue: record.queue,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    headerKeys: Object.keys(record.headers),
    visibilityTimeoutMilliseconds: record.visibilityTimeoutMilliseconds,
    ...(record.retryPolicy !== undefined
      ? { retryPolicy: projectRetryPolicy(record.retryPolicy) }
      : {}),
    ...(record.scheduleToCloseDeadline !== undefined
      ? { scheduleToCloseDeadline: record.scheduleToCloseDeadline }
      : {}),
    ...(record.executionRequirement !== undefined
      ? { executionRequirement: projectExecutionRequirement(record.executionRequirement) }
      : {}),
    ...(record.fairShareKey !== undefined ? { fairShareKey: record.fairShareKey } : {}),
    ...(record.stickyWorkflowId !== undefined ? { stickyWorkflowId: record.stickyWorkflowId } : {}),
    createdAt: record.createdAt,
    attempt: record.attempt,
  };
}

function attemptFields(record: RemoteTaskAttemptFields) {
  return {
    retryCount: record.retryCount,
    requeueCount: record.requeueCount,
    ...(record.lastRequeueReason !== undefined
      ? { lastRequeueReason: record.lastRequeueReason }
      : {}),
  };
}

function leaseHolderFields(
  record: Pick<
    RemoteTaskLeased | RemoteTaskCompleting | RemoteTaskCancelling,
    'leaseDeadline' | 'firstQueuedAt' | 'lastQueuedAt' | 'startedAt' | 'lastHeartbeatAt'
  >,
) {
  return {
    leaseDeadline: record.leaseDeadline,
    firstQueuedAt: record.firstQueuedAt,
    lastQueuedAt: record.lastQueuedAt,
    startedAt: record.startedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
  };
}

function projectQueued(record: RemoteTaskQueued): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record),
    ...attemptFields(record),
    state: 'queued',
    availableAt: record.availableAt,
    firstQueuedAt: record.firstQueuedAt,
    lastQueuedAt: record.lastQueuedAt,
    ...(record.lastDispatchedAt !== undefined ? { lastDispatchedAt: record.lastDispatchedAt } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
  };
}

function projectLeased(record: RemoteTaskLeased): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record),
    ...attemptFields(record),
    ...leaseHolderFields(record),
    state: 'leased',
  };
}

function projectCompleting(record: RemoteTaskCompleting): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record),
    ...attemptFields(record),
    ...leaseHolderFields(record),
    state: 'completing',
    pendingStatus: record.pendingStatus,
    resultDigest: record.pendingResultDigest,
  };
}

function projectCancelling(record: RemoteTaskCancelling): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record),
    ...attemptFields(record),
    ...leaseHolderFields(record),
    state: 'cancelling',
    cancellationReason: record.cancellationReason,
    cancellationRequestedAt: record.cancellationRequestedAt,
  };
}

function terminalDispositionFields(record: RemoteTaskTerminal) {
  if (record.disposition === 'resolved') {
    // Only the 'resolved' lineage's resultDigest is a genuine content hash
    // of an actual result value, safe to publish (TaskResultView's own
    // documented "digest not value" contract). The 'cancelled' (when
    // cancelled mid-attempt) and 'retryExhausted' lineages instead store a
    // synthetic placeholder — task-ledger-transitions(-cancellation).ts
    // build it as `${disposition}:${operationId}:${attemptToken}` — which
    // would leak the excluded attemptToken verbatim if returned here.
    return {
      disposition: 'resolved' as const,
      resultDigest: record.resultDigest,
      resultStatus: record.status,
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }
  if (record.disposition === 'cancelled') {
    return {
      disposition: 'cancelled' as const,
      cancellationReason: record.cancellationReason,
    };
  }
  return {
    disposition: 'retryExhausted' as const,
    error: record.error,
  };
}

function projectTerminal(record: RemoteTaskTerminal): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record),
    state: 'terminal',
    terminalAt: record.terminalAt,
    adopted: record.adopted,
    ...(record.adoptedAt !== undefined ? { adoptedAt: record.adoptedAt } : {}),
    ...terminalDispositionFields(record),
  };
}

function projectDeadLettered(record: RemoteTaskDeadLettered): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record),
    ...attemptFields(record),
    state: 'deadLettered',
    pendingStatus: record.pendingStatus,
    resultDigest: record.pendingResultDigest,
    deadLetteredAt: record.deadLetteredAt,
    persistenceFailureReason: record.persistenceFailureReason,
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

function projectTaskDetail(record: RemoteTaskRecord): GetTaskDetailOutput {
  switch (record.state) {
    case 'queued':
      return projectQueued(record);
    case 'leased':
      return projectLeased(record);
    case 'completing':
      return projectCompleting(record);
    case 'cancelling':
      return projectCancelling(record);
    case 'terminal':
      return projectTerminal(record);
    case 'deadLettered':
      return projectDeadLettered(record);
    default: {
      // Exhaustiveness guard: adding a new RemoteTaskRecord state without a
      // case above must fail this typecheck.
      const exhaustive: never = record;
      return exhaustive;
    }
  }
}

export const getTaskDetailOperation = defineOperation<GetTaskDetailInput, GetTaskDetailOutput>({
  name: 'weft.tasks.get',
  mcpExposable: false,
  summary: "Get one task's full durable ledger state",
  destructive: false,
  tags: ['Observability'],
  inputSchema: getTaskDetailInput,
  outputSchema: getTaskDetailOutputSchema,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:read'] },
  },
  producibleFaults: ['NotFound'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetTaskDetailOutput> => {
    const typedEngine = engine as Engine;
    const raw = await typedEngine.storage.get(taskLedgerKey(input.operationId));
    if (raw === null) {
      raiseFault(getTaskDetailOperation, {
        code: 'NotFound',
        message: `No task found for operation "${input.operationId}"`,
        data: { resource: 'task', identifier: input.operationId },
      });
    }
    const decoded = decodeRemoteTaskRecord(raw);
    if (decoded === null || decoded.operationId !== input.operationId) {
      // Either the key's bytes don't decode into a valid RemoteTaskRecord,
      // or (an import, manual storage repair, or corruption) they decode to
      // a *different* operationId's record living under this key. Both are
      // data-integrity concerns, not a missing resource — reporting
      // NotFound would tell an operator the task was never dispatched or
      // was cleanly reaped, or worse, silently hand back a different task's
      // data for this lookup, masking the storage problem entirely.
      raiseFault(getTaskDetailOperation, {
        code: 'EngineFailure',
        message: `Task ledger record for operation "${input.operationId}" could not be decoded`,
        data: {},
      });
    }
    return projectTaskDetail(decoded);
  },
});

export const getTaskDetailRestBinding: UnknownRestBinding = {
  method: 'GET',
  // Deliberately not `/v1/tasks/:operationId`: a caller-controlled
  // operationId is only required to be a nonempty bounded string, so it can
  // legally equal an existing (or future) literal sibling segment under
  // `/v1/tasks/` — "diagnostics" today. A bare :operationId route would make
  // that task permanently unreachable over REST (the literal route always
  // wins; see static-registrations.ts's registration-order comment). The
  // `/detail/` segment reserves a namespace this operation owns outright.
  path: '/v1/tasks/detail/:operationId',
  pathParamNames: ['operationId'],
  operationName: 'weft.tasks.get',
  inputSources: {
    operationId: { kind: 'path', pathParam: 'operationId' },
  },
  extractInput: async (_request, pathParams) => ({
    operationId: pathParams['operationId'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
