import {
  buildClaimAttemptRecordWrite,
  buildCurrentAttemptDispositionWrites,
  digestAttemptToken,
} from '../../core/task-ledger/task-attempt-runtime.ts';
import { commitTaskLedgerTransition } from '../../core/task-ledger/task-ledger-runtime.ts';
import { claimQueued, renewAttemptLease } from '../../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskRecord,
} from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import { readRestJsonBody, type RestBodyReadOptions } from '../rest-body.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { ServerContext } from './context.ts';
import type { TaskResultDisposition } from './task-ledger-completion.ts';
import { recordTaskBacklogMetric, recordTaskQueueLatencyMetric } from './task-metrics.ts';
import { applyWorkerTaskResult } from './task-result-application.ts';
import {
  authorizeTaskResultForCurrentAttempt,
  currentAttemptFromLedgerRecord,
} from './task-result-authorization.ts';
import { taskResultPayloadSizeError } from './task-result-resolution.ts';

const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;
const TASK_HEARTBEAT_RE = /^\/v1\/tasks\/([\w-]+)\/heartbeat$/;
const TASK_DIAGNOSTICS_PATH = '/v1/tasks/diagnostics';

const MAX_POLL_TIMEOUT = 60_000;
const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;

async function parseTaskResultBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<Record<string, unknown> | null | Response> {
  try {
    return (await readRestJsonBody(request, options)) as Record<string, unknown>;
  } catch (error) {
    if (isPayloadTooLargeFault(error)) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return null;
  }
}

function isPayloadTooLargeFault(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['code'] === 'PayloadTooLarge' &&
    typeof (value as Record<string, unknown>)['message'] === 'string'
  );
}

type ValidatedTaskResult = {
  operationId: string;
  /**
   * `'cancelled'` (COR-230, acceptance criterion 13) is a long-poll worker's
   * cooperative response to a heartbeat-piggybacked cancellation signal —
   * the exact counterpart to the WebSocket transport's `taskResult(status:
   * 'cancelled')`. `commitTaskLedgerCompletion` resolves it through the same
   * dedicated `Cancelling --> Terminal` path either way.
   */
  status: 'completed' | 'failed' | 'cancelled';
  workerId: string | undefined;
  value: unknown;
  error: string | undefined;
  attemptToken: string;
  workflowRevision: string | undefined;
};

