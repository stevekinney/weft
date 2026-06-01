/**
 * Dispatches activity execution requests to a pool of Web Workers.
 *
 * Wraps {@link WorkerPool} with a request-response pattern: acquire a worker,
 * post the activity request, wait for the result, and release the worker.
 *
 * @module workers/activity-worker-dispatcher
 */

import type { ActivityExecutionRequest, ActivityExecutionResult } from './activity-runner.ts';
import type { WorkerPool } from './pool.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout in milliseconds for waiting on a worker response. */
const DEFAULT_WORKER_TIMEOUT_MILLISECONDS = 30_000;

// ---------------------------------------------------------------------------
// ActivityWorkerDispatcher
// ---------------------------------------------------------------------------

/**
 * Options for {@link ActivityWorkerDispatcher}.
 *
 * Currently the only option is `timeoutMilliseconds`, which controls how long
 * the dispatcher waits for a worker to respond before treating the task as
 * failed and terminating the worker.
 *
 * @example
 * ```ts
 * import { ActivityWorkerDispatcher, WorkerPool, type ActivityWorkerDispatcherOptions } from '@lostgradient/weft';
 *
 * const options: ActivityWorkerDispatcherOptions = {
 *   timeoutMilliseconds: 60_000,
 * };
 * const pool = new WorkerPool({ concurrency: 4, workerUrl: './worker.ts' });
 * using dispatcher = new ActivityWorkerDispatcher(pool, options);
 * void dispatcher;
 * ```
 */
export type ActivityWorkerDispatcherOptions = {
  /** Maximum time in milliseconds to wait for a worker to respond before
   *  rejecting and terminating the worker. Default: 30 000 (30 seconds). */
  timeoutMilliseconds?: number;
};

/**
 * Dispatches activity execution requests to a pool of Web Workers and awaits
 * their results, implementing a request-response pattern over the Worker
 * message protocol.
 *
 * Acquires a worker from the {@link WorkerPool}, posts the
 * {@link ActivityExecutionRequest}, waits for the matching
 * {@link ActivityExecutionResult}, then releases the worker back to the pool.
 * If no response arrives within the configured timeout, the task fails and the
 * worker is terminated.
 *
 * @example
 * ```ts
 * import { ActivityWorkerDispatcher, WorkerPool } from '@lostgradient/weft';
 *
 * const pool = new WorkerPool({
 *   concurrency: 4,
 *   workerUrl: new URL('./my-worker.ts', import.meta.url),
 * });
 * using dispatcher = new ActivityWorkerDispatcher(pool, { timeoutMilliseconds: 30_000 });
 *
 * const result = await dispatcher.execute({
 *   operationId: crypto.randomUUID(),
 *   activityName: 'processImage',
 *   input: { url: 'https://example.com/img.png' },
 *   attempt: 1,
 * });
 * console.log(result.status); // 'completed' or 'failed'
 * ```
 */
export class ActivityWorkerDispatcher implements Disposable, AsyncDisposable {
  readonly #pool: WorkerPool;
  readonly #timeoutMilliseconds: number;

  constructor(pool: WorkerPool, options?: ActivityWorkerDispatcherOptions) {
    this.#pool = pool;
    this.#timeoutMilliseconds = options?.timeoutMilliseconds ?? DEFAULT_WORKER_TIMEOUT_MILLISECONDS;
  }

  /**
   * Dispatch an activity execution request to a worker and wait for the result.
   * Acquires a worker from the pool, sends the request, waits for a matching
   * response, then releases the worker back to the pool.
   *
   * If the worker does not respond within the configured timeout, the promise
   * resolves with a `failed` result and the worker is terminated.
   */
  async execute(request: ActivityExecutionRequest): Promise<ActivityExecutionResult> {
    const worker = await this.#pool.acquire();
    let terminated = false;

    try {
      return await new Promise<ActivityExecutionResult>((resolve) => {
        let settled = false;

        const settle = (result: ActivityExecutionResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const onMessage = (event: MessageEvent<ActivityExecutionResult>) => {
          if (event.data.operationId === request.operationId) {
            settle(event.data);
          }
        };

        const onError = (event: ErrorEvent) => {
          settle({
            operationId: request.operationId,
            status: 'failed',
            error: `Activity worker crashed: ${event.message ?? 'unknown error'}`,
          });
        };

        const timer = setTimeout(() => {
          settle({
            operationId: request.operationId,
            status: 'failed',
            error:
              `Activity "${request.activityName}" timed out after ${this.#timeoutMilliseconds}ms ` +
              `(operationId: ${request.operationId})`,
          });
          // Terminate the unresponsive worker so it doesn't linger.
          // Mark as terminated so the finally block skips pool release.
          terminated = true;
          worker.terminate();
        }, this.#timeoutMilliseconds);

        const cleanup = () => {
          clearTimeout(timer);
          worker.removeEventListener('message', onMessage as EventListener);
          worker.removeEventListener('error', onError as EventListener);
        };

        worker.addEventListener('message', onMessage as EventListener);
        worker.addEventListener('error', onError as EventListener);
        worker.postMessage(request);
      });
    } finally {
      if (!terminated) {
        this.#pool.release(worker);
      }
    }
  }

  /** Get the number of available workers. */
  get availableCount(): number {
    return this.#pool.availableCount;
  }

  /** Get the total number of workers in the pool. */
  get totalCount(): number {
    return this.#pool.totalCount;
  }

  /** Get the number of pending dispatch requests. */
  get pendingCount(): number {
    return this.#pool.pendingCount;
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    this.#pool[Symbol.dispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#pool[Symbol.asyncDispose]();
  }
}
