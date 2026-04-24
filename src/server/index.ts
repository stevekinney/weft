/**
 * Bun.serve() wrapper with WebSocket support, dashboard UI, and clean shutdown.
 *
 * @module server
 */

import type { ServerWebSocket } from 'bun';

import { decode, encode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import {
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AttributesChangedEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  TokenEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from '../core/events.ts';
import { calculateBackoff } from '../core/scheduler.ts';
import type { RetryPolicy } from '../core/types.ts';
import type { MetricsCollector, PrometheusExporter } from '../observability/metrics.ts';
import { KEYS } from '../storage/interface.ts';
import type { RoutingOptions, RoutingPolicy } from '../worker/registry.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import type { AuthConfig, AuthContext, Authenticator } from './authentication.ts';
import { buildTLSOptions, createAuthenticator, validateAuthConfig } from './authentication.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import { authContextToPrincipal, handleRequest } from './handler.ts';
import { handleJsonRpcHttpRequest } from './json-rpc-http.ts';
import { REST_BINDINGS, createLiveOperationRegistry } from './rest-bindings.ts';
import {
  claimNextSequence,
  evictOldestAffinityEntries,
  restoreExtendedDeadlineIfStillActive,
} from './runtime-helpers.ts';
import { parseOptionalSequenceCursor } from './sequence-cursor.ts';
import { TaskQueue, type PendingTask, type SchedulingPolicy } from './task-queue.ts';
import type { InflightRecord, QueuedRecord } from './task-state.ts';
import {
  markQueued,
  transitionInflightToQueued,
  transitionInflightToResolved,
  transitionQueuedToInflight,
} from './task-state.ts';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Type guard for decoded storage records in the inflight state. */
function isInflightRecord(value: unknown): value is InflightRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['operationId'] === 'string' &&
    typeof record['activityName'] === 'string' &&
    typeof record['queue'] === 'string' &&
    typeof record['attempt'] === 'number' &&
    typeof record['visibilityTimeout'] === 'number' &&
    typeof record['workerId'] === 'string' &&
    typeof record['deadline'] === 'number'
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  engine: Engine;
  port?: number;
  hostname?: string;
  /** Enable Bun's development mode (HMR, source maps, detailed errors). */
  development?: boolean;
  /** Dashboard HTML import for Bun's static route handler (e.g., `import dashboard from './index.html'`). */
  dashboard?: unknown;
  /** Authentication configuration. When provided, all non-public endpoints require valid credentials. */
  auth?: AuthConfig;
  /** How often (in ms) the server scans `op:inflight:*` for expired visibility deadlines. Defaults to 5 000. */
  visibilityPollIntervalMs?: number;
  /**
   * Routing policy used by the {@link WorkerRegistry} when dispatching tasks.
   * Defaults to `'least-loaded'`. Set to `'round-robin'` for deterministic
   * rotation across workers.
   *
   * **Note on `'fair-share'`:** fair-share requires a `fairShareKey` to be
   * passed at dispatch time via {@link TaskDispatch.fairShareKey}. `serve()`
   * does not currently derive that key from `ctx.tenant` automatically — call
   * sites must thread it through each `dispatchTask()` call themselves. When
   * the key is omitted on a dispatch, the registry degrades gracefully to
   * least-loaded for that single call.
   */
  routingPolicy?: RoutingPolicy;
  /**
   * Scheduling policy used by the {@link TaskQueue} when ordering pending tasks
   * within a queue. Defaults to `'priority'`.
   */
  schedulingPolicy?: SchedulingPolicy;
  /**
   * Optional {@link PrometheusExporter} that produces the body of `/v1/metrics`.
   * Recommended for projects that source metrics from the OpenTelemetry SDK —
   * e.g. wrap `@opentelemetry/exporter-prometheus` to satisfy the interface.
   * When set, it takes precedence over {@link ServeOptions.metricsCollector}.
   */
  prometheusExporter?: PrometheusExporter;
  /**
   * Optional {@link MetricsCollector} used as the default metrics source for
   * `/v1/metrics` when no `prometheusExporter` is supplied.
   *
   * @deprecated Prefer `prometheusExporter` — wrap your metrics source (OTel
   * or otherwise) in a {@link PrometheusExporter} and pass it there. This
   * field remains for projects still using the legacy `MetricsCollector`
   * path and has lower precedence if both are set.
   */
  metricsCollector?: MetricsCollector;
}

export interface TaskDispatch {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number;
  /** Queue to dispatch the task to. Defaults to `'default'`. */
  queue?: string;
  /** Workflow ID. Required for sticky routing to track worker affinity. */
  workflowId?: string | undefined;
  /** When true, prefer the worker that last handled a task for this workflow. Requires `workflowId`. */
  sticky?: boolean;
  /** Visibility timeout in milliseconds. Defaults to `DEFAULT_VISIBILITY_TIMEOUT` (30 000). */
  visibilityTimeout?: number;
  /** Retry policy governing maxAttempts and backoff between reassignment attempts. */
  retryPolicy?: RetryPolicy;
  /** Propagated interceptor headers (e.g. W3C trace context, auth tokens). */
  headers?: Record<string, string>;
  /** Task priority. Higher values are dequeued first. Agent tasks default to 10. */
  priority?: number;
  /**
   * Partition key for `'fair-share'` routing — typically a tenant or customer
   * id. Ignored by other policies. When omitted under `'fair-share'`, the
   * registry degrades gracefully to `'least-loaded'` for that dispatch.
   */
  fairShareKey?: string;
}

export interface WeftServer extends AsyncDisposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly registry: WorkerRegistry;
  readonly taskQueue: TaskQueue;
  stop(): Promise<void>;
  /** Dispatch a task to the best available worker. Returns true if dispatched. */
  dispatchTask(task: TaskDispatch): Promise<boolean>;
  /** Send a shutdown message to a specific worker and wait for it to disconnect. Returns true if the worker was found. */
  shutdownWorker(workerId: string, options?: { timeoutMs?: number }): Promise<boolean>;
  /** Send a shutdown message to all connected workers and wait for them to disconnect. */
  shutdownAllWorkers(options?: { timeoutMs?: number }): Promise<void>;
  /** Send a cancel message for a specific operation to the worker handling it. Returns true if the worker was found. */
  cancelTask(operationId: string): boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ConnectionType = 'worker' | 'stream' | 'watch' | 'generic';

interface WebSocketData {
  pathname: string;
  connectionType: ConnectionType;
  /** Workflow ID extracted from the URL for stream/watch connections. */
  workflowId?: string;
  /** Optional starting sequence for stream replay. */
  resumeFrom?: number;
  /** Queue name extracted from the URL for worker connections. */
  queue?: string;
  workerId?: string;
  lastDeliveredSequence?: number;
  replayInProgress?: boolean;
  pendingStreamMessages?: Array<{ sequence: number; message: string }>;
}

// ---------------------------------------------------------------------------
// Worker stream helpers
// ---------------------------------------------------------------------------

const WORKER_STREAM_RE = /^\/v1\/tasks\/([\w-]+)\/stream$/;
const WORKFLOW_STREAM_RE = /^\/v1\/workflows\/([^/]+)\/stream$/;
const WORKFLOW_WATCH_RE = /^\/v1\/workflows\/([^/]+)\/watch$/;
const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_RESULT_RE = /^\/v1\/tasks\/([\w-]+)\/result$/;

const MAX_POLL_TIMEOUT = 60_000;
const DEFAULT_POLL_TIMEOUT = 30_000;
const MAX_AFFINITY_ENTRIES = 10_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;
const MIN_VISIBILITY_TIMEOUT = 10;
const MAX_VISIBILITY_TIMEOUT = 3_600_000;
const MAX_WORKER_CONCURRENCY = 1_000;
/** Reconciliation full-scan runs at this multiple of the visibility poll interval (~60s at default). */
const RECONCILIATION_MULTIPLIER = 12;

/**
 * Clamp a visibility timeout to the allowed range.
 *
 * Negative or near-zero values cause immediate expiry, and `Infinity`
 * prevents expiry entirely—both are dangerous. This helper constrains
 * the value to [10 ms, 3 600 000 ms] (10 milliseconds to 1 hour).
 */
function clampVisibilityTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VISIBILITY_TIMEOUT;
  return Math.min(Math.max(value, MIN_VISIBILITY_TIMEOUT), MAX_VISIBILITY_TIMEOUT);
}

