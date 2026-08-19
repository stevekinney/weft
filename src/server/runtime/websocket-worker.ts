import type { ServerWebSocket } from 'bun';

import { decode, encode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  parseWorkerToServerMessage,
  type HeartbeatMessage,
  type TaskResultMessage,
  type WorkerToServerMessage,
} from '../../worker/protocol.ts';
import { workerProtocolIncompatibleMessage } from '../../worker/worker-protocol-incompatible-error.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { isInflightRecord, readInflightRecord } from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { withRetry } from './retry.ts';
import { recordWorkerCapacitySaturationMetric } from './task-metrics.ts';
import {
  taskResultPayloadSizeError,
  transitionTaskResultToResolvedWithRetry,
} from './task-result-resolution.ts';
import { WORKER_STREAM_RE } from './websocket-upgrade.ts';
import {
  rejectProtocolMessage,
  rejectRegistration,
  sendWorkerProtocolMessage,
} from './websocket-worker-messaging.ts';
import { registerWorker } from './websocket-worker-registration.ts';

function isWorkerConnection(pathname: string): boolean {
  return WORKER_STREAM_RE.test(pathname);
}

export { isInflightRecord } from '../task-state.ts';

export { withRetry } from './retry.ts';

function resolveTaskResultStatus(message: TaskResultMessage): 'completed' | 'failed' {
  return message.status === 'completed' ? 'completed' : 'failed';
}

