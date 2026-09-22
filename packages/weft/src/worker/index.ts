/* oxlint-disable max-lines -- RemoteWorker is a single cohesive WebSocket lifecycle state machine (connect re-entrancy, registration ack, heartbeat, drain/shutdown, task dispatch, and the new result-resend/backpressure recovery) whose transitions all mutate the same private socket/abort/heartbeat/outbox fields; the connection-related fix that pushed it past 500 lines came after extracting every separable concern into siblings (task-result-outbox.ts, activity-table.ts, options.ts incl. buildRegisterMessage); rejected: splitting the lifecycle methods into free functions threading 6+ private fields, which fragments the state machine and harms readability without reducing real complexity. */
// ---------------------------------------------------------------------------
// Remote worker client — connects to the server via WebSocket
// ---------------------------------------------------------------------------

import { sleep } from '../runtime/portable.ts';
import { normalizeWorkerJsonValue, resolveActivityTable } from './activity-table.ts';
import {
  buildComposedInterceptor,
  executeWithInterceptors,
  type ComposedInterceptor,
} from './execute-with-interceptors.ts';
import { HeartbeatManager } from './heartbeat.ts';
import {
  assertManifestMatchesWorkflows,
  buildRegisterMessage,
  snapshotWorkflows,
  type InternalRemoteWorkerOptions,
  type PendingRegistration,
  type RemoteWorkerOptions,
} from './options.ts';
import {
  parseServerToWorkerMessage,
  type ServerToWorkerMessage,
  type TaskMessage,
  type TaskResultMessage,
} from './protocol.ts';
import { MAX_BUFFERED_TASK_RESULTS, TaskResultOutbox } from './task-result-outbox.ts';
import type { RemoteWorkerActivityFunction } from './workflow-activity-binding.ts';

export type { RemoteWorkerOptions } from './options.ts';
export { isOutboxFull, MAX_BUFFERED_TASK_RESULTS } from './task-result-outbox.ts';

export { HeartbeatManager } from './heartbeat.ts';
export { LongPollWorker } from './long-poll.ts';
export type { LongPollWorkerOptions } from './long-poll.ts';
export { WorkerRegistry } from './registry.ts';
export type { InFlightTask, RoutingOptions, WorkerInfo } from './registry.ts';
export type { RemoteActivityContext } from './remote-activity-context.ts';
export {
  buildQualifiedActivityTable,
  type RemoteWorkerActivityFunction,
  type RemoteWorkerActivityImplementation,
  type RemoteWorkerWorkflowDefinition,
} from './workflow-activity-binding.ts';

// ---------------------------------------------------------------------------
// RemoteWorker
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_QUEUE = 'default';
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 30_000;

type BunWebSocketConstructor = {
  new (url: string): WebSocket;
  new (url: string, options: { headers: Record<string, string> }): WebSocket;
};

function createWorkerWebSocket(
  url: string,
  headers: Record<string, string> | undefined,
): WebSocket {
  if (headers === undefined) return new WebSocket(url);

  // Bun supports custom WebSocket upgrade headers; the DOM lib only types the
  // browser constructor overload, so the worker client narrows to Bun's shape
  // at construction time while preserving tests that replace global WebSocket.
  const Constructor = WebSocket as unknown as BunWebSocketConstructor;
  return new Constructor(url, { headers });
}

// The server accepts a worker-stream path with or without the external
// `/api` prefix (authentication-bridge.ts strips `/api` before routing), so
// this must match both forms — otherwise a caller's fully-qualified,
// `/api`-prefixed serverUrl would fail to match, fall through to the
// bare-origin branch below, and silently lose its queue segment and any
// query parameters.
const WORKER_STREAM_PATH_RE = /^(?:\/api)?\/v1\/tasks\/([^/]+)\/stream$/;

