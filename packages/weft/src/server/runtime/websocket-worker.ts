import type { ServerWebSocket } from 'bun';

import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  parseWorkerToServerMessage,
  type HeartbeatMessage,
  type RegisterErrorMessage,
  type TaskResultMessage,
  type WorkerToServerMessage,
} from '../../worker/protocol.ts';
import { workerProtocolIncompatibleMessage } from '../../worker/worker-protocol-incompatible-error.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { renewAttemptLease } from '../task-ledger-transitions.ts';
import type { ServerContext } from './context.ts';
import { withRetry } from './retry.ts';
import {
  commitTaskLedgerCompletion,
  dispatchTaskDeadLetteredEvent,
} from './task-ledger-completion.ts';
import { commitTaskLedgerTransition } from './task-ledger-runtime.ts';
import {
  recordTaskExecutionLatencyMetric,
  recordWorkerCapacitySaturationMetric,
} from './task-metrics.ts';
import { taskResultPayloadSizeError } from './task-result-resolution.ts';
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
      status: resolvedStatus,
      ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
    },
    context.payloadSizeMaxBytes,
  );

  context.registry.completeTask(operationId);
  context.deadlineTracker.remove(operationId);
  cleanupWorkflowIndex(operationId);
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  void (async () => {
    if (payloadError !== null) {
      sendWorkerProtocolMessage(ws, {
        type: 'protocolError',
        code: 'invalid_message',
        message: payloadError.message,
      });
      const rejected = await commitTaskLedgerCompletion(options.engine.storage, {
        operationId,
        attemptToken: message.attemptToken,
        status: 'failed',
        error: payloadError.message,
      });
      if (rejected.ok) {
        recordTaskExecutionLatencyMetric(
          context.metricsCollector,
          { startedAt: rejected.completing.startedAt },
          Date.now(),
        );
      } else {
        console.error(
          `[weft] Failed to persist oversized task result rejection for task "${operationId}":`,
          rejected.reason,
        );
        if (rejected.deadLettered !== undefined) {
          dispatchTaskDeadLetteredEvent(options, operationId, rejected.deadLettered, workerId);
        }
      }
      return;
    }

    const committed = await commitTaskLedgerCompletion(options.engine.storage, {
      operationId,
      attemptToken: message.attemptToken,
      status: resolvedStatus,
      ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
    });
    if (committed.ok) {
      recordTaskExecutionLatencyMetric(
        context.metricsCollector,
        { startedAt: committed.completing.startedAt },
        Date.now(),
      );
    } else {
      console.error(
        `[weft] Failed to commit task result for "${operationId}" through the durable ledger:`,
        committed.reason,
      );
      if (committed.deadLettered !== undefined) {
        dispatchTaskDeadLetteredEvent(options, operationId, committed.deadLettered, workerId);
      }
    }
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
      const attemptToken = task.attemptToken;
      void withRetry(async () => {
        // Guard: if the task completed or was reassigned during the async gap,
        // skip the write to avoid resurrecting or corrupting another worker's record.
        if (!context.registry.isAssigned(opId)) return;
        const currentTask = context.registry
          .getWorkerTasks(heartbeatWorkerId ?? '')
          .find((trackedTask) => trackedTask.operationId === opId);
        if (!currentTask) return;

        // A single attempt, matching the brief's failure matrix: "Stale
        // heartbeat conditional write loses; terminal state remains sole
        // state." A lost CAS here means a result, timeout, or cancellation
        // already committed a newer generation — the heartbeat write simply
        // loses, silently, rather than fighting to retry a transition that
        // no longer applies.
        await commitTaskLedgerTransition(
          options.engine.storage,
          opId,
          (current, now) =>
            renewAttemptLease(
              current,
              {
                attemptToken,
                workerSessionId: heartbeatWorkerId ?? '',
                leaseDurationMilliseconds: task.visibilityTimeout,
              },
              now,
            ),
          1,
        );
      }, `extend visibility for task "${opId}"`).catch((error) => {
        console.error(`[weft] Failed to extend visibility for task "${opId}":`, error);
      });
    }
  }
}

type ParseResult = { ok: true; message: WorkerToServerMessage } | { ok: false };

/**
 * Best-effort `workerId` extraction from a frame that failed protocol
 * parsing. The frame may still carry a syntactically valid `workerId` even
 * though some other field failed validation — used only to enrich the
 * bounded rejection log, never to authorize or route anything.
 */
function extractOptionalWorkerId(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const workerId = (parsed as Record<string, unknown>)['workerId'];
  return typeof workerId === 'string' && workerId.length > 0 ? workerId : undefined;
}

/**
 * Record a wire-shape registration rejection, then send `registerError` and
 * close the socket. Extracted from {@link parseAndValidateWorkerFrame} to
 * keep that function's branching within the repository's complexity budget.
 */
function recordAndRejectRegistrationFrame(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  parsed: unknown,
  code: RegisterErrorMessage['code'],
  message: string,
  requestedProtocolVersion: number | undefined,
): void {
  const rejectedWorkerId = extractOptionalWorkerId(parsed);
  context.registry.recordRejection({
    code,
    ...(rejectedWorkerId !== undefined ? { workerId: rejectedWorkerId } : {}),
    rejectedAt: Date.now(),
    queue: ws.data.queue ?? 'default',
  });
  rejectRegistration(ws, code, message, requestedProtocolVersion);
}

/**
 * Parse and validate an incoming WebSocket frame from a worker.
 * Rejects the connection if the frame is malformed or fails protocol validation.
 * Returns the parsed message on success or `{ ok: false }` if the connection was closed.
 */
function parseAndValidateWorkerFrame(
  context: ServerContext,
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
      recordAndRejectRegistrationFrame(
        context,
        ws,
        parsed,
        result.error.code,
        message,
        result.error.requestedProtocolVersion,
      );
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

  const parsed = parseAndValidateWorkerFrame(context, ws, rawMessage);
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
