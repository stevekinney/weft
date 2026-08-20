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
 * proves which attempt won, it does not re-deliver payloads.
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

import { z } from 'zod';

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

const getTaskDetailInput = z.object({
  operationId: z.string().min(1),
});

const durationSchema = z.union([z.number(), z.string()]);

const retryPolicySchema = z
  .object({
    maxAttempts: z.number(),
    initialBackoff: durationSchema,
    backoffMultiplier: z.number(),
    maxBackoff: durationSchema,
    nonRetryableErrors: z.array(z.string()).optional(),
  })
  .strict();

const executionRequirementSchema = z
  .object({
    deploymentName: z.string().optional(),
    buildId: z.string().optional(),
    artifactDigest: z.string().optional(),
    workflowRevision: z.string().optional(),
    activityContractHash: z.string().optional(),
  })
  .strict();

const taskDetailBaseFields = {
  operationId: z.string(),
  workflowId: z.string().optional(),
  workflowType: z.string(),
  activityName: z.string(),
  queue: z.string(),
  priority: z.number().optional(),
  headerKeys: z.array(z.string()),
  visibilityTimeoutMilliseconds: z.number(),
  retryPolicy: retryPolicySchema.optional(),
  scheduleToCloseDeadline: z.number().optional(),
  executionRequirement: executionRequirementSchema.optional(),
  fairShareKey: z.string().optional(),
  stickyWorkflowId: z.string().optional(),
  createdAt: z.number(),
  attempt: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative().optional(),
  requeueCount: z.number().int().nonnegative().optional(),
  lastRequeueReason: z.string().optional(),
};

const leaseHolderSchemaFields = {
  leaseDeadline: z.number(),
  firstQueuedAt: z.number(),
  lastQueuedAt: z.number(),
  startedAt: z.number(),
  lastHeartbeatAt: z.number(),
};

const taskDetailQueuedSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('queued'),
    availableAt: z.number(),
    firstQueuedAt: z.number(),
    lastQueuedAt: z.number(),
    lastDispatchedAt: z.number().optional(),
    startedAt: z.number().optional(),
  })
  .strict();

const taskDetailLeasedSchema = z
  .object({ ...taskDetailBaseFields, state: z.literal('leased'), ...leaseHolderSchemaFields })
  .strict();

const taskDetailCompletingSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('completing'),
    ...leaseHolderSchemaFields,
    pendingStatus: z.enum(['completed', 'failed']),
    resultDigest: z.string(),
  })
  .strict();

const taskDetailCancellingSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('cancelling'),
    ...leaseHolderSchemaFields,
    cancellationReason: z.string(),
    cancellationRequestedAt: z.number(),
  })
  .strict();

const taskDetailTerminalSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('terminal'),
    disposition: z.enum(['resolved', 'cancelled', 'retryExhausted']),
    resultDigest: z.string(),
    terminalAt: z.number(),
    adopted: z.boolean(),
    adoptedAt: z.number().optional(),
    resultStatus: z.enum(['completed', 'failed']).optional(),
    cancellationReason: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const taskDetailDeadLetteredSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('deadLettered'),
    pendingStatus: z.enum(['completed', 'failed']),
    resultDigest: z.string(),
    deadLetteredAt: z.number(),
    persistenceFailureReason: z.string(),
    error: z.string().optional(),
  })
  .strict();

const getTaskDetailOutput = z.discriminatedUnion('state', [
  taskDetailQueuedSchema,
  taskDetailLeasedSchema,
  taskDetailCompletingSchema,
  taskDetailCancellingSchema,
  taskDetailTerminalSchema,
  taskDetailDeadLetteredSchema,
]);

export type GetTaskDetailInput = z.infer<typeof getTaskDetailInput>;
export type GetTaskDetailOutput = z.infer<typeof getTaskDetailOutput>;

function baseEnvelopeFields(record: RemoteTaskRecord) {
  return {
    operationId: record.operationId,
    ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
    workflowType: record.workflowType,
    activityName: record.activityName,
    queue: record.queue,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    headerKeys: Object.keys(record.headers),
    visibilityTimeoutMilliseconds: record.visibilityTimeoutMilliseconds,
    ...(record.retryPolicy !== undefined ? { retryPolicy: record.retryPolicy } : {}),
    ...(record.scheduleToCloseDeadline !== undefined
      ? { scheduleToCloseDeadline: record.scheduleToCloseDeadline }
      : {}),
    ...(record.executionRequirement !== undefined
      ? { executionRequirement: record.executionRequirement }
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
    return {
      disposition: 'resolved' as const,
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
    resultDigest: record.resultDigest,
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
  outputSchema: getTaskDetailOutput,
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
    if (decoded === null) {
      // The key exists but its bytes do not decode into a valid
      // RemoteTaskRecord — a data-integrity concern (corruption, or a
      // future record-version skew this build cannot read), not a missing
      // resource. Reporting NotFound here would tell an operator the task
      // was never dispatched or was cleanly reaped, hiding the exact record
      // that needs investigation.
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