function authorizeWorkerPrincipal(principal: Principal | undefined): Response | null {
  if (principal === undefined) return null;
  if (isAuthenticated(principal) && principal.hasScope('workers:write')) return null;
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

/**
 * Await startup task-ledger recovery (WFT-23) before a long-poll claim or
 * result submission touches the ledger or the in-memory indexes recovery
 * rebuilds. Returns a 503 with an actionable error if recovery itself
 * failed, else `null` to let the caller proceed.
 */
async function awaitTaskLedgerRecovery(context: ServerContext): Promise<Response | null> {
  try {
    await context.taskLedgerRecovery.ready;
    return null;
  } catch (error) {
    return Response.json(
      {
        error: `Startup task-ledger recovery failed — cannot admit new task claims: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 503 },
    );
  }
}

/**
 * Validate and extract typed fields from a parsed task-result body.
 * Returns the validated result or a 400 Response if validation fails.
 */
function validateTaskResultBody(body: Record<string, unknown>): ValidatedTaskResult | Response {
  const operationId = body['operationId'];
  const status = body['status'];
  if (typeof operationId !== 'string' || typeof status !== 'string') {
    return Response.json(
      { error: 'Missing required fields: operationId, status' },
      { status: 400 },
    );
  }

  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    return Response.json(
      { error: 'status must be "completed", "failed", or "cancelled"' },
      { status: 400 },
    );
  }

  const rawAttemptToken = body['attemptToken'];
  if (typeof rawAttemptToken !== 'string' || rawAttemptToken === '') {
    return Response.json({ error: 'attemptToken must be a non-empty string' }, { status: 400 });
  }

  return {
    operationId,
    status,
    workerId: typeof body['workerId'] === 'string' ? body['workerId'] : undefined,
    value: body['value'],
    error: typeof body['error'] === 'string' ? body['error'] : undefined,
    attemptToken: rawAttemptToken,
    workflowRevision:
      typeof body['workflowRevision'] === 'string' ? body['workflowRevision'] : undefined,
  };
}

/**
 * Whether a long-poll completion may apply, read from the durable ledger
 * record rather than the old `op:inflight:` record. Unlike the pre-ledger
 * system, an absent or non-owning record is a hard rejection, not a
 * duplicate-tolerant no-op — the ledger's single authoritative key removes
 * the ambiguity that made "absent" a plausible stand-in for "already
 * resolved elsewhere" (see the project brief's failure matrix: "Result
 * arrives for unknown operation → Rejected"). The identity/attempt-token
 * decision itself is shared with the WebSocket transport (COR-233) — see
 * `authorizeTaskResultForCurrentAttempt` in `task-result-authorization.ts`,
 * which is also what lets a resend of an already-`terminal`/`deadLettered`
 * result reach `commitTaskLedgerCompletion`'s idempotent `duplicate`
 * handling instead of dying here the way it did before COR-233.
 *
 * Revision authorization (WFT-20) is STRICT for long-poll, unlike the
 * WebSocket transport's additive policy: when the stored ledger record
 * carries a `workflowRevision`, the POST body must echo it back exactly — a
 * missing echo is rejected the same as a mismatched one. Long-poll has no
 * live in-flight registry entry to fall back to ("was this SDK ever told
 * about the field") the way the WebSocket path does, so once ANY caller
 * starts supplying `workflowRevision` on `TaskDispatch` for a given
 * operation, every worker completing it must echo the value back. Checked
 * only while the attempt is still live (`leased`/`completing`) — a resend
 * against an already-resolved record is authorized by attempt token alone
 * (see `authorizeTaskResultForCurrentAttempt`), and `commitTaskLedgerCompletion`'s
 * content-digest comparison is what actually guards a resolved record
 * against a genuinely different resubmission from there.
 *
 * `queue` is the `:queue` path segment the result POST arrived on. It must
 * match the record's own `queue` exactly (COR-240) — otherwise a result
 * submitted against the wrong queue path could still authorize a completion
 * as long as the rest of the body matched, which is not the contract the
 * queue segment exists to enforce.
 */
function isLongPollCompletionAuthorized(
  record: RemoteTaskRecord | null,
  validated: ValidatedTaskResult,
  queue: string,
): boolean {
  if (record !== null && record.queue !== queue) return false;

  const authorization = authorizeTaskResultForCurrentAttempt(
    currentAttemptFromLedgerRecord(record),
    validated.workerId,
    validated.attemptToken,
  );
  if (!authorization.ok) return false;

  if (
    record !== null &&
    (record.state === 'leased' || record.state === 'completing' || record.state === 'cancelling') &&
    record.workflowRevision !== undefined &&
    validated.workflowRevision !== record.workflowRevision
  ) {
    return false;
  }

  return true;
}

/**
 * Apply a validated task result through the shared result-application
 * implementation (`applyWorkerTaskResult`, COR-240 acceptance criterion 12),
 * then update the in-memory bookkeeping the durable write does not own —
 * resolving any parked local completion waiters and clearing the deadline
 * tracker entry.
 */
async function applyTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
): Promise<{ ok: true; disposition: TaskResultDisposition } | { ok: false; reason: string }> {
  const { operationId, status, value, error } = result;

  const applied = await applyWorkerTaskResult(
    options,
    context.metricsCollector,
    {
      operationId,
      attemptToken: result.attemptToken,
      status,
      ...(status === 'completed' ? { value } : {}),
      ...(status !== 'completed' && error !== undefined ? { error } : {}),
    },
    result.workerId,
  );
  if (!applied.ok) {
    return { ok: false, reason: applied.reason };
  }

  // Dead-lettered is terminal-ish: no further heartbeat/visibility extension
  // will arrive for this operation, so stop tracking its deadline either
  // way. taskQueue.complete() is deliberately skipped for a dead letter —
  // that signals a normal delivered result to whatever is waiting, and a
  // dead letter is the opposite: the result could not be durably applied as
  // completed/failed.
  context.deadlineTracker.remove(operationId);
  if (applied.disposition !== 'dead-lettered') {
    context.taskQueue.complete({ operationId, status, value, error });
    recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  }

  return { ok: true, disposition: applied.disposition };
}

function payloadSizeExceededResponse(error: {
  code: string;
  message: string;
  maxBytes: number;
  serializedBytes: number;
  payloadKind: string;
}): Response {
  return Response.json(
    {
      error: error.message,
      code: error.code,
      maxBytes: error.maxBytes,
      serializedBytes: error.serializedBytes,
      payloadKind: error.payloadKind,
    },
    { status: 413 },
  );
}

/** The worker-facing identity of a long-poll claim: the synthetic worker id and its per-claim token. */
export interface LongPollClaim {
  workerId: string;
  attemptToken: string;
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
): Promise<LongPollClaim | null> {
  const workerSessionId = `longpoll-${crypto.randomUUID().slice(0, 8)}`;
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

  return { workerId: workerSessionId, attemptToken };
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
      ...(task.workflowExecutionToken !== undefined && {
        workflowExecutionToken: task.workflowExecutionToken,
      }),
      ...(task.workflowRevision !== undefined && { workflowRevision: task.workflowRevision }),
    });
  }

  return new Response(null, { status: 204 });
}

export async function handleTaskResultRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  if (request.method !== 'POST') {
    return null;
  }

  const completeMatch = TASK_RESULT_RE.exec(url.pathname);
  if (!completeMatch?.[1]) {
    return null;
  }
  const queue = decodeURIComponent(completeMatch[1]);

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

  const validated = validateTaskResultBody(body);
  if (validated instanceof Response) {
    return validated;
  }

  const record = decodeRemoteTaskRecord(
    await options.engine.storage.get(taskLedgerKey(validated.operationId)),
  );
  if (!isLongPollCompletionAuthorized(record, validated, queue)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const payloadError = taskResultPayloadSizeError(
    {
      status: validated.status,
      ...(validated.status === 'completed'
        ? { value: validated.value }
        : { error: validated.error }),
    },
    context.payloadSizeMaxBytes,
  );
  if (payloadError !== null) {
    const rejected = await applyWorkerTaskResult(
      options,
      context.metricsCollector,
      {
        operationId: validated.operationId,
        attemptToken: validated.attemptToken,
        status: 'failed',
        error: payloadError.message,
      },
      validated.workerId,
    );
    if (rejected.ok) {
      context.deadlineTracker.remove(validated.operationId);
      if (rejected.disposition !== 'dead-lettered') {
        context.taskQueue.complete({
          operationId: validated.operationId,
          status: 'failed',
          error: payloadError.message,
        });
        recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
      }
    } else {
      console.error(
        `[weft] Failed to persist oversized task result rejection for task "${validated.operationId}":`,
        rejected.reason,
      );
    }
    return payloadSizeExceededResponse(payloadError);
  }

  const applied = await applyTaskResult(context, options, validated);
  if (!applied.ok) {
    console.error(
      `[weft] Failed to commit task result for "${validated.operationId}" through the durable ledger:`,
      applied.reason,
    );
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  return Response.json({ ok: true, disposition: applied.disposition });
}

// ---------------------------------------------------------------------------
// Heartbeat (COR-230, acceptance criterion 5)
// ---------------------------------------------------------------------------

type ValidatedTaskHeartbeat = {
  operationId: string;
  workerId: string | undefined;
  attemptToken: string;
};

/**
 * Validate and extract typed fields from a parsed long-poll heartbeat body.
 * Mirrors {@link validateTaskResultBody}'s shape and strictness — `attemptToken`
 * is required exactly the same way, since this is the same identity fence
 * `authorizeTaskResultForCurrentAttempt` checks for both a completion and a
 * heartbeat.
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

  if (record !== null && record.state === 'cancelling') {
    return Response.json({ ok: true, cancelled: true });
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
    });
  }

  context.deadlineTracker.remove(validated.operationId);
  context.deadlineTracker.add({
    operationId: validated.operationId,
    deadline: renewed.record.leaseDeadline,
  });

  return Response.json({ ok: true, cancelled: false, leaseDeadline: renewed.record.leaseDeadline });
}
