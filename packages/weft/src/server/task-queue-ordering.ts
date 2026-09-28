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
