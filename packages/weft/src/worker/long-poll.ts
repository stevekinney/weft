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
   * How often (ms) to send a heartbeat for each in-flight activity (COR-230,
   * acceptance criterion 5). Defaults to 10 000, matching `HeartbeatManager`'s
   * WebSocket-transport default. Each heartbeat renews the activity's
   * attempt-fenced visibility deadline through the same `renewAttemptLease`
   * transition the WebSocket transport's `activityHeartbeat` uses, and its
   * response carries a `cancelled` flag this worker checks to learn about a
   * server-initiated cancellation — long-poll has no server-to-worker push
   * channel, so the heartbeat response is where that signal piggybacks.
   */
  heartbeatIntervalMs?: number;
  /**
   * HTTP headers sent with poll and result requests, such as `Authorization`.
   * When the server enforces authentication, supply credentials with the
   * `workers:write` scope here. `Content-Type` is reserved on result requests
   * and is always set to `application/json`, overriding any value passed here.
   */
  headers?: Record<string, string>;
  /** Activity interceptors to run around each activity execution on this worker. */
  interceptors?: ActivityInterceptor[];
  /**
   * Bound on how long {@link LongPollWorker.stop} waits for in-flight
   * activities to actually finish unwinding after signaling their
   * `AbortController`s, before returning anyway (COR-220, "bounded drain").
   * `stop()` aborts every in-flight activity synchronously and immediately;
   * this timeout only covers the COOPERATIVE part — an activity that ignores
   * its `AbortSignal` (or is stuck in non-abortable synchronous/native work)
   * would otherwise hold `stop()` open forever, matching `RemoteWorker`'s
   * `disconnectTimeoutMs` bound on the identical problem. Defaults to
   * `30_000`.
   */
  disconnectTimeoutMs?: number;
}

