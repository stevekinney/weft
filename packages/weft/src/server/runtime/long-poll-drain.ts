/**
 * Move long-poll hints onto WebSocket workers once one can take them.
 *
 * `dispatchTaskImpl` tries WebSocket workers first and falls back to the
 * long-poll `TaskQueue` only when none can take a task right then — none is
 * connected yet, or every one is at capacity. Nothing else ever revisits that
 * choice: a WebSocket worker never polls the long-poll queue, and orphan
 * reconciliation skips a task the queue still tracks. So without this drain a
 * fallen-back task waits for a long-poll worker, or for the queue's
 * pending-task time to live to drop the hint and a later reconciliation pass
 * to redispatch it — minutes, on a server whose WebSocket workers sit idle.
 *
 * The two moments a WebSocket worker gains room trigger a drain of its queue:
 * registration (`websocket-worker-registration.ts`) and a task result that
 * frees a capacity slot (`websocket-worker.ts`). The drain moves one hint at a
 * time, and only while some connected WebSocket worker can take it, through
 * the ordinary dispatch path, so routing, revision fences, and the durable
 * claim all apply unchanged.
 *
 * @module server/runtime/long-poll-drain
 */

import { decodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { ServerContext } from './context.ts';
import { dispatchTaskImpl } from './task-dispatch.ts';
import { recordTaskBacklogMetric } from './task-metrics.ts';
import { taskDispatchFromLedgerRecord } from './task-reconciliation.ts';

/**
 * Start a drain of `queue` without waiting for it. Message handlers call this:
 * a drain makes durable ledger writes and must never hold up the frame that
 * triggered it.
 */
export function drainLongPollQueueInBackground(
  context: ServerContext,
  options: ServeOptions,
  queue: string,
): void {
  void drainLongPollQueue(context, options, queue).catch((error: unknown) => {
    console.error(`[weft] Long-poll drain of queue "${queue}" failed:`, error);
  });
}

/**
 * Move `queue`'s long-poll hints onto WebSocket workers until none can take
 * the next one. One drain runs per queue at a time. A trigger that arrives
 * while one is running marks it to go around again rather than starting a
 * second, so room freed after the running drain's last check is never missed.
 */
export async function drainLongPollQueue(
  context: ServerContext,
  options: ServeOptions,
  queue: string,
): Promise<void> {
  const running = context.longPollDrains.get(queue);
  if (running !== undefined) {
    running.rerun = true;
    return;
  }

  const state = { rerun: false };
  context.longPollDrains.set(queue, state);
  try {
    do {
      state.rerun = false;
      // Hints whose dispatch failed this pass, so one no worker can take does
      // not block the ones behind it. Each hint is tried at most once a pass.
      const skipped = new Set<string>();
      while (!context.stopping && (await moveOneHint(context, options, queue, skipped))) {
        // Each iteration handles one hint; stop when none is left to try.
      }
    } while (state.rerun && !context.stopping);
  } finally {
    context.longPollDrains.delete(queue);
  }
}

/**
 * Withdraw the first untried hint a connected WebSocket worker could take and
 * dispatch it. A stale hint is discarded; a dispatch that does not land
 * restores the hint where it was and adds it to `skipped`. Returns `false`
 * only when no untried hint is eligible.
 */
async function moveOneHint(
  context: ServerContext,
  options: ServeOptions,
  queue: string,
  skipped: Set<string>,
): Promise<boolean> {
  const withdrawn = context.taskQueue.withdrawPending(
    queue,
    (task) => !skipped.has(task.operationId) && webSocketWorkerCanTake(context, queue, task),
  );
  if (withdrawn === undefined) return false;
  recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);

  const { operationId } = withdrawn.task;
  let dispatched = false;
  try {
    const record = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(operationId)),
    );
    // The ledger is the authority and the queue only a hint. A record that
    // is no longer `queued` was cancelled or claimed by another route, so
    // there is nothing left to deliver.
    if (record === null || record.state !== 'queued') return true;
    dispatched = await dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(record), {
      redispatch: true,
      longPollFallback: false,
    });
  } catch (error) {
    console.error(`[weft] Failed to move long-poll task "${operationId}" to a worker:`, error);
  }
  if (dispatched) return true;

  // The worker's room went to another dispatch first, the claim lost a race,
  // or the task is not claimable yet. The hint goes back where it was, and a
  // later trigger retries it.
  context.taskQueue.restorePending(withdrawn);
  recordTaskBacklogMetric(context.metricsCollector, context.taskQueue);
  skipped.add(operationId);
  return true;
}

/**
 * Whether a connected WebSocket worker could take `task` right now. The
 * registry can also hold long-poll workers, which have no socket, and a
 * worker inside its reconnect grace window still has one but must not be
 * routed to. The eligibility inputs are the ones `buildRoutingOptions` in
 * `task-dispatch.ts` gives WebSocket dispatch; sticky affinity and the
 * fair-share key only choose among eligible workers, so they are left out.
 */
function webSocketWorkerCanTake(context: ServerContext, queue: string, task: PendingTask): boolean {
  return context.registry.hasEligibleWorker(
    task.activityName,
    { queue, excludeWorkerIds: new Set(context.pendingWorkerRequeues.keys()) },
    (worker) => context.workerSockets.has(worker.id),
  );
}
