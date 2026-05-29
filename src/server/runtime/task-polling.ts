import type { ServeOptions } from '../index.ts';
import { isAuthenticated, type Principal } from '../principal.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { InflightRecord } from '../task-state.ts';
import {
  readInflightRecord,
  transitionInflightToResolved,
  transitionQueuedToInflight,
} from '../task-state.ts';
import type { ServerContext } from './context.ts';
import {
  recordTaskBacklogMetric,
  recordTaskExecutionLatencyMetric,
  recordTaskQueueLatencyMetric,
} from './task-metrics.ts';

const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;
const TASK_DIAGNOSTICS_PATH = '/v1/tasks/diagnostics';

const MAX_POLL_TIMEOUT = 60_000;
const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;

async function parseTaskResultBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ValidatedTaskResult = {
  operationId: string;
  status: 'completed' | 'failed';
  workerId: string | undefined;
  value: unknown;
  error: string | undefined;
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

  return {
    operationId,
    status,
    workerId: typeof body['workerId'] === 'string' ? body['workerId'] : undefined,
    value: body['value'],
    error: typeof body['error'] === 'string' ? body['error'] : undefined,
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

    const resolvedAt = Date.now();
    await transitionInflightToResolved(options.engine.storage, operationId, resolvedStatus, {
      ...(inflightRecord === null ? {} : { record: inflightRecord }),
      resolvedAt,
      resolutionReason: resolvedStatus,
      ...(status === 'completed' ? { value } : { error }),
    });
    if (inflightRecord !== null) {
      recordTaskExecutionLatencyMetric(context.metricsCollector, inflightRecord, resolvedAt);
    }
  } catch (storageError) {
    console.error(
      `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
      storageError,
    );
  }
}

export function createLongPollInflightRecord(queue: string, task: PendingTask): InflightRecord {
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
    firstQueuedAt: task.firstQueuedAt ?? task.enqueuedAt ?? now,
    lastQueuedAt: task.lastQueuedAt ?? task.enqueuedAt ?? now,
    lastDispatchedAt: now,
    startedAt: now,
    retryCount: task.retryCount ?? Math.max(0, (task.attempt ?? 1) - 1),
    requeueCount: task.requeueCount ?? 0,
    lastRequeueReason: task.lastRequeueReason,
  };
}

export async function markTaskClaimedByLongPollWorker(
  context: ServerContext,
  options: ServeOptions,
  queue: string,
  task: PendingTask,
): Promise<string> {
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
  return normalizedInflightRecord.workerId;
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
    const workerId = await markTaskClaimedByLongPollWorker(context, options, queue, task);
    return Response.json({ ...task, workerId });
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

  const body = await parseTaskResultBody(request);
  if (body === null) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validated = validateTaskResultBody(body);
  if (validated instanceof Response) {
    return validated;
  }

  // Ownership guard. When the task is still in flight, the submitter must echo
  // the exact workerId the server handed out on claim — a missing workerId
  // (`undefined`) is rejected rather than treated as a wildcard match. A null
  // record means the task already resolved/expired/was reclaimed, so there is
  // no owner to match against; the completion lands on whatever the queue does
  // with an unknown operationId (a no-op for already-settled work).
  const inflightRecord = await readInflightRecord(options.engine.storage, validated.operationId);
  if (
    inflightRecord !== null &&
    (validated.workerId === undefined || inflightRecord.workerId !== validated.workerId)
  ) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  await applyTaskResult(context, options, validated, inflightRecord);
  return Response.json({ ok: true });
}
