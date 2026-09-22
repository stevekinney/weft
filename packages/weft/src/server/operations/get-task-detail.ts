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
 * **Excluded fields.** `attemptToken` and `workerSessionId` are never
 * projected here, matching `TaskResultView`'s own documented exclusion
 * list — they are worker ownership/session internals (and, for
 * `attemptToken`, a fencing secret — COR-205, acceptance criteria 8 and 10)
 * with no business being public. The CURRENT record's own `executionIdentity`
 * stays excluded too, for the same reason it always has. `attempts`
 * (COR-205) is the one deliberate exception: it projects each historical
 * `TaskAttemptRecord`'s `executionIdentity` and `attemptTokenDigest` — never
 * the raw token — because a retry's build/deployment identity, unlike a
 * live connection's ownership, is exactly the audit trail an operator needs
 * (acceptance criterion 9: "a retry across builds displays both attempt
 * identities"). `headers`
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

import {
  decodeTaskAttemptRecord,
  taskAttemptPrefix,
  type TaskAttemptRecord,
} from '../../core/task-ledger/task-attempt.ts';
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
} from '../../core/task-ledger/task-ledger.ts';
import type { Storage } from '../../storage/interface.ts';
import type { WorkerExecutionIdentity } from '../../worker/manifest/types.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import {
  executionIdentitySchema,
  executionRequirementSchema,
  getTaskDetailInput,
  getTaskDetailOutputSchema,
  retryPolicySchema,
  taskAttemptSchema,
  type GetTaskDetailOutput,
} from './get-task-detail-schema.ts';
import { requireOperationStorage } from './operation-helpers.ts';

export {
  executionRequirementSchema,
  getTaskDetailOutputSchema,
  retryPolicySchema,
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

function projectExecutionIdentity(
  executionIdentity: WorkerExecutionIdentity,
): z.infer<typeof executionIdentitySchema> {
  return {
    workerId: executionIdentity.workerId,
    manifestDigest: executionIdentity.manifestDigest,
    sdkVersion: executionIdentity.sdkVersion,
    runtimeName: executionIdentity.runtimeName,
    runtimeVersion: executionIdentity.runtimeVersion,
    deploymentName: executionIdentity.deploymentName,
    buildId: executionIdentity.buildId,
    artifactDigest: executionIdentity.artifactDigest,
    workflowType: executionIdentity.workflowType,
    workflowRevision: executionIdentity.workflowRevision,
    activityName: executionIdentity.activityName,
    activityContractHash: executionIdentity.activityContractHash,
    protocolVersion: executionIdentity.protocolVersion,
  };
}

/**
 * Project one durable {@link TaskAttemptRecord} into the diagnostics shape
 * (COR-205, acceptance criteria 9 and 10) — never the raw `attemptToken`,
 * only its digest.
 */
function projectAttempt(record: TaskAttemptRecord): z.infer<typeof taskAttemptSchema> {
  return {
    attempt: record.attempt,
    attemptTokenDigest: record.attemptTokenDigest,
    ...(record.sessionGeneration !== undefined
      ? { sessionGeneration: record.sessionGeneration }
      : {}),
    ...(record.executionIdentity !== undefined
      ? { executionIdentity: projectExecutionIdentity(record.executionIdentity) }
      : {}),
    ...(record.executionRequirement !== undefined
      ? { executionRequirement: projectExecutionRequirement(record.executionRequirement) }
      : {}),
    claimedAt: record.claimedAt,
    disposition: record.disposition,
    dispositionAt: record.dispositionAt,
    ...(record.dispositionReason !== undefined
      ? { dispositionReason: record.dispositionReason }
      : {}),
    ...(record.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
  };
}

/**
 * Read every {@link TaskAttemptRecord} for `operationId`, oldest attempt
 * first (acceptance criterion 9's ordering — a retry across builds should
 * read chronologically). A bounded scan: attempts per operation are capped
 * by the dispatch's retry policy, the same bound `reapRetainedTerminalRecord`
 * relies on for purge (criterion 12).
 */
async function loadTaskAttemptHistory(
  storage: Pick<Storage, 'get' | 'scan'>,
  operationId: string,
): Promise<TaskAttemptRecord[]> {
  const records: TaskAttemptRecord[] = [];
  for await (const [, value] of storage.scan(taskAttemptPrefix(operationId))) {
    const decoded = decodeTaskAttemptRecord(value);
    if (decoded !== null) records.push(decoded);
  }
  // Sort by the ledger's own authoritative attempt counter (criterion 4),
  // NOT `claimedAt`: two attempts claimed within the same millisecond
  // (routine under fast dispatch/retry, and common in tests) would tie on a
  // wall-clock timestamp, and the storage scan's own key order — sorted by
  // `attemptTokenDigest`, an opaque hash unrelated to claim order — is not a
  // safe fallback tiebreaker. `attempt` is a monotonic integer with no such
  // collision risk.
  return records.toSorted((left, right) => left.attempt - right.attempt);
}

function baseEnvelopeFields(record: RemoteTaskRecord, attempts: readonly TaskAttemptRecord[]) {
  return {
    operationId: record.operationId,
    attempts: attempts.map(projectAttempt),
    ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
    ...(record.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: record.workflowExecutionToken }
      : {}),
    ...(record.workflowRevision !== undefined ? { workflowRevision: record.workflowRevision } : {}),
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
    | 'leaseDeadline'
    | 'attemptDeadline'
    | 'firstQueuedAt'
    | 'lastQueuedAt'
    | 'startedAt'
    | 'lastHeartbeatAt'
  >,
) {
  return {
    leaseDeadline: record.leaseDeadline,
    // A clock, not identity — unlike `attemptToken`/`workerSessionId`, this
    // module's own excluded-fields list never covered it (COR-220).
    ...(record.attemptDeadline !== undefined ? { attemptDeadline: record.attemptDeadline } : {}),
    firstQueuedAt: record.firstQueuedAt,
    lastQueuedAt: record.lastQueuedAt,
    startedAt: record.startedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
  };
}

function projectQueued(
  record: RemoteTaskQueued,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record, attempts),
    ...attemptFields(record),
    state: 'queued',
    availableAt: record.availableAt,
    firstQueuedAt: record.firstQueuedAt,
    lastQueuedAt: record.lastQueuedAt,
    ...(record.lastDispatchedAt !== undefined ? { lastDispatchedAt: record.lastDispatchedAt } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
  };
}

function projectLeased(
  record: RemoteTaskLeased,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record, attempts),
    ...attemptFields(record),
    ...leaseHolderFields(record),
    state: 'leased',
  };
}