// Mirrors the server's own worker-stream route grammar
// (websocket-upgrade.ts's `WORKER_STREAM_RE`: `/^\/v1\/tasks\/([\w-]+)\/stream$/`).
// A queue outside this grammar would still let the client construct and
// connect a WebSocket, but the server would fail to classify the upgrade as
// a worker connection, silently ignore every message the worker sends, and
// leave `connect()` pending forever with no error.
const QUEUE_NAME_RE = /^[\w-]+$/;

function assertValidQueueName(queue: string): void {
  if (!QUEUE_NAME_RE.test(queue)) {
    throw new Error(
      `RemoteWorker queue "${queue}" is not a valid queue name — the server's worker-stream ` +
        `route only accepts word characters and hyphens ([\\w-]+).`,
    );
  }
}

/**
 * Resolve the single WebSocket URL and effective queue this worker connects
 * with, accepting exactly one of two forms:
 *
 *   - A bare server origin plus the `queue` option (or its default), which
 *     this function combines into the canonical `/v1/tasks/{queue}/stream`
 *     endpoint.
 *   - A complete worker-stream `serverUrl` that already encodes a queue, with
 *     no `queue` option — or one that matches the encoded queue exactly. The
 *     encoded path may carry the optional `/api` prefix the server also
 *     accepts.
 *
 * A `serverUrl` that encodes a queue different from an explicitly passed
 * `queue` option throws at construction time: the two configuration sources
 * disagree, and connecting to either silently would mean routing to a queue
 * neither value alone asked for. Either resolved queue is also validated
 * against the server's route grammar, so a malformed queue fails fast here
 * rather than connecting a WebSocket the server can never classify.
 */
function resolveWorkerConnectUrl(
  serverUrl: string,
  explicitQueue: string | undefined,
): { url: string; queue: string } {
  const parsed = new URL(serverUrl);
  const match = WORKER_STREAM_PATH_RE.exec(parsed.pathname);

  if (match !== null) {
    const embeddedQueue = decodeURIComponent(match[1] as string);
    assertValidQueueName(embeddedQueue);
    if (explicitQueue !== undefined && explicitQueue !== embeddedQueue) {
      throw new Error(
        `RemoteWorker serverUrl "${serverUrl}" already encodes queue "${embeddedQueue}", which ` +
          `conflicts with the "queue" option "${explicitQueue}". Pass either a bare server ` +
          `origin with the "queue" option, or a complete worker-stream serverUrl with no ` +
          `"queue" option — not both.`,
      );
    }
    return { url: serverUrl, queue: embeddedQueue };
  }

  const queue = explicitQueue ?? DEFAULT_QUEUE;
  assertValidQueueName(queue);
  const url = new URL(`/v1/tasks/${encodeURIComponent(queue)}/stream`, serverUrl).toString();
  return { url, queue };
}

/**
 * WebSocket-based remote worker that connects to the Weft server and executes
 * activities on behalf of the engine.
 *
 * Construct with the server URL, a map of activity implementations, and optional
 * concurrency and queue settings.  Call `start()` to open the WebSocket
 * connection and begin processing tasks.  Dispose the instance (or call
 * `[Symbol.dispose]()`) to close the connection.
 *
 * @example
 * ```ts
 * import { RemoteWorker } from '@lostgradient/weft';
 *
 * using worker = new RemoteWorker({
 *   serverUrl: 'ws://localhost:3000',
 *   workflows: {
 *     notifications: {
 *       name: 'notifications',
 *       activities: {
 *         sendEmail: async (input: unknown) => {
 *           console.log('sending', input);
 *           return 'sent';
 *         },
 *       },
 *     },
 *   },
 *   concurrency: 5,
 *   queue: 'email',
 *   deploymentName: 'notifications',
 *   buildId: '2026.08.19-1',
 * });
 * await worker.connect();
 * ```
 */
