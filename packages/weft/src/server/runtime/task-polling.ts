import type { JSONValue } from '../../core/json.ts';
import {
  buildClaimAttemptRecordWrite,
  buildCurrentAttemptDispositionWrites,
  buildTaskAttemptTransitionEvent,
  digestAttemptToken,
} from '../../core/task-ledger/task-attempt-runtime.ts';
import { commitTaskLedgerTransition } from '../../core/task-ledger/task-ledger-runtime.ts';
import { claimQueued, renewAttemptLease } from '../../core/task-ledger/task-ledger-transitions.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import type { Principal } from '../principal.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { ServerContext } from './context.ts';
import { recordTaskBacklogMetric, recordTaskQueueLatencyMetric } from './task-metrics.ts';
import {
  authorizeTaskResultForCurrentAttempt,
  currentAttemptFromLedgerRecord,
} from './task-result-authorization.ts';
import { activityHeartbeatDetailsPayloadSizeError } from './task-result-resolution.ts';
import {
  authorizeWorkerPrincipal,
  awaitTaskLedgerRecovery,
  parseTaskResultBody,
} from './task-result-submission.ts';

const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_HEARTBEAT_RE = /^\/v1\/tasks\/([\w-]+)\/heartbeat$/;
const TASK_DIAGNOSTICS_PATH = '/v1/tasks/diagnostics';

export const MAX_POLL_TIMEOUT = 60_000;
export const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;

/** The worker-facing identity of a long-poll claim: the synthetic worker id and its per-claim token. */
export interface LongPollClaim {
  workerId: string;
  attemptToken: string;
  /** A PRIOR attempt's recorded heartbeat details (COR-226), echoed back so this (possibly redispatched) attempt can resume from them. */
  lastHeartbeatDetails?: unknown;
}

/**
 * Conditionally claim the durable `queued` ledger record for a task the
 * in-memory `TaskQueue` matched to a long-poll waiter. Returns `null` when
 * the claim loses — the ledger disagrees with the in-memory match hint,
 * meaning another actor already claimed or cancelled this operationId — in
 * which case the caller treats the poll as if nothing matched, per "index
 * disagreement never authorizes a state transition".
 *
 * Long-poll workers never call `WorkerRegistry.register()`, so there is no
 * manifest to build a `WorkerExecutionIdentity` from; the claim always omits
 * `executionIdentity` (see `RemoteTaskLeased.executionIdentity`'s doc
 * comment) rather than fabricate one.
 */
export async function markTaskClaimedByLongPollWorker(
  context: ServerContext,
  options: ServeOptions,
  task: PendingTask,
  workerSessionId: string = `longpoll-${crypto.randomUUID().slice(0, 8)}`,
): Promise<LongPollClaim | null> {
  const attemptToken = crypto.randomUUID();
  const visibilityTimeout = task.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
  const attemptTokenDigest = digestAttemptToken(attemptToken);

  const result = await commitTaskLedgerTransition(
    options.engine.storage,
    task.operationId,
    (current, now) => {
      if (current === null || current.state !== 'queued') {
        return {
          ok: false as const,
          reason: `operation "${task.operationId}" is not claimable from its current ledger state`,
        };
      }
      return claimQueued(
        current,
        {
          expectedGeneration: current.generation,
          attemptToken,
          workerSessionId,
          leaseDurationMilliseconds: visibilityTimeout,
        },
        now,
      );
    },
    1,
    [],
    // A long-poll claim never has an `executionIdentity` (no manifest — see
    // `RemoteTaskLeased.executionIdentity`'s doc comment) or a session
    // generation (no `WorkerRegistry.register()` call either), but still
    // produces a complete attempt record (criterion 1): operationId,
    // attempt, digest, and worker session are always known.
    async (_current, nextRecord, now) =>
      [
        buildClaimAttemptRecordWrite({
          operationId: nextRecord.operationId,
          attempt: nextRecord.attempt,
          attemptTokenDigest,
          workerSessionId: nextRecord.workerSessionId,
          ...(nextRecord.executionRequirement !== undefined
            ? { executionRequirement: nextRecord.executionRequirement }
            : {}),
          claimedAt: now,
        }),
      ] as const,
  );
  if (!result.ok) return null;

  context.deadlineTracker.add({
    operationId: task.operationId,
    deadline: result.record.leaseDeadline,
  });
  recordTaskQueueLatencyMetric(context.metricsCollector, {
    lastQueuedAt: result.record.lastQueuedAt,
    lastDispatchedAt: Date.now(),
  });
  recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  context.registry.assignTask(
    workerSessionId,
    task.operationId,
    visibilityTimeout,
    undefined,
    attemptToken,
    task.workflowRevision,
  );
  // COR-198: attempt-by-attempt worker transition.
  options.engine.dispatchEvent(
    await buildTaskAttemptTransitionEvent(options.engine.storage, {
      operationId: task.operationId,
      workflowId: task.workflowId,
      activityName: task.activityName,
      attempt: result.record.attempt,
      attemptTokenDigest,
      workerSessionId,
      executionIdentity: undefined,
      executionRequirement: result.record.executionRequirement,
    }),
  );

  return {
    workerId: workerSessionId,
    attemptToken,
    ...(result.record.lastHeartbeatDetails !== undefined && {
      lastHeartbeatDetails: result.record.lastHeartbeatDetails,
    }),
  };
}