/**
 * Retry an async operation with a simple linear backoff.
 *
 * `maxAttempts` controls the total number of tries (including the initial one).
 * The default of `2` means: try once, and if it fails, retry once more.
 *
 * Used for critical fire-and-forget paths (event persistence, inflight
 * restoration) where a single transient failure should not silently lose data.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
      /* c8 ignore start -- retry exhaustion requires forced storage or network failures */
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        console.warn(`[weft] Retrying "${label}" (attempt ${attempt + 1}/${maxAttempts})`);
        // Brief delay before retry — 100 ms × attempt number.
        await Bun.sleep(100 * attempt);
      }
    }
  }
  // All attempts exhausted — throw the last error so callers can handle it.
  throw lastError;
  /* c8 ignore stop */
}

function isWorkerConnection(pathname: string): boolean {
  return WORKER_STREAM_RE.test(pathname);
}

function tryDecodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function parseTaskResultBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Classify a WebSocket request URL and extract relevant parameters. */
function classifyConnection(
  url: URL,
): Pick<WebSocketData, 'connectionType' | 'workflowId' | 'queue'> | null {
  const pathname = url.pathname;
  const streamMatch = WORKFLOW_STREAM_RE.exec(pathname);
  if (streamMatch?.[1]) {
    const workflowId = tryDecodePathComponent(streamMatch[1]);
    return workflowId === null ? null : { connectionType: 'stream', workflowId };
  }

  const watchMatch = WORKFLOW_WATCH_RE.exec(pathname);
  if (watchMatch?.[1]) {
    const workflowId = tryDecodePathComponent(watchMatch[1]);
    return workflowId === null ? null : { connectionType: 'watch', workflowId };
  }

  const workerMatch = WORKER_STREAM_RE.exec(pathname);
  if (workerMatch?.[1]) {
    const queue = tryDecodePathComponent(workerMatch[1]);
    return queue === null ? null : { connectionType: 'worker', queue };
  }

  return { connectionType: 'generic' };
}

function workflowChannelPath(workflowId: string, connectionType: 'watch' | 'stream'): string {
  return `/v1/workflows/${encodeURIComponent(workflowId)}/${connectionType}`;
}

function sendStreamMessage(
  ws: ServerWebSocket<WebSocketData>,
  sequence: number,
  message: string,
): void {
  if (sequence <= (ws.data.lastDeliveredSequence ?? -1)) {
    return;
  }

  ws.send(message);
  ws.data.lastDeliveredSequence = sequence;
}

async function getHighestStoredStreamSequence(
  engine: Engine,
  workflowId: string,
  key: string,
): Promise<number> {
  const prefix = KEYS.streamChunkPrefix(workflowId, key);

  for await (const [storageKey] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
    const sequenceText = storageKey.slice(prefix.length);
    const sequence = Number.parseInt(sequenceText, 10);
    if (Number.isSafeInteger(sequence) && sequence >= 0) {
      return sequence;
    }
  }

  return -1;
}

// ---------------------------------------------------------------------------
// WebSocket event broadcasting
// ---------------------------------------------------------------------------

/**
 * Serialize an engine event to a JSON message for WebSocket clients.
 *
 * The wire format matches the dashboard's `WorkflowEvent` interface:
 * `{ type: string; timestamp: number; data: Record<string, unknown> }`.
 */
function serializeEvent(event: Event): string | null {
  const data: Record<string, unknown> = {};

  // Extract all public properties from the event into the nested data bag
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    // Serialize Error objects to plain strings
    if (value instanceof Error) {
      data[key] = value.message;
    } else {
      data[key] = value;
    }
  }

  const message: { type: string; timestamp: number; data: Record<string, unknown> } = {
    type: event.type,
    timestamp: Date.now(),
    data,
  };

  return JSON.stringify(message);
}

/**
 * Result of wiring up engine-to-WebSocket event broadcasting.
 *
 * - `dispose`: removes all listeners (abort signal). Called on server shutdown.
 * - `cleanupWorkflow`: drops the per-workflow sequence state for the given
 *   workflow id. Should be invoked when a workflow reaches a terminal state
 *   so the bookkeeping maps do not grow unbounded over the server's lifetime.
 */
export interface EventBroadcastingHandle {
  dispose: () => void;
  cleanupWorkflow: (workflowId: string) => void;
}

/**
 * Extract a `workflowId` from a DOM `Event` when the concrete event carries
 * one. All workflow, activity, token, signal, attribute, and update events
 * in `core/events.ts` expose a `workflowId: string` field, but the `Event`
 * base type does not know about it — so a runtime structural check narrows
 * the value before we use it to key bookkeeping maps. Returns `undefined`
 * for events without a string `workflowId` property.
 */
