import { ActivityFailedEvent } from '../../core/events.ts';
import {
  buildAttemptDispositionWriteForToken,
  buildCurrentAttemptDispositionWrites,
} from '../../core/task-ledger/task-attempt-runtime.ts';
import { taskAttemptPrefix } from '../../core/task-ledger/task-attempt.ts';
import {
  commitTaskLedgerDelete,
  commitTaskLedgerTransition,
} from '../../core/task-ledger/task-ledger-runtime.ts';
import {
  canDeleteRetainedTerminalTask,
  commitUncertainCancellation,
  requeueExpiredAttempt,
} from '../../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskBase,
  type RemoteTaskLeased,
  type RemoteTaskQueued,
  type RemoteTaskTerminal,
} from '../../core/task-ledger/task-ledger.ts';
import { storageKeys } from '../../storage/interface.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';
import { restoreExtendedDeadlineIfStillActive } from '../runtime-helpers.ts';
import type { ServerContext } from './context.ts';
import { buildTerminalResolutionWrites } from './remote-activity-result-bridge.ts';
import { scheduleDelayedDispatch } from './task-dispatch.ts';
import {
  isTaskHeartbeatStaleForMetrics,
  recordTaskRequeueMetric,
  recordTaskRetryMetric,
  recordTaskStaleHeartbeatMetric,
  recordWorkerCapacitySaturationMetric,
} from './task-metrics.ts';

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
 * Given a leased ledger record whose visibility deadline has passed, either
 * permanently fail the task (retry attempts exhausted) or requeue it with
 * backoff for redispatch. Both the worker-disconnect handler and the
 * visibility-timeout scanner share this logic. A single attempt, no retry —
 * a lost compare-and-swap here means a concurrent heartbeat renewed the
 * lease or another actor already resolved this attempt, and retrying the
 * identical transition cannot change that outcome.
 */
export async function reassignOrExpireTask(
  context: ServerContext,
  options: ServeOptions,
  operationId: string,
  record: RemoteTaskLeased,
  reason: string = 'visibility-timeout',
): Promise<void> {
  // Worker disconnect forfeits the lease immediately rather than waiting for
  // the deadline to pass — see `RequeueExpiredAttemptInput.skipDeadlineCheck`.
  const skipDeadlineCheck = reason === 'worker-disconnect';
  const result = await commitTaskLedgerTransition(
    options.engine.storage,
    operationId,
    (current, now) =>
      requeueExpiredAttempt(
        current,
        { attemptToken: record.attemptToken, requeueReason: reason, skipDeadlineCheck },
        now,
      ),
    1,
    [],
    // Acceptance criterion 5: the retiring attempt's identity and
    // disposition are retained on requeue, not overwritten — a fresh
    // `TaskAttemptRecord` for the NEXT attempt is written separately, at its
    // own claim. This covers requeue from every origin `reassignOrExpireTask`
    // is called from: visibility-timeout expiry (`scanExpiredTasks`), worker
    // disconnect (`worker-disconnect-requeue.ts`), and startup recovery of an
    // already-expired lease (`task-ledger-recovery.ts`) — acceptance
    // criteria 5, 6 (disconnect/restart attributability), and the "restart"
    // and "disconnect" fixtures all resolve through this one call site.
    async (_current, nextRecord, now) => [
      ...(await buildAttemptDispositionWriteForToken(
        options.engine.storage,
        operationId,
        record.attemptToken,
        {
          disposition: nextRecord.state === 'terminal' ? 'retryExhausted' : 'requeued',
          dispositionAt: now,
          dispositionReason: reason,
        },
      )),
      // Acceptance criterion 6: retry exhaustion co-commits the durable
      // async-activity resolution record too, so a parked `ctx.run()` can
      // resume with the real exhaustion error even across a crash — same
      // reasoning as the ordinary completion path
      // (`task-ledger-completion.ts`'s `commitTerminalFromCompleting`).
      ...(nextRecord.state === 'terminal'
        ? buildTerminalResolutionWrites(nextRecord.workflowId, nextRecord.operationId, {
            status: 'failed',
            error: nextRecord.error,
          })
        : []),
    ],
  );
  if (!result.ok) {
    console.error(`[weft] Failed to requeue/expire task "${operationId}": ${result.reason}`);
    return;
  }
  recordWorkerCapacitySaturationMetric(context.metricsCollector, context.registry);

  if (result.record.state === 'terminal') {
    options.engine.dispatchEvent(
      new ActivityFailedEvent(
        operationId,
        record.workflowId ?? '',
        record.activityName,
        new Error(result.record.error),
        record.attempt,
      ),
    );
    return;
  }

  recordTaskRetryMetric(context.metricsCollector);
  recordTaskRequeueMetric(context.metricsCollector);

  const delay = Math.max(0, result.record.availableAt - Date.now());
  scheduleDelayedDispatch(context, options, taskDispatchFromLedgerRecord(record), delay);
}

