import type { ServerWebSocket } from 'bun';

import { buildCurrentAttemptDispositionWrites } from '../../core/task-ledger/task-attempt-runtime.ts';
import { commitTaskLedgerTransition } from '../../core/task-ledger/task-ledger-runtime.ts';
import { renewAttemptLease } from '../../core/task-ledger/task-ledger-transitions.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  parseWorkerToServerMessage,
  type ActivityHeartbeatMessage,
  type HeartbeatMessage,
  type RegisterErrorMessage,
  type TaskResultMessage,
  type WorkerToServerMessage,
} from '../../worker/protocol.ts';
import { workerProtocolIncompatibleMessage } from '../../worker/worker-protocol-incompatible-error.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { ServerContext } from './context.ts';
import { withRetry } from './retry.ts';
import type { TaskLedgerCompletionInput } from './task-ledger-completion.ts';
import { recordWorkerCapacitySaturationMetric } from './task-metrics.ts';
import { applyWorkerTaskResult } from './task-result-application.ts';
import {
  authorizeTaskResultForCurrentAttempt,
  currentAttemptFromInFlightTask,
  currentAttemptFromLedgerRecord,
  type TaskResultAuthorizationFailure,
} from './task-result-authorization.ts';
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

/**
 * COR-230, acceptance criterion 13: a worker's `status: 'cancelled'`
 * `taskResult` is passed through as `'cancelled'`, distinctly from
 * `'failed'` — before COR-230 this folded into `'failed'` here, which is
 * exactly the generic-failure conflation criterion 13 exists to eliminate.
 * `commitTaskLedgerCompletion` decides from there whether the ledger has a
 * matching `Cancelling` record to resolve it against, or must normalize it
 * back to a failure itself (no cancellation was ever recorded).
 */
function resolveTaskResultStatus(message: TaskResultMessage): 'completed' | 'failed' | 'cancelled' {
  if (message.status === 'completed') return 'completed';
  if (message.status === 'cancelled') return 'cancelled';
  return 'failed';
}

/**
 * The `protocolError` text for a rejected `taskResult`, shared by
 * `onTaskResultMessage`'s fast path and its fallback (COR-233) so both
 * report the same wording for the same failure. `'no-current-attempt'` only
 * ever reaches this from the fallback (the fast path branches on
 * `inFlightTask === undefined` before authorizing), and reads the same as
 * `'worker-mismatch'` — from the worker's point of view, "no one recognizes
 * this attempt" and "someone else holds it" are both "not assigned to you".
 */
function taskResultRejectionMessage(
  reason: TaskResultAuthorizationFailure,
  operationId: string,
  workerId: string | undefined,
): string {
  if (reason === 'attempt-token-mismatch') {
    return `taskResult for operation "${operationId}" rejected — stale attempt token`;
  }
  return `taskResult for operation "${operationId}" rejected — task not assigned to worker "${workerId ?? ''}"`;
}

/**
 * The `protocolError` text for a rejected `activityHeartbeat` (COR-230).
 * Mirrors {@link taskResultRejectionMessage}'s wording exactly, since the
 * underlying decision is the identical `authorizeTaskResultForCurrentAttempt`
 * check — a stale, superseded, or unrecognized attempt reads the same
 * whether the rejected message was a completion or a heartbeat.
 */
function activityHeartbeatRejectionMessage(
  reason: TaskResultAuthorizationFailure,
  operationId: string,
  workerId: string | undefined,
): string {
  if (reason === 'attempt-token-mismatch') {
    return `activityHeartbeat for operation "${operationId}" rejected — stale attempt token`;
  }
  return `activityHeartbeat for operation "${operationId}" rejected — task not assigned to worker "${workerId ?? ''}"`;
}

/**
 * Commit an already-authorized `taskResult` through the shared
 * result-application implementation and acknowledge it, or log a durable
 * commit failure. Shared by `onTaskResultMessage`'s fast (in-flight) path and
 * its ledger-backed fallback path (COR-233) so both send identical
 * ack/error shapes.
 */