export async function handleTaskPollRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  if (request.method !== 'GET') {
    return null;
  }

  if (url.pathname === TASK_DIAGNOSTICS_PATH) {
    return null;
  }

  const pollMatch = TASK_POLL_RE.exec(url.pathname);
  if (!pollMatch?.[1]) {
    return null;
  }

  const authorizationResponse = authorizeWorkerPrincipal(principal);
  if (authorizationResponse !== null) return authorizationResponse;

  const recoveryResponse = await awaitTaskLedgerRecovery(context);
  if (recoveryResponse !== null) return recoveryResponse;

  const queue = decodeURIComponent(pollMatch[1]);
  const activities = url.searchParams.getAll('activity');
  if (activities.length === 0) {
    return Response.json(
      { error: 'At least one "activity" query parameter is required' },
      { status: 400 },
    );
  }

  const rawTimeout = url.searchParams.get('timeout');
  const timeout =
    rawTimeout !== null
      ? Math.min(Math.max(0, Number(rawTimeout)), MAX_POLL_TIMEOUT)
      : DEFAULT_POLL_TIMEOUT;

  const task = await context.taskQueue.poll(queue, activities, timeout, request.signal);
  if (task !== null) {
    const claim = await markTaskClaimedByLongPollWorker(context, options, task);
    if (claim === null) {
      // The in-memory match was stale by the time the durable claim ran —
      // treat this poll as if nothing matched rather than handing out a
      // task the ledger disagrees the worker actually holds.
      return new Response(null, { status: 204 });
    }
    return Response.json({
      ...task,
      workerId: claim.workerId,
      attemptToken: claim.attemptToken,
      ...(claim.lastHeartbeatDetails !== undefined && {
        lastHeartbeatDetails: claim.lastHeartbeatDetails,
      }),
      ...(task.workflowExecutionToken !== undefined && {
        workflowExecutionToken: task.workflowExecutionToken,
      }),
      ...(task.workflowRevision !== undefined && { workflowRevision: task.workflowRevision }),
    });
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Heartbeat (COR-230, acceptance criterion 5)
// ---------------------------------------------------------------------------

type ValidatedTaskHeartbeat = {
  operationId: string;
  workerId: string | undefined;
  attemptToken: string;
  /** Heartbeat details this beat carries (COR-226), or `undefined` when the body omitted the field. */
  details: unknown;
};

/**
 * Validate and extract typed fields from a parsed long-poll heartbeat body.
 * Mirrors {@link validateTaskResultBody}'s shape and strictness — `attemptToken`
 * is required exactly the same way, since this is the same identity fence
 * `authorizeTaskResultForCurrentAttempt` checks for both a completion and a
 * heartbeat. `details` (COR-226) is unvalidated shape here — the size bound
 * is enforced by the caller once authorization succeeds, matching
 * `taskResult`'s own validate-then-size-check ordering.
 */
function validateTaskHeartbeatBody(
  body: Record<string, unknown>,
): ValidatedTaskHeartbeat | Response {
  const operationId = body['operationId'];
  if (typeof operationId !== 'string' || operationId.length === 0) {
    return Response.json({ error: 'Missing required field: operationId' }, { status: 400 });
  }
  const attemptToken = body['attemptToken'];
  if (typeof attemptToken !== 'string' || attemptToken.length === 0) {
    return Response.json({ error: 'attemptToken must be a non-empty string' }, { status: 400 });
  }
  return {
    operationId,
    workerId: typeof body['workerId'] === 'string' ? body['workerId'] : undefined,
    attemptToken,
    details: body['details'],
  };
}

/**
 * Long-poll counterpart to the WebSocket transport's `activityHeartbeat`
 * (COR-230, acceptance criterion 5 — "long-running WebSocket and long-poll
 * activities renew the same attempt-fenced lease contract"). Authorizes
 * through the exact same {@link authorizeTaskResultForCurrentAttempt} /
 * {@link currentAttemptFromLedgerRecord} seam `taskResult` uses (extended,
 * COR-230, to also recognize a `cancelling` record as a live attempt), and
 * renews through the exact same {@link renewAttemptLease} transition the
 * WebSocket path's `onActivityHeartbeatMessage` uses — same fencing, same
 * three clocks, same absolute-deadline cap. No second implementation.
 *
 * A `cancelling` record is a valid heartbeat target but is never renewed —
 * `renewAttemptLease`'s own precondition requires `state === 'leased'`,
 * matching the WebSocket path exactly, and there would be nothing to renew
 * for either transport since a cancellation deadline (not the visibility
 * deadline) now governs the record's clock. Instead, the response's
 * `cancelled: true` flag piggybacks the cancellation signal back to the
 * worker (COR-230's suggested shape for a transport with no server-to-worker
 * push channel) — `LongPollWorker` checks it on every heartbeat response and
 * aborts the matching local `AbortController` when it sees it.
 */
export async function handleTaskHeartbeatRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  if (request.method !== 'POST') {
    return null;
  }

  const heartbeatMatch = TASK_HEARTBEAT_RE.exec(url.pathname);
  if (!heartbeatMatch?.[1]) {
    return null;
  }
  const queue = decodeURIComponent(heartbeatMatch[1]);

  const authorizationResponse = authorizeWorkerPrincipal(principal);
  if (authorizationResponse !== null) return authorizationResponse;

  const recoveryResponse = await awaitTaskLedgerRecovery(context);
  if (recoveryResponse !== null) return recoveryResponse;

  const body = await parseTaskResultBody(
    request,
    options.maxRequestBodyBytes !== undefined ? { maxBodyBytes: options.maxRequestBodyBytes } : {},
  );
  if (body instanceof Response) {
    return body;
  }
  if (body === null) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validated = validateTaskHeartbeatBody(body);
  if (validated instanceof Response) {
    return validated;
  }

  const record = decodeRemoteTaskRecord(
    await options.engine.storage.get(taskLedgerKey(validated.operationId)),
  );
  if (record !== null && record.queue !== queue) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromLedgerRecord(record),
    validated.workerId,
    validated.attemptToken,
  );
  if (!authorization.ok) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // COR-226: validate `details` at the protocol boundary, same bound and
  // error shape a `taskResult` value already gets.
  const detailsError = activityHeartbeatDetailsPayloadSizeError(
    validated.details,
    context.payloadSizeMaxBytes,
  );
  if (detailsError !== null) {
    return Response.json({ error: detailsError.message }, { status: 413 });
  }
  const details = validated.details as JSONValue | undefined;

  if (record !== null && record.state === 'cancelling') {
    return Response.json({ ok: true, cancelled: true, reason: record.cancellationReason });
  }
  if (record === null || record.state !== 'leased') {
    // Authorization succeeded (terminal/deadLettered, matched by
    // attemptToken alone) against an attempt that has already resolved —
    // nothing left to renew or cancel. A resent heartbeat after the result
    // already landed is a harmless no-op, not an error.
    return Response.json({ ok: true, cancelled: false });
  }

  const renewed = await commitTaskLedgerTransition(
    options.engine.storage,
    validated.operationId,
    (current, now) =>
      renewAttemptLease(
        current,
        {
          attemptToken: validated.attemptToken,
          workerSessionId: record.workerSessionId,
          leaseDurationMilliseconds: record.visibilityTimeoutMilliseconds,
          ...(details !== undefined ? { details } : {}),
        },
        now,
      ),
    1,
    [],
    // Acceptance criterion 7: heartbeat evidence rides on the SAME
    // attempt-token-fenced transition `renewAttemptLease` already gates —
    // a stale attempt never reaches this callback because its precondition
    // (attempt token + worker session match) already rejected the transition
    // above.
    async (current, _nextRecord, now) =>
      buildCurrentAttemptDispositionWrites(options.engine.storage, current, {
        lastHeartbeatAt: now,
      }),
  );
  if (!renewed.ok) {
    // Lost the race to a concurrent requeue, cancellation, or result commit
    // — the fresh record no longer supports this renewal. Re-read to answer
    // accurately rather than reporting a stale `cancelled: false`.
    const current = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(validated.operationId)),
    );
    return Response.json({
      ok: true,
      cancelled: current !== null && current.state === 'cancelling',
      ...(current !== null && current.state === 'cancelling'
        ? { reason: current.cancellationReason }
        : {}),
    });
  }

  context.deadlineTracker.remove(validated.operationId);
  context.deadlineTracker.add({
    operationId: validated.operationId,
    deadline: renewed.record.leaseDeadline,
  });

  return Response.json({ ok: true, cancelled: false, leaseDeadline: renewed.record.leaseDeadline });
}