export class RemoteWorker implements Disposable {
  #options: RemoteWorkerOptions;
  /**
   * Resolved at construction time so name-grammar / key-vs-name violations
   * fail fast at the SDK entry instead of mid-dispatch. Keys are qualified
   * activity names (`${workflowType}.${activityName}`) built from `workflows`.
   */
  #activityTable: Record<string, RemoteWorkerActivityFunction>;
  /** Resolved once at construction time by {@link resolveWorkerConnectUrl}. */
  #connectUrl: string;
  #ws: WebSocket | null;
  #inFlight: number;
  #abortController: AbortController;
  #heartbeat: HeartbeatManager;
  #shuttingDown: boolean;
  /**
   * Keyed by `operationId`, but the abort decision is also fenced by
   * `attemptToken` (COR-230, acceptance criterion 11) — a `cancel` control
   * naming an attempt this worker has already superseded (e.g. it completed
   * and was later redispatched the same `operationId` under a fresh
   * attempt) matches nothing and is safely ignored, exactly like the
   * server's own `taskResult`/`activityHeartbeat` attempt-token fencing.
   */
  #taskAbortControllers: Map<string, { controller: AbortController; attemptToken: string }>;
  #composedInterceptor: ComposedInterceptor | null;
  #pendingRegistration: PendingRegistration | null;
  /**
   * Terminal-completion frames produced while the socket was unusable. Flushed
   * on the next `registerAck`; survives across `connect()` calls (the whole
   * point of resend on reconnect) and is cleared only on disposal.
   */
  #taskResultOutbox: TaskResultOutbox;
  /** Set once in `[Symbol.dispose]`. Disposal is terminal: post-dispose `connect()` rejects. */
  #disposed: boolean;
  /** Resolved worker id (provided or generated), stable for the instance lifetime. */
  #workerId: string;
  /**
   * The `sessionGeneration` from the most recent `registerAck` (protocol v6,
   * COR-220), echoed back as `register.resumeSessionGeneration` on the next
   * `connect()` so the server can recognize a reconnect as a PROVEN resume of
   * this exact session rather than a brand new one. Same lifetime rule as
   * `#taskResultOutbox`: survives an involuntary socket loss (the whole point
   * of proving a resume on the automatic or caller-driven reconnect that
   * follows), and is cleared only by a DELIBERATE `disconnect()` or
   * `[Symbol.dispose]()` — at that point this worker is no longer trying to
   * continue any particular session, so a later `connect()` should register
   * fresh, not claim continuity with a session it chose to leave.
   */
  #lastSessionGeneration: number | undefined;

