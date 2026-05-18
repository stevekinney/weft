// ---------------------------------------------------------------------------
// In-memory task queue for HTTP long-poll workers
// ---------------------------------------------------------------------------

import type { RetryPolicy } from '../core/types.ts';
import type { TaskQueueSnapshot } from './task-queue-summary.ts';
import { buildQueueSummaries } from './task-queue-summary.ts';
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

type CompletionCallback = (result: TaskResult) => void;

/**
 * Strategy used by {@link TaskQueue.enqueue} to place an incoming task in the
 * per-queue pending list. In all strategies, {@link TaskQueue.poll} dequeues
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
 *   newer arrivals jump in front of them, and when {@link TaskQueueOptions.pendingTaskTimeToLive}
 *   is finite (the default is 5 minutes) they eventually expire and fail with
 *   a generic timeout error — the producer gets no signal that LIFO ordering
 *   was responsible. Only choose `'lifo'` for workloads where you actively
 *   want bursty arrivals to displace older work, and consider setting
 *   `pendingTaskTimeToLive` to `Infinity` (or aggressively low) to make the
 *   trade-off explicit.
 */
export type SchedulingPolicy = 'priority' | 'fifo' | 'lifo';

/**
 * Per-queue snapshot reported by {@link TaskQueue.getQueueSummaries}.
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

/** Configuration options for {@link TaskQueue}. */
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

const DEFAULT_PENDING_TASK_TTL = 5 * 60 * 1000; // 5 minutes

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

