import { decode } from '../../core/codec.ts';
import { ActivityFailedEvent } from '../../core/events.ts';
import { calculateBackoff } from '../../core/scheduler.ts';
import { KEYS } from '../../storage/interface.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';
import { restoreExtendedDeadlineIfStillActive } from '../runtime-helpers.ts';
import type { InflightRecord, QueuedRecord, TaskRequeueReason } from '../task-state.ts';
import {
  isTaskDeadLettered,
  transitionInflightToQueued,
  transitionInflightToResolved,
} from '../task-state.ts';
import type { ServerContext } from './context.ts';
import { dispatchTaskImpl, scheduleDelayedDispatch } from './task-dispatch.ts';
import {
  isTaskHeartbeatStaleForMetrics,
  recordTaskRequeueMetric,
  recordTaskRetryMetric,
  recordTaskStaleHeartbeatMetric,
  recordWorkerCapacitySaturationMetric,
} from './task-metrics.ts';
import { isInflightRecord } from './websocket-worker.ts';

interface ManualTaskReconciliationRegistration {
  scanAt?: (operationId: string, trackedDeadline: number, now: number) => Promise<void>;
}

interface ManualTaskReconciliationForTesting {
  readonly options: ServeOptions;
  scanAt(operationId: string, trackedDeadline: number, now: number): Promise<void>;
}

const manualTaskReconciliationRegistrations = new WeakMap<
  ServeOptions,
  ManualTaskReconciliationRegistration
>();

/** @internal Restricts manual reconciliation to explicitly marked test options. */
export function useManualTaskReconciliationForTesting(
  options: ServeOptions,
): ManualTaskReconciliationForTesting {
  const registration: ManualTaskReconciliationRegistration = {};
  manualTaskReconciliationRegistrations.set(options, registration);
  return {
    options,
    scanAt(operationId, trackedDeadline, now) {
      if (registration.scanAt === undefined) {
        throw new Error('Manual task reconciliation requires a running test server');
      }
      return registration.scanAt(operationId, trackedDeadline, now);
    },
  };
}

/** @internal Installs the narrow one-shot test controller before a server starts. */
export function consumeManualTaskReconciliationForTesting(
  options: ServeOptions,
  context: ServerContext,
  cleanupWorkflowIndex: (operationId: string) => void,
): boolean {
  const registration = manualTaskReconciliationRegistrations.get(options);
  manualTaskReconciliationRegistrations.delete(options);
  if (registration === undefined) return false;

  registration.scanAt = async (operationId, trackedDeadline, now) => {
    context.deadlineTracker.add({ operationId, deadline: trackedDeadline });
    await scanExpiredTasks(context, options, cleanupWorkflowIndex, now);
  };
  return true;
}

/**
 * Given a persisted inflight record, either permanently fail the task (if
 * retry attempts are exhausted) or transition it back to queued and
 * re-dispatch with backoff. Both the worker-disconnect handler and the
 * visibility-timeout scanner share this logic.
 */
export async function reassignOrExpireTask(
  context: ServerContext,
  options: ServeOptions,
  operationId: string,
  record: InflightRecord,
  reason: TaskRequeueReason = 'visibility-timeout',
): Promise<void> {
  const nextAttempt = (record.attempt ?? 1) + 1;
  const policy = record.retryPolicy;
  const nextRetryCount = Math.max(record.retryCount ?? 0, nextAttempt - 1);

  if (hasExceededMaxAttempts(policy, nextAttempt)) {
    await expireTaskAfterMaxAttempts(context, options, operationId, record, policy);
    return;
  }

  const queuedRecord = createRequeuedRecord(record, nextAttempt, nextRetryCount, reason);
  await transitionInflightToQueued(options.engine.storage, operationId, queuedRecord);
  recordTaskRetryMetric(context.metricsCollector);
  recordTaskRequeueMetric(context.metricsCollector);
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  scheduleTaskRedispatch(context, options, createRequeuedTaskDispatch(record, nextAttempt), policy);
}

