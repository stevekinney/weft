// ---------------------------------------------------------------------------
// HTTP long-poll fallback worker for environments without WebSocket support
// ---------------------------------------------------------------------------

import type { ActivityInterceptor } from '../core/interceptor.ts';
import { sleep } from '../runtime/portable.ts';
import { normalizeWorkerJsonValue } from './activity-table.ts';
import {
  AttemptControllerTable,
  cancellationErrorMessage,
  DEFAULT_CANCELLED_TASK_ERROR,
} from './attempt-controllers.ts';
import {
  buildComposedInterceptor,
  executeWithInterceptors,
  type ComposedInterceptor,
} from './execute-with-interceptors.ts';
import {
  DEFAULT_RESULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RESULT_RETRY_MAX_DELAY_MS,
  LongPollResultDelivery,
} from './long-poll-result-delivery.ts';
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
  /**
   * Base delay (ms) before the first retry of a result POST that failed
   * (network error) or was transiently rejected (COR-235). Defaults to
   * {@link DEFAULT_RESULT_RETRY_BASE_DELAY_MS}. Exposed for tests that need
   * fast retries — production code should rarely override it.
   */
  resultRetryBaseDelayMs?: number;
  /**
   * Upper bound (ms) the result-retry delay backs off to (COR-235). Defaults
   * to {@link DEFAULT_RESULT_RETRY_MAX_DELAY_MS}.
   */
  resultRetryMaxDelayMs?: number;
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
  /** A PRIOR attempt's recorded heartbeat details (COR-226), when one exists — surfaced to the activity as `context.lastHeartbeatDetails`. */
  lastHeartbeatDetails?: unknown;
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
 * Result delivery is durable (COR-235), through {@link LongPollResultDelivery}
 * — the long-poll counterpart to `RemoteWorker`'s `TaskResultOutbox` +
 * reconnect-flush: a produced result is retained until the server's
 * disposition (`applied`/`duplicate`/`dead-lettered`) is actually read,
 * retried with a capped backoff on network failure or a transient rejection,
 * and dropped only on a correlated permanent rejection (COR-1271). `stop()`
 * suspends retrying (buffered entries survive) and reports how many results
 * are still unacknowledged, exactly like `RemoteWorker.disconnect()`; a later
 * `start()` resumes delivery for anything still buffered. Unlike
 * `RemoteWorker`'s WebSocket outbox, this durability is process-memory only —
 * a process restart loses whatever was still buffered, matching this
 * transport's stateless-HTTP nature (there is no reconnect to resume across).
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
   * Tuple-keyed by `(operationId, attemptToken)` (COR-223) — mirrors
   * `RemoteWorker`'s `#taskAbortControllers` exactly, so a cancellation
   * signal that names an attempt this worker has already completed or
   * superseded matches nothing rather than aborting whatever now runs under
   * that `operationId`, and an earlier attempt's `finally` block can only
   * ever delete its OWN entry — never a later, still-live attempt's
   * controller for the same operation.
   */
  #taskAbortControllers: AttemptControllerTable;
  /**
   * Durable result delivery (COR-235) — the long-poll counterpart to
   * `RemoteWorker`'s `TaskResultOutbox` + reconnect-flush. Constructed once
   * (not per `start()`) so buffered, unacknowledged results survive a
   * `stop()`/`start()` cycle exactly like `RemoteWorker`'s outbox survives a
   * `disconnect()`/`connect()` cycle.
   */
  #delivery: LongPollResultDelivery;

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
    this.#taskAbortControllers = new AttemptControllerTable();
    this.#delivery = new LongPollResultDelivery({
      resultUrl: this.#buildResultUrl(),
      ...(this.#options.headers === undefined ? {} : { headers: this.#options.headers }),
      retryBaseDelayMs: options.resultRetryBaseDelayMs ?? DEFAULT_RESULT_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: options.resultRetryMaxDelayMs ?? DEFAULT_RESULT_RETRY_MAX_DELAY_MS,
    });
  }

  /**
   * Start polling for tasks, and resume delivery of any result still
   * buffered from before a previous `stop()` (COR-235) — mirrors
   * `RemoteWorker.connect()` flushing its outbox on every (re)connect.
   */
  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#abortController = new AbortController();
    this.#delivery.flush();
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
   *
   * Resolves with the number of buffered results still awaiting a durable
   * disposition when the stop completes (COR-235) — mirrors `RemoteWorker.disconnect()`'s
   * identical return shape. Delivery is SUSPENDED (every scheduled retry
   * cancelled) rather than kept running in the background: this worker has
   * no reconnect event of its own to resume on, so a caller that wants those
   * results delivered must call `start()` again, which flushes them.
   */
  async stop(): Promise<{ unacknowledgedResults: number }> {
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

    this.#delivery.suspend();
    const unacknowledgedResults = this.#delivery.unacknowledgedCount;
    if (unacknowledgedResults > 0) {
      console.warn(
        `[weft] LongPollWorker stopped with ${String(unacknowledgedResults)} result(s) still unacknowledged; they will resend on the next start()`,
      );
    }
    return { unacknowledgedResults };
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get running(): boolean {
    return this.#running;
  }

  /**
   * Number of buffered results still awaiting a durable disposition
   * (applied/duplicate/dead-lettered) from the server (COR-235). Zero means
   * every result this worker has produced has been durably resolved.
   */
  get unacknowledgedResultCount(): number {
    return this.#delivery.unacknowledgedCount;
  }

  [Symbol.dispose](): void {
    this.#running = false;
    this.#abortController.abort();
    this.#abortAllTasks();
    this.#delivery.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Abort every in-flight activity's controller and clear the table. */
  #abortAllTasks(): void {
    this.#taskAbortControllers.abortAll();
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

  /**
   * Whether the poll loop should decline to poll for new work right now:
   * either execution is already at `concurrency`, or (COR-235) the
   * result-delivery outbox is full — a worker whose buffered, unacknowledged
   * results have hit `MAX_BUFFERED_TASK_RESULTS` should stop accepting new
   * work rather than piling up results it cannot yet deliver, mirroring
   * `RemoteWorker`'s identical outbox-full backpressure.
   */
  #atCapacity(): boolean {
    if (this.#delivery.full) {
      if (this.#delivery.shouldWarnFull()) {
        console.warn(
          `[weft] LongPollWorker result buffer full (${String(this.#delivery.unacknowledgedCount)}); declining new tasks until the backlog drains`,
        );
      }
      return true;
    }
    return this.#inFlight >= (this.#options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async #pollLoop(): Promise<void> {
    const pollUrl = this.#buildPollUrl();

    while (this.#running && !this.#abortController.signal.aborted) {
      if (this.#atCapacity()) {
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

        void this.#executeTask(task);
      } catch {
        // Abort errors are expected during shutdown; network errors trigger a backoff
        if (this.#running) {
          await sleep(1000);
        }
      }
    }
  }

  /**
   * Send one activity heartbeat for `task` (COR-230, acceptance criterion 5),
   * optionally carrying `details` (COR-226) — used both by the automatic
   * per-attempt keepalive timer (no details) and by an activity's own
   * on-demand `context.heartbeat(details)` call. Aborts the CURRENTLY
   * tracked controller for `(task.operationId, task.attemptToken)` — looked
   * up fresh through `#taskAbortControllers` on every call (COR-223), not a
   * closure-captured reference — if the response reports the attempt
   * cancelled, carrying the server's durably recorded cancellation reason
   * when present. Network or non-OK responses are logged and otherwise
   * ignored — a missed heartbeat is retried on the next interval tick,
   * exactly as a dropped WebSocket `activityHeartbeat` frame would be by the
   * next timer fire; it never fails the activity itself.
   */
  async #sendHeartbeat(task: PolledTask, details?: unknown): Promise<void> {
    const controller = this.#taskAbortControllers.get(task.operationId, task.attemptToken);
    if (controller === undefined || controller.signal.aborted) return;
    const normalizedDetails = details === undefined ? undefined : normalizeWorkerJsonValue(details);
    try {
      const response = await fetch(this.#buildHeartbeatUrl(), {
        method: 'POST',
        headers: { ...this.#options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: task.operationId,
          workerId: task.workerId,
          attemptToken: task.attemptToken,
          ...(normalizedDetails !== undefined ? { details: normalizedDetails } : {}),
        }),
        signal: this.#abortController.signal,
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        ok?: boolean;
        cancelled?: boolean;
        reason?: string;
      };
      if (body.cancelled === true) {
        controller.abort(body.reason ?? DEFAULT_CANCELLED_TASK_ERROR);
      }
    } catch {
      // Best-effort: a missed heartbeat is retried on the next interval tick.
    }
  }

  async #executeTask(task: PolledTask): Promise<void> {
    this.#inFlight += 1;

    const taskAbortController = new AbortController();
    this.#taskAbortControllers.set(task.operationId, task.attemptToken, taskAbortController);
    const heartbeatTimer = setInterval(
      () => void this.#sendHeartbeat(task),
      this.#options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );

    try {
      const activityFunction = this.#options.activities[task.activityName];
      if (activityFunction === undefined) {
        // COR-235: every result — including this one — is durably retained
        // and retried through `#delivery` rather than a single best-effort
        // `fetch()`. `deliver()` buffers synchronously before attempting the
        // first send (so the result cannot be lost even if this call were
        // never awaited) and resolves once that first attempt's round trip
        // completes, matching the pre-COR-235 timing `#inFlight`/heartbeat
        // cleanup below already assumed. Any RETRY beyond this first attempt
        // runs on its own backgrounded timer — the actual fix.
        await this.#delivery.deliver({
          operationId: task.operationId,
          ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
          attemptToken: task.attemptToken,
          status: 'failed',
          error: `Unknown activity: ${task.activityName}`,
        });
        return;
      }

      const result = await executeWithInterceptors(
        activityFunction,
        task,
        this.#composedInterceptor,
        taskAbortController.signal,
        (details) => void this.#sendHeartbeat(task, details),
      );

      await this.#delivery.deliver({
        operationId: task.operationId,
        ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
        attemptToken: task.attemptToken,
        status: 'completed',
        value: result,
      });
    } catch (error) {
      const cancelled = taskAbortController.signal.aborted;
      await this.#delivery.deliver({
        operationId: task.operationId,
        ...(task.workerId === undefined ? {} : { workerId: task.workerId }),
        attemptToken: task.attemptToken,
        ...(cancelled
          ? {
              status: 'cancelled',
              cancelled: true,
              error: cancellationErrorMessage(taskAbortController.signal),
            }
          : {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            }),
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.#taskAbortControllers.delete(task.operationId, task.attemptToken);
      this.#inFlight -= 1;
    }
  }
}
