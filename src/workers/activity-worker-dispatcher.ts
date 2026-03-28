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
// ActivityWorkerDispatcher
// ---------------------------------------------------------------------------

export class ActivityWorkerDispatcher implements Disposable, AsyncDisposable {
  readonly #pool: WorkerPool;

  constructor(pool: WorkerPool) {
    this.#pool = pool;
  }

  /**
   * Dispatch an activity execution request to a worker and wait for the result.
   * Acquires a worker from the pool, sends the request, waits for a matching
   * response, then releases the worker back to the pool.
   */
  async execute(request: ActivityExecutionRequest): Promise<ActivityExecutionResult> {
    const worker = await this.#pool.acquire();

    try {
      return await new Promise<ActivityExecutionResult>((resolve) => {
        const onMessage = (event: MessageEvent<ActivityExecutionResult>) => {
          if (event.data.operationId === request.operationId) {
            cleanup();
            resolve(event.data);
          }
        };

        const onError = (event: ErrorEvent) => {
          cleanup();
          resolve({
            operationId: request.operationId,
            status: 'failed',
            error: `Activity worker crashed: ${event.message ?? 'unknown error'}`,
          });
        };

        const cleanup = () => {
          worker.removeEventListener('message', onMessage as EventListener);
          worker.removeEventListener('error', onError as EventListener);
        };

        worker.addEventListener('message', onMessage as EventListener);
        worker.addEventListener('error', onError as EventListener);
        worker.postMessage(request);
      });
    } finally {
      this.#pool.release(worker);
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