type PolledTask = {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number;
  headers?: Record<string, string>;
  workerId?: string;
  workflowExecutionToken?: string;
  attemptToken: string;
  /** Present when the dispatcher supplied one — governs the heartbeat-renewable visibility deadline (COR-230). */
  visibilityTimeout?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/** Default {@link LongPollWorkerOptions.disconnectTimeoutMs} — matches `RemoteWorker`'s `DEFAULT_DISCONNECT_TIMEOUT_MS`. */
const DEFAULT_DISCONNECT_TIMEOUT_MS = 30_000;

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
 * Long-running activities are kept alive the same way a WebSocket worker's
 * are (COR-230, acceptance criterion 5): a periodic heartbeat POST per
 * in-flight task, authorized and renewed through the exact same
 * `renewAttemptLease` transition the WebSocket transport's `activityHeartbeat`
 * uses on the server. Each activity gets its own `AbortController`, keyed by
 * `(operationId, attemptToken)` exactly like {@link RemoteWorker}'s, so a
 * server-initiated cancellation — signaled back on the heartbeat response,
 * since this transport has no server-to-worker push channel — aborts only
 * the attempt it names.
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
  /**
   * Keyed by `operationId`, fenced by `attemptToken` (COR-230, acceptance
   * criterion 11) — mirrors `RemoteWorker`'s `#taskAbortControllers` exactly,
   * so a cancellation signal that names an attempt this worker has already
   * completed or superseded matches nothing rather than aborting whatever
   * now runs under that `operationId`.
   */
  #taskAbortControllers: Map<string, { controller: AbortController; attemptToken: string }>;

  constructor(options: LongPollWorkerOptions) {
    this.#options = {
      ...options,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: options.queue ?? DEFAULT_QUEUE,
      pollTimeout: options.pollTimeout ?? DEFAULT_POLL_TIMEOUT,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      disconnectTimeoutMs: options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS,
    };
    this.#running = false;
    this.#inFlight = 0;
    this.#abortController = new AbortController();
    this.#composedInterceptor = buildComposedInterceptor(options.interceptors);
    this.#taskAbortControllers = new Map();
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

  /**
   * Stop polling and wait for in-flight activities to finish, up to
   * {@link LongPollWorkerOptions.disconnectTimeoutMs} (COR-220, bounded
   * drain). Every in-flight `AbortController` is aborted synchronously and
   * immediately — the bound only covers how long this then waits for that
   * cooperative unwind to actually complete before giving up and returning
   * anyway, matching `RemoteWorker`'s identical `disconnectTimeoutMs` bound
   * on the same problem: a non-cooperative activity that ignores its
   * `AbortSignal` must not hold `stop()` open forever.
   */
  async stop(): Promise<void> {
    this.#abortController.abort();
    this.#running = false;
    this.#abortAllTasks();

    const deadline =
      Date.now() + (this.#options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS);
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await sleep(50);
    }
    if (this.#inFlight > 0) {
      console.warn(
        `[weft] LongPollWorker stop() timed out with ${String(this.#inFlight)} activities still in-flight — a non-cooperative activity may be ignoring its AbortSignal`,
      );
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
    this.#abortAllTasks();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Abort every in-flight activity's controller and clear the map. */
  #abortAllTasks(): void {
    for (const { controller } of this.#taskAbortControllers.values()) {
      controller.abort();
    }
    this.#taskAbortControllers.clear();
  }

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

  /** Build the activity-heartbeat URL (COR-230). */
  #buildHeartbeatUrl(): string {
    const queue = this.#options.queue ?? DEFAULT_QUEUE;
    return `${this.#options.serverUrl}/api/v1/tasks/${encodeURIComponent(queue)}/heartbeat`;
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

        const task = (await response.json()) as PolledTask;

        void this.#executeTask(task, resultUrl);
      } catch {
        // Abort errors are expected during shutdown; network errors trigger a backoff
        if (this.#running) {
          await sleep(1000);
        }
      }
    }
  }

  /**
   * Send one activity heartbeat for `task` (COR-230, acceptance criterion 5)
   * and abort `controller` if the response reports the attempt cancelled.
   * Network or non-OK responses are logged and otherwise ignored — a missed
   * heartbeat is retried on the next interval tick, exactly as a dropped
   * WebSocket `activityHeartbeat` frame would be by the next timer fire; it
   * never fails the activity itself.
   */
  async #sendHeartbeat(task: PolledTask, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      const response = await fetch(this.#buildHeartbeatUrl(), {
        method: 'POST',
        headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: task.operationId,
          workerId: task.workerId,
          attemptToken: task.attemptToken,
        }),
        signal: this.#abortController.signal,
      });
      if (!response.ok) return;
      const body = (await response.json()) as { ok?: boolean; cancelled?: boolean };
      if (body.cancelled === true) {
        controller.abort();
      }
    } catch {
      // Best-effort: a missed heartbeat is retried on the next interval tick.
    }
  }

  async #executeTask(task: PolledTask, resultUrl: string): Promise<void> {
    this.#inFlight += 1;

    const taskAbortController = new AbortController();
    this.#taskAbortControllers.set(task.operationId, {
      controller: taskAbortController,
      attemptToken: task.attemptToken,
    });
    const heartbeatTimer = setInterval(
      () => void this.#sendHeartbeat(task, taskAbortController),
      this.#options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );

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
        taskAbortController.signal,
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
        const cancelled = taskAbortController.signal.aborted;
        await fetch(resultUrl, {
          method: 'POST',
          headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationId: task.operationId,
            workerId: task.workerId,
            attemptToken: task.attemptToken,
            ...(cancelled
              ? { status: 'cancelled', cancelled: true, error: 'Task cancelled' }
              : {
                  status: 'failed',
                  error: error instanceof Error ? error.message : String(error),
                }),
          }),
          signal: this.#abortController.signal,
        });
      } catch {
        // Best-effort error reporting; server will eventually time out the task
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.#taskAbortControllers.delete(task.operationId);
      this.#inFlight -= 1;
    }
  }
}
