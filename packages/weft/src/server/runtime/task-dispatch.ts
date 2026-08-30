import { isJSONValue } from '../../core/json.ts';
import { buildWorkerExecutionIdentity } from '../../worker/manifest/execution-identity.ts';
import type { RoutingOptions } from '../../worker/registry.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';
import { evictOldestAffinityEntries } from '../runtime-helpers.ts';
import {
  claimQueued,
  createQueued,
  type ClaimQueuedInput,
  type CreateQueuedInput,
  type TaskLedgerTransitionResult,
} from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  REMOTE_TASK_RECORD_VERSION,
  taskLedgerKey,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskRecord,
} from '../task-ledger.ts';
import type { ServerContext } from './context.ts';
import { commitTaskLedgerTransition } from './task-ledger-runtime.ts';
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

/**
 * Schedule a delayed dispatch, tracking the timer for cleanup on shutdown.
 *
 * No-ops once `context.stopping` is set — `server.stop()`'s timer-clearing
 * disposer has already run by then, so arming a new timer here would leak a
 * callback that fires against a stopped server instead of being cleared.
 */
export function scheduleDelayedDispatch(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
  delay: number,
): void {
  if (context.stopping) return;
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

/** The optional `CreateQueuedInput` fields a `TaskDispatch` may or may not carry. */
function buildOptionalCreateQueuedFields(task: TaskDispatch): Partial<CreateQueuedInput> {
  return {
    ...(task.workflowId !== undefined ? { workflowId: task.workflowId } : {}),
    ...(task.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: task.workflowExecutionToken }
      : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.fairShareKey !== undefined ? { fairShareKey: task.fairShareKey } : {}),
    ...(task.sticky && task.workflowId !== undefined ? { stickyWorkflowId: task.workflowId } : {}),
    ...(task.retryPolicy !== undefined ? { retryPolicy: task.retryPolicy } : {}),
  };
}

/** The durable envelope every fresh dispatch would create if no ledger record exists yet. */
function buildCreateQueuedInput(
  task: TaskDispatch,
  queue: string,
  visibilityTimeout: number,
): CreateQueuedInput {
  const input = task.input === undefined ? null : task.input;
  if (!isJSONValue(input)) {
    throw new Error(
      `TaskDispatch for operation "${task.operationId}" has a non-JSON-serializable "input" — the durable task ledger requires JSON-safe input.`,
    );
  }
  return {
    recordVersion: REMOTE_TASK_RECORD_VERSION,
    operationId: task.operationId,
    workflowType: task.workflowType,
    activityName: task.activityName,
    queue,
    input,
    headers: task.headers ?? {},
    visibilityTimeoutMilliseconds: visibilityTimeout,
    createdAt: Date.now(),
    ...buildOptionalCreateQueuedFields(task),
  };
}

/**
 * Compose "create if absent, then claim" into one transition attempt. A
 * fresh dispatch and a redispatch of an already-`queued` ledger record (from
 * `requeueExpiredAttempt`) both land here — `createQueued`'s only
 * precondition is that the key is absent, so it never fails when reached
 * with `current === null`. Any other pre-existing state (already leased,
 * completing, cancelling, terminal, or dead-lettered) means another actor
 * already owns this operationId; reject rather than double-dispatch.
 */
function buildCreateThenClaimTransition(
  createInput: CreateQueuedInput,
  claimInput: Omit<ClaimQueuedInput, 'expectedGeneration'>,
): (current: RemoteTaskRecord | null, now: number) => TaskLedgerTransitionResult<RemoteTaskLeased> {
  return (current, now) => {
    let queuedRecord: RemoteTaskQueued;
    if (current === null) {
      const created = createQueued(null, createInput, now);
      if (!created.ok) return created;
      queuedRecord = created.nextRecord;
    } else if (current.state === 'queued') {
      queuedRecord = current;
    } else {
      return {
        ok: false,
        reason: `operation "${createInput.operationId}" is not claimable from state "${current.state}"`,
      };
    }
    return claimQueued(
      queuedRecord,
      { ...claimInput, expectedGeneration: queuedRecord.generation },
      now,
    );
  };
}

