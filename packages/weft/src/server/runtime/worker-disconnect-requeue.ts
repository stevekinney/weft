/**
 * Forfeit a worker's in-flight work: remove its in-flight tracking, drop it
 * from the registry, clear its workflow affinity, and durably reassign each
 * task it was holding — the shared "give up this session's work" primitive
 * used by two callers.
 *
 * Split into its own module (COR-220) because a second caller needs it:
 * `authentication-bridge.ts`'s close handler (inline when the grace period
 * is 0, or from the deferred-requeue timer once the grace period elapses
 * with no reconnect) AND `websocket-worker-registration.ts`'s UNPROVEN
 * reconnect path (a `register` that arrives while a grace-period requeue is
 * still pending, but that fails to prove it is resuming that exact session —
 * see `registerWorker`'s doc comment). Keeping both callers importing from
 * this leaf module, rather than from each other, avoids a cycle:
 * `authentication-bridge.ts` already imports `handleWorkerWebSocketMessage`
 * from `websocket-worker.ts`, which imports registration handling from
 * `websocket-worker-registration.ts` — that module importing back from
 * `authentication-bridge.ts` would close the loop.
 *
 * Returns once every affected task's durable requeue attempt has settled.
 * This is load-bearing for the unproven-reconnect caller: it AWAITS this
 * function to completion before sending the new session's `registerAck`, so
 * no frame the new session is allowed to send can ever race the requeue that
 * rotates each attempt away from the forfeited session's `attemptToken` —
 * see `registerWorker`'s doc comment for why that ordering, not a
 * session-generation comparison, is what closes the "same worker, new
 * session, stale frame" race. Never rejects — each per-task reassignment
 * attempt has its own try/catch, matching the original inline requeue loop's
 * error handling.
 *
 * @module server/runtime/worker-disconnect-requeue
 */

import { WorkerDisconnectedEvent } from '../../core/events.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import type { ServerContext } from './context.ts';
import { reassignOrExpireTask } from './task-reconciliation.ts';

export async function runWorkerDisconnectRequeue(
  context: ServerContext,
  options: ServeOptions,
  workerId: string,
  cleanupWorkflowIndex: (operationId: string) => void,
): Promise<void> {
  // Capture in-flight tasks from the in-memory registry (source of truth)
  // before cleanup so they can be reassigned even if storage hasn't committed yet.
  const inFlightTasks = context.registry.getWorkerTasks(workerId);

  // Remove in-flight tracking synchronously to allow re-dispatch.
  for (const task of inFlightTasks) {
    context.registry.completeTask(task.operationId);
    context.deadlineTracker.remove(task.operationId);
  }

  context.registry.unregister(workerId);
  context.workerSockets.delete(workerId);
  options.engine.dispatchEvent(new WorkerDisconnectedEvent(workerId, inFlightTasks.length));

  // Clean up affinity entries that pointed at this worker.
  for (const [workflowId, affinityWorkerId] of context.workerAffinity) {
    if (affinityWorkerId === workerId) {
      context.workerAffinity.delete(workflowId);
    }
  }

  // Clean up workflow→operations reverse index for tasks owned by this worker.
  for (const task of inFlightTasks) {
    cleanupWorkflowIndex(task.operationId);
  }

  // Requeue each in-flight task with incremented attempt, respecting retry policy.
  // The in-memory registry is the source of truth for *which* tasks to reassign.
  // Full task metadata (activityName, input, etc.) is read from storage.
  await Promise.all(
    inFlightTasks.map(async (task) => {
      try {
        const record = decodeRemoteTaskRecord(
          await options.engine.storage.get(taskLedgerKey(task.operationId)),
        );

        if (record !== null && record.state === 'leased') {
          await reassignOrExpireTask(
            context,
            options,
            task.operationId,
            record,
            'worker-disconnect',
          );
        } else {
          // Storage write hadn't committed, or a result/timeout/cancellation
          // already settled this attempt — nothing to reassign.
          console.warn(
            `[weft] No leased ledger record found for task "${task.operationId}" — skipping reassignment`,
          );
        }
      } catch (error) {
        console.error(
          `[weft] Failed to reassign task "${task.operationId}" from worker "${workerId}":`,
          error,
        );
      }
    }),
  );
}