function hasExceededMaxAttempts(
  policy: InflightRecord['retryPolicy'],
  nextAttempt: number,
): policy is NonNullable<InflightRecord['retryPolicy']> {
  return policy !== undefined && nextAttempt > policy.maxAttempts;
}

async function expireTaskAfterMaxAttempts(
  context: ServerContext,
  options: ServeOptions,
  operationId: string,
  record: InflightRecord,
  policy: NonNullable<InflightRecord['retryPolicy']>,
): Promise<void> {
  await transitionInflightToResolved(options.engine.storage, operationId, 'failed', {
    record,
    resolutionReason: 'max-attempts-exceeded',
  });
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);
  options.engine.dispatchEvent(
    new ActivityFailedEvent(
      record.operationId,
      record.workflowId ?? '',
      record.activityName,
      new Error(
        `Activity "${record.activityName}" exhausted all ${policy.maxAttempts} retry attempts`,
      ),
      record.attempt ?? 1,
    ),
  );
}

function createRequeuedRecord(
  record: InflightRecord,
  nextAttempt: number,
  nextRetryCount: number,
  reason: TaskRequeueReason,
): QueuedRecord {
  return {
    operationId: record.operationId,
    activityName: record.activityName,
    input: record.input,
    queue: record.queue,
    attempt: nextAttempt,
    visibilityTimeout: record.visibilityTimeout,
    retryPolicy: record.retryPolicy,
    queuedAt: Date.now(),
    workflowId: record.workflowId,
    firstQueuedAt: record.firstQueuedAt,
    lastDispatchedAt: record.lastDispatchedAt,
    startedAt: record.startedAt,
    retryCount: nextRetryCount,
    requeueCount: (record.requeueCount ?? 0) + 1,
    lastRequeueReason: reason,
  };
}

function createRequeuedTaskDispatch(record: InflightRecord, nextAttempt: number): TaskDispatch {
  const taskDispatch: TaskDispatch = {
    operationId: record.operationId,
    activityName: record.activityName,
    input: record.input,
    queue: record.queue,
    attempt: nextAttempt,
    visibilityTimeout: record.visibilityTimeout,
    workflowId: record.workflowId,
    workflowExecutionToken: record.workflowExecutionToken,
  };
  if (record.retryPolicy !== undefined) {
    taskDispatch.retryPolicy = record.retryPolicy;
  }
  return taskDispatch;
}

function scheduleTaskRedispatch(
  context: ServerContext,
  options: ServeOptions,
  taskDispatch: TaskDispatch,
  policy: InflightRecord['retryPolicy'],
): void {
  if (policy) {
    const delay = calculateBackoff((taskDispatch.attempt ?? 1) - 1, policy);
    scheduleDelayedDispatch(context, options, taskDispatch, delay);
  } else {
    void dispatchTaskImpl(context, options, taskDispatch).catch((err) =>
      console.error(`[weft] Redispatch failed for "${taskDispatch.operationId}":`, err),
    );
  }
}

/**
 * Drain expired entries from the in-memory deadline heap and reassign
 * their tasks. Only touches storage for the specific operations whose
 * deadlines have actually passed — no full `op:inflight:*` scan.
 */
