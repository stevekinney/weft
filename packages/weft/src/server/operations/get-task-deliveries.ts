/**
 * `weft.tasks.deliveries` and `weft.tasks.deadletters.get` (COR-1366) —
 * companion operations to `weft.tasks.get` that expose what that operation
 * deliberately does not.
 *
 * **`weft.tasks.deliveries`** returns the transport-level answer every
 * `taskResult` submission for one operation received: the `taskResultAck`
 * disposition (`applied`/`duplicate`/`dead-lettered`) or the hard rejection
 * (the WebSocket transport's correlated `protocolError`, long-poll's `403`)
 * with its reason. `weft.tasks.get`'s `attempts[].disposition` is what the
 * LEDGER decided about an attempt; this is what each delivery of that
 * attempt's result was TOLD — a worker that resent after a lost ack shows up
 * here as an `applied` then a `duplicate`, where the ledger shows one
 * `resolved`. Same `system:read` scope as `weft.tasks.get`: an entry carries
 * an attempt token digest, a worker id, a disposition or rejection code, and
 * rejection text with the raw attempt token redacted — never a payload.
 *
 * **`weft.tasks.deadletters.get`** returns a dead-lettered attempt's retained
 * result value. `weft.tasks.get` returns only the value's `resultDigest`, on
 * the "digest not value" rule: a read surface proves which attempt won, it
 * does not re-deliver payloads to every caller who can read task state. A
 * dead letter is the one case where an operator genuinely needs the payload
 * — to decide whether to clear it, and to recover the result by hand — so
 * this operation serves it under a stricter access model:
 *
 *   - **Scope: `system:admin` only.** The same scope required to clear the
 *     dead letter (`weft.tasks.diagnostics.deadletters.clear`): whoever may
 *     destroy the retained value may read it first, and nobody else may.
 *     `system:read` does not suffice.
 *   - **No redaction of the value; nothing else exposed.** The value is an
 *     activity's return value, whose shape the server cannot know, so no
 *     field-level redaction rule could be correct — the scope is the
 *     control. Everything `weft.tasks.get` excludes stays excluded: no raw
 *     `attemptToken` (only `attemptTokenDigest`), no `workerSessionId`, no
 *     task `input`, no `headers`.
 *   - **Size-limited, never truncated.** The serialized value is returned
 *     inline only up to `maxBytes` (default 64 KiB, at most 1 MiB). A larger
 *     value is reported as `{ kind: 'omitted', serializedBytes, maxBytes }`
 *     rather than cut short: a truncated JSON value is not the value, and
 *     showing one as if it were would mislead the operator deciding what to
 *     do with it. The caller can retry with a higher `maxBytes`.
 *   - **Not exposed to MCP** (`mcpExposable: false`), so payloads stay out of
 *     model context unless an operator moves them there deliberately.
 *
 * Both operations answer `NotFound` when the operation has no ledger record,
 * and `weft.tasks.deadletters.get` also when the record exists but is not
 * dead-lettered — matching `weft.tasks.diagnostics.deadletters.clear`.
 *
 * @module server/operations/get-task-deliveries
 */

import type { FaultCode } from '../../core/fault-code.ts';
import { decodeTaskAttemptRecord, taskAttemptPrefix } from '../../core/task-ledger/task-attempt.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  utf8ByteLength,
  type RemoteTaskRecord,
} from '../../core/task-ledger/task-ledger.ts';
import {
  decodeTaskResultDeliveryHistory,
  TASK_RESULT_DELIVERY_HISTORY_LIMIT,
  taskResultDeliveryKey,
  type TaskResultDeliveryEntry,
} from '../../core/task-ledger/task-result-delivery.ts';
import type { Storage } from '../../storage/interface.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { requireOperationStorage } from './operation-helpers.ts';
import {
  getTaskDeadLetterInput,
  getTaskDeadLetterOutputSchema,
  getTaskResultDeliveriesInput,
  getTaskResultDeliveriesOutputSchema,
  type GetTaskDeadLetterOutput,
  type GetTaskResultDeliveriesOutput,
  type TaskResultDeliveryView,
} from './task-delivery-schemas.ts';

