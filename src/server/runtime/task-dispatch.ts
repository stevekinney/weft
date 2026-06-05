import type { RoutingOptions } from '../../worker/registry.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';
import { evictOldestAffinityEntries } from '../runtime-helpers.ts';
import type { InflightRecord, QueuedRecord } from '../task-state.ts';
import { markQueued, readQueuedRecord, transitionQueuedToInflight } from '../task-state.ts';
import type { ServerContext } from './context.ts';
import {
  recordTaskBacklogMetric,
  recordTaskQueueLatencyMetric,
  recordWorkerCapacitySaturationMetric,
} from './task-metrics.ts';

const MAX_AFFINITY_ENTRIES = 10_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;
const MIN_VISIBILITY_TIMEOUT = 10;
const MAX_VISIBILITY_TIMEOUT = 3_600_000;

/**
 * Clamp a visibility timeout to the allowed range.
 *
 * Negative or near-zero values cause immediate expiry, and `Infinity`
 * prevents expiry entirely—both are dangerous. This helper constrains
 * the value to [10 ms, 3 600 000 ms] (10 milliseconds to 1 hour).
 */
function clampVisibilityTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VISIBILITY_TIMEOUT;
  return Math.min(Math.max(value, MIN_VISIBILITY_TIMEOUT), MAX_VISIBILITY_TIMEOUT);
}

/** Schedule a delayed dispatch, tracking the timer for cleanup on shutdown. */
export function scheduleDelayedDispatch(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
  delay: number,
): void {
  const timer = setTimeout(() => {
    context.pendingTimers.delete(timer);
    void dispatchTaskImpl(context, options, task).catch((err) =>
      console.error(`[weft] Delayed redispatch failed for "${task.operationId}":`, err),
    );
  }, delay);
  context.pendingTimers.add(timer);
}

export function resolveTaskPriority(
  _context: ServerContext,
  _options: ServeOptions,
  task: TaskDispatch,
): number | undefined {
  if (task.priority !== undefined) return task.priority;
  return undefined;
}

/**
 * Validate that the task envelope is not a duplicate.
 * Returns false if the operationId is already assigned or tracked.
 */
function validateTaskEnvelope(context: ServerContext, task: TaskDispatch): boolean {
  return (
    !context.registry.isAssigned(task.operationId) && !context.taskQueue.isTracked(task.operationId)
  );
}

/**
 * Resolve routing options from the task envelope and sticky affinity state.
 */
function buildRoutingOptions(
  context: ServerContext,
  task: TaskDispatch,
  queue: string,
): RoutingOptions {
  const routingOptions: RoutingOptions = { queue };
  if (task.sticky && task.workflowId) {
    const stickyWorkerId = context.workerAffinity.get(task.workflowId);
    if (stickyWorkerId !== undefined) {
      routingOptions.sticky = stickyWorkerId;
    }
  }
  if (task.fairShareKey !== undefined) {
    routingOptions.fairShareKey = task.fairShareKey;
  }
  // Skip workers currently in the reconnect grace window. Their socket is
  // still in `workerSockets` but the peer has closed; if `findWorker`
  // returned one of them we would either fail the dispatch (returning false
  // and falling back to long-poll while peers were ready) or — without this
  // exclusion — send the frame on a dead socket.
  if (context.pendingWorkerRequeues.size > 0) {
    routingOptions.excludeWorkerIds = new Set(context.pendingWorkerRequeues.keys());
  }
  return routingOptions;
}

/**
 * Record workflow-level affinity and the workflow→operation reverse index
 * after a successful dispatch.
 */
function recordDispatchOutcome(context: ServerContext, task: TaskDispatch, workerId: string): void {
  if (!task.workflowId) return;

  context.workerAffinity.set(task.workflowId, workerId);
  evictOldestAffinityEntries(context.workerAffinity, MAX_AFFINITY_ENTRIES);

  let operationIds = context.workflowOperations.get(task.workflowId);
  if (!operationIds) {
    operationIds = new Set();
    context.workflowOperations.set(task.workflowId, operationIds);
  }
  operationIds.add(task.operationId);
  context.operationToWorkflow.set(task.operationId, task.workflowId);
}

/**
 * Attempt to dispatch the task to a connected WebSocket worker.
 * Returns true if dispatched, false if no suitable worker was found.
 */
