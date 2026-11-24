// ---------------------------------------------------------------------------
// Pending-task ordering for the in-memory task queue's scheduling policies
// ---------------------------------------------------------------------------

import type { PendingTask, SchedulingPolicy } from './task-queue-types.ts';

/**
 * Place `task` into `tasks` at the position prescribed by `policy`.
 *
 * Every policy keeps the property that `TaskQueue.poll` can simply
 * dequeue the first matching entry — the ordering logic lives here.
 */
export function insertByPolicy(
  tasks: PendingTask[],
  task: PendingTask,
  policy: SchedulingPolicy,
): void {
  if (tasks.length === 0 || policy === 'fifo') {
    tasks.push(task);
    return;
  }
  if (policy === 'lifo') {
    tasks.unshift(task);
    return;
  }
  // 'priority': ahead of the first strictly lower priority, so equal
  // priorities keep FIFO order.
  const taskPriority = task.priority ?? 0;
  const insertAt = tasks.findIndex((existing) => (existing.priority ?? 0) < taskPriority);
  if (insertAt === -1) {
    tasks.push(task);
  } else {
    tasks.splice(insertAt, 0, task);
  }
}

/**
 * Tracks whether the LIFO + finite-TTL starvation warning has already been
 * emitted in this process. The warning is one-shot to avoid spamming logs when
 * many TaskQueues are constructed with the same configuration (e.g. tests).
 */
let lifoStarvationWarningEmitted = false;

/**
 * Reset the one-shot LIFO starvation warning. Test-only: production code
 * should never need to call this.
 */
export function resetLifoStarvationWarningForTesting(): void {
  lifoStarvationWarningEmitted = false;
}

/**
 * Warn once per process when LIFO is paired with a finite expiration. The
 * combination silently produces "task expired" failures for tasks that never
 * reach the head of the stack under sustained load — the producer sees a
 * generic timeout, not the LIFO scheduling decision behind it. We only warn
 * (rather than reject) so existing configurations keep working; the
 * documentation on `SchedulingPolicy` describes the trade-off in full.
 */
export function warnOnceOnLifoStarvation(
  schedulingPolicy: SchedulingPolicy,
  pendingTaskTimeToLive: number,
): void {
  if (
    schedulingPolicy === 'lifo' &&
    pendingTaskTimeToLive > 0 &&
    Number.isFinite(pendingTaskTimeToLive) &&
    !lifoStarvationWarningEmitted
  ) {
    lifoStarvationWarningEmitted = true;
    console.warn(
      `[weft] TaskQueue configured with schedulingPolicy='lifo' and a finite ` +
        `pendingTaskTimeToLive (${pendingTaskTimeToLive}ms). Under sustained ` +
        `load, tasks at the bottom of the LIFO stack can sit unclaimed until they ` +
        `expire and fail with a generic timeout error. Set pendingTaskTimeToLive to ` +
        `Infinity to disable expiration, or use 'fifo'/'priority' if fairness matters.`,
    );
  }
}