/**
 * Reconstruct the `TaskDispatch` a fresh dispatch of this operation would
 * have used, from the durable envelope alone. Shared by expired-lease
 * redispatch ({@link reassignOrExpireTask}) and startup recovery's
 * `queued`-record redispatch (`task-ledger-recovery.ts`) — both cases hand a
 * record back to `dispatchTaskImpl` with no original caller-supplied
 * `TaskDispatch` still in memory. Every `RemoteTaskBase` field
 * `buildRoutingOptions`/`resolveTaskPriority` read at dispatch time
 * (`priority`, `fairShareKey`, sticky affinity) must round-trip here too, or
 * a requeued or recovered task silently loses its original routing intent.
 */
export function taskDispatchFromLedgerRecord(record: RemoteTaskBase): TaskDispatch {
  const taskDispatch: TaskDispatch = {
    operationId: record.operationId,
    activityName: record.activityName,
    workflowType: record.workflowType,
    input: record.input,
    queue: record.queue,
    visibilityTimeout: record.visibilityTimeoutMilliseconds,
    workflowExecutionToken: record.workflowExecutionToken,
    workflowRevision: record.workflowRevision,
  };
  if (record.workflowId !== undefined) {
    taskDispatch.workflowId = record.workflowId;
  }
  if (record.retryPolicy !== undefined) {
    taskDispatch.retryPolicy = record.retryPolicy;
  }
  if (Object.keys(record.headers).length > 0) {
    taskDispatch.headers = record.headers;
  }
  if (record.priority !== undefined) {
    taskDispatch.priority = record.priority;
  }
  if (record.fairShareKey !== undefined) {
    taskDispatch.fairShareKey = record.fairShareKey;
  }
  if (record.stickyWorkflowId !== undefined) {
    taskDispatch.sticky = true;
  }
  return taskDispatch;
}

/**
 * Redispatch a `queued` ledger record whose delayed-retry `availableAt` has
 * elapsed. Covers the case where the process-local `setTimeout` a durable
 * retry's original `scheduleDelayedDispatch` call armed was lost — to a
 * restart, or because the record was never dispatched from this process at
 * all (e.g. written by a peer) — so `availableAt` is the correctness
 * mechanism and the timer is only a latency optimization. Skipped when the
 * operation is already tracked in-memory (dispatched or mid-redispatch) so
 * this never races a live attempt.
 */
function redispatchAvailableQueuedRecord(
  context: ServerContext,
  options: ServeOptions,
  decoded: RemoteTaskQueued,
): void {
  if (context.registry.isAssigned(decoded.operationId)) return;
  if (context.taskQueue.isTracked(decoded.operationId)) return;
  scheduleDelayedDispatch(context, options, taskDispatchFromLedgerRecord(decoded), 0);
}

/**
 * Reap an adopted terminal record once it has aged past
 * {@link ServeOptions.taskRetentionWindowMs} (WFT-24). No-ops when the
 * option is unset — retention is opt-in, `undefined` means "keep terminal
 * records forever," matching the acceptance criterion's letter ("terminal
 * results remain until workflow adoption or explicit retained-dead-letter
 * disposition") rather than a default that starts silently deleting data on
 * upgrade. Unadopted terminal records are never reaped here regardless of
 * age — `canDeleteRetainedTerminalTask`'s own precondition already rejects
 * them, but the age check short-circuits first to avoid a wasted read on
 * every young record.
 */