function projectCompleting(
  record: RemoteTaskCompleting,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record, attempts),
    ...attemptFields(record),
    ...leaseHolderFields(record),
    state: 'completing',
    pendingStatus: record.pendingStatus,
    resultDigest: record.pendingResultDigest,
  };
}

function projectCancelling(
  record: RemoteTaskCancelling,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record, attempts),
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

function projectTerminal(
  record: RemoteTaskTerminal,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record, attempts),
    state: 'terminal',
    terminalAt: record.terminalAt,
    adopted: record.adopted,
    ...(record.adoptedAt !== undefined ? { adoptedAt: record.adoptedAt } : {}),
    ...terminalDispositionFields(record),
  };
}

function projectDeadLettered(
  record: RemoteTaskDeadLettered,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  return {
    ...baseEnvelopeFields(record, attempts),
    ...attemptFields(record),
    state: 'deadLettered',
    pendingStatus: record.pendingStatus,
    resultDigest: record.pendingResultDigest,
    deadLetteredAt: record.deadLetteredAt,
    persistenceFailureReason: record.persistenceFailureReason,
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}

function projectTaskDetail(
  record: RemoteTaskRecord,
  attempts: readonly TaskAttemptRecord[],
): GetTaskDetailOutput {
  switch (record.state) {
    case 'queued':
      return projectQueued(record, attempts);
    case 'leased':
      return projectLeased(record, attempts);
    case 'completing':
      return projectCompleting(record, attempts);
    case 'cancelling':
      return projectCancelling(record, attempts);
    case 'terminal':
      return projectTerminal(record, attempts);
    case 'deadLettered':
      return projectDeadLettered(record, attempts);
    default: {
      // Exhaustiveness guard: adding a new RemoteTaskRecord state without a
      // case above must fail this typecheck.
      const exhaustive: never = record;
      return exhaustive;
    }
  }
}

export const getTaskDetailOperation = defineOperation({
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
    const storage = requireOperationStorage(engine, ['get', 'scan']);
    const raw = await storage.get(taskLedgerKey(input.operationId));
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
    const attempts = await loadTaskAttemptHistory(storage, input.operationId);
    return projectTaskDetail(decoded, attempts);
  },
});

export const getTaskDetailRestBinding: UnknownRestBinding = {
  method: 'GET',
  // Deliberately not `/v1/tasks/:operationId`: a caller-controlled
  // operationId is a nonempty, bounded identifier other than the exact
  // string "." or ".." (WFT-95; enforced at fresh-dispatch admission in
  // `dispatchTaskImpl`, not here — a redispatched, already-decoded ledger
  // record is exempt from that check), so it can still legally equal an
  // existing (or future) literal sibling segment under `/v1/tasks/` —
  // "diagnostics" today. A bare :operationId route would make that task
  // permanently unreachable over REST (the literal route always wins; see
  // static-rest-bindings.ts's registration-order comment). The `/detail/`
  // segment reserves a namespace this operation owns outright.
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
