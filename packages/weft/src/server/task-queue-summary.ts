// ---------------------------------------------------------------------------
// Pure summary projection for TaskQueue diagnostics
// ---------------------------------------------------------------------------

import type { SchedulingPolicy, TaskQueueSummary } from './task-queue-types.ts';

/**
 * Read-only snapshot of the fields {@link buildQueueSummaries} needs. Captured
 * synchronously by {@link TaskQueue.captureSnapshot} so all reads happen within
 * a single turn of the event loop — no locks required.
 *
 * This type is internal to the server package and must not be re-exported from
 * the public barrel.
 */
export type TaskQueueSnapshot = {
  /** Shallow copy of queue → pending task metadata (only `enqueuedAt` is read). */
  pending: ReadonlyMap<string, ReadonlyArray<{ enqueuedAt?: number | undefined }>>;
  /** Shallow copy of queue → waiter array (only `length` is read). */
  waiters: ReadonlyMap<string, ReadonlyArray<unknown>>;
  /** Scheduling policy the queue was configured with. */
  schedulingPolicy: SchedulingPolicy;
};

/**
 * Build the sorted per-queue summary list from a synchronously captured
 * snapshot. Pure function: no live registry references, no side effects.
 *
 * Returns one entry per queue name appearing in either `pending` or `waiters`,
 * sorted ascending by queue name so responses are stable.
 */
export function buildQueueSummaries(snapshot: TaskQueueSnapshot): TaskQueueSummary[] {
  const summaries = new Map<string, TaskQueueSummary>();

  for (const [queue, tasks] of snapshot.pending) {
    let oldestEnqueuedAt: number | null = null;
    for (const task of tasks) {
      const enqueuedAt = task.enqueuedAt;
      if (enqueuedAt === undefined) continue;
      if (oldestEnqueuedAt === null || enqueuedAt < oldestEnqueuedAt) {
        oldestEnqueuedAt = enqueuedAt;
      }
    }
    summaries.set(queue, {
      queue,
      backlog: tasks.length,
      oldestEnqueuedAt,
      waitingPollers: 0,
      schedulingPolicy: snapshot.schedulingPolicy,
    });
  }

  for (const [queue, waiters] of snapshot.waiters) {
    const existing = summaries.get(queue);
    if (existing === undefined) {
      summaries.set(queue, {
        queue,
        backlog: 0,
        oldestEnqueuedAt: null,
        waitingPollers: waiters.length,
        schedulingPolicy: snapshot.schedulingPolicy,
      });
    } else {
      existing.waitingPollers = waiters.length;
    }
  }

  return [...summaries.values()].toSorted((a, b) =>
    a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0,
  );
}
