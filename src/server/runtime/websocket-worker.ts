import type { ServerWebSocket } from 'bun';

import { decode, encode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  parseWorkerToServerMessage,
  type HeartbeatMessage,
  type ProtocolErrorMessage,
  type RegisterErrorMessage,
  type RegisterMessage,
  type TaskResultMessage,
  type WorkerToServerMessage,
} from '../../worker/protocol.ts';
import type { WorkerRegistrationInfo } from '../../worker/registry.ts';
import { workerProtocolIncompatibleMessage } from '../../worker/worker-protocol-incompatible-error.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { isAuthenticated } from '../principal.ts';
import {
  isInflightRecord,
  readInflightRecord,
  transitionInflightToResolved,
} from '../task-state.ts';
import type { ServerContext } from './context.ts';
import {
  recordTaskExecutionLatencyMetric,
  recordWorkerCapacitySaturationMetric,
} from './task-metrics.ts';
import { WORKER_STREAM_RE } from './websocket-upgrade.ts';

const MAX_WORKER_CONCURRENCY = 1_000;
const DEFAULT_WORKER_CONCURRENCY = 10;
const WORKER_PROTOCOL_CLOSE_CODE = 1002;
const WORKER_REGISTRATION_CLOSE_CODE = 1008;

function isWorkerConnection(pathname: string): boolean {
  return WORKER_STREAM_RE.test(pathname);
}

export { isInflightRecord } from '../task-state.ts';

export async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        console.warn(`[weft] Retrying "${label}" (attempt ${attempt + 1}/${maxAttempts})`);
        await Bun.sleep(100 * attempt);
      }
    }
  }

  throw lastError;
}

function sendWorkerProtocolMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: ProtocolErrorMessage | RegisterErrorMessage | Record<string, unknown>,
): void {
  ws.send(JSON.stringify(message));
}

function closeWorkerSocket(ws: ServerWebSocket<WebSocketData>, code: number, reason: string): void {
  try {
    ws.unsubscribe(ws.data.pathname);
  } catch {
    // The socket may already be detached from the subscription set.
  }
  ws.close(code, reason);
  setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      // The peer may have already completed the close handshake.
    }
  }, 10);
}

function rejectRegistration(
  ws: ServerWebSocket<WebSocketData>,
  code: RegisterErrorMessage['code'],
  message: string,
  requestedProtocolVersion?: number,
): void {
  sendWorkerProtocolMessage(ws, {
    type: 'registerError',
    code,
    message,
    supportedProtocolVersions: REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
    ...(requestedProtocolVersion !== undefined ? { requestedProtocolVersion } : {}),
  });
  closeWorkerSocket(ws, WORKER_REGISTRATION_CLOSE_CODE, code);
}

function rejectProtocolMessage(
  ws: ServerWebSocket<WebSocketData>,
  code: ProtocolErrorMessage['code'],
  message: string,
): void {
  sendWorkerProtocolMessage(ws, { type: 'protocolError', code, message });
  closeWorkerSocket(ws, WORKER_PROTOCOL_CLOSE_CODE, code);
}

/**
 * Whether the connection's principal is allowed to register a worker. An
 * absent principal means authentication is disabled on this server, so the
 * registration is allowed; a present principal must carry `workers:write`.
 */
function principalMayRegisterWorker(principal: WebSocketData['principal']): boolean {
  if (principal === undefined) return true;
  return isAuthenticated(principal) && principal.hasScope('workers:write');
}

/**
 * Build the registry descriptor from a register message, including only the
 * optional metadata fields the worker actually supplied so the registry never
 * stores `undefined` values.
 */
function buildWorkerRegistrationInfo(
  message: RegisterMessage,
  queue: string,
  concurrency: number,
): WorkerRegistrationInfo {
  return {
    id: message.workerId,
    queue,
    activities: [...message.activities],
    concurrency,
    ...(message.deploymentName !== undefined ? { deploymentName: message.deploymentName } : {}),
    ...(message.buildId !== undefined ? { buildId: message.buildId } : {}),
    ...(message.runtimeVersion !== undefined ? { runtimeVersion: message.runtimeVersion } : {}),
    ...(message.gitSha !== undefined ? { gitSha: message.gitSha } : {}),
    ...(message.startedAt !== undefined ? { startedAt: message.startedAt } : {}),
    ...(message.capabilities !== undefined ? { capabilities: message.capabilities } : {}),
  };
}

function registerWorker(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
): void {
  if (!principalMayRegisterWorker(ws.data.principal)) {
    rejectRegistration(
      ws,
      'invalid_registration',
      'Worker registration requires the workers:write scope',
      message.protocolVersion,
    );
    return;
  }

  const rawConcurrency = message.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
  const clampedConcurrency = Math.min(
    Math.max(1, Math.floor(rawConcurrency)),
    MAX_WORKER_CONCURRENCY,
  );
  const queue = ws.data.queue ?? 'default';

  // Cancel any pending deferred-requeue for this workerId. The previous socket
  // closed and scheduled a requeue inside the grace period; the worker is
  // reconnecting before that fires, so we hold its in-flight tasks instead of
  // reassigning them.
  const pendingRequeue = context.pendingWorkerRequeues.get(message.workerId);
  if (pendingRequeue !== undefined) {
    clearTimeout(pendingRequeue);
    context.pendingWorkerRequeues.delete(message.workerId);
  }

  ws.data.workerId = message.workerId;
  ws.data.workerRegistered = true;
  ws.data.workerProtocolVersion = message.protocolVersion;
  context.registry.register(buildWorkerRegistrationInfo(message, queue, clampedConcurrency));
  context.workerSockets.set(message.workerId, ws);
  sendWorkerProtocolMessage(ws, {
    type: 'registerAck',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId: message.workerId,
    queue,
    activities: [...message.activities],
    concurrency: clampedConcurrency,
  });
}

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
  //
  // Limitation, documented and accepted in this PR: (operationId, workerId)
  // is sufficient ONLY when takeover moves the task to a different
  // workerId. If the scheduler re-selects the same workerId on a later
  // attempt (e.g., a single-worker deployment where the only available
  // worker is the one that just timed out), a stale completion from the
  // earlier attempt can pass this guard. Production deployments that need
  // to defend against this case must use multiple workers and a routing
  // policy that avoids reselecting the displaced worker, or wait for a
  // future protocol revision that adds an attempt token to the wire format.
  // Adding an attempt token here would require a protocol-version bump and
  // is explicitly out of scope.
  if (workerId === undefined || !context.registry.isAssignedToWorker(operationId, workerId)) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: `taskResult for operation "${operationId}" rejected — task not assigned to worker "${workerId ?? ''}"`,
    });
    return;
  }

  context.registry.completeTask(operationId);
  context.deadlineTracker.remove(operationId);
  cleanupWorkflowIndex(operationId);
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  void (async () => {
    const inflightRecord = await readInflightRecord(options.engine.storage, operationId);
    const resolvedAt = Date.now();
    const resolvedStatus = resolveTaskResultStatus(message);
    await transitionInflightToResolved(options.engine.storage, operationId, resolvedStatus, {
      ...(inflightRecord === null ? {} : { record: inflightRecord }),
      resolvedAt,
      resolutionReason: resolvedStatus,
      ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
    });
    if (inflightRecord !== null) {
      recordTaskExecutionLatencyMetric(context.metricsCollector, inflightRecord, resolvedAt);
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
    if (
      result.error.code === 'invalid_registration' ||
      result.error.code === 'unsupported_protocol_version'
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
      registerWorker(context, ws, message);
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