async function commitAndAcknowledgeTaskResult(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  workerId: string | undefined,
  message: TaskResultMessage,
): Promise<void> {
  const operationId = message.operationId;
  const resolvedStatus = resolveTaskResultStatus(message);
  const payloadError = taskResultPayloadSizeError(
    {
      status: resolvedStatus,
      ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
    },
    context.payloadSizeMaxBytes,
  );

  if (payloadError !== null) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: payloadError.message,
    });
    const rejected = await applyWorkerTaskResult(
      options,
      context.metricsCollector,
      {
        operationId,
        attemptToken: message.attemptToken,
        status: 'failed',
        error: payloadError.message,
      },
      workerId,
    );
    if (rejected.ok) {
      sendTaskResultAck(ws, operationId, message.attemptToken, rejected.disposition);
    } else {
      console.error(
        `[weft] Failed to persist oversized task result rejection for task "${operationId}":`,
        rejected.reason,
      );
    }
    return;
  }

  const input: TaskLedgerCompletionInput = {
    operationId,
    attemptToken: message.attemptToken,
    status: resolvedStatus,
    ...(message.status === 'completed' ? { value: message.value } : { error: message.error }),
  };
  const applied = await applyWorkerTaskResult(options, context.metricsCollector, input, workerId);
  if (applied.ok) {
    sendTaskResultAck(ws, operationId, message.attemptToken, applied.disposition);
  } else {
    console.error(
      `[weft] Failed to commit task result for "${operationId}" through the durable ledger:`,
      applied.reason,
    );
  }
}

/**
 * Fallback path for a `taskResult` whose operation `WorkerRegistry` has no
 * in-flight entry for at all — either it never existed, or (COR-233)
 * `completeTask()` already removed it while processing this exact result's
 * first delivery, before the durable commit completed and before its
 * `taskResultAck` necessarily made it back to the worker. A worker resending
 * after losing that ack — `TaskResultOutbox`'s entire reason to exist
 * (`worker/task-result-outbox.ts`) — always lands here on retry: the
 * ephemeral registry has forgotten the operation, but the durable ledger has
 * not. Reading it directly, the same source of truth long-poll always reads,
 * is what lets the resend reach `applyWorkerTaskResult`'s idempotent
 * `duplicate`/`dead-lettered` handling instead of a `protocolError` that can
 * never clear — "not in the registry" can never become false again for an
 * operation that has already resolved, so treating it as a final rejection
 * would strand the worker's outbox forever.
 */