/**
 * Split a `${workflowType}.${activityName}` qualified routing name (the
 * convention `TaskDispatch.activityName`/`WorkerInfo.activities` use
 * throughout dispatch and registration — see
 * `websocket-worker-registration.ts`'s `deriveActivitiesFromManifest`) back
 * into the bare activity name `buildWorkerExecutionIdentity` needs for its
 * `manifest.workflows[workflowType].activities[activityName]` lookup. Falls
 * back to the whole string when there is no `.` — a manifest cannot declare
 * an activity name containing one (`validateWorkflowOrActivityName`), so an
 * unqualified `activityName` here can only mean the routing name and the
 * bare name coincide, not that qualification was optional.
 */
function bareActivityName(qualifiedActivityName: string): string {
  const dotIndex = qualifiedActivityName.indexOf('.');
  return dotIndex === -1 ? qualifiedActivityName : qualifiedActivityName.slice(dotIndex + 1);
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

  // Build (and validate) the durable envelope BEFORE reserving capacity —
  // buildCreateQueuedInput throws on non-JSON input, and that must not leak
  // a reservation nothing will ever release.
  const createInput = buildCreateQueuedInput(task, queue, visibilityTimeout);

  // Unique per-dispatch token. Generated once here and written to all three
  // homes — the registry's in-flight entry (WebSocket completion validates
  // against it), the durable leased record, and the wire frame the worker
  // echoes. Re-dispatch after a timeout/disconnect routes back through this
  // function, so each attempt gets a fresh token by construction.
  const attemptToken = crypto.randomUUID();
  const executionIdentity = buildWorkerExecutionIdentity({
    manifest: worker.manifest,
    manifestDigest: worker.acceptedManifestDigest,
    workerId: worker.id,
    workflowType: task.workflowType,
    activityName: bareActivityName(task.activityName),
  });

  // Reserve capacity BEFORE the durable claim attempt, per the brief: "resolve
  // eligible workers and reserve one capacity slot in one synchronous
  // coordinator turn... release the reservation on a failed write." A single
  // attempt (no retry) — a lost CAS here means another actor already claimed
  // or cancelled this operationId, so retrying the same transition cannot
  // change the outcome; the caller falls back to the long-poll path instead.
  context.registry.assignTask(
    worker.id,
    task.operationId,
    visibilityTimeout,
    task.fairShareKey,
    attemptToken,
  );

  let result;
  try {
    result = await commitTaskLedgerTransition(
      options.engine.storage,
      task.operationId,
      buildCreateThenClaimTransition(createInput, {
        attemptToken,
        workerSessionId: worker.id,
        ...(executionIdentity !== undefined ? { executionIdentity } : {}),
        leaseDurationMilliseconds: visibilityTimeout,
      }),
      1,
    );
  } catch (error) {
    // Durable claim failed after the local reservation — release it and let
    // the caller observe the failure rather than leaking capacity silently.
    context.registry.releaseReservation(task.operationId);
    throw error;
  }

  if (!result.ok) {
    context.registry.releaseReservation(task.operationId);
    return false;
  }

  context.deadlineTracker.add({
    operationId: task.operationId,
    deadline: result.record.leaseDeadline,
  });

  ws.send(
    JSON.stringify({
      type: 'task',
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input === undefined ? null : task.input,
      attempt: result.record.attempt,
      attemptToken,
      ...(task.workflowExecutionToken !== undefined && {
        workflowExecutionToken: task.workflowExecutionToken,
      }),
      ...(task.headers ? { headers: task.headers } : {}),
    }),
  );

  recordTaskQueueLatencyMetric(context.metricsCollector, {
    lastQueuedAt: result.record.lastQueuedAt,
    lastDispatchedAt: Date.now(),
  });
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  recordDispatchOutcome(context, task, worker.id);

  return true;
}