interface Waiter {
  activities: string[];
  resolve: (task: PendingTask | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

/**
 * Manages pending tasks and waiting long-poll requests. When a task is
 * enqueued and a matching waiter exists, the task is dispatched immediately.
 * When a poll request arrives and no task is available, the request blocks
 * until a task arrives or the timeout expires.
 */
export class TaskQueue {
  #pending = new Map<string, PendingTask[]>();
  #waiters = new Map<string, Waiter[]>();
  #completionCallbacks = new Map<string, CompletionCallback>();
  #dispatched = new Set<string>();
  /** Expiration timers for pending tasks, keyed by operationId. */
  #expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #pendingTaskTimeToLive: number;
  #schedulingPolicy: SchedulingPolicy;

  constructor(options?: TaskQueueOptions) {
    const ttl = options?.pendingTaskTimeToLive ?? DEFAULT_PENDING_TASK_TTL;
    this.#pendingTaskTimeToLive = ttl;
    this.#schedulingPolicy = options?.schedulingPolicy ?? 'priority';

    // Warn once per process when LIFO is paired with a finite expiration. The
    // combination silently produces "task expired" failures for tasks that
    // never reach the head of the stack under sustained load — the producer
    // sees a generic timeout, not the LIFO scheduling decision behind it.
    // We only warn (rather than reject) so existing configurations keep
    // working; the documentation on `SchedulingPolicy` describes the trade-off in full.
    if (
      this.#schedulingPolicy === 'lifo' &&
      this.#pendingTaskTimeToLive > 0 &&
      Number.isFinite(this.#pendingTaskTimeToLive) &&
      !lifoStarvationWarningEmitted
    ) {
      lifoStarvationWarningEmitted = true;
      console.warn(
        `[weft] TaskQueue configured with schedulingPolicy='lifo' and a finite ` +
          `pendingTaskTimeToLive (${this.#pendingTaskTimeToLive}ms). Under sustained ` +
          `load, tasks at the bottom of the LIFO stack can sit unclaimed until they ` +
          `expire and fail with a generic timeout error. Set pendingTaskTimeToLive to ` +
          `Infinity to disable expiration, or use 'fifo'/'priority' if fairness matters.`,
      );
    }
  }

  /** The scheduling policy this queue was configured with. */
  get schedulingPolicy(): SchedulingPolicy {
    return this.#schedulingPolicy;
  }

  /**
   * Enqueue a task. If a matching waiter exists, dispatch immediately.
   * Returns true if the task was dispatched to a waiter or queued.
   */
  enqueue(queue: string, task: PendingTask, onComplete?: CompletionCallback): boolean {
    // Reject duplicate operationIds — each task assigned to exactly one worker.
    if (this.#dispatched.has(task.operationId)) {
      return false;
    }

    this.#dispatched.add(task.operationId);
    task.enqueuedAt ??= Date.now();

    if (onComplete) {
      this.#completionCallbacks.set(task.operationId, onComplete);
    }

    const waiters = this.#waiters.get(queue);
    if (waiters && waiters.length > 0) {
      const index = waiters.findIndex((w) => w.activities.includes(task.activityName));

      if (index !== -1) {
        const waiter = waiters[index]!;
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        if (waiters.length === 0) this.#waiters.delete(queue);
        waiter.resolve(task);
        return true;
      }
    }

    const tasks = this.#pending.get(queue) ?? [];
    insertByPolicy(tasks, task, this.#schedulingPolicy);
    this.#pending.set(queue, tasks);

    this.#scheduleExpiration(queue, task.operationId);

    return true;
  }

  /**
   * Long-poll for a task. Returns immediately if a matching task is queued,
   * otherwise blocks until a task arrives or `timeout` milliseconds elapse.
   */
  poll(
    queue: string,
    activities: string[],
    timeout: number,
    signal?: AbortSignal,
  ): Promise<PendingTask | null> {
    // Check for an immediately available task
    const tasks = this.#pending.get(queue);
    if (tasks) {
      const index = tasks.findIndex((t) => activities.includes(t.activityName));
      if (index !== -1) {
        const task = tasks.splice(index, 1)[0]!;
        if (tasks.length === 0) this.#pending.delete(queue);
        this.#cancelExpiration(task.operationId);
        return Promise.resolve(task);
      }
    }

    // No task available — wait for one
    return new Promise<PendingTask | null>((_resolve) => {
      let settled = false;
      const resolve = (value: PendingTask | null) => {
        if (settled) return;
        settled = true;
        _resolve(value);
      };

      const waiters = this.#waiters.get(queue) ?? [];
      this.#waiters.set(queue, waiters);

      const cleanup = () => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        if (waiters.length === 0) this.#waiters.delete(queue);
      };

      // Captured so the abort listener can be removed when the poll settles
      // normally. Without explicit removal, `{ once: true }` only prunes the
      // listener after `abort` actually fires, which leaks closures on
      // long-lived signals (one per worker poll loop polls thousands of times).
      const settle = (value: PendingTask | null) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(null);

      const timer = setTimeout(() => settle(null), timeout);

      const waiter: Waiter = {
        activities,
        resolve: settle,
        timer,
      };
      waiters.push(waiter);

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Report a task completion. Invokes the completion callback registered
   * during enqueue (if any). Returns true if a callback was found.
   */
  complete(result: TaskResult): boolean {
    this.#cancelExpiration(result.operationId);
    this.#dispatched.delete(result.operationId);

    const callback = this.#completionCallbacks.get(result.operationId);
    if (callback) {
      this.#completionCallbacks.delete(result.operationId);
      callback(result);
      return true;
    }
    return false;
  }

  /** Check whether an operationId is currently tracked (pending or dispatched). */
  isTracked(operationId: string): boolean {
    return this.#dispatched.has(operationId);
  }

  /** Check if any waiter in the queue can handle the given activity. */
  hasWaiter(queue: string, activityName: string): boolean {
    const waiters = this.#waiters.get(queue);
    if (!waiters) return false;
    return waiters.some((w) => w.activities.includes(activityName));
  }

  /** Number of pending (unclaimed) tasks in a queue. */
  pendingCount(queue: string): number {
    return this.#pending.get(queue)?.length ?? 0;
  }

  /** Total number of pending tasks across every queue. */
  totalPendingCount(): number {
    let count = 0;
    for (const tasks of this.#pending.values()) {
      count += tasks.length;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Pending task expiration
  // ---------------------------------------------------------------------------

  /**
   * Schedule an expiration timer for a pending task. When it fires the task is
   * removed from `#pending`, `#dispatched`, and `#completionCallbacks`, and the
   * completion callback (if any) is invoked with a timeout failure.
   */
  #scheduleExpiration(queue: string, operationId: string): void {
    const ttl = this.#pendingTaskTimeToLive;
    if (ttl <= 0 || !Number.isFinite(ttl)) return;

    const timer = setTimeout(() => this.#expireTask(queue, operationId), ttl);
    this.#expirationTimers.set(operationId, timer);
  }

  /** Cancel a previously scheduled expiration timer. */
  #cancelExpiration(operationId: string): void {
    const timer = this.#expirationTimers.get(operationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#expirationTimers.delete(operationId);
    }
  }

  /** Remove an expired task and notify via the completion callback. */
  #expireTask(queue: string, operationId: string): void {
    this.#expirationTimers.delete(operationId);

    // Remove from the pending list
    const tasks = this.#pending.get(queue);
    if (tasks) {
      const index = tasks.findIndex((t) => t.operationId === operationId);
      if (index !== -1) {
        tasks.splice(index, 1);
        if (tasks.length === 0) this.#pending.delete(queue);
      }
    }

    // Clean up dispatched tracking
    this.#dispatched.delete(operationId);

    // Invoke and remove the completion callback with a timeout error
    const callback = this.#completionCallbacks.get(operationId);
    if (callback) {
      this.#completionCallbacks.delete(operationId);
      callback({
        operationId,
        status: 'failed',
        error: `Task expired after ${this.#pendingTaskTimeToLive}ms without being claimed by a worker`,
      });
    }
  }

  /** Peek the ordered pending tasks for a queue without dequeuing. Test helper. */
  peekPending(queue: string): PendingTask[] {
    return [...(this.#pending.get(queue) ?? [])];
  }

  /**
   * Synchronously reads internal state into a plain snapshot object for use by
   * {@link buildQueueSummaries}. Single-turn event-loop reads are consistent
   * without explicit locking.
   */
  captureSnapshot(): TaskQueueSnapshot {
    return {
      pending: new Map(
        [...this.#pending.entries()].map(([q, tasks]) => [
          q,
          tasks.map((t) => ({ enqueuedAt: t.enqueuedAt })),
        ]),
      ),
      waiters: new Map([...this.#waiters.entries()].map(([q, ws]) => [q, ws.slice()])),
      schedulingPolicy: this.#schedulingPolicy,
    };
  }

  /**
   * Per-queue summary used by `weft.task.queues.list`. Returns one entry per
   * queue appearing in `#pending` or `#waiters`, sorted ascending by name.
   * See {@link buildQueueSummaries} for field semantics.
   */
  getQueueSummaries(): TaskQueueSummary[] {
    return buildQueueSummaries(this.captureSnapshot());
  }

  /** Remove and return pending tasks older than `maxAge` milliseconds. */
  removeStale(maxAge: number): PendingTask[] {
    if (!Number.isFinite(maxAge) || maxAge < 0) {
      throw new RangeError(`maxAge must be a finite, non-negative number, got: ${maxAge}`);
    }
    const cutoff = Date.now() - maxAge;
    const stale: PendingTask[] = [];

    for (const [queue, tasks] of this.#pending) {
      const remaining: PendingTask[] = [];

      for (const task of tasks) {
        if ((task.enqueuedAt ?? 0) < cutoff) {
          stale.push(task);
          this.#cancelExpiration(task.operationId);
          this.#dispatched.delete(task.operationId);

          const callback = this.#completionCallbacks.get(task.operationId);
          if (callback) {
            this.#completionCallbacks.delete(task.operationId);
            callback({
              operationId: task.operationId,
              status: 'failed',
              error: `Task expired after ${maxAge}ms without being claimed`,
            });
          }
        } else {
          remaining.push(task);
        }
      }

      if (remaining.length === 0) {
        this.#pending.delete(queue);
      } else {
        this.#pending.set(queue, remaining);
      }
    }

    return stale;
  }
}

/**
 * Place `task` into `tasks` at the position prescribed by `policy`.
 *
 * Every policy keeps the property that {@link TaskQueue.poll} can simply
 * dequeue the first matching entry — the ordering logic lives here.
 */
function insertByPolicy(tasks: PendingTask[], task: PendingTask, policy: SchedulingPolicy): void {
  if (tasks.length === 0) {
    tasks.push(task);
    return;
  }

  switch (policy) {
    case 'fifo':
      tasks.push(task);
      return;
    case 'lifo':
      tasks.unshift(task);
      return;
    case 'priority': {
      const taskPriority = task.priority ?? 0;
      const insertAt = tasks.findIndex((existing) => (existing.priority ?? 0) < taskPriority);
      if (insertAt === -1) {
        tasks.push(task);
      } else {
        tasks.splice(insertAt, 0, task);
      }
      return;
    }
  }
}
