// ---------------------------------------------------------------------------
// Public types for the in-memory task queue and its diagnostics
// ---------------------------------------------------------------------------

import type { RetryPolicy } from '../core/types.ts';
import type { TaskLifecycleFields } from './task-state.ts';

/** A task waiting to be claimed by a long-poll worker. */
export interface PendingTask extends TaskLifecycleFields {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number | undefined;
  retryPolicy?: RetryPolicy | undefined;
  visibilityTimeout?: number | undefined;
  enqueuedAt?: number | undefined;
  /** Propagated interceptor headers (e.g. W3C trace context, auth tokens). */
  headers?: Record<string, string> | undefined;
  /** Workflow that dispatched this activity. Present when the dispatch included a workflowId. */
  workflowId?: string | undefined;
  /** Durable token for the workflow run that dispatched this activity, when known. */
  workflowExecutionToken?: string | undefined;
  /**
   * Task priority. Higher values are dequeued first. Tasks with equal priority
   * maintain FIFO order. Default: 0. Agent workflow tasks use priority 10.
   */
  priority?: number | undefined;
}

/** Result reported by a long-poll worker after executing a task. */
export interface TaskResult {
  operationId: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string | undefined;
}

/**
 * Strategy used by `TaskQueue.enqueue` to place an incoming task in the
 * per-queue pending list. In all strategies, `TaskQueue.poll` dequeues
 * the first task whose activity matches the waiter — so the ordering imposed
 * at enqueue time is what actually gets observed.
 *
 * - `'priority'` (default) inserts by descending `task.priority`. Tasks at the
 *   same priority keep FIFO order. This is the historical behavior.
 * - `'fifo'` ignores priority and appends to the end of the list. Oldest tasks
 *   are dequeued first. Use this when fairness across producers matters more
 *   than urgency.
 * - `'lifo'` prepends to the start of the list. Newest tasks are dequeued
 *   first. Use this for time-sensitive, short-lived work where fresh requests
 *   are more valuable than stale ones (e.g. interactive UI refreshes).
 *
 *   **Starvation warning**: under sustained load, tasks at the bottom of the
 *   LIFO stack may never be dequeued. They sit in the pending list while
 *   newer arrivals jump in front of them, and when `TaskQueueOptions.pendingTaskTimeToLive`
 *   is finite (the default is 5 minutes) they eventually expire and fail with
 *   a generic timeout error — the producer gets no signal that LIFO ordering
 *   was responsible. Only choose `'lifo'` for workloads where you actively
 *   want bursty arrivals to displace older work, and consider setting
 *   `pendingTaskTimeToLive` to `Infinity` (or aggressively low) to make the
 *   trade-off explicit.
 */
export type SchedulingPolicy = 'priority' | 'fifo' | 'lifo';

/**
 * Per-queue snapshot reported by `TaskQueue.getQueueSummaries`.
 * Wall-clock-free: `oldestEnqueuedAt` is the raw `enqueuedAt` of the oldest
 * pending task (or `null` when the queue has no pending tasks). Age in
 * milliseconds is derived by the caller against a single per-request `now`.
 */
export type TaskQueueSummary = {
  /** Queue name. */
  queue: string;
  /** Pending (unclaimed) task count. */
  backlog: number;
  /**
   * Epoch milliseconds when the oldest pending task was enqueued, or `null`
   * when the queue has no pending tasks (or — defensively — when no pending
   * task carries an `enqueuedAt`, which should not happen after enqueue
   * defaults it).
   */
  oldestEnqueuedAt: number | null;
  /** Active long-poll waiters parked on this queue. */
  waitingPollers: number;
  /** Scheduling policy in effect for the queue. */
  schedulingPolicy: SchedulingPolicy;
};

/** Configuration options for `TaskQueue`. */
export type TaskQueueOptions = {
  /**
   * Maximum time (in milliseconds) a task can sit in the pending queue before
   * it expires. When a task expires its completion callback is invoked with a
   * `'failed'` result carrying a timeout error, and all associated state is
   * cleaned up. Set to `0` or `Infinity` to disable expiration.
   *
   * @default 300_000 (5 minutes)
   */
  pendingTaskTimeToLive?: number;
  /**
   * How tasks are ordered within a queue at enqueue time.
   *
   * @default 'priority'
   */
  schedulingPolicy?: SchedulingPolicy;
};
