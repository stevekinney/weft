import type { ServeOptions } from '../index.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import { readRestJsonBody, type RestBodyReadOptions } from '../rest-body.ts';
import { claimQueued } from '../task-ledger-transitions.ts';
import { decodeRemoteTaskRecord, taskLedgerKey, type RemoteTaskRecord } from '../task-ledger.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { ServerContext } from './context.ts';
import { commitTaskLedgerCompletion } from './task-ledger-completion.ts';
import { commitTaskLedgerTransition } from './task-ledger-runtime.ts';
import {
  recordTaskBacklogMetric,
  recordTaskExecutionLatencyMetric,
  recordTaskQueueLatencyMetric,
} from './task-metrics.ts';
import { taskResultPayloadSizeError } from './task-result-resolution.ts';

const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;
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
  status: 'completed' | 'failed';
  workerId: string | undefined;
  value: unknown;
  error: string | undefined;
  attemptToken: string;
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

  if (status !== 'completed' && status !== 'failed') {
    return Response.json({ error: 'status must be "completed" or "failed"' }, { status: 400 });
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
  };
}

/**
 * Whether a long-poll completion may apply, read from the durable ledger
 * record rather than the old `op:inflight:` record. Unlike the pre-ledger
 * system, an absent or non-owning record is a hard rejection, not a
 * duplicate-tolerant no-op — the ledger's single authoritative key removes
 * the ambiguity that made "absent" a plausible stand-in for "already
 * resolved elsewhere" (see the project brief's failure matrix: "Result
 * arrives for unknown operation → Rejected").
 */
function isLongPollCompletionAuthorized(
  record: RemoteTaskRecord | null,
  validated: ValidatedTaskResult,
): boolean {
  if (record === null) return false;
  if (record.state !== 'leased' && record.state !== 'completing') return false;
  if (validated.workerId === undefined || record.workerSessionId !== validated.workerId) {
    return false;
  }
  return validated.attemptToken === record.attemptToken;
}

/**
 * Apply a validated task result: commit it through the durable ledger, then
 * update the in-memory bookkeeping the durable write does not own —
 * resolving any parked local completion waiters and clearing the deadline
 * tracker entry.
 */
async function applyTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { operationId, status, value, error } = result;

  const committed = await commitTaskLedgerCompletion(options.engine.storage, {
    operationId,
    attemptToken: result.attemptToken,
    status,
    ...(status === 'completed' ? { value } : {}),
    ...(status === 'failed' && error !== undefined ? { error } : {}),
  });
  if (!committed.ok) return committed;

  recordTaskExecutionLatencyMetric(
    context.metricsCollector,
    { startedAt: committed.completing.startedAt },
    Date.now(),
  );
  context.taskQueue.complete({ operationId, status, value, error });
  context.deadlineTracker.remove(operationId);
  recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);

  return { ok: true };
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
  if (!isLongPollCompletionAuthorized(record, validated)) {
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
    const rejected = await commitTaskLedgerCompletion(options.engine.storage, {
      operationId: validated.operationId,
      attemptToken: validated.attemptToken,
      status: 'failed',
      error: payloadError.message,
    });
    if (rejected.ok) {
      recordTaskExecutionLatencyMetric(
        context.metricsCollector,
        { startedAt: rejected.completing.startedAt },
        Date.now(),
      );
      context.taskQueue.complete({
        operationId: validated.operationId,
        status: 'failed',
        error: payloadError.message,
      });
      context.deadlineTracker.remove(validated.operationId);
      recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
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
  return Response.json({ ok: true });
}