/**
 * Ensure the task has a durable `queued` ledger record — creating one for a
 * fresh dispatch, or reusing the one already there for a redispatch of a
 * requeued task — then hand it to the in-memory long-poll queue as a match
 * hint. The ledger record, not `TaskQueue`, is authoritative: a long-poll
 * claim re-reads and conditionally claims it independently (see
 * `task-polling.ts`), so a stale or lost hint here just means the poller
 * waits for the next match rather than corrupting durable state.
 */
async function enqueueTaskForLongPoll(
  context: ServerContext,
  options: ServeOptions,
  task: TaskDispatch,
  queue: string,
  visibilityTimeout: number,
  resolvedPriority: number | undefined,
): Promise<boolean> {
  const storage = options.engine.storage;
  const createInput = buildCreateQueuedInput(task, queue, visibilityTimeout);
  const rawExisting = await storage.get(taskLedgerKey(task.operationId));
  const current = decodeRemoteTaskRecord(rawExisting);

  let queuedRecord: RemoteTaskQueued;
  if (current === null) {
    const result = await commitTaskLedgerTransition(
      storage,
      task.operationId,
      (freshCurrent, now) => createQueued(freshCurrent, createInput, now),
      1,
    );
    if (!result.ok) {
      // Lost the create race to a concurrent dispatch for the same
      // operationId — the winner's record is now durable; use it as the hint.
      const raced = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(task.operationId)));
      if (raced === null || raced.state !== 'queued') return false;
      queuedRecord = raced;
    } else {
      queuedRecord = result.record;
    }
  } else if (current.state === 'queued') {
    queuedRecord = current;
  } else {
    return false;
  }

  const enqueued = context.taskQueue.enqueue(queue, {
    operationId: task.operationId,
    activityName: task.activityName,
    input: task.input,
    attempt: queuedRecord.attempt,
    retryPolicy: task.retryPolicy,
    visibilityTimeout,
    workflowId: task.workflowId,
    workflowExecutionToken: task.workflowExecutionToken,
    firstQueuedAt: queuedRecord.firstQueuedAt,
    lastQueuedAt: queuedRecord.lastQueuedAt,
    lastDispatchedAt: queuedRecord.lastDispatchedAt,
    startedAt: queuedRecord.startedAt,
    retryCount: queuedRecord.retryCount,
    requeueCount: queuedRecord.requeueCount,
    // PendingTask.lastRequeueReason is the old narrow TaskRequeueReason enum;
    // the ledger's requeueReason is free text (RequeueExpiredAttemptInput).
    // TaskQueue is an in-memory match hint only, not the durable authority,
    // so this cosmetic field is dropped rather than narrowed unsafely.
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
  // Gate on startup task-ledger recovery (WFT-23) — covers both the public
  // `WeftServer.dispatchTask` entry point and `scheduleDelayedDispatch`'s
  // timer callback, which also calls this function directly. A rejected
  // gate means the recovery scan itself failed; propagate that failure
  // loudly rather than silently returning false, which callers would read
  // as an ordinary "no worker available" outcome.
  try {
    await context.taskLedgerRecovery.ready;
  } catch (error) {
    throw new Error(
      `Cannot dispatch task "${task.operationId}" — startup task-ledger recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!task.workflowType) {
    throw new Error(
      `TaskDispatch for operation "${task.operationId}" is missing required field "workflowType".`,
    );
  }
  // A qualified activityName's prefix must agree with workflowType — a
  // mismatch would still resolve a manifest lookup (against the WRONG
  // workflow) and persist incorrect provenance rather than failing loudly.
  const dotIndex = task.activityName.indexOf('.');
  if (dotIndex !== -1 && task.activityName.slice(0, dotIndex) !== task.workflowType) {
    throw new Error(
      `TaskDispatch for operation "${task.operationId}" has activityName "${task.activityName}" whose qualifier does not match workflowType "${task.workflowType}".`,
    );
  }
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
