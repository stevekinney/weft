import type { ServeOptions } from '../index.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import { readRestJsonBody, type RestBodyReadOptions } from '../rest-body.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { InflightRecord } from '../task-state.ts';
import { readInflightRecord, transitionQueuedToInflight } from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { recordTaskBacklogMetric, recordTaskQueueLatencyMetric } from './task-metrics.ts';
import {
  taskResultPayloadSizeError,
  transitionTaskResultToResolvedWithRetry,
} from './task-result-resolution.ts';

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
  attemptToken: string | undefined;
};

function authorizeWorkerPrincipal(principal: Principal | undefined): Response | null {
  if (principal === undefined) return null;
  if (isAuthenticated(principal) && principal.hasScope('workers:write')) return null;
  return Response.json({ error: 'Forbidden' }, { status: 403 });
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

  // Distinguish a missing attemptToken from a present but malformed one. A
  // present non-string token is a protocol error, rejected here the same way the
  // WebSocket parser rejects it, so the two transports stay consistent and a
  // `{ attemptToken: 42 }` is never silently treated as absent.
  const rawAttemptToken = body['attemptToken'];
  if (
    rawAttemptToken !== undefined &&
    (typeof rawAttemptToken !== 'string' || rawAttemptToken === '')
  ) {
    return Response.json(
      { error: 'attemptToken must be a non-empty string when present' },
      { status: 400 },
    );
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
 * Apply a validated task result: notify the task queue, remove the deadline,
 * and transition the storage record to resolved.
 */
async function applyTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
  inflightRecord: InflightRecord | null,
): Promise<void> {
  const { operationId, status, value, error } = result;

  const resolvedStatus = status === 'failed' ? 'failed' : ('completed' as const);
  try {
    context.taskQueue.complete({ operationId, status, value, error });
    context.deadlineTracker.remove(operationId);

    await transitionTaskResultToResolvedWithRetry(context, options, {
      operationId,
      status: resolvedStatus,
      resolutionReason: resolvedStatus,
      inflightRecord,
      ...(status === 'completed' ? { value } : { error }),
    });
  } catch (storageError) {
    console.error(
      `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
      storageError,
    );
  }
}

async function applyPayloadRejectedTaskResult(
  context: ServerContext,
  options: ServeOptions,
  result: ValidatedTaskResult,
  inflightRecord: InflightRecord | null,
  error: Error,
): Promise<void> {
  context.taskQueue.complete({
    operationId: result.operationId,
    status: 'failed',
    error: error.message,
  });
  context.deadlineTracker.remove(result.operationId);

  await transitionTaskResultToResolvedWithRetry(context, options, {
    operationId: result.operationId,
    status: 'failed',
    resolutionReason: 'failed',
    inflightRecord,
    error: error.message,
    skipPayloadSizeCheck: true,
  });
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

/**
 * A freshly created long-poll inflight record always carries an `attemptToken`.
 * The intersection makes that invariant a compile-time fact so the claim can read
 * the token directly without an unreachable empty-string fallback.
 */
type TokenedInflightRecord = InflightRecord & { attemptToken: string };

export function createLongPollInflightRecord(
  queue: string,
  task: PendingTask,
): TokenedInflightRecord {
  const now = Date.now();
  const visibilityTimeout = task.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
  const deadline = now + visibilityTimeout;

  return {
    operationId: task.operationId,
    workerId: `longpoll-${crypto.randomUUID().slice(0, 8)}`,
    deadline,
    activityName: task.activityName,
    queue,
    input: task.input,
    attempt: task.attempt ?? 1,
    visibilityTimeout,
    retryPolicy: task.retryPolicy,
    workflowId: task.workflowId,
    workflowExecutionToken: task.workflowExecutionToken,
    // Fresh per-claim token. The long-poll completion handler validates the
    // echoed token against the durable record, rejecting a stale earlier claim
    // whose visibility timed out and was reclaimed. Re-claim writes a new record
    // (delete-then-create) so the token rotates by construction.
    attemptToken: crypto.randomUUID(),
    firstQueuedAt: task.firstQueuedAt ?? task.enqueuedAt ?? now,
    lastQueuedAt: task.lastQueuedAt ?? task.enqueuedAt ?? now,
    lastDispatchedAt: now,
    startedAt: now,
    retryCount: task.retryCount ?? Math.max(0, (task.attempt ?? 1) - 1),
    requeueCount: task.requeueCount ?? 0,
    lastRequeueReason: task.lastRequeueReason,
  };
}

/** The worker-facing identity of a long-poll claim: the synthetic worker id and its per-claim token. */
export interface LongPollClaim {
  workerId: string;
  attemptToken: string;
}

export async function markTaskClaimedByLongPollWorker(
  context: ServerContext,
  options: ServeOptions,
  queue: string,
  task: PendingTask,
): Promise<LongPollClaim> {
  const inflightRecord = createLongPollInflightRecord(queue, task);
  context.deadlineTracker.add({
    operationId: task.operationId,
    deadline: inflightRecord.deadline,
  });
  const normalizedInflightRecord = await transitionQueuedToInflight(
    options.engine.storage,
    task.operationId,
    inflightRecord,
  );
  recordTaskQueueLatencyMetric(context.metricsCollector, normalizedInflightRecord);
  recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  return {
    workerId: normalizedInflightRecord.workerId,
    // The token is read from the freshly created record (typed to always carry
    // one), not from the normalized round-trip, so the claim never hands the
    // worker an empty or missing token to echo.
    attemptToken: inflightRecord.attemptToken,
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
    const claim = await markTaskClaimedByLongPollWorker(context, options, queue, task);
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

  // A null record means the task already resolved/expired/was reclaimed, so there
  // is no owner to match against; the completion lands as a no-op on already-
  // settled work. Otherwise the submitter must clear both the workerId and the
  // attempt-token guards before the result is applied.
  const inflightRecord = await readInflightRecord(options.engine.storage, validated.operationId);
  if (inflightRecord !== null && !isLongPollCompletionAuthorized(inflightRecord, validated)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const payloadError = taskResultPayloadSizeError(
    {
      operationId: validated.operationId,
      status: validated.status,
      resolutionReason: validated.status,
      ...(validated.status === 'completed'
        ? { value: validated.value }
        : { error: validated.error }),
    },
    context.payloadSizeMaxBytes,
  );
  if (payloadError !== null) {
    try {
      await applyPayloadRejectedTaskResult(
        context,
        options,
        validated,
        inflightRecord,
        payloadError,
      );
    } catch (error) {
      console.error(
        `[weft] Failed to persist oversized task result rejection for task "${validated.operationId}":`,
        error,
      );
    }
    return payloadSizeExceededResponse(payloadError);
  }

  await applyTaskResult(context, options, validated, inflightRecord);
  return Response.json({ ok: true });
}

/**
 * Whether a long-poll completion may apply to an in-flight task. Two layered
 * checks, both no-ops on rejection (the caller never reaches `applyTaskResult`):
 *
 * - **workerId**: the submitter must echo the exact synthetic workerId handed out
 *   on claim — a missing workerId is rejected, not treated as a wildcard.
 * - **attemptToken**: the per-claim token distinguishes a re-claimed earlier
 *   attempt (same operationId, possibly reusable workerId) from the current one.
 *   When the in-flight record carries a token, the submitter must echo the same
 *   non-empty token. A missing or different token is rejected.
 */
function isLongPollCompletionAuthorized(
  inflightRecord: InflightRecord,
  validated: ValidatedTaskResult,
): boolean {
  if (validated.workerId === undefined || inflightRecord.workerId !== validated.workerId) {
    return false;
  }
  if (
    inflightRecord.attemptToken !== undefined &&
    validated.attemptToken !== inflightRecord.attemptToken
  ) {
    return false;
  }
  return true;
}