/** Handle a validated `taskResult` message from a worker. */
function onTaskResultMessage(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  message: TaskResultMessage,
  cleanupWorkflowIndex: (operationId: string) => void,
): void {
  const operationId = message.operationId;
  const workerId = ws.data.workerId;
  // Ownership guard. The registry's in-flight entry records the worker that
  // currently owns the task. A stale completion from a worker that has been
  // displaced by visibility-timeout reassignment — original worker
  // partitions, scanner reassigns to a peer — no longer matches and is
  // rejected here instead of mutating engine state.
  if (workerId === undefined || !context.registry.isAssignedToWorker(operationId, workerId)) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: `taskResult for operation "${operationId}" rejected — task not assigned to worker "${workerId ?? ''}"`,
    });
    return;
  }
  // The non-empty token is part of every task result. Check it after worker
  // ownership so a stale completion cannot mutate state when a later attempt is
  // reassigned to the same worker.
  if (!context.registry.isAssignedToAttempt(operationId, workerId, message.attemptToken)) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: `taskResult for operation "${operationId}" rejected — stale attempt token`,
    });
    return;
  }

  const resolvedStatus = resolveTaskResultStatus(message);
  const payloadError = taskResultPayloadSizeError(
    {
      operationId,
      status: resolvedStatus,
      resolutionReason: resolvedStatus,
      ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
    },
    context.payloadSizeMaxBytes,
  );

  context.registry.completeTask(operationId);
  context.deadlineTracker.remove(operationId);
  cleanupWorkflowIndex(operationId);
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  void (async () => {
    const inflightRecord = await readInflightRecord(options.engine.storage, operationId);
    if (payloadError !== null) {
      sendWorkerProtocolMessage(ws, {
        type: 'protocolError',
        code: 'invalid_message',
        message: payloadError.message,
      });
      await transitionTaskResultToResolvedWithRetry(context, options, {
        operationId,
        status: 'failed',
        resolutionReason: 'failed',
        inflightRecord,
        error: payloadError.message,
        skipPayloadSizeCheck: true,
      });
      return;
    }

    await transitionTaskResultToResolvedWithRetry(context, options, {
      operationId,
      status: resolvedStatus,
      resolutionReason: resolvedStatus,
      inflightRecord,
      ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
    });
  })().catch((error) => {
    console.error(
      `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
      error,
    );
  });
}

/** Handle a validated `heartbeat` message from a worker. */
function onHeartbeatMessage(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  _message: HeartbeatMessage,
): void {
  const workerId = ws.data.workerId;
  if (!workerId) return;

  context.registry.heartbeat(workerId);

  // Extend visibility deadline for all in-flight tasks assigned to this worker.
  for (const task of context.registry.getWorkerTasks(workerId)) {
    const newDeadline = context.registry.extendVisibility(task.operationId, task.visibilityTimeout);

    // Update persisted storage record and deadline tracker with
    // the same deadline the registry computed, so all three stay
    // in sync across restarts and visibility scans.
    if (newDeadline !== undefined) {
      context.deadlineTracker.remove(task.operationId);
      context.deadlineTracker.add({ operationId: task.operationId, deadline: newDeadline });

      const opId = task.operationId;
      const heartbeatWorkerId = ws.data.workerId;
      void withRetry(async () => {
        // Guard: if the task completed or was reassigned during the async gap,
        // skip the write to avoid resurrecting or corrupting another worker's record.
        if (!context.registry.isAssigned(opId)) return;
        const currentTask = context.registry
          .getWorkerTasks(heartbeatWorkerId ?? '')
          .find((trackedTask) => trackedTask.operationId === opId);
        if (!currentTask) return;

        const inflightKey = KEYS.operationInflight(opId);
        const existing = await options.engine.storage.get(inflightKey);
        if (existing) {
          const decoded = decode(existing);
          if (!isInflightRecord(decoded)) {
            console.error(
              `[weft] Corrupt inflight record for task "${opId}" during heartbeat — skipping visibility extension`,
            );
            return;
          }
          const updated = { ...decoded, deadline: newDeadline, lastHeartbeatAt: Date.now() };
          await options.engine.storage.put(inflightKey, encode(updated));
        }
      }, `extend visibility for task "${opId}"`).catch((error) => {
        console.error(`[weft] Failed to extend visibility for task "${opId}":`, error);
      });
    }
  }
}

type ParseResult = { ok: true; message: WorkerToServerMessage } | { ok: false };

/**
 * Parse and validate an incoming WebSocket frame from a worker.
 * Rejects the connection if the frame is malformed or fails protocol validation.
 * Returns the parsed message on success or `{ ok: false }` if the connection was closed.
 */
function parseAndValidateWorkerFrame(
  ws: ServerWebSocket<WebSocketData>,
  rawMessage: string | Buffer,
): ParseResult {
  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rejectProtocolMessage(ws, 'invalid_json', 'Worker protocol messages must be valid JSON');
    return { ok: false };
  }

  const result = parseWorkerToServerMessage(parsed);
  if (!result.ok) {
    // deployment_conflict and registration_rejected can never actually come
    // from wire-shape parsing — only registerWorker() decides those, after
    // deep manifest validation succeeds — but they share RegisterErrorMessage's
    // code union, so they are routed through rejectRegistration here too to
    // keep this narrowing exhaustive against that type rather than relying on
    // a runtime guarantee the type checker cannot see.
    if (
      result.error.code === 'invalid_registration' ||
      result.error.code === 'unsupported_protocol_version' ||
      result.error.code === 'deployment_conflict' ||
      result.error.code === 'registration_rejected'
    ) {
      // Phase 4: a worker advertising an older protocol version (the v1 wire
      // semantics, which sent bare activity names) is rejected with the
      // canonical incompatibility message so operators see "upgrade the worker
      // SDK" instead of "no worker for activity X" later in replay.
      const message =
        result.error.code === 'unsupported_protocol_version'
          ? workerProtocolIncompatibleMessage({
              expected: REMOTE_WORKER_PROTOCOL_VERSION,
              received: result.error.requestedProtocolVersion,
            })
          : result.error.message;
      rejectRegistration(ws, result.error.code, message, result.error.requestedProtocolVersion);
      return { ok: false };
    }

    rejectProtocolMessage(ws, result.error.code, result.error.message);
    return { ok: false };
  }

  return { ok: true, message: result.message };
}

export function handleWorkerWebSocketMessage(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  rawMessage: string | Buffer,
  cleanupWorkflowIndex: (operationId: string) => void,
): void {
  if (!isWorkerConnection(ws.data.pathname)) return;

  const parsed = parseAndValidateWorkerFrame(ws, rawMessage);
  if (!parsed.ok) return;

  const { message } = parsed;
  if (message.type !== 'register' && ws.data.workerRegistered !== true) {
    rejectProtocolMessage(
      ws,
      'registration_required',
      'Worker must register before sending heartbeat or taskResult messages',
    );
    return;
  }

  switch (message.type) {
    case 'register': {
      void registerWorker(context, options, ws, message).catch((error: unknown) => {
        console.error(`[weft] Failed to register worker "${message.workerId}":`, error);
      });
      break;
    }
    case 'taskResult': {
      onTaskResultMessage(context, options, ws, message, cleanupWorkflowIndex);
      break;
    }
    case 'heartbeat': {
      onHeartbeatMessage(context, options, ws, message);
      break;
    }
    default: {
      // Exhaustiveness guard: adding a new WorkerToServerMessage variant
      // without a case above must fail this typecheck.
      const _exhaustive: never = message;
      return _exhaustive;
    }
  }
}
