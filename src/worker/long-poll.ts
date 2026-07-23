// ---------------------------------------------------------------------------
// HTTP long-poll fallback worker for environments without WebSocket support
// ---------------------------------------------------------------------------

import type { ActivityInterceptor } from '../core/interceptor.ts';
import { sleep } from '../runtime/portable.ts';
import {
  buildComposedInterceptor,
  executeWithInterceptors,
  type ComposedInterceptor,
} from './execute-with-interceptors.ts';
import type { RemoteWorkerActivityFunction } from './workflow-activity-binding.ts';

export interface LongPollWorkerOptions {
  serverUrl: string;
  activities: Record<string, RemoteWorkerActivityFunction>;
  concurrency?: number;
  queue?: string;
  pollTimeout?: number; // ms, default: 30000
  /**
   * HTTP headers sent with poll and result requests, such as `Authorization`.
   * When the server enforces authentication, supply credentials with the
   * `workers:write` scope here. `Content-Type` is reserved on result requests
   * and is always set to `application/json`, overriding any value passed here.
   */
  headers?: Record<string, string>;
  /** Activity interceptors to run around each activity execution on this worker. */
  interceptors?: ActivityInterceptor[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const DEFAULT_POLL_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// LongPollWorker
// ---------------------------------------------------------------------------

/**
 * HTTP long-poll fallback worker for environments where WebSocket connections
 * are unavailable (e.g. certain serverless runtimes or proxied environments).
 *
 * Continuously polls the server for pending tasks using HTTP long-polling and
 * executes them locally.  Supports the same activity and interceptor model as
 * {@link RemoteWorker} but with slightly higher per-task latency due to the
 * poll round-trip.
 *
 * @example
 * ```ts
 * import { LongPollWorker } from '@lostgradient/weft';
 *
 * using worker = new LongPollWorker({
 *   serverUrl: 'http://localhost:3000',
 *   activities: {
 *     resize: async (input: unknown) => {
 *       return `resized:${JSON.stringify(input)}`;
 *     },
 *   },
 *   concurrency: 3,
 *   queue: 'images',
 * });
 * worker.start();
 * ```
 */
export class LongPollWorker implements Disposable {
  #options: LongPollWorkerOptions;
  #running: boolean;
  #inFlight: number;
  #abortController: AbortController;
  #composedInterceptor: ComposedInterceptor | null;

  constructor(options: LongPollWorkerOptions) {
    this.#options = {
      ...options,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: options.queue ?? DEFAULT_QUEUE,
      pollTimeout: options.pollTimeout ?? DEFAULT_POLL_TIMEOUT,
    };
    this.#running = false;
    this.#inFlight = 0;
    this.#abortController = new AbortController();
    this.#composedInterceptor = buildComposedInterceptor(options.interceptors);
  }

  /** Start polling for tasks. */
  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#abortController = new AbortController();
    void this.#pollLoop();
  }

  /** Stop polling and wait for in-flight to finish. */
  async stop(): Promise<void> {
    this.#abortController.abort();
    this.#running = false;

    // Wait for in-flight tasks to complete
    while (this.#inFlight > 0) {
      await sleep(50);
    }
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get running(): boolean {
    return this.#running;
  }

  [Symbol.dispose](): void {
    this.#running = false;
    this.#abortController.abort();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Build the poll URL with activity and timeout query parameters. */
  #buildPollUrl(): string {
    const queue = this.#options.queue ?? DEFAULT_QUEUE;
    const params = new URLSearchParams();
    params.set('timeout', String(this.#options.pollTimeout ?? DEFAULT_POLL_TIMEOUT));
    for (const activity of Object.keys(this.#options.activities)) {
      params.append('activity', activity);
    }
    return `${this.#options.serverUrl}/api/v1/tasks/${encodeURIComponent(queue)}?${params.toString()}`;
  }

  /** Build the task result URL. */
  #buildResultUrl(): string {
    const queue = this.#options.queue ?? DEFAULT_QUEUE;
    return `${this.#options.serverUrl}/api/v1/tasks/${encodeURIComponent(queue)}/result`;
  }

  async #pollLoop(): Promise<void> {
    const pollUrl = this.#buildPollUrl();
    const resultUrl = this.#buildResultUrl();

    while (this.#running && !this.#abortController.signal.aborted) {
      // Only poll when we have capacity
      if (this.#inFlight >= (this.#options.concurrency ?? DEFAULT_CONCURRENCY)) {
        await sleep(100);
        continue;
      }

      try {
        const response = await fetch(pollUrl, {
          ...(this.#options.headers === undefined ? {} : { headers: this.#options.headers }),
          signal: this.#abortController.signal,
        });

        // 204 No Content means no task available — poll again
        if (response.status === 204) {
          continue;
        }

        if (!response.ok) {
          await sleep(1000);
          continue;
        }

        const task = (await response.json()) as {
          operationId: string;
          activityName: string;
          input: unknown;
          attempt?: number;
          headers?: Record<string, string>;
          workerId?: string;
          workflowExecutionToken?: string;
          attemptToken: string;
        };

        void this.#executeTask(task, resultUrl);
      } catch {
        // Abort errors are expected during shutdown; network errors trigger a backoff
        if (this.#running) {
          await sleep(1000);
        }
      }
    }
  }

  async #executeTask(
    task: {
      operationId: string;
      activityName: string;
      input: unknown;
      attempt?: number;
      headers?: Record<string, string>;
      workerId?: string;
      workflowExecutionToken?: string;
      attemptToken: string;
    },
    resultUrl: string,
  ): Promise<void> {
    this.#inFlight += 1;

    try {
      const activityFunction = this.#options.activities[task.activityName];
      if (activityFunction === undefined) {
        await fetch(resultUrl, {
          method: 'POST',
          headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: task.operationId,
            workerId: task.workerId,
            attemptToken: task.attemptToken,
            status: 'failed',
            error: `Unknown activity: ${task.activityName}`,
          }),
          signal: this.#abortController.signal,
        });
        return;
      }

      const result = await executeWithInterceptors(
        activityFunction,
        task,
        this.#composedInterceptor,
        this.#abortController.signal,
      );

      await fetch(resultUrl, {
        method: 'POST',
        headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: task.operationId,
          workerId: task.workerId,
          attemptToken: task.attemptToken,
          status: 'completed',
          value: result,
        }),
        signal: this.#abortController.signal,
      });
    } catch (error) {
      try {
        await fetch(resultUrl, {
          method: 'POST',
          headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: task.operationId,
            workerId: task.workerId,
            attemptToken: task.attemptToken,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }),
          signal: this.#abortController.signal,
        });
      } catch {
        // Best-effort error reporting; server will eventually time out the task
      }
    } finally {
      this.#inFlight -= 1;
    }
  }
}