async function reapRetainedTerminalRecord(
  options: ServeOptions,
  decoded: RemoteTaskTerminal,
  now: number,
): Promise<void> {
  if (options.taskRetentionWindowMs === undefined) return;
  if (!decoded.adopted) return;
  const retainedSince = decoded.adoptedAt ?? decoded.terminalAt;
  if (now - retainedSince < options.taskRetentionWindowMs) return;

  // Acceptance criterion 12: purge removes attempt records through bounded
  // operations. The number of attempts under one operationId is bounded by
  // its retry policy, so this prefix scan — and the single conditionalBatch
  // it feeds — never approaches a full-ledger scan.
  const attemptKeys: string[] = [];
  for await (const attemptKey of storageKeys(
    options.engine.storage,
    taskAttemptPrefix(decoded.operationId),
  )) {
    attemptKeys.push(attemptKey);
  }

  const deleted = await commitTaskLedgerDelete(
    options.engine.storage,
    decoded.operationId,
    (current) =>
      canDeleteRetainedTerminalTask(current, {
        expectedRetentionGeneration: decoded.retentionGeneration,
      }),
    1,
    attemptKeys,
  );
  if (!deleted.ok) {
    console.error(
      `[weft] Failed to reap retained terminal task "${decoded.operationId}": ${deleted.reason}`,
    );
  }
}