export async function scanExpiredTasks(
  context: ServerContext,
  options: ServeOptions,
  cleanupWorkflowIndex: (operationId: string) => void,
  now = Date.now(),
): Promise<void> {
  if (context.scanRunning) return;
  context.scanRunning = true;
  try {
    const expired = context.deadlineTracker.drainExpired(now);

    for (const { operationId, deadline } of expired) {
      // Skip if the reconciliation scanner (or a previous iteration) is
      // already acting on this operation — re-queue the heap entry so the
      // fast path will revisit it on the next tick once the other worker
      // has released the claim.
      if (context.processingOperations.has(operationId)) {
        context.deadlineTracker.add({ operationId, deadline });
        continue;
      }
      context.processingOperations.add(operationId);
      try {
        const inflightKey = KEYS.operationInflight(operationId);
        const existing = await options.engine.storage.get(inflightKey);

        if (!existing) continue; // Already resolved or requeued by another path.

        const decoded = decode(existing);
        if (!isInflightRecord(decoded)) {
          console.error(`[weft] Corrupt inflight record for task "${operationId}" — skipping`);
          continue;
        }

        if (await isTaskDeadLettered(options.engine.storage, operationId)) {
          continue;
        }

        // Double-check the deadline in case a heartbeat extended it after
        // the entry was added to the heap.
        if (
          restoreExtendedDeadlineIfStillActive(
            context.deadlineTracker,
            operationId,
            decoded.deadline,
            now,
          )
        ) {
          continue;
        }

        // Expired — remove from registry, clean up workflow index, and reassign or permanently fail.
        context.registry.completeTask(decoded.operationId);
        cleanupWorkflowIndex(decoded.operationId);
        await reassignOrExpireTask(context, options, decoded.operationId, decoded);
      } catch (error) {
        // Re-add to the heap so it will be retried on the next tick
        // instead of waiting for the slower reconciliation scan.
        context.deadlineTracker.add({ operationId, deadline });
        console.error(
          `[weft] Failed to process expired task "${operationId}" — will retry:`,
          error,
        );
      } finally {
        context.processingOperations.delete(operationId);
      }
    }
  } catch (error) {
    console.error('[weft] Visibility timeout scanner error:', error);
  } finally {
    context.scanRunning = false;
  }
}

export async function reconcileOrphanedRecords(
  context: ServerContext,
  options: ServeOptions,
  cleanupWorkflowIndex: (operationId: string) => void,
): Promise<void> {
  if (context.reconciliationRunning) return;
  context.reconciliationRunning = true;
  try {
    const now = Date.now();
    let staleHeartbeatCount = 0;
    for await (const [, value] of options.engine.storage.scan('op:inflight:')) {
      try {
        const decoded = decode(value);
        if (!isInflightRecord(decoded)) continue;
        if (isTaskHeartbeatStaleForMetrics(decoded, now)) staleHeartbeatCount += 1;
        if (await isTaskDeadLettered(options.engine.storage, decoded.operationId)) continue;

        if (decoded.deadline > now) {
          // Still valid — ensure it is tracked in the heap so the fast path
          // can handle it when it expires. Skip the heap rewrite if another
          // path is currently mid-process on this id — its `finally` block
          // will leave the heap in a consistent state.
          if (context.processingOperations.has(decoded.operationId)) continue;
          context.deadlineTracker.remove(decoded.operationId);
          context.deadlineTracker.add({
            operationId: decoded.operationId,
            deadline: decoded.deadline,
          });
          continue;
        }

        // Expired orphan — claim the id so `scanExpiredTasks` cannot race
        // us on `completeTask`/`reassignOrExpireTask`. If the fast path is
        // already processing it, skip and let the next reconciliation tick
        // revisit any remaining orphans.
        if (context.processingOperations.has(decoded.operationId)) continue;
        context.processingOperations.add(decoded.operationId);
        try {
          // Expired orphan — remove from heap, registry, and workflow index, then reassign.
          context.deadlineTracker.remove(decoded.operationId);
          context.registry.completeTask(decoded.operationId);
          cleanupWorkflowIndex(decoded.operationId);
          await reassignOrExpireTask(context, options, decoded.operationId, decoded);
        } finally {
          context.processingOperations.delete(decoded.operationId);
        }
      } catch (error) {
        console.error('[weft] Failed to reconcile inflight record — skipping:', error);
      }
    }
    recordTaskStaleHeartbeatMetric(context.metricsCollector, staleHeartbeatCount);
  } catch (error) {
    console.error('[weft] Reconciliation scanner error:', error);
  } finally {
    context.reconciliationRunning = false;
  }
}