export {
  deadLetterPayloadSchema,
  getTaskDeadLetterOutputSchema,
  getTaskResultDeliveriesOutputSchema,
  taskResultDeliverySchema,
  type GetTaskDeadLetterInput,
  type GetTaskDeadLetterOutput,
  type GetTaskResultDeliveriesInput,
  type GetTaskResultDeliveriesOutput,
} from './task-delivery-schemas.ts';

type FaultingOperation = {
  readonly name: string;
  readonly producibleFaults?: readonly FaultCode[];
};

/**
 * Read and decode the ledger record, raising `NotFound` when absent and
 * `EngineFailure` when undecodable or filed under the wrong key — the same
 * posture as `weft.tasks.get`.
 */
async function readLedgerRecord(
  operation: FaultingOperation,
  storage: Pick<Storage, 'get'>,
  operationId: string,
): Promise<RemoteTaskRecord> {
  const raw = await storage.get(taskLedgerKey(operationId));
  if (raw === null) {
    raiseFault(operation, {
      code: 'NotFound',
      message: `No task found for operation "${operationId}"`,
      data: { resource: 'task', identifier: operationId },
    });
  }
  const decoded = decodeRemoteTaskRecord(raw);
  if (decoded === null || decoded.operationId !== operationId) {
    raiseFault(operation, {
      code: 'EngineFailure',
      message: `Task ledger record for operation "${operationId}" could not be decoded`,
      data: {},
    });
  }
  return decoded;
}

/** `attemptTokenDigest` → ledger attempt number, from the operation's attempt history. */
async function loadAttemptNumbers(
  storage: Pick<Storage, 'scan'>,
  operationId: string,
): Promise<Map<string, number>> {
  const attempts = new Map<string, number>();
  for await (const [, value] of storage.scan(taskAttemptPrefix(operationId))) {
    const decoded = decodeTaskAttemptRecord(value);
    if (decoded !== null) attempts.set(decoded.attemptTokenDigest, decoded.attempt);
  }
  return attempts;
}

function projectDelivery(
  entry: TaskResultDeliveryEntry,
  attempts: ReadonlyMap<string, number>,
): TaskResultDeliveryView {
  const attempt = attempts.get(entry.attemptTokenDigest);
  const common = {
    ...(attempt !== undefined ? { attempt } : {}),
    attemptTokenDigest: entry.attemptTokenDigest,
    transport: entry.transport,
    ...(entry.workerId !== undefined ? { workerId: entry.workerId } : {}),
    submittedStatus: entry.submittedStatus,
    receivedAt: entry.receivedAt,
  };
  if (entry.outcome === 'acknowledged') {
    return {
      ...common,
      outcome: 'acknowledged',
      disposition: entry.disposition,
      ...(entry.oversizedPayload === true ? { oversizedPayload: true as const } : {}),
    };
  }
  return {
    ...common,
    outcome: 'rejected',
    rejectionCode: entry.rejectionCode,
    reason: entry.reason,
  };
}

const taskDeliveryTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
} as const;

export const getTaskResultDeliveriesOperation = defineOperation({
  name: 'weft.tasks.deliveries',
  mcpExposable: false,
  summary: "Get the transport-level delivery history of one task's results",
  description:
    'Every answered taskResult submission for one operation, oldest first: the taskResultAck ' +
    'disposition (applied, duplicate, dead-lettered) or the hard rejection with its code and ' +
    'reason. Bounded per operation; droppedCount reports older entries no longer retained.',
  destructive: false,
  tags: ['Observability'],
  inputSchema: getTaskResultDeliveriesInput,
  outputSchema: getTaskResultDeliveriesOutputSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  producibleFaults: ['NotFound'],
  discoverable: true,
  transports: taskDeliveryTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetTaskResultDeliveriesOutput> => {
    const storage = requireOperationStorage(engine, ['get', 'scan']);
    await readLedgerRecord(getTaskResultDeliveriesOperation, storage, input.operationId);
    const history = decodeTaskResultDeliveryHistory(
      await storage.get(taskResultDeliveryKey(input.operationId)),
    );
    const attempts = await loadAttemptNumbers(storage, input.operationId);
    return {
      operationId: input.operationId,
      deliveries: (history?.entries ?? []).map((entry) => projectDelivery(entry, attempts)),
      historyLimit: TASK_RESULT_DELIVERY_HISTORY_LIMIT,
      droppedCount: history?.droppedCount ?? 0,
    };
  },
});

