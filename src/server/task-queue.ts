// ---------------------------------------------------------------------------
// In-memory task queue for HTTP long-poll workers
// ---------------------------------------------------------------------------

/** A task waiting to be claimed by a long-poll worker. */
export interface PendingTask {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number | undefined;
}

/** Result reported by a long-poll worker after executing a task. */
export interface TaskResult {
  operationId: string;
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string | undefined;
}

type CompletionCallback = (result: TaskResult) => void;

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

  /**
   * Enqueue a task. If a matching waiter exists, dispatch immediately.
   * Returns true if the task was dispatched to a waiter or queued.
   */
  enqueue(queue: string, task: PendingTask, onComplete?: CompletionCallback): boolean {
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
    tasks.push(task);
    this.#pending.set(queue, tasks);
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

      const settle = (value: PendingTask | null) => {
        clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(() => settle(null), timeout);

      const waiter: Waiter = {
        activities,
        resolve: settle,
        timer,
      };
      waiters.push(waiter);

      if (signal) {
        signal.addEventListener('abort', () => settle(null), { once: true });
      }
    });
  }

  /**
   * Report a task completion. Invokes the completion callback registered
   * during enqueue (if any). Returns true if a callback was found.
   */
  complete(result: TaskResult): boolean {
    const callback = this.#completionCallbacks.get(result.operationId);
    if (callback) {
      this.#completionCallbacks.delete(result.operationId);
      callback(result);
      return true;
    }
    return false;
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
}