async function selectAndReserveWorker(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
  queue: string,
  visibilityTimeout: number,
): Promise<boolean> {
  const routingOptions = buildRoutingOptions(context, task, queue);
  const worker = context.registry.findWorker(task.activityName, routingOptions);
  if (!worker) return false;

  const ws = context.workerSockets.get(worker.id);
  if (!ws) return false;

  const now = Date.now();
  const existingQueuedRecord = await readQueuedRecord(options.engine.storage, task.operationId);
  // Unique per-dispatch token. Generated once here and written to all three
  // homes — the registry's in-flight entry (WebSocket completion validates
  // against it), the durable inflight record, and the wire frame the worker
  // echoes. Re-dispatch after a timeout/disconnect routes back through this
  // function, so each attempt gets a fresh token by construction.
  const attemptToken = crypto.randomUUID();
  context.registry.assignTask(
    worker.id,
    task.operationId,
    visibilityTimeout,
    task.fairShareKey,
    attemptToken,
  );

  // Persist the in-flight record BEFORE sending the task frame on the wire.
  // If the worker is fast enough to ack-and-complete before this write
  // committed, `transitionInflightToResolved` could delete-then-have-its
  // delete-overwritten by this put, producing an orphaned inflight record
  // that the scanner re-dispatches forever.
  const deadline = now + visibilityTimeout;
  context.deadlineTracker.add({ operationId: task.operationId, deadline });
  const inflightRecord: InflightRecord = {
    operationId: task.operationId,
    workerId: worker.id,
    deadline,
    activityName: task.activityName,
    queue,
    input: task.input,
    attempt: task.attempt ?? 1,
    visibilityTimeout,
    retryPolicy: task.retryPolicy,
    workflowId: task.workflowId,
    attemptToken,
  };
  const normalizedInflightRecord = await transitionQueuedToInflight(
    options.engine.storage,
    task.operationId,
    inflightRecord,
    {
      queuedRecord: existingQueuedRecord,
      now,
    },
  );

  ws.send(
    JSON.stringify({
      type: 'task',
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input === undefined ? null : task.input,
      attempt: task.attempt ?? 1,
      attemptToken,
      ...(task.headers ? { headers: task.headers } : {}),
    }),
  );

  recordTaskQueueLatencyMetric(context.metricsCollector, normalizedInflightRecord);
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  recordDispatchOutcome(context, task, worker.id);

  return true;
}

/**
 * Merge a new queued record with lifecycle fields preserved from any existing
 * queued record in storage, so retry counts and timing evidence survive re-queues.
 */
function mergeQueuedRecordLifecycle(
  fresh: QueuedRecord,
  existing: QueuedRecord | null,
): QueuedRecord {
  return {
    ...fresh,
    firstQueuedAt: existing?.firstQueuedAt ?? fresh.queuedAt,
    lastQueuedAt: fresh.queuedAt,
    lastDispatchedAt: existing?.lastDispatchedAt,
    startedAt: existing?.startedAt,
    retryCount: existing?.retryCount ?? fresh.retryCount,
    requeueCount: existing?.requeueCount ?? fresh.requeueCount,
    lastRequeueReason: existing?.lastRequeueReason,
  };
}

/**
 * Persist the task as queued in storage and enqueue to the in-memory task queue.
 *
 * The durable record is written BEFORE the in-memory enqueue: `enqueue()` may
 * immediately resolve a waiting long-poll request which transitions queued→inflight.
 * Writing after enqueue could recreate a stale queued record over the inflight record.
 */
async function enqueueTaskForLongPoll(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
  queue: string,
  visibilityTimeout: number,
  resolvedPriority: number | undefined,
): Promise<boolean> {
  const attempt = task.attempt ?? 1;
  const freshRecord: QueuedRecord = {
    operationId: task.operationId,
    activityName: task.activityName,
    input: task.input,
    queue,
    attempt,
    visibilityTimeout,
    retryPolicy: task.retryPolicy,
    queuedAt: Date.now(),
    workflowId: task.workflowId,
    retryCount: Math.max(0, attempt - 1),
    requeueCount: 0,
  };
  const existingQueuedRecord = await readQueuedRecord(options.engine.storage, task.operationId);
  const normalizedQueuedRecord = await markQueued(
    options.engine.storage,
    mergeQueuedRecordLifecycle(freshRecord, existingQueuedRecord),
  );

  const enqueued = context.taskQueue.enqueue(queue, {
    operationId: task.operationId,
    activityName: task.activityName,
    input: task.input,
    attempt,
    retryPolicy: task.retryPolicy,
    visibilityTimeout,
    workflowId: task.workflowId,
    firstQueuedAt: normalizedQueuedRecord.firstQueuedAt,
    lastQueuedAt: normalizedQueuedRecord.lastQueuedAt,
    lastDispatchedAt: normalizedQueuedRecord.lastDispatchedAt,
    startedAt: normalizedQueuedRecord.startedAt,
    retryCount: normalizedQueuedRecord.retryCount,
    requeueCount: normalizedQueuedRecord.requeueCount,
    lastRequeueReason: normalizedQueuedRecord.lastRequeueReason,
    ...(task.headers ? { headers: task.headers } : {}),
    ...(resolvedPriority !== undefined ? { priority: resolvedPriority } : {}),
  });
  recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  return enqueued;
}

export async function dispatchTaskImpl(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
): Promise<boolean> {
  const queue = task.queue ?? 'default';
  const visibilityTimeout = clampVisibilityTimeout(task.visibilityTimeout);
  const resolvedPriority = resolveTaskPriority(context, options, task);

  // Each task assigned to exactly one worker — reject duplicates.
  if (!validateTaskEnvelope(context, task)) {
    return false;
  }

  // Try WebSocket workers first (lowest latency).
  const dispatched = await selectAndReserveWorker(context, options, task, queue, visibilityTimeout);
  if (dispatched) return true;

  // Fall back to long-poll task queue.
  return enqueueTaskForLongPoll(context, options, task, queue, visibilityTimeout, resolvedPriority);
}

/** Send a cancel message to the worker handling a specific operation. */
export function cancelTask(context: ServerContext, operationId: string): boolean {
  // O(1) lookup via the registry's in-flight task map.
  const task = context.registry.getTask(operationId);
  if (!task) return false;

  const ws = context.workerSockets.get(task.workerId);
  if (!ws) return false;

  ws.send(JSON.stringify({ type: 'cancel', operationId }));
  return true;
}