function projectDeadLetterPayload(
  value: unknown,
  maxBytes: number,
): GetTaskDeadLetterOutput['payload'] {
  if (value === undefined) return { kind: 'absent' };
  const serializedBytes = utf8ByteLength(JSON.stringify(value));
  if (serializedBytes > maxBytes) {
    return { kind: 'omitted', reason: 'exceeds-max-bytes', serializedBytes, maxBytes };
  }
  return { kind: 'value', value, serializedBytes };
}

export const getTaskDeadLetterOperation = defineOperation({
  name: 'weft.tasks.deadletters.get',
  mcpExposable: false,
  summary: "Get a dead-lettered task attempt's retained result value",
  description:
    'Returns the result value a dead-lettered attempt retained, not only its digest. Requires ' +
    'system:admin, the scope that may clear the dead letter. The value is returned inline up to ' +
    'maxBytes (default 64 KiB, at most 1 MiB) and is otherwise reported as omitted, never ' +
    'truncated. The raw attempt token, task input, and headers are never returned.',
  destructive: false,
  tags: ['Observability'],
  inputSchema: getTaskDeadLetterInput,
  outputSchema: getTaskDeadLetterOutputSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:admin'] } },
  producibleFaults: ['NotFound'],
  discoverable: true,
  transports: taskDeliveryTransports,
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetTaskDeadLetterOutput> => {
    const storage = requireOperationStorage(engine, ['get']);
    const record = await readLedgerRecord(getTaskDeadLetterOperation, storage, input.operationId);
    if (record.state !== 'deadLettered') {
      raiseFault(getTaskDeadLetterOperation, {
        code: 'NotFound',
        message: `No dead-lettered task found for operation "${input.operationId}"`,
        data: { resource: 'task', identifier: input.operationId },
      });
    }
    return {
      operationId: record.operationId,
      ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
      workflowType: record.workflowType,
      activityName: record.activityName,
      queue: record.queue,
      attempt: record.attempt,
      attemptTokenDigest: await sha256Hex(record.attemptToken),
      pendingStatus: record.pendingStatus,
      resultDigest: record.pendingResultDigest,
      deadLetteredAt: record.deadLetteredAt,
      persistenceFailureReason: record.persistenceFailureReason,
      ...(record.error !== undefined ? { error: record.error } : {}),
      payload: projectDeadLetterPayload(record.value, input.maxBytes),
    };
  },
});

// Both routes live under `weft.tasks.get`'s `/v1/tasks/detail/` namespace,
// which that binding reserves so a caller-chosen operationId can never
// collide with a literal sibling segment under `/v1/tasks/`.

export const getTaskResultDeliveriesRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/tasks/detail/:operationId/deliveries',
  pathParamNames: ['operationId'],
  operationName: 'weft.tasks.deliveries',
  inputSources: { operationId: { kind: 'path', pathParam: 'operationId' } },
  extractInput: async (_request, pathParams) => ({ operationId: pathParams['operationId'] ?? '' }),
  success: { kind: 'json', status: 200 },
};

export const getTaskDeadLetterRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/tasks/detail/:operationId/dead-letter',
  pathParamNames: ['operationId'],
  operationName: 'weft.tasks.deadletters.get',
  inputSources: {
    operationId: { kind: 'path', pathParam: 'operationId' },
    maxBytes: { kind: 'query', queryParam: 'maxBytes' },
  },
  extractInput: async (request, pathParams) => {
    const maxBytes = new URL(request.url).searchParams.get('maxBytes');
    return {
      operationId: pathParams['operationId'] ?? '',
      maxBytes: maxBytes === null || maxBytes.length === 0 ? undefined : Number(maxBytes),
    };
  },
  success: { kind: 'json', status: 200 },
};