function getWorkflowIdFromEvent(event: Event): string | undefined {
  if (!('workflowId' in event)) return undefined;
  const candidate = (event as { workflowId: unknown }).workflowId;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Attach event listeners to the engine that broadcast events via WebSocket
 * and persist each event to storage so GET /v1/workflows/:id/events returns data.
 * Returns a handle exposing a cleanup function and a per-workflow eviction hook.
 */
export function wireEventBroadcasting(
  engine: Engine,
  server: ReturnType<typeof Bun.serve>,
  options?: {
    publishTokenMessage?: (workflowId: string, sequence: number, message: string) => void;
  },
): EventBroadcastingHandle {
  const controller = new AbortController();
  const { signal } = controller;

  /**
   * Per-workflow monotonic sequence counter for event storage keys.
   *
   * On first access for a given workflow, the counter is initialized from
   * storage by scanning for the highest existing event key. This prevents
   * sequence numbers from resetting to 0 after a server restart, which would
   * silently overwrite previously persisted events.
   */
  const sequenceCounters = new Map<string, number>();
  const sequenceInitPromises = new Map<string, Promise<void>>();
  const tokenSequenceCounters = new Map<string, number>();
  const tokenSequenceInitPromises = new Map<string, Promise<void>>();

  /**
   * Per-workflow serialization chain. Each workflow's events are persisted
   * sequentially by chaining promises—this eliminates the read-modify-write
   * race on `sequenceCounters` without requiring an explicit mutex.
   */
  const sequenceChains = new Map<string, Promise<void>>();

  /** Ensure the sequence counter for a workflow is seeded from storage. */
  function ensureSequenceInitialized(workflowId: string): Promise<void> {
    const existing = sequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = KEYS.eventPrefix(workflowId);
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        // Key format: ev:{workflowId}:{zero-padded sequence}
        const parts = key.split(':');
        const sequencePart = parts[parts.length - 1];
        if (sequencePart !== undefined) {
          highestSequence = parseInt(sequencePart, 10);
        }
      }

      // Start after the highest existing sequence number.
      sequenceCounters.set(workflowId, highestSequence + 1);
    })().catch((error) => {
      // Clear the cached promise so a subsequent event can retry initialization
      // instead of perpetually reusing a rejected promise.
      sequenceInitPromises.delete(workflowId);
      throw error;
    });

    sequenceInitPromises.set(workflowId, promise);
    return promise;
  }

  /** Ensure the token-stream chunk counter is seeded from durable storage. */
  function ensureTokenSequenceInitialized(workflowId: string): Promise<void> {
    const existing = tokenSequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = KEYS.streamChunkPrefix(workflowId, 'tokens');
      let highestSequence = -1;

      for await (const [key] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
        const sequenceText = key.slice(prefix.length);
        const parsedSequence = Number.parseInt(sequenceText, 10);
        if (Number.isSafeInteger(parsedSequence)) {
          highestSequence = parsedSequence;
        }
      }

      tokenSequenceCounters.set(workflowId, highestSequence + 1);
    })().catch((error) => {
      tokenSequenceInitPromises.delete(workflowId);
      throw error;
    });

    tokenSequenceInitPromises.set(workflowId, promise);
    return promise;
  }

  /** Persist an event to storage and publish to WebSocket channels. */
  async function persistAndPublishEvent(
    workflowId: string,
    eventType: string,
    message: string,
  ): Promise<void> {
    await ensureSequenceInitialized(workflowId);

    const parsed = JSON.parse(message) as {
      type: string;
      timestamp: number;
      data: Record<string, unknown>;
    };

    // Claim the sequence number once — outside the retry scope so a
    // failed storage write doesn't consume an additional number.
    const sequence = claimNextSequence(sequenceCounters, workflowId);
    const storageKey = KEYS.event(workflowId, sequence);
    const encoded = encode(parsed);

    await withRetry(
      async () => engine.storage.put(storageKey, encoded),
      `persist event "${eventType}" for workflow "${workflowId}"`,
    );

    // Publish to the workflow's watch channel
    const watchChannel = workflowChannelPath(workflowId, 'watch');
    server.publish(watchChannel, message);

    // For token events, also publish to the stream channel
    if (eventType === TokenEvent.type) {
      const tokenPayload = {
        workflowId:
          typeof parsed.data['workflowId'] === 'string' ? parsed.data['workflowId'] : workflowId,
        token: typeof parsed.data['token'] === 'string' ? parsed.data['token'] : '',
        model: typeof parsed.data['model'] === 'string' ? parsed.data['model'] : '',
      };
      await ensureTokenSequenceInitialized(workflowId);
      const tokenSequence = claimNextSequence(tokenSequenceCounters, workflowId);
      await withRetry(
        async () =>
          engine.storage.put(
            KEYS.streamChunk(workflowId, 'tokens', tokenSequence),
            encode(tokenPayload),
          ),
        `persist token stream chunk for workflow "${workflowId}"`,
      );

      const streamMessage = JSON.stringify({
        ...parsed,
        sequence: tokenSequence,
        data: tokenPayload,
      });
      if (options?.publishTokenMessage) {
        options.publishTokenMessage(workflowId, tokenSequence, streamMessage);
      } else {
        const streamChannel = workflowChannelPath(workflowId, 'stream');
        server.publish(streamChannel, streamMessage);
      }
    }
  }

  const eventTypes = [
    WorkflowStartedEvent.type,
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
    ActivityStartedEvent.type,
    ActivityCompletedEvent.type,
    ActivityFailedEvent.type,
    TokenEvent.type,
    SignalReceivedEvent.type,
    SignalDeliveredEvent.type,
    AttributesChangedEvent.type,
    UpdateReceivedEvent.type,
    UpdateCompletedEvent.type,
  ] as const;

  for (const eventType of eventTypes) {
    engine.addEventListener(
      eventType,
      (event) => {
        const workflowId = getWorkflowIdFromEvent(event);
        if (workflowId === undefined) return;

        const message = serializeEvent(event);
        if (message === null) return;

        // Persist the event to storage for the REST events endpoint.
        // Sequence initialization is async (reads storage on first access per
        // workflow), so chain the persistence behind it. WebSocket publishing
        // is deferred until persistence succeeds so clients never see events
        // that failed to store.
        //
        // Events for the same workflow are serialized through `sequenceChains`
        // to prevent concurrent handlers from racing on `nextSequence`.
        const previousChain = sequenceChains.get(workflowId) ?? Promise.resolve();
        const nextChain = previousChain
          .then(() => persistAndPublishEvent(workflowId, eventType, message))
          /* c8 ignore next 6 -- requires forced event persistence failure */
          .catch((error) => {
            console.error(
              `[weft] Failed to persist event "${eventType}" for workflow "${workflowId}":`,
              error,
            );
          });
        sequenceChains.set(workflowId, nextChain);
        // Cleanup for terminal events lives in a dedicated listener that
        // calls `cleanupWorkflow(workflowId)` — see the consumer of the
        // returned handle in `serve()`. That path handles chain extension
        // (new events arriving after the terminal event) correctly; doing
        // the cleanup inline here would race with it.
      },
      { signal },
    );
  }

  /**
   * Drop the per-workflow bookkeeping for a workflow that has reached a
   * terminal state. Waits for any in-flight persistence on the workflow's
   * serialization chain to settle before removing the entries — otherwise a
   * racing handler could reinsert them via `persistAndPublishEvent`.
   *
   * Concurrency: between capturing `pendingChain` and the `finally` running
   * `drop`, another event for the same workflow could arrive and extend the
   * chain. We drop the entries only once we observe that the chain has not
   * advanced during the await, and otherwise recurse to wait for the new
   * tail. Without this loop, `drop` could fire while a subsequent
   * `persistAndPublishEvent` was still using the counter, producing a
   * "counter accessed before initialization" error on the next event.
   */
  function cleanupWorkflow(workflowId: string): void {
    const pendingChain = sequenceChains.get(workflowId);
    const drop = (): void => {
      sequenceCounters.delete(workflowId);
      sequenceInitPromises.delete(workflowId);
      tokenSequenceCounters.delete(workflowId);
      tokenSequenceInitPromises.delete(workflowId);
      sequenceChains.delete(workflowId);
    };
    if (!pendingChain) {
      drop();
      return;
    }
    void pendingChain.finally(() => {
      // If another event extended the chain while we were awaiting the
      // previous tail, recurse to wait on the new tail.
      if (sequenceChains.get(workflowId) !== pendingChain) {
        cleanupWorkflow(workflowId);
        return;
      }
      drop();
    });
  }

  return {
    dispose: () => controller.abort(),
    cleanupWorkflow,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Start the Weft HTTP + WebSocket server with embedded dashboard. */
export function serve(options: ServeOptions): WeftServer {
  const port = options.port ?? 7233;
  const hostname = options.hostname ?? '0.0.0.0';
  const development = options.development ?? false;

  // Validate auth config synchronously so misconfigurations fail fast.
  if (options.auth) {
    validateAuthConfig(options.auth);
  }

  // The authenticator is initialized asynchronously (key import) but the
  // promise is created eagerly and resolved before the first request completes.
  const authenticatorPromise: Promise<Authenticator> | null = options.auth
    ? createAuthenticator(options.auth)
    : null;

  const tlsOptions = buildTLSOptions(options.auth);

  // The dashboard HTML is passed in via options or loaded dynamically.
  // When available, Bun's static route handler bundles and serves it
  // with HMR in dev mode and cached assets in production mode.
  const dashboard = options.dashboard ?? null;

  const registry = new WorkerRegistry(
    options.routingPolicy !== undefined ? { policy: options.routingPolicy } : undefined,
  );
  const taskQueue = new TaskQueue(
    options.schedulingPolicy !== undefined
      ? { schedulingPolicy: options.schedulingPolicy }
      : undefined,
  );
  const workerSockets = new Map<string, ServerWebSocket<WebSocketData>>();
  const streamSockets = new Map<string, Set<ServerWebSocket<WebSocketData>>>();
  /** Tracks per-workflow worker affinity for sticky routing. Maps workflowId → workerId. */
  const workerAffinity = new Map<string, string>();
  /** Reverse index: workflowId → set of operationIds currently in-flight for that workflow. */
  const workflowOperations = new Map<string, Set<string>>();
  /** Reverse lookup: operationId → workflowId for O(1) cleanup on task completion. */
  const operationToWorkflow = new Map<string, string>();
  /** Tracks pending backoff-delay timers so they can be cleared on shutdown. */
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** In-memory min-heap for inflight task deadlines — avoids full storage scans on each visibility tick. */
  const deadlineTracker = new DeadlineTracker();

  /** Remove an operationId from the workflow→operations reverse index. */
  function cleanupWorkflowIndex(operationId: string): void {
    const workflowId = operationToWorkflow.get(operationId);
    if (workflowId) {
      const opIds = workflowOperations.get(workflowId);
      if (opIds) {
        opIds.delete(operationId);
        if (opIds.size === 0) workflowOperations.delete(workflowId);
      }
      operationToWorkflow.delete(operationId);
    }
  }

  function addStreamSocket(workflowId: string, ws: ServerWebSocket<WebSocketData>): void {
    let sockets = streamSockets.get(workflowId);
    if (!sockets) {
      sockets = new Set();
      streamSockets.set(workflowId, sockets);
    }
    sockets.add(ws);
  }

  function removeStreamSocket(ws: ServerWebSocket<WebSocketData>): void {
    const workflowId = ws.data.workflowId;
    if (!workflowId) return;

    const sockets = streamSockets.get(workflowId);
    if (!sockets) return;

    sockets.delete(ws);
    if (sockets.size === 0) {
      streamSockets.delete(workflowId);
    }
  }

  function flushPendingStreamMessages(ws: ServerWebSocket<WebSocketData>): void {
    const pendingMessages = ws.data.pendingStreamMessages ?? [];
    pendingMessages.sort((left, right) => left.sequence - right.sequence);

    for (const pending of pendingMessages) {
      sendStreamMessage(ws, pending.sequence, pending.message);
    }

    ws.data.pendingStreamMessages = [];
  }

  function publishTokenMessage(workflowId: string, sequence: number, message: string): void {
    const sockets = streamSockets.get(workflowId);
    if (!sockets) return;

    for (const ws of sockets) {
      if (ws.data.replayInProgress) {
        ws.data.pendingStreamMessages ??= [];
        ws.data.pendingStreamMessages.push({ sequence, message });
        continue;
      }

      sendStreamMessage(ws, sequence, message);
    }
  }

  /**
   * Send existing token chunks from storage to a newly
   * connected stream client, so it can catch up on tokens emitted before
   * the connection was established.
   */
  async function replayTokenStream(
    ws: ServerWebSocket<WebSocketData>,
    workflowId: string,
  ): Promise<void> {
    ws.data.lastDeliveredSequence = -1;

    try {
      const requestedResumeFrom = ws.data.resumeFrom;
      const after =
        requestedResumeFrom === undefined
          ? -1
          : Math.min(
              requestedResumeFrom,
              await getHighestStoredStreamSequence(options.engine, workflowId, 'tokens'),
            );
      ws.data.lastDeliveredSequence = after;
      const chunks =
        after >= 0
          ? await options.engine.getStreamChunks(workflowId, 'tokens', { after })
          : await options.engine.getStreamChunks(workflowId, 'tokens');

      for (const chunk of chunks) {
        if (typeof chunk.value !== 'object' || chunk.value === null) {
          continue;
        }

        sendStreamMessage(
          ws,
          chunk.sequence,
          JSON.stringify({
            type: TokenEvent.type,
            timestamp: Date.now(),
            sequence: chunk.sequence,
            data: chunk.value,
          }),
        );
      }
      /* c8 ignore start -- replay failures require injected storage scan faults */
    } catch (error) {
      console.error(`[weft] Failed to replay token stream for workflow "${workflowId}":`, error);
    } finally {
      ws.data.replayInProgress = false;
      flushPendingStreamMessages(ws);
    }
    /* c8 ignore stop */
  }

  /** Schedule a delayed dispatch, tracking the timer for cleanup on shutdown. */
  function scheduleDelayedDispatch(task: TaskDispatch, delay: number): void {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      /* c8 ignore next 3 -- delayed redispatch failure requires injected storage faults */
      void dispatchTaskImpl(task).catch((err) =>
        console.error(`[weft] Delayed redispatch failed for "${task.operationId}":`, err),
      );
    }, delay);
    pendingTimers.add(timer);
  }

  /**
   * Given a persisted inflight record, either permanently fail the task (if
   * retry attempts are exhausted) or transition it back to queued and
   * re-dispatch with backoff. Both the worker-disconnect handler and the
   * visibility-timeout scanner share this logic.
   */
  async function reassignOrExpireTask(operationId: string, record: InflightRecord): Promise<void> {
    const nextAttempt = (record.attempt ?? 1) + 1;
    const policy = record.retryPolicy;

    if (policy && nextAttempt > policy.maxAttempts) {
      await transitionInflightToResolved(options.engine.storage, operationId, 'failed');
      options.engine.dispatchEvent(
        new ActivityFailedEvent(
          record.operationId,
          record.workflowId ?? '',
          record.activityName,
          new Error(
            `Activity "${record.activityName}" exhausted all ${policy.maxAttempts} retry attempts`,
          ),
          record.attempt ?? 1,
        ),
      );
      return;
    }

    const queuedRecord: QueuedRecord = {
      operationId: record.operationId,
      activityName: record.activityName,
      input: record.input,
      queue: record.queue,
      attempt: nextAttempt,
      visibilityTimeout: record.visibilityTimeout,
      retryPolicy: policy,
      queuedAt: Date.now(),
      workflowId: record.workflowId,
    };
    await transitionInflightToQueued(options.engine.storage, operationId, queuedRecord);

    const taskDispatch: TaskDispatch = {
      operationId: record.operationId,
      activityName: record.activityName,
      input: record.input,
      queue: record.queue,
      attempt: nextAttempt,
      visibilityTimeout: record.visibilityTimeout,
      workflowId: record.workflowId,
      ...(policy ? { retryPolicy: policy } : {}),
    };

    if (policy) {
      const delay = calculateBackoff(record.attempt ?? 1, policy);
      scheduleDelayedDispatch(taskDispatch, delay);
    } else {
      /* c8 ignore next 3 -- immediate redispatch failure requires injected storage faults */
      void dispatchTaskImpl(taskDispatch).catch((err) =>
        console.error(`[weft] Redispatch failed for "${record.operationId}":`, err),
      );
    }
  }

  const routes: Record<string, unknown> = {};
  if (dashboard !== null) {
    routes['/ui'] = dashboard;
    routes['/ui/*'] = dashboard;
  }

  // One operation registry per serve() instance — held for the server's
  // lifetime so `executeOperation` sees the same resolution table
  // across requests. Registry contents are immutable after creation,
  // so sharing across concurrent requests is safe.
  const liveOperationRegistry = createLiveOperationRegistry();

  async function authenticateRequest(request: Request): Promise<{
    authContext?: AuthContext;
    response: Response | null;
  }> {
    if (!authenticatorPromise) {
      return { response: null };
    }

    const authenticator = await authenticatorPromise;
    const authResult = await authenticator(request);
    if (authResult.authenticated) {
      if (authResult.method === 'public') {
        return { response: null };
      }

      return {
        authContext: {
          method: authResult.method,
          ...(authResult.claims !== undefined ? { claims: authResult.claims } : {}),
          ...(authResult.principal !== undefined ? { principal: authResult.principal } : {}),
        },
        response: null,
      };
    }

    return {
      response: new Response(JSON.stringify({ error: authResult.error }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        },
      }),
    };
  }

  function createLongPollInflightRecord(queue: string, task: PendingTask): InflightRecord {
    const visibilityTimeout = task.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
    const deadline = Date.now() + visibilityTimeout;

    return {
      operationId: task.operationId,
      workerId: `longpoll-${crypto.randomUUID().slice(0, 8)}`,
      deadline,
      activityName: task.activityName,
      queue,
      input: task.input,
      attempt: task.attempt ?? 1,
      visibilityTimeout,
      retryPolicy: task.retryPolicy,
    };
  }

  function markTaskClaimedByLongPollWorker(queue: string, task: PendingTask): void {
    const inflightRecord = createLongPollInflightRecord(queue, task);
    deadlineTracker.add({
      operationId: task.operationId,
      deadline: inflightRecord.deadline,
    });
    void transitionQueuedToInflight(options.engine.storage, task.operationId, inflightRecord);
  }

  function handleWebSocketUpgrade(request: Request, url: URL): Response | undefined | null {
    if (request.headers.get('upgrade') !== 'websocket') {
      return null;
    }

    const classification = classifyConnection(url);
    if (classification === null) {
      return new Response('Invalid encoded WebSocket path', { status: 400 });
    }

    const resumeFromParam = url.searchParams.get('resumeFrom');
    const resumeFromResult = parseOptionalSequenceCursor(
      resumeFromParam,
      'resumeFrom query parameter',
    );
    if (resumeFromResult.error) {
      return new Response(resumeFromResult.error, { status: 400 });
    }
    const resumeFrom = resumeFromResult.value;

    const upgraded = server.upgrade(request, {
      data: {
        pathname: url.pathname,
        ...classification,
        ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      },
    });
    if (upgraded) {
      return undefined;
    }

    return new Response('WebSocket upgrade failed', { status: 400 });
  }

  async function handleTaskPollRequest(request: Request, url: URL): Promise<Response | null> {
    if (request.method !== 'GET') {
      return null;
    }

    const pollMatch = TASK_POLL_RE.exec(url.pathname);
    if (!pollMatch?.[1]) {
      return null;
    }

    const queue = decodeURIComponent(pollMatch[1]);
    const activities = url.searchParams.getAll('activity');
    if (activities.length === 0) {
      return Response.json(
        { error: 'At least one "activity" query parameter is required' },
        { status: 400 },
      );
    }

    const rawTimeout = url.searchParams.get('timeout');
    const timeout =
      rawTimeout !== null
        ? Math.min(Math.max(0, Number(rawTimeout)), MAX_POLL_TIMEOUT)
        : DEFAULT_POLL_TIMEOUT;

    const task = await taskQueue.poll(queue, activities, timeout);
    if (task !== null) {
      markTaskClaimedByLongPollWorker(queue, task);
      return Response.json(task);
    }

    return new Response(null, { status: 204 });
  }

  async function handleTaskResultRequest(request: Request, url: URL): Promise<Response | null> {
    if (request.method !== 'POST') {
      return null;
    }

    const completeMatch = TASK_RESULT_RE.exec(url.pathname);
    if (!completeMatch?.[1]) {
      return null;
    }

    const body = await parseTaskResultBody(request);
    if (body === null) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const operationId = body['operationId'];
    const status = body['status'];
    if (typeof operationId !== 'string' || typeof status !== 'string') {
      return Response.json(
        { error: 'Missing required fields: operationId, status' },
        { status: 400 },
      );
    }

    if (status !== 'completed' && status !== 'failed') {
      return Response.json({ error: 'status must be "completed" or "failed"' }, { status: 400 });
    }

    taskQueue.complete({
      operationId,
      status,
      value: body['value'],
      error: typeof body['error'] === 'string' ? body['error'] : undefined,
    });

    deadlineTracker.remove(operationId);
    const resolvedStatus = status === 'failed' ? 'failed' : ('completed' as const);
    /* c8 ignore next 8 -- only trips when resolved-state persistence is forced to fail */
    transitionInflightToResolved(options.engine.storage, operationId, resolvedStatus).catch(
      (error) => {
        console.error(
          `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
          error,
        );
      },
    );

    return Response.json({ ok: true });
  }

  const server = Bun.serve<WebSocketData>({
    port,
    hostname,
    development,
    routes,
    ...(tlsOptions ? { tls: tlsOptions } : {}),
    async fetch(request) {
      const url = new URL(request.url);

      const authentication = await authenticateRequest(request);
      if (authentication.response) {
        return authentication.response;
      }

      const websocketResponse = handleWebSocketUpgrade(request, url);
      if (websocketResponse !== null) {
        return websocketResponse;
      }

      const taskPollResponse = await handleTaskPollRequest(request, url);
      if (taskPollResponse !== null) {
        return taskPollResponse;
      }

      const taskResultResponse = await handleTaskResultRequest(request, url);
      if (taskResultResponse !== null) {
        return taskResultResponse;
      }

      // JSON-RPC HTTP endpoint. Claimed here so `handleRequest` doesn't
      // see `/jsonrpc` and return 404 from its REST route table. The
      // adapter enforces method (POST only) and content-type internally.
      if (url.pathname === '/jsonrpc') {
        return handleJsonRpcHttpRequest(request, {
          registry: liveOperationRegistry,
          engine: options.engine,
          principal: authContextToPrincipal(authentication.authContext),
        });
      }

      // API routes via existing platform-agnostic handler. Under
      // `exactOptionalPropertyTypes` we can't spread `undefined` values into
      // an options object whose fields are `T?: U` (not `T?: U | undefined`),
      // so each optional field is attached only when present.
      return handleRequest(request, options.engine, {
        ...(authentication.authContext !== undefined
          ? { authContext: authentication.authContext }
          : {}),
        ...(options.prometheusExporter !== undefined
          ? { prometheusExporter: options.prometheusExporter }
          : {}),
        ...(options.metricsCollector !== undefined
          ? { metricsCollector: options.metricsCollector }
          : {}),
        operationRegistry: liveOperationRegistry,
        restBindings: REST_BINDINGS,
      });
    },
    websocket: {
      open(ws) {
        const { pathname, connectionType, workflowId } = ws.data;
        // Watch and worker sockets ride Bun pub/sub by pathname. Stream
        // sockets do not: `serve()` wires token delivery through
        // `publishTokenMessage()` and the `streamSockets` registry instead,
        // while `wireEventBroadcasting()` retains the `server.publish()`
        // fallback for direct callers that manage subscriptions themselves.
        if (pathname && connectionType !== 'stream') {
          ws.subscribe(pathname);
        }

        // Stream sockets track replay state individually so reconnects can
        // catch up from durable storage without duplicate live tokens.
        if (connectionType === 'stream' && workflowId) {
          ws.data.replayInProgress = true;
          ws.data.pendingStreamMessages = [];
          addStreamSocket(workflowId, ws);
          void replayTokenStream(ws, workflowId);
        }
      },
      message(ws, rawMessage) {
        if (!isWorkerConnection(ws.data.pathname)) return;

        const text =
          typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);

        let parsed: { type: string; [key: string]: unknown };
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }

        switch (parsed.type) {
          case 'register': {
            const rawWorkerId = parsed['workerId'];
            const workerId = typeof rawWorkerId === 'string' ? rawWorkerId : '';
            if (!workerId) return;

            const activities = parsed['activities'];
            const concurrency = parsed['concurrency'];

            // Validate and cap concurrency to prevent a misconfigured client
            // from claiming an unbounded number of task slots.
            const rawConcurrency = typeof concurrency === 'number' ? concurrency : 10;
            const clampedConcurrency = Math.min(
              Math.max(1, Math.floor(rawConcurrency)),
              MAX_WORKER_CONCURRENCY,
            );

            ws.data.workerId = workerId;
            registry.register({
              id: workerId,
              queue: ws.data.queue ?? 'default',
              activities: Array.isArray(activities) ? (activities as string[]) : [],
              concurrency: clampedConcurrency,
            });
            workerSockets.set(workerId, ws);
            break;
          }
          case 'taskResult': {
            const operationId = parsed['operationId'];
            const resultStatus = parsed['status'];
            if (typeof operationId === 'string') {
              // Remove in-flight tracking and decrement the worker's counter.
              registry.completeTask(operationId);
              deadlineTracker.remove(operationId);
              cleanupWorkflowIndex(operationId);

              // Atomically transition inflight → resolved in storage.
              let resolvedStatus: 'completed' | 'failed';
              if (resultStatus === 'completed') {
                resolvedStatus = 'completed';
              } else if (resultStatus === 'failed' || resultStatus === 'cancelled') {
                resolvedStatus = 'failed';
              } else {
                console.warn(
                  `[weft] taskResult for operation "${operationId}" has unexpected status "${String(
                    resultStatus,
                  )}" — treating as failed`,
                );
                resolvedStatus = 'failed';
              }
              transitionInflightToResolved(
                options.engine.storage,
                operationId,
                resolvedStatus,
                /* c8 ignore next 6 -- only trips when resolved-state persistence is forced to fail */
              ).catch((error) => {
                console.error(
                  `[weft] Failed to transition task "${operationId}" to resolved — inflight record may leak:`,
                  error,
                );
              });
            } else {
              // Fallback: decrement counter by worker ID when operationId is missing.
              // This path leaks the inflight tracking record — log a warning.
              const workerId = ws.data.workerId;
              if (workerId) {
                console.warn(
                  `[weft] taskResult from worker "${workerId}" is missing operationId — inflight tracking record will leak`,
                );
                registry.taskCompleted(workerId);
              }
            }
            break;
          }
          case 'heartbeat': {
            const workerId = ws.data.workerId;
            if (workerId) {
              registry.heartbeat(workerId);

              // Extend visibility deadline for all in-flight tasks assigned to this worker.
              for (const task of registry.getWorkerTasks(workerId)) {
                const newDeadline = registry.extendVisibility(
                  task.operationId,
                  task.visibilityTimeout,
                );

                // Update persisted storage record and deadline tracker with
                // the same deadline the registry computed, so all three stay
                // in sync across restarts and visibility scans.
                if (newDeadline !== undefined) {
                  deadlineTracker.remove(task.operationId);
                  deadlineTracker.add({ operationId: task.operationId, deadline: newDeadline });

                  const opId = task.operationId;
                  const heartbeatWorkerId = ws.data.workerId;
                  void withRetry(async () => {
                    // Guard: if the task completed or was reassigned during the async gap,
                    // skip the write to avoid resurrecting or corrupting another worker's record.
                    if (!registry.isAssigned(opId)) return;
                    const currentTask = registry
                      .getWorkerTasks(heartbeatWorkerId ?? '')
                      .find((t) => t.operationId === opId);
                    if (!currentTask) return;

                    const inflightKey = KEYS.operationInflight(opId);
                    const existing = await options.engine.storage.get(inflightKey);
                    if (existing) {
                      const decoded = decode(existing);
                      /* c8 ignore next 5 -- corrupt-record handling is defensive */
                      if (!isInflightRecord(decoded)) {
                        console.error(
                          `[weft] Corrupt inflight record for task "${opId}" during heartbeat — skipping visibility extension`,
                        );
                        return;
                      }
                      const updated = { ...decoded, deadline: newDeadline };
                      await options.engine.storage.put(inflightKey, encode(updated));
                    }
                    /* c8 ignore next 3 -- write-failure handling is defensive */
                  }, `extend visibility for task "${opId}"`).catch((error) => {
                    console.error(`[weft] Failed to extend visibility for task "${opId}":`, error);
                  });
                }
              }
            }
            break;
          }
        }
      },
      close(ws) {
        if (ws.data.connectionType === 'stream') {
          removeStreamSocket(ws);
        }

        const workerId = ws.data.workerId;
        if (workerId) {
          // Fix 2: If the worker already reconnected with a new socket, this close
          // event is for the stale connection — skip cleanup entirely.
          if (workerSockets.get(workerId) !== ws) {
            console.warn(
              `[weft] Ignoring stale socket close for worker "${workerId}" — already reconnected`,
            );
            return;
          }

          // Capture in-flight tasks from the in-memory registry (source of truth)
          // before cleanup so they can be reassigned even if storage hasn't committed yet.
          const inFlightTasks = registry.getWorkerTasks(workerId);

          // Remove in-flight tracking synchronously to allow re-dispatch.
          for (const task of inFlightTasks) {
            registry.completeTask(task.operationId);
            deadlineTracker.remove(task.operationId);
          }

          registry.unregister(workerId);
          workerSockets.delete(workerId);

          // Clean up affinity entries that pointed at this worker.
          for (const [workflowId, affinityWorkerId] of workerAffinity) {
            if (affinityWorkerId === workerId) {
              workerAffinity.delete(workflowId);
            }
          }

          // Clean up workflow→operations reverse index for tasks owned by this worker.
          for (const task of inFlightTasks) {
            cleanupWorkflowIndex(task.operationId);
          }

          // Requeue each in-flight task with incremented attempt, respecting retry policy.
          // The in-memory registry is the source of truth for *which* tasks to reassign.
          // Full task metadata (activityName, input, etc.) is read from storage.
          for (const task of inFlightTasks) {
            void (async () => {
              try {
                const inflightKey = KEYS.operationInflight(task.operationId);
                const existing = await options.engine.storage.get(inflightKey);

                if (existing) {
                  const record = decode(existing);
                  /* c8 ignore next 5 -- corrupt inflight records require inconsistent storage state */
                  if (!isInflightRecord(record)) {
                    console.error(
                      `[weft] Corrupt inflight record for task "${task.operationId}" — skipping reassignment`,
                    );
                    return;
                  }
                  await reassignOrExpireTask(task.operationId, record);
                } else {
                  // Storage write hadn't committed — clean up the key just in case.
                  /* c8 ignore next 4 -- missing inflight records require inconsistent storage state */
                  console.warn(
                    `[weft] No inflight record found in storage for task "${task.operationId}" — skipping reassignment`,
                  );
                  await options.engine.storage.delete(inflightKey);
                }
                /* c8 ignore next 5 -- reassignment failure handling is defensive */
              } catch (error) {
                console.error(
                  `[weft] Failed to reassign task "${task.operationId}" from worker "${workerId}":`,
                  error,
                );
              }
            })();
          }
        }
      },
    },
  });

  // AsyncDisposableStack manages all server resources and disposes them in
  // reverse registration order on shutdown: interval → broadcasting → server.
  const stack = new AsyncDisposableStack();

  // Register the HTTP server first — it is disposed last.
  // Force-close active connections to avoid hanging on drain.
  stack.defer(() => server.stop(true));

  // Wire up engine events → WebSocket broadcasting.
  // If wiring throws after the server is already listening, dispose the
  // stack (which stops the server) before propagating the error.
  let broadcastingHandle: EventBroadcastingHandle;
  try {
    broadcastingHandle = wireEventBroadcasting(options.engine, server, {
      publishTokenMessage,
    });
    /* c8 ignore start -- initialization failure requires injected broadcaster setup faults */
  } catch (error) {
    void stack[Symbol.asyncDispose]();
    throw error;
  }
  /* c8 ignore stop */

  // Registered second — disposed second-to-last.
  stack.defer(broadcastingHandle.dispose);

  // Clean up per-workflow state when workflows reach a terminal state:
  // both the sticky-routing affinity map and the event-broadcasting sequence
  // maps retain entries keyed by workflow id, and neither is bounded by
  // anything other than "workflows observed for the lifetime of the process".
  const affinityController = new AbortController();
  const terminalEventTypes = [
    WorkflowCompletedEvent.type,
    WorkflowFailedEvent.type,
    WorkflowCancelledEvent.type,
    WorkflowTimedOutEvent.type,
  ] as const;

  for (const eventType of terminalEventTypes) {
    options.engine.addEventListener(
      eventType,
      (event) => {
        const workflowId = getWorkflowIdFromEvent(event);
        if (workflowId) {
          workerAffinity.delete(workflowId);
          broadcastingHandle.cleanupWorkflow(workflowId);
        }
      },
      { signal: affinityController.signal },
    );
  }
  stack.defer(() => affinityController.abort());

  // Propagate workflow cancellation to in-flight workers.
  const cancelPropagationController = new AbortController();
  options.engine.addEventListener(
    WorkflowCancelledEvent.type,
    (event) => {
      const workflowId = getWorkflowIdFromEvent(event);
      if (!workflowId) return;

      const operationIds = workflowOperations.get(workflowId);
      if (!operationIds || operationIds.size === 0) return;

      for (const operationId of operationIds) {
        cancelTask(operationId);
        operationToWorkflow.delete(operationId);
      }

      // Clean up the reverse index entry now that all operations are cancelled.
      workflowOperations.delete(workflowId);
    },
    { signal: cancelPropagationController.signal },
  );
  stack.defer(() => cancelPropagationController.abort());

  // Restore persisted in-flight records from storage so visibility timeout
  // tracking survives server restarts. Records whose deadline has already
  // passed are removed from storage (the task will be retried by the engine).
  void withRetry(async () => {
    for await (const [key, value] of options.engine.storage.scan('op:inflight:')) {
      const decoded = decode(value);
      if (!isInflightRecord(decoded)) {
        /* c8 ignore next 2 -- corrupt persisted inflight records are defensive */
        console.error(`[weft] Corrupt inflight record at "${key}" during restore — skipping`);
        continue;
      }
      const record = decoded;
      const now = Date.now();
      if (record.deadline <= now) {
        // Expired while the server was down — remove from storage.
        void options.engine.storage.delete(key);
      } else {
        // Still within the visibility window — use remaining time so the
        // deadline matches the original persisted value. Then patch the
        // stored visibilityTimeout to the original value so future heartbeat
        // extensions use the full duration, not the diminished remainder.
        const remaining = record.deadline - now;
        registry.assignTask(record.workerId, record.operationId, remaining);
        deadlineTracker.add({ operationId: record.operationId, deadline: record.deadline });
        const tracked = registry
          .getWorkerTasks(record.workerId)
          .find((t) => t.operationId === record.operationId);
        if (tracked) {
          tracked.visibilityTimeout = record.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;
        }

        // Rebuild workflow→operations reverse index so WorkflowCancelledEvent
        // can propagate cancels to tasks restored from storage after a restart.
        if (record.workflowId) {
          let opIds = workflowOperations.get(record.workflowId);
          if (!opIds) {
            opIds = new Set();
            workflowOperations.set(record.workflowId, opIds);
          }
          opIds.add(record.operationId);
          operationToWorkflow.set(record.operationId, record.workflowId);
        }
      }
    }
    /* c8 ignore next 2 -- restore failure requires injected storage scan faults */
  }, 'restore in-flight tasks from storage').catch((error) => {
    console.error('[weft] Failed to restore in-flight tasks from storage:', error);
  });

  // ---------------------------------------------------------------------------
  // Visibility timeout expiry scanner
  // ---------------------------------------------------------------------------

  const visibilityPollMs = options.visibilityPollIntervalMs ?? 5_000;
  let scanRunning = false;

  /**
   * Fine-grained mutex over in-flight operation ids shared by both expiry
   * paths. `scanExpiredTasks` (fast path, deadline heap) and
   * `reconcileOrphanedRecords` (slow path, full storage scan) can observe the
   * same expired record and concurrently call `registry.completeTask`,
   * `reassignOrExpireTask`, and dispatch `ActivityFailedEvent`. Both scanners
   * claim the operationId here before processing and release it afterwards so
   * only one path ever acts on a given task at a time.
   */
  const processingOperations = new Set<string>();

  /**
   * Drain expired entries from the in-memory deadline heap and reassign
   * their tasks. Only touches storage for the specific operations whose
   * deadlines have actually passed — no full `op:inflight:*` scan.
   */
  async function scanExpiredTasks(): Promise<void> {
    if (scanRunning) return;
    scanRunning = true;
    try {
      const now = Date.now();
      const expired = deadlineTracker.drainExpired(now);

      for (const { operationId, deadline } of expired) {
        // Skip if the reconciliation scanner (or a previous iteration) is
        // already acting on this operation — re-queue the heap entry so the
        // fast path will revisit it on the next tick once the other worker
        // has released the claim.
        if (processingOperations.has(operationId)) {
          deadlineTracker.add({ operationId, deadline });
          continue;
        }
        processingOperations.add(operationId);
        try {
          const inflightKey = KEYS.operationInflight(operationId);
          const existing = await options.engine.storage.get(inflightKey);

          if (!existing) continue; // Already resolved or requeued by another path.

          const decoded = decode(existing);
          if (!isInflightRecord(decoded)) {
            /* c8 ignore next 2 -- corrupt inflight records are defensive */
            console.error(`[weft] Corrupt inflight record for task "${operationId}" — skipping`);
            continue;
          }

          // Double-check the deadline in case a heartbeat extended it after
          // the entry was added to the heap.
          if (
            restoreExtendedDeadlineIfStillActive(
              deadlineTracker,
              operationId,
              decoded.deadline,
              now,
            )
          ) {
            continue;
          }

          // Expired — remove from registry, clean up workflow index, and reassign or permanently fail.
          registry.completeTask(decoded.operationId);
          cleanupWorkflowIndex(decoded.operationId);
          await reassignOrExpireTask(decoded.operationId, decoded);
          /* c8 ignore next 5 -- retry path requires injected storage or reassignment faults */
        } catch (error) {
          // Re-add to the heap so it will be retried on the next tick
          // instead of waiting for the slower reconciliation scan.
          deadlineTracker.add({ operationId, deadline });
          console.error(
            `[weft] Failed to process expired task "${operationId}" — will retry:`,
            error,
          );
        } finally {
          processingOperations.delete(operationId);
        }
      }
      /* c8 ignore next 2 -- scanner failure requires injected storage scan faults */
    } catch (error) {
      console.error('[weft] Visibility timeout scanner error:', error);
    } finally {
      scanRunning = false;
    }
  }

  const visibilityPollHandle = setInterval(() => {
    void scanExpiredTasks();
  }, visibilityPollMs);

  // Periodic full-storage reconciliation to catch orphaned inflight records
  // that were never tracked in the heap (e.g., written by another process or
  // left over from a crash). Runs at 12x the visibility poll interval to keep
  // cost low while still providing a safety net.
  let reconciliationRunning = false;

  async function reconcileOrphanedRecords(): Promise<void> {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      const now = Date.now();
      for await (const [, value] of options.engine.storage.scan('op:inflight:')) {
        try {
          const decoded = decode(value);
          if (!isInflightRecord(decoded)) continue;

          if (decoded.deadline > now) {
            // Still valid — ensure it is tracked in the heap so the fast path
            // can handle it when it expires. Skip the heap rewrite if another
            // path is currently mid-process on this id — its `finally` block
            // will leave the heap in a consistent state.
            if (processingOperations.has(decoded.operationId)) continue;
            deadlineTracker.remove(decoded.operationId);
            deadlineTracker.add({ operationId: decoded.operationId, deadline: decoded.deadline });
            continue;
          }

          // Expired orphan — claim the id so `scanExpiredTasks` cannot race
          // us on `completeTask`/`reassignOrExpireTask`. If the fast path is
          // already processing it, skip and let the next reconciliation tick
          // revisit any remaining orphans.
          if (processingOperations.has(decoded.operationId)) continue;
          processingOperations.add(decoded.operationId);
          try {
            // Expired orphan — remove from heap, registry, and workflow index, then reassign.
            deadlineTracker.remove(decoded.operationId);
            registry.completeTask(decoded.operationId);
            cleanupWorkflowIndex(decoded.operationId);
            await reassignOrExpireTask(decoded.operationId, decoded);
            /* c8 ignore next 2 -- reconciliation failure handling is defensive */
          } finally {
            processingOperations.delete(decoded.operationId);
          }
        } catch (error) {
          console.error('[weft] Failed to reconcile inflight record — skipping:', error);
        }
      }
      /* c8 ignore next 2 -- reconciliation scan failure requires injected storage faults */
    } catch (error) {
      console.error('[weft] Reconciliation scanner error:', error);
    } finally {
      reconciliationRunning = false;
    }
  }

  const reconciliationIntervalMs = visibilityPollMs * RECONCILIATION_MULTIPLIER;
  const reconciliationHandle = setInterval(() => {
    void reconcileOrphanedRecords();
  }, reconciliationIntervalMs);

  // Registered last — disposed first (reverse order).
  stack.defer(() => {
    clearInterval(visibilityPollHandle);
    clearInterval(reconciliationHandle);
    deadlineTracker.clear();
    // Clear all pending backoff-delay timers to prevent callbacks firing
    // against a stopped server.
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
  });

  function resolveTaskPriority(task: TaskDispatch): number | undefined {
    if (task.priority !== undefined) return task.priority;
    if (task.workflowId && options.engine.isAgentWorkflow(task.workflowId)) return 10;
    return undefined;
  }

  async function dispatchTaskImpl(task: TaskDispatch): Promise<boolean> {
    const queue = task.queue ?? 'default';
    const visibilityTimeout = clampVisibilityTimeout(task.visibilityTimeout);
    const resolvedPriority = resolveTaskPriority(task);

    // Each task assigned to exactly one worker — reject duplicates.
    if (registry.isAssigned(task.operationId) || taskQueue.isTracked(task.operationId)) {
      return false;
    }

    // Resolve sticky preference: look up the last worker for this workflow.
    let stickyWorkerId: string | undefined;
    if (task.sticky && task.workflowId) {
      stickyWorkerId = workerAffinity.get(task.workflowId);
    }

    // Try WebSocket workers first (lowest latency). Build routing options
    // with `exactOptionalPropertyTypes` in mind — only attach optional fields
    // when they are actually defined.
    const routingOptions: RoutingOptions = { queue };
    if (stickyWorkerId !== undefined) {
      routingOptions.sticky = stickyWorkerId;
    }
    if (task.fairShareKey !== undefined) {
      routingOptions.fairShareKey = task.fairShareKey;
    }
    const worker = registry.findWorker(task.activityName, routingOptions);
    if (worker) {
      const ws = workerSockets.get(worker.id);
      if (ws) {
        ws.send(
          JSON.stringify({
            type: 'task',
            operationId: task.operationId,
            activityName: task.activityName,
            input: task.input,
            attempt: task.attempt ?? 1,
            ...(task.headers ? { headers: task.headers } : {}),
          }),
        );
        registry.assignTask(worker.id, task.operationId, visibilityTimeout, task.fairShareKey);

        // Persist in-flight record to storage so it survives server restart.
        // Uses a batch to atomically remove any stale queued record and write the inflight record.
        const deadline = Date.now() + visibilityTimeout;
        deadlineTracker.add({ operationId: task.operationId, deadline });
        const inflightRecord: InflightRecord = {
          operationId: task.operationId,
          workerId: worker.id,
          deadline,
          activityName: task.activityName,
          queue,
          input: task.input,
          attempt: task.attempt ?? 1,
          visibilityTimeout,
          retryPolicy: task.retryPolicy,
          workflowId: task.workflowId,
        };
        await options.engine.storage.batch([
          { type: 'delete', key: KEYS.operationQueued(task.operationId) },
          {
            type: 'put',
            key: KEYS.operationInflight(task.operationId),
            value: encode(inflightRecord),
          },
        ]);

        // Record affinity for future sticky routing (FIFO eviction when over limit).
        if (task.workflowId) {
          workerAffinity.set(task.workflowId, worker.id);
          evictOldestAffinityEntries(workerAffinity, MAX_AFFINITY_ENTRIES);

          // Track operation in the workflow→operations reverse index for cancel propagation.
          let operationIds = workflowOperations.get(task.workflowId);
          if (!operationIds) {
            operationIds = new Set();
            workflowOperations.set(task.workflowId, operationIds);
          }
          operationIds.add(task.operationId);
          operationToWorkflow.set(task.operationId, task.workflowId);
        }

        return true;
      }
    }

    // Fall back to long-poll task queue.
    // Persist the durable queued record BEFORE enqueuing to the in-memory queue.
    // enqueue() may resolve a waiting long-poll request immediately, and the
    // GET handler transitions queued→inflight. If markQueued() ran after enqueue(),
    // it could recreate a stale op:queued:* record after the inflight transition.
    const queuedRecord: QueuedRecord = {
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input,
      queue,
      attempt: task.attempt ?? 1,
      visibilityTimeout,
      retryPolicy: task.retryPolicy,
      queuedAt: Date.now(),
      workflowId: task.workflowId,
    };
    await markQueued(options.engine.storage, queuedRecord);

    // Now enqueue to the in-memory queue. The operationId is tracked immediately,
    // preventing TOCTOU races where a concurrent dispatch could pass the
    // duplicate check during an async gap.
    return taskQueue.enqueue(queue, {
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input,
      attempt: task.attempt ?? 1,
      retryPolicy: task.retryPolicy,
      visibilityTimeout,
      ...(task.headers ? { headers: task.headers } : {}),
      ...(resolvedPriority !== undefined ? { priority: resolvedPriority } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Worker shutdown helpers
  // ---------------------------------------------------------------------------

  const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

  /** Send a cancel message to the worker handling a specific operation. */
  function cancelTask(operationId: string): boolean {
    // O(1) lookup via the registry's in-flight task map.
    const task = registry.getTask(operationId);
    if (!task) return false;

    const ws = workerSockets.get(task.workerId);
    if (!ws) return false;

    ws.send(JSON.stringify({ type: 'cancel', operationId }));
    return true;
  }

  /** Send a shutdown message to a specific worker and wait for it to disconnect. */
  async function shutdownWorker(
    workerId: string,
    shutdownOptions?: { timeoutMs?: number },
  ): Promise<boolean> {
    const ws = workerSockets.get(workerId);
    if (!ws) return false;

    ws.send(JSON.stringify({ type: 'shutdown' }));

    const timeout = shutdownOptions?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    while (workerSockets.has(workerId)) {
      if (Date.now() >= deadline) {
        return true; // We sent the message, but the worker did not disconnect in time.
      }
      await Bun.sleep(50);
    }

    return true;
  }

  /** Send a shutdown message to all connected workers and wait for them to disconnect. */
  async function shutdownAllWorkers(shutdownOptions?: { timeoutMs?: number }): Promise<void> {
    const workerIds = [...workerSockets.keys()];
    await Promise.all(workerIds.map((id) => shutdownWorker(id, shutdownOptions)));
  }

  const resolvedPort = server.port ?? port;
  const resolvedHostname = server.hostname ?? hostname;
  const scheme = tlsOptions ? 'https' : 'http';

  return {
    port: resolvedPort,
    hostname: resolvedHostname,
    url: `${scheme}://${resolvedHostname}:${resolvedPort}`,
    registry,
    taskQueue,
    async stop() {
      await stack[Symbol.asyncDispose]();
    },
    dispatchTask: dispatchTaskImpl,
    shutdownWorker,
    shutdownAllWorkers,
    cancelTask,
    [Symbol.asyncDispose]() {
      return stack[Symbol.asyncDispose]();
    },
  };
}