async function applyTaskResultFallback(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  workerId: string | undefined,
  message: TaskResultMessage,
): Promise<void> {
  const operationId = message.operationId;
  const record = decodeRemoteTaskRecord(
    await options.engine.storage.get(taskLedgerKey(operationId)),
  );

  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromLedgerRecord(record),
    workerId,
    message.attemptToken,
  );
  if (!authorization.ok) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: taskResultRejectionMessage(authorization.reason, operationId, workerId),
    });
    return;
  }

  // Additive revision policy (WFT-20), matching the fast path's check below:
  // only enforced while the record still carries a `workflowRevision`. A
  // genuine resend of the same original message always echoes back whatever
  // it echoed the first time, so this only ever rejects a submission that is
  // not actually the buffered resend it claims to be.
  if (
    record !== null &&
    record.workflowRevision !== undefined &&
    message.workflowRevision !== record.workflowRevision
  ) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: `taskResult for operation "${operationId}" rejected — revision mismatch`,
    });
    return;
  }

  await commitAndAcknowledgeTaskResult(context, options, ws, workerId, message);
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
  const inFlightTask = context.registry.getTask(operationId);

  if (inFlightTask === undefined) {
    // No live in-flight entry at all — never dispatched to this worker, or
    // (COR-233) already resolved and forgotten by `completeTask()`. Fall
    // back to the durable ledger rather than reject outright; see
    // `applyTaskResultFallback`'s doc comment.
    void applyTaskResultFallback(context, options, ws, workerId, message).catch((error) => {
      console.error(`[weft] Failed to resolve fallback task result for "${operationId}":`, error);
    });
    return;
  }

  // Ownership + attempt-token guard, shared with long-poll (COR-233). The
  // registry's in-flight entry records the worker that currently owns the
  // task; a stale completion from a worker displaced by visibility-timeout
  // reassignment — original worker partitions, scanner reassigns to a peer —
  // no longer matches and is rejected here instead of mutating engine state.
  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromInFlightTask(inFlightTask),
    workerId,
    message.attemptToken,
  );
  if (!authorization.ok) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: taskResultRejectionMessage(authorization.reason, operationId, workerId),
    });
    return;
  }
  // Revision authorization (WFT-20) is ADDITIVE for WebSocket, unlike
  // long-poll's strict policy: a missing echo is tolerated whenever the
  // in-flight entry itself carries no `workflowRevision` (the dispatch never
  // opted in, or a pre-WFT-20 worker SDK never echoes the field back) — a
  // present-and-wrong echo always rejects.
  if (
    inFlightTask.workflowRevision !== undefined &&
    message.workflowRevision !== inFlightTask.workflowRevision
  ) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: `taskResult for operation "${operationId}" rejected — revision mismatch`,
    });
    return;
  }

  context.registry.completeTask(operationId);
  context.deadlineTracker.remove(operationId);
  cleanupWorkflowIndex(operationId);
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  void commitAndAcknowledgeTaskResult(context, options, ws, workerId, message).catch((error) => {
    console.error(
      `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
      error,
    );
  });
}

/**
 * Acknowledge a worker's `taskResult` (COR-240, protocol v4). Sent only when
 * `commitTaskLedgerCompletion` produced an applied, duplicate, or
 * dead-lettered disposition — never for a hard rejection (unknown
 * operation, stale attempt, conflicting content, queued/newer attempt),
 * which the caller already reported via `protocolError` before this would
 * be reached.
 */
function sendTaskResultAck(
  ws: ServerWebSocket<WebSocketData>,
  operationId: string,
  attemptToken: string,
  disposition: 'applied' | 'duplicate' | 'dead-lettered',
): void {
  sendWorkerProtocolMessage(ws, { type: 'taskResultAck', operationId, attemptToken, disposition });
}

/**
 * Handle a validated worker-session `heartbeat` message (COR-230, acceptance
 * criterion 1).
 *
 * Renews ONLY `WorkerRegistry`'s session-liveness clock —
 * `context.registry.heartbeat(workerId)` — and nothing else. Before v5 this
 * also fanned out to extend the visibility deadline of every in-flight task
 * assigned to the connection; that fan-out could not distinguish a live
 * long-running attempt from a stale one the connection no longer actually
 * owned, and is exactly what this split removes. Per-attempt visibility
 * renewal is `onActivityHeartbeatMessage`'s job now, below — a bare
 * `heartbeat` proves the connection is alive, nothing more.
 */
function onHeartbeatMessage(
  context: ServerContext,
  _options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  _message: HeartbeatMessage,
): void {
  const workerId = ws.data.workerId;
  if (!workerId) return;

  context.registry.heartbeat(workerId);
}

/**
 * Handle a validated `activityHeartbeat` message from a worker (COR-230,
 * acceptance criteria 2-4 and 6).
 *
 * Renews ONLY the one named attempt's heartbeat-extendable visibility
 * deadline, fenced by the same `authorizeTaskResultForCurrentAttempt`
 * identity check `onTaskResultMessage` uses for `taskResult` — a stale,
 * superseded, cancelled, completing, or otherwise no-longer-current attempt
 * is rejected with `protocolError` rather than silently renewed (criterion
 * 3) or allowed to shorten/resurrect the lease (criterion 4, enforced inside
 * `renewAttemptLease` itself). Unlike `onTaskResultMessage`, this has no
 * ledger-backed fallback path for a `WorkerRegistry`-forgotten operation: a
 * lost heartbeat is simply retried on the worker's next interval, so there
 * is no ambiguous-ack/outbox concern forcing a resend against an
 * already-resolved record the way there is for `taskResult`.
 */
function onActivityHeartbeatMessage(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  message: ActivityHeartbeatMessage,
): void {
  const workerId = ws.data.workerId;
  const operationId = message.operationId;
  const inFlightTask = context.registry.getTask(operationId);

  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromInFlightTask(inFlightTask),
    workerId,
    message.attemptToken,
  );
  if (!authorization.ok) {
    sendWorkerProtocolMessage(ws, {
      type: 'protocolError',
      code: 'invalid_message',
      message: activityHeartbeatRejectionMessage(authorization.reason, operationId, workerId),
    });
    return;
  }
  // Authorization succeeding against an InFlightTask-derived CurrentAttempt
  // (see `currentAttemptFromInFlightTask`) implies `inFlightTask` is defined
  // — the `undefined` case maps to `CurrentAttempt` `undefined`, which
  // `authorizeTaskResultForCurrentAttempt` always rejects as
  // 'no-current-attempt'.
  const task = inFlightTask as NonNullable<typeof inFlightTask>;

  const newDeadline = context.registry.extendVisibility(operationId, task.visibilityTimeout);
  if (newDeadline === undefined) return;

  // Update persisted storage record and deadline tracker with the same
  // deadline the registry computed, so all three stay in sync across
  // restarts and visibility scans.
  context.deadlineTracker.remove(operationId);
  context.deadlineTracker.add({ operationId, deadline: newDeadline });

  const attemptToken = task.attemptToken;
  void withRetry(async () => {
    // Guard: if the task completed or was reassigned during the async gap,
    // skip the write to avoid resurrecting or corrupting another worker's record.
    if (!context.registry.isAssignedToAttempt(operationId, workerId ?? '', attemptToken)) return;

    // A single attempt, matching the brief's failure matrix: "Stale
    // heartbeat conditional write loses; terminal state remains sole
    // state." A lost CAS here means a result, timeout, or cancellation
    // already committed a newer generation — the heartbeat write simply
    // loses, silently, rather than fighting to retry a transition that
    // no longer applies. `renewAttemptLease` itself enforces the
    // never-shortens / never-exceeds-attemptDeadline monotonicity
    // guarantees (criteria 4 and 6).
    await commitTaskLedgerTransition(
      options.engine.storage,
      operationId,
      (current, now) =>
        renewAttemptLease(
          current,
          {
            attemptToken,
            workerSessionId: workerId ?? '',
            leaseDurationMilliseconds: task.visibilityTimeout,
          },
          now,
        ),
      1,
      [],
      // Acceptance criterion 7: heartbeat evidence rides on the SAME
      // attempt-token-fenced transition `renewAttemptLease` already gates —
      // a stale attempt never reaches this callback because its
      // precondition already rejected the transition above. Safe inside
      // this fire-and-forget closure because `digestAttemptToken` is now
      // the SYNCHRONOUS digest (`sha256HexSync`) — see its doc comment.
      async (current, _nextRecord, now) =>
        buildCurrentAttemptDispositionWrites(options.engine.storage, current, {
          lastHeartbeatAt: now,
        }),
    );
  }, `extend visibility for task "${operationId}"`).catch((error) => {
    console.error(`[weft] Failed to extend visibility for task "${operationId}":`, error);
  });
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
      void registerWorker(context, options, ws, message, cleanupWorkflowIndex).catch(
        (error: unknown) => {
          console.error(`[weft] Failed to register worker "${message.workerId}":`, error);
        },
      );
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
    case 'activityHeartbeat': {
      onActivityHeartbeatMessage(context, options, ws, message);
      break;
    }
    default: {
      // Exhaustiveness guard: adding a new WorkerToServerMessage variant
      // without a case above must fail this typecheck.
      const exhaustiveCheck: never = message;
      return exhaustiveCheck;
    }
  }
}