/**
 * Drain expired entries from the in-memory deadline heap and reassign
 * their tasks. Only touches storage for the specific operations whose
 * deadlines have actually passed — no full ledger scan.
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
        const decoded = decodeRemoteTaskRecord(
          await options.engine.storage.get(taskLedgerKey(operationId)),
        );

        // COR-230, acceptance criterion 15: a `cancelling` record whose
        // `cancellationDeadline` has passed with no cooperative
        // `taskResult(status: 'cancelled')` from the worker is force-settled
        // as cancelled, with `uncertain: true` recorded — the server does
        // not know whether the activity actually stopped. Tracked in the
        // same deadline heap `cancelTask` populates in place of the
        // visibility deadline this operationId no longer has once it left
        // `leased`.
        if (decoded !== null && decoded.state === 'cancelling') {
          if (decoded.cancellationDeadline > now) {
            // Not yet due — a fresh read raced ahead of the heap entry's own
            // deadline; re-track it rather than dropping it.
            context.deadlineTracker.add({ operationId, deadline: decoded.cancellationDeadline });
            continue;
          }
          const settled = await commitTaskLedgerTransition(
            options.engine.storage,
            operationId,
            (current, settleNow) =>
              commitUncertainCancellation(
                current,
                { attemptToken: decoded.attemptToken },
                settleNow,
              ),
            1,
            [],
            async (current, nextRecord, settleNow) => [
              ...(await buildCurrentAttemptDispositionWrites(options.engine.storage, current, {
                disposition: 'cancelled',
                dispositionAt: settleNow,
                dispositionReason: 'cancellation deadline elapsed with no cooperative result',
              })),
              // Acceptance criterion 6: same reasoning as the cooperative
              // cancellation path in `task-ledger-completion.ts`.
              ...buildTerminalResolutionWrites(nextRecord.workflowId, nextRecord.operationId, {
                status: 'failed',
                error: nextRecord.cancellationReason,
                failureCategory: 'cancellation',
              }),
            ],
          );
          if (!settled.ok) {
            // Lost the race to the worker's own cooperative result (or a
            // concurrent settlement) — the record already resolved some
            // other way; nothing left to do.
            continue;
          }
          context.registry.completeTask(operationId);
          cleanupWorkflowIndex(operationId);
          continue;
        }

        if (decoded === null || decoded.state !== 'leased') continue; // Already resolved or requeued by another path.

        // Double-check the deadline in case a heartbeat extended it after
        // the entry was added to the heap.
        if (
          restoreExtendedDeadlineIfStillActive(
            context.deadlineTracker,
            operationId,
            decoded.leaseDeadline,
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

/**
 * Periodic full-ledger safety net (WFT-23), independent of the in-memory
 * deadline heap `scanExpiredTasks` drains: catches `leased` records whose
 * expiry was never tracked in the heap (written by a peer, or lost to a
 * restart), `queued` records whose durable `availableAt` has elapsed but
 * whose `scheduleDelayedDispatch` timer never fired (same causes), and
 * (WFT-24) adopted `terminal` records old enough to reap under
 * {@link ServeOptions.taskRetentionWindowMs}, and (COR-230, acceptance
 * criterion 15) `cancelling` records whose cancellation-deadline heap entry
 * was never tracked or was lost — same causes as the `leased` case, same
 * "ensure it's tracked, or force-settle it if already due" treatment.
 * `completing` and `deadLettered` are left untouched — resolving those is
 * either the worker's redelivered result (`completing`) or explicitly out
 * of this slice's scope.
 */
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
    for await (const [, value] of options.engine.storage.scan('task-ledger:')) {
      // `server.stop()` may run while this scan is still in flight — see
      // the identical guard and comment in `task-ledger-recovery.ts`'s
      // startup scan, which this mirrors for the same reason: stop
      // processing further records once shutdown has begun, so this loop
      // cannot issue a durable write or delete against a torn-down server.
      if (context.stopping) return;
      try {
        const decoded = decodeRemoteTaskRecord(value);
        if (decoded === null) continue;
        if (decoded.state === 'queued') {
          if (decoded.availableAt <= now)
            redispatchAvailableQueuedRecord(context, options, decoded);
          continue;
        }
        if (decoded.state === 'terminal') {
          await reapRetainedTerminalRecord(options, decoded, now);
          continue;
        }
        // COR-230, acceptance criterion 15: catch a `cancelling` record
        // whose cancellation-deadline heap entry was never tracked (written
        // by a peer) or lost (a restart) — the same safety-net role this
        // full-ledger sweep already plays for `leased` records below.
        if (decoded.state === 'cancelling') {
          if (context.processingOperations.has(decoded.operationId)) continue;
          if (decoded.cancellationDeadline > now) {
            context.deadlineTracker.remove(decoded.operationId);
            context.deadlineTracker.add({
              operationId: decoded.operationId,
              deadline: decoded.cancellationDeadline,
            });
            continue;
          }
          context.processingOperations.add(decoded.operationId);
          try {
            context.deadlineTracker.remove(decoded.operationId);
            const settled = await commitTaskLedgerTransition(
              options.engine.storage,
              decoded.operationId,
              (current, settleNow) =>
                commitUncertainCancellation(
                  current,
                  { attemptToken: decoded.attemptToken },
                  settleNow,
                ),
              1,
              [],
              async (current, nextRecord, settleNow) => [
                ...(await buildCurrentAttemptDispositionWrites(options.engine.storage, current, {
                  disposition: 'cancelled',
                  dispositionAt: settleNow,
                  dispositionReason: 'cancellation deadline elapsed with no cooperative result',
                })),
                ...buildTerminalResolutionWrites(nextRecord.workflowId, nextRecord.operationId, {
                  status: 'failed',
                  error: nextRecord.cancellationReason,
                  failureCategory: 'cancellation',
                }),
              ],
            );
            if (settled.ok) {
              context.registry.completeTask(decoded.operationId);
              cleanupWorkflowIndex(decoded.operationId);
            }
          } finally {
            context.processingOperations.delete(decoded.operationId);
          }
          continue;
        }
        if (decoded.state !== 'leased') continue;
        if (isTaskHeartbeatStaleForMetrics(decoded, now)) staleHeartbeatCount += 1;

        if (decoded.leaseDeadline > now) {
          // Still valid — ensure it is tracked in the heap so the fast path
          // can handle it when it expires. Skip the heap rewrite if another
          // path is currently mid-process on this id — its `finally` block
          // will leave the heap in a consistent state.
          if (context.processingOperations.has(decoded.operationId)) continue;
          context.deadlineTracker.remove(decoded.operationId);
          context.deadlineTracker.add({
            operationId: decoded.operationId,
            deadline: decoded.leaseDeadline,
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
        console.error('[weft] Failed to reconcile leased ledger record — skipping:', error);
      }
    }
    recordTaskStaleHeartbeatMetric(context.metricsCollector, staleHeartbeatCount);
  } catch (error) {
    console.error('[weft] Reconciliation scanner error:', error);
  } finally {
    context.reconciliationRunning = false;
  }
}