  constructor(options: InternalRemoteWorkerOptions) {
    this.#activityTable = resolveActivityTable(options);
    if (options.manifest !== undefined) {
      assertManifestMatchesWorkflows(options.manifest, options.workflows);
    }
    this.#workerId = options.workerId ?? crypto.randomUUID();
    const resolvedConnection = resolveWorkerConnectUrl(options.serverUrl, options.queue);
    this.#connectUrl = resolvedConnection.url;
    this.#options = {
      ...options,
      // Snapshot so a caller mutating their own `workflows` object after
      // construction cannot desync a future connect()'s advertised manifest
      // from the `#activityTable` built above from the same original shape.
      workflows: snapshotWorkflows(options.workflows),
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      queue: resolvedConnection.queue,
      workerId: this.#workerId,
    };
    this.#ws = null;
    this.#inFlight = 0;
    this.#abortController = new AbortController();
    this.#shuttingDown = false;
    this.#taskAbortControllers = new Map();
    this.#composedInterceptor = buildComposedInterceptor(options.interceptors);
    this.#pendingRegistration = null;
    this.#taskResultOutbox = new TaskResultOutbox(
      options.maxBufferedResults ?? MAX_BUFFERED_TASK_RESULTS,
    );
    this.#disposed = false;
    this.#lastSessionGeneration = undefined;
    this.#heartbeat = new HeartbeatManager(() => {
      this.#sendMessage({ type: 'heartbeat', workerId: this.#workerId });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Connect to the server and start processing tasks. */
  async connect(): Promise<void> {
    // Disposal is terminal: a disposed worker cannot be revived. Reconnection
    // after a graceful stop uses disconnect() + connect(), neither of which
    // sets #disposed.
    if (this.#disposed) {
      throw new Error('RemoteWorker has been disposed and cannot reconnect');
    }

    // Reset shutdown flag so a reconnection after graceful shutdown can
    // accept new tasks (the flag is set by #gracefulShutdown and never
    // cleared elsewhere).
    this.#shuttingDown = false;

    // Re-entrancy guard. A redundant connect() on a healthy, registered worker
    // is a no-op — closing the live socket would force avoidable redelivery of
    // in-flight tasks. Any other state (registration still pending, or a
    // half-open/closing socket) is torn down first so the prior connect()
    // promise is settled and the prior socket + listeners are released.
    if (
      this.#ws !== null &&
      this.#ws.readyState === WebSocket.OPEN &&
      this.#pendingRegistration === null
    ) {
      return;
    }
    this.#teardownActiveConnection('Superseded by a new connect() call');

    return new Promise<void>((resolve, reject) => {
      const ws = createWorkerWebSocket(this.#connectUrl, this.#options.headers);
      // Track the socket immediately (while still CONNECTING) so a re-entrant
      // connect() or a #failSocket() before `open` can close it instead of
      // leaking it. The `connected` getter and #readySocket() already gate on
      // readyState === OPEN, so a CONNECTING socket here is correctly treated as
      // not-yet-usable.
      this.#ws = ws;
      this.#pendingRegistration = { resolve, reject };

      ws.addEventListener(
        'open',
        () => {
          this.#sendMessage(
            buildRegisterMessage(this.#workerId, this.#options, this.#lastSessionGeneration),
          );
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'message',
        (event: MessageEvent) => {
          void this.#handleMessage(event);
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'error',
        () => {
          this.#rejectPendingRegistration('WebSocket connection failed');
        },
        { signal: this.#abortController.signal },
      );

      ws.addEventListener(
        'close',
        () => {
          this.#heartbeat.stop();
          this.#ws = null;
          this.#rejectPendingRegistration('WebSocket closed before worker registration completed');
        },
        { signal: this.#abortController.signal },
      );
    });
  }

  /**
   * Gracefully disconnect: finish in-flight, then close. Resolves with the
   * number of buffered results still awaiting a `taskResultAck` when the
   * disconnect completes — a result whose `taskResult` was sent but never
   * acknowledged (or never buffered onto a live socket at all) survives the
   * disconnect and is resent on the next `connect()`, but the caller learns
   * about it here rather than discovering it silently later.
   */
  async disconnect(): Promise<{ unacknowledgedResults: number }> {
    this.#heartbeat.stop();
    await this.#drainAndClose();
    // Deliberate disconnect — this worker is no longer trying to continue
    // any particular session, so a later connect() registers fresh rather
    // than claiming a resume. See `#lastSessionGeneration`'s doc comment.
    this.#lastSessionGeneration = undefined;
    return { unacknowledgedResults: this.#taskResultOutbox.size };
  }

  /** Get the number of in-flight tasks. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Whether the worker is connected. */
  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Whether the worker is in the process of shutting down. */
  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /**
   * Number of buffered results still awaiting a `taskResultAck`. Zero means
   * every result this worker has produced has been durably acknowledged by
   * the server.
   */
  get unacknowledgedResultCount(): number {
    return this.#taskResultOutbox.size;
  }

  [Symbol.dispose](): void {
    // Disposal is terminal. Mark it before clearing the outbox so an activity
    // that resolves after this point is dropped by #sendTaskResult rather than
    // re-buffering a result disposal is discarding.
    this.#disposed = true;
    this.#taskResultOutbox.clear();
    this.#lastSessionGeneration = undefined;
    this.#abortAllTasks();
    this.#rejectPendingRegistration('Worker disposed before worker registration completed');
    this.#abortController.abort();
    this.#abortController = new AbortController();
    this.#heartbeat.stop();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Abort all in-flight task controllers and clear the map. */
  #abortAllTasks(): void {
    for (const { controller } of this.#taskAbortControllers.values()) {
      controller.abort();
    }
    this.#taskAbortControllers.clear();
  }

  async #gracefulShutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#heartbeat.stop();
    await this.#drainAndClose();
    // Server-initiated shutdown has no caller to hand a result to — unlike
    // disconnect(), which returns the count — so report it the same way the
    // backlog-full and drain-timeout conditions above already do.
    if (this.#taskResultOutbox.size > 0) {
      console.warn(
        `[weft] RemoteWorker shut down with ${this.#taskResultOutbox.size} result(s) still unacknowledged; they will resend on the next connect()`,
      );
    }
  }

  /** Drain in-flight tasks (with timeout), abort listeners, and close the socket. */
  async #drainAndClose(): Promise<void> {
    const timeout = this.#options.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    while (this.#inFlight > 0) {
      if (Date.now() >= deadline) {
        console.warn(
          `[weft] RemoteWorker timed out after ${timeout}ms with ${this.#inFlight} tasks still in-flight`,
        );
        // Abort all remaining in-flight task controllers so activities don't
        // continue running after the worker has disconnected.
        this.#abortAllTasks();
        break;
      }
      await sleep(50);
    }

    // Always abort the old controller to detach event listeners, even if the
    // remote end already closed the connection (which sets #ws to null via the
    // close listener). Then swap to a fresh controller for future connect() calls.
    this.#rejectPendingRegistration('Worker disconnected before worker registration completed');
    const oldAbortController = this.#abortController;
    this.#abortController = new AbortController();
    oldAbortController.abort();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  #parseServerMessage(event: MessageEvent): ServerToWorkerMessage | null {
    let rawData: unknown;
    try {
      rawData = JSON.parse(String(event.data));
    } catch {
      console.warn('[weft] Received non-JSON server message — ignoring');
      return null;
    }

    const parsed = parseServerToWorkerMessage(rawData);
    if (!parsed.ok) {
      if (parsed.error.code === 'unknown_message_type') {
        return null;
      }
      console.warn(`[weft] Received malformed server message: ${parsed.error.message}`);
      return null;
    }

    return parsed.message;
  }

  #handleRegisterAck(sessionGeneration: number): void {
    if (this.#pendingRegistration === null) return;

    // Cache for the NEXT connect() — see `#lastSessionGeneration`'s doc
    // comment for the full lifetime rule (kept across an involuntary drop,
    // cleared only by a deliberate disconnect()/dispose()).
    this.#lastSessionGeneration = sessionGeneration;

    const pending = this.#pendingRegistration;
    // Null the pending registration first so #readySocket() reports ready
    // during the flush below.
    this.#pendingRegistration = null;
    this.#heartbeat.start();

    // Re-send any results buffered while the socket was down. If the flush
    // cannot complete (a send threw and #failSocket() tore the socket down),
    // the connection is no longer usable, so reject this connect() rather than
    // handing the caller a "connected" worker over a dead socket — they will
    // retry connect() and the surviving buffered results flush then.
    if (this.#flushTaskResultOutbox()) {
      pending.resolve();
    } else {
      pending.reject(new Error('reconnect required: result flush failed during registration'));
    }
  }

  #handleRegisterError(message: string): void {
    this.#rejectPendingRegistration(message);
    this.#heartbeat.stop();
    // Close AND null #ws, consistent with every other close site. Leaving a
    // CLOSING socket in #ws lets its later `close` event null out a socket a
    // fast reconnect may have already assigned.
    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  #rejectPendingRegistration(message: string): void {
    if (this.#pendingRegistration === null) return;

    const pending = this.#pendingRegistration;
    this.#pendingRegistration = null;
    pending.reject(new Error(message));
  }

  /**
   * Handle a server `cancel` control (COR-230, acceptance criterion 11).
   * The lookup is fenced by `attemptToken`, not `operationId` alone — a
   * `cancel` for an attempt this worker no longer holds (already completed,
   * or superseded by a later redispatch of the same `operationId`) matches
   * nothing and is ignored rather than aborting whatever now runs under
   * that operationId.
   */
  #handleCancel(operationId: string, attemptToken: string): void {
    const entry = this.#taskAbortControllers.get(operationId);
    if (entry === undefined || entry.attemptToken !== attemptToken) return;
    entry.controller.abort();
  }

  async #handleMessage(event: MessageEvent): Promise<void> {
    const data = this.#parseServerMessage(event);
    if (data === null) return;

    switch (data.type) {
      case 'registerAck':
        this.#handleRegisterAck(data.sessionGeneration);
        break;
      case 'registerError':
        this.#handleRegisterError(data.message);
        break;
      case 'protocolError':
        console.warn(`[weft] RemoteWorker protocol error from server: ${data.message}`);
        break;
      case 'task':
        if (!this.#shuttingDown) await this.#executeTask(data);
        break;
      case 'shutdown':
        void this.#gracefulShutdown();
        break;
      case 'cancel':
        this.#handleCancel(data.operationId, data.attemptToken);
        break;
      case 'taskResultAck':
        // A dead-lettered disposition still drains the outbox entry — the
        // server has made its terminal decision and resending cannot change
        // it — but the activity's outcome never reached the workflow, so say
        // so rather than letting the drop look like a clean `applied` ack.
        if (data.disposition === 'dead-lettered') {
          console.warn(
            `[weft] RemoteWorker result for operation ${data.operationId} (attempt ${data.attemptToken}) was dead-lettered by the server; the activity's outcome was not applied to the workflow`,
          );
        }
        this.#taskResultOutbox.acknowledge(data.operationId, data.attemptToken);
        break;
    }
  }

  async #executeTask(task: TaskMessage): Promise<void> {
    // Backpressure: if unsent results have piled up to the ceiling, decline the
    // task without executing it and without emitting any frame. Failing the
    // socket halts further intake; the server's visibility timeout redelivers
    // the un-acked task later. This bounds memory (the worker stops executing
    // new work once the backlog is full) without ever dropping a completed
    // result.
    if (this.#taskResultOutbox.full) {
      if (this.#taskResultOutbox.shouldWarnFull()) {
        console.warn(
          `[weft] RemoteWorker result buffer full (${this.#taskResultOutbox.size}); declining new tasks until the backlog drains`,
        );
      }
      this.#failSocket();
      return;
    }

    // Echo the per-dispatch attempt token back to the server so it can reject a
    const activityFunction = this.#activityTable[task.activityName];
    if (activityFunction === undefined) {
      this.#sendTaskResult({
        type: 'taskResult',
        operationId: task.operationId,
        status: 'failed',
        error: `Unknown activity: ${task.activityName}`,
        attemptToken: task.attemptToken,
      });
      return;
    }

    const taskAbortController = new AbortController();
    this.#taskAbortControllers.set(task.operationId, {
      controller: taskAbortController,
      attemptToken: task.attemptToken,
    });
    this.#inFlight += 1;

    try {
      const result = await executeWithInterceptors(
        activityFunction,
        task,
        this.#composedInterceptor,
        taskAbortController.signal,
      );

      this.#sendTaskResult({
        type: 'taskResult',
        operationId: task.operationId,
        status: 'completed',
        value: normalizeWorkerJsonValue(result),
        attemptToken: task.attemptToken,
      });
    } catch (error) {
      if (taskAbortController.signal.aborted) {
        this.#sendTaskResult({
          type: 'taskResult',
          operationId: task.operationId,
          status: 'cancelled',
          cancelled: true,
          error: 'Task cancelled',
          attemptToken: task.attemptToken,
        });
      } else {
        this.#sendTaskResult({
          type: 'taskResult',
          operationId: task.operationId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          attemptToken: task.attemptToken,
        });
      }
    } finally {
      this.#taskAbortControllers.delete(task.operationId);
      this.#inFlight -= 1;
    }
  }

  /**
   * The socket a `taskResult` may be sent over right now — open AND already
   * registered — or `null` when no send is permitted. Returning the socket
   * (rather than a boolean) lets callers send without a `?.` that would
   * silently swallow a null `#ws` and drop the result.
   */
  #readySocket(): WebSocket | null {
    if (
      this.#ws !== null &&
      this.#ws.readyState === WebSocket.OPEN &&
      this.#pendingRegistration === null
    ) {
      return this.#ws;
    }
    return null;
  }

  /**
   * Deliver a terminal task result, buffering it in the attempt-keyed outbox
   * first so it survives an ambiguous send (COR-240): `WebSocket.send()`
   * returning proves only that the frame left this process, not that the
   * server received it or that its `taskResultAck` made it back. The entry
   * is buffered unconditionally, before the send is even attempted, and
   * removed only by `#handleMessage`'s `taskResultAck` case — never here,
   * regardless of whether the send below succeeds.
   */
  #sendTaskResult(message: TaskResultMessage): void {
    // An activity that resolves after disposal must not re-populate the outbox
    // that disposal just cleared.
    if (this.#disposed) return;

    this.#taskResultOutbox.buffer(message);

    const socket = this.#readySocket();
    if (socket === null) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The socket died in the gap after the readiness check (a real
      // WebSocket race). The result is already buffered above; fail the
      // socket so the reconnect path re-flushes it.
      this.#failSocket();
    }
  }

  /**
   * Resend every still-unacknowledged buffered result over the
   * (just-registered) socket, in insertion order. Returns `true` if every
   * send was attempted without the socket failing, or the buffer was empty;
   * `false` if a send failed, in which case the socket has been torn down via
   * `#failSocket()` and every buffered result — including ones already sent
   * this pass — stays buffered for the next reconnect, since none of them has
   * been acknowledged yet. Never throws.
   */
  #flushTaskResultOutbox(): boolean {
    for (const message of this.#taskResultOutbox.drainOrder()) {
      const socket = this.#readySocket();
      if (socket === null) {
        this.#failSocket();
        return false;
      }
      try {
        socket.send(JSON.stringify(message));
      } catch {
        this.#failSocket();
        return false;
      }
    }
    return true;
  }

  /**
   * Tear down the current socket from application logic (a send failed or the
   * result backlog is full). Uses the same abort-before-replace discipline as
   * `#teardownActiveConnection` so no late event from the failed socket can
   * mutate worker state, and rejects any still-pending registration so a
   * `connect()` whose socket fails before `registerAck` (e.g. a task that
   * arrives full-buffer before registration completes) settles rather than
   * hanging forever. Does not touch the outbox — buffered results survive.
   */
  #failSocket(): void {
    this.#rejectPendingRegistration(
      'WebSocket failed before worker registration completed; reconnect required',
    );
    const oldAbortController = this.#abortController;
    this.#abortController = new AbortController();
    oldAbortController.abort();
    this.#heartbeat.stop();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  /**
   * Settle and release the in-progress or established connection ahead of a new
   * one. Rejects any pending registration (so a re-entrant connect() never
   * leaves the first caller hanging) and detaches the prior socket's listeners
   * by swapping the abort controller before the new socket attaches its own.
   * Does not touch the outbox — buffered results survive across reconnects.
   */
  #teardownActiveConnection(reason: string): void {
    this.#rejectPendingRegistration(reason);
    this.#heartbeat.stop();

    const oldAbortController = this.#abortController;
    this.#abortController = new AbortController();
    oldAbortController.abort();

    if (this.#ws !== null) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  #sendMessage(message: Record<string, unknown>): void {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }
}
