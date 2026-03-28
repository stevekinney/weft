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
import { KEYS } from '../storage/interface.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import type { AuthConfig, Authenticator } from './authentication.ts';
import { buildTLSOptions, createAuthenticator, validateAuthConfig } from './authentication.ts';
import { handleRequest } from './handler.ts';
import type { TaskResult } from './task-queue.ts';
import { TaskQueue } from './task-queue.ts';

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
}

export interface TaskDispatch {
  operationId: string;
  activityName: string;
  input: unknown;
  attempt?: number;
  /** Queue to dispatch the task to. Defaults to `'default'`. */
  queue?: string;
  /** Workflow ID. Required for sticky routing to track worker affinity. */
  workflowId?: string;
  /** When true, prefer the worker that last handled a task for this workflow. Requires `workflowId`. */
  sticky?: boolean;
  /** Visibility timeout in milliseconds. Defaults to `DEFAULT_VISIBILITY_TIMEOUT` (30 000). */
  visibilityTimeout?: number;
  /** Retry policy governing maxAttempts and backoff between reassignment attempts. */
  retryPolicy?: RetryPolicy;
}

export interface WeftServer extends Disposable {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly registry: WorkerRegistry;
  readonly taskQueue: TaskQueue;
  stop(): void;
  /** Dispatch a task to the best available worker. Returns true if dispatched. */
  dispatchTask(task: TaskDispatch): boolean;
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
  /** Queue name extracted from the URL for worker connections. */
  queue?: string;
  workerId?: string;
}

// ---------------------------------------------------------------------------
// Worker stream helpers
// ---------------------------------------------------------------------------

const WORKER_STREAM_RE = /^\/v1\/tasks\/([\w-]+)\/stream$/;
const WORKFLOW_STREAM_RE = /^\/v1\/workflows\/([\w-]+)\/stream$/;
const WORKFLOW_WATCH_RE = /^\/v1\/workflows\/([\w-]+)\/watch$/;
const TASK_POLL_RE = /^\/v1\/tasks\/([\w-]+)$/;
const TASK_COMPLETE_RE = /^\/v1\/tasks\/([\w-]+)\/complete$/;

const MAX_POLL_TIMEOUT = 60_000;
const DEFAULT_POLL_TIMEOUT = 30_000;
const DEFAULT_VISIBILITY_TIMEOUT = 30_000;

function isWorkerConnection(pathname: string): boolean {
  return WORKER_STREAM_RE.test(pathname);
}

/** Classify a WebSocket pathname and extract relevant parameters. */
function classifyConnection(
  pathname: string,
): Pick<WebSocketData, 'connectionType' | 'workflowId' | 'queue'> {
  const streamMatch = WORKFLOW_STREAM_RE.exec(pathname);
  if (streamMatch?.[1]) {
    return { connectionType: 'stream', workflowId: decodeURIComponent(streamMatch[1]) };
  }

  const watchMatch = WORKFLOW_WATCH_RE.exec(pathname);
  if (watchMatch?.[1]) {
    return { connectionType: 'watch', workflowId: decodeURIComponent(watchMatch[1]) };
  }

  const workerMatch = WORKER_STREAM_RE.exec(pathname);
  if (workerMatch?.[1]) {
    return { connectionType: 'worker', queue: decodeURIComponent(workerMatch[1]) };
  }

  return { connectionType: 'generic' };
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
 * Attach event listeners to the engine that broadcast events via WebSocket
 * and persist each event to storage so GET /v1/workflows/:id/events returns data.
 * Returns a cleanup function that removes all listeners.
 */
function wireEventBroadcasting(engine: Engine, server: ReturnType<typeof Bun.serve>): () => void {
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

  /** Ensure the sequence counter for a workflow is seeded from storage. */
  function ensureSequenceInitialized(workflowId: string): Promise<void> {
    const existing = sequenceInitPromises.get(workflowId);
    if (existing) return existing;

    const promise = (async () => {
      const prefix = `ev:${workflowId}:`;
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

  function nextSequence(workflowId: string): number {
    const current = sequenceCounters.get(workflowId);
    if (current === undefined) {
      throw new Error(
        `Sequence counter for workflow "${workflowId}" accessed before initialization`,
      );
    }
    sequenceCounters.set(workflowId, current + 1);
    return current;
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
        const raw =
          'workflowId' in event ? (event as Record<string, unknown>)['workflowId'] : undefined;
        const workflowId = typeof raw === 'string' ? raw : undefined;
        if (workflowId === undefined) return;

        const message = serializeEvent(event);
        if (message === null) return;

        // Persist the event to storage for the REST events endpoint.
        // Sequence initialization is async (reads storage on first access per
        // workflow), so chain the persistence behind it. WebSocket publishing
        // is deferred until persistence succeeds so clients never see events
        // that failed to store.
        void (async () => {
          try {
            await ensureSequenceInitialized(workflowId);

            const parsed = JSON.parse(message) as {
              type: string;
              timestamp: number;
              data: Record<string, unknown>;
            };
            const sequence = nextSequence(workflowId);
            const storageKey = KEYS.event(workflowId, sequence);
            await engine.storage.put(storageKey, encode(parsed));

            // Publish to the workflow's watch channel
            const watchChannel = `/v1/workflows/${workflowId}/watch`;
            server.publish(watchChannel, message);

            // For token events, also publish to the stream channel
            if (eventType === TokenEvent.type) {
              const streamChannel = `/v1/workflows/${workflowId}/stream`;
              server.publish(streamChannel, message);
            }
          } catch (error) {
            console.error(
              `[weft] Failed to persist event "${eventType}" for workflow "${workflowId}":`,
              error,
            );
          }
        })();
      },
      { signal },
    );
  }

  return () => controller.abort();
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

  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();
  const workerSockets = new Map<string, ServerWebSocket<WebSocketData>>();
  /** Tracks per-workflow worker affinity for sticky routing. Maps workflowId → workerId. */
  const workerAffinity = new Map<string, string>();

  /**
   * Send existing token events from storage as replay messages to a newly
   * connected stream client, so it can catch up on tokens emitted before
   * the connection was established.
   */
  async function replayTokenEvents(
    ws: ServerWebSocket<WebSocketData>,
    workflowId: string,
  ): Promise<void> {
    const prefix = `ev:${workflowId}:`;
    try {
      for await (const [, value] of options.engine.storage.scan(prefix)) {
        const event = decode(value) as { type: string; data: Record<string, unknown> };
        if (event.type !== TokenEvent.type) continue;

        ws.send(
          JSON.stringify({
            type: 'replay',
            timestamp: Date.now(),
            data: event.data,
          }),
        );
      }
    } catch (error) {
      console.error(`[weft] Failed to replay token events for workflow "${workflowId}":`, error);
    }
  }

  const routes: Record<string, unknown> = {};
  if (dashboard !== null) {
    routes['/ui'] = dashboard;
    routes['/ui/*'] = dashboard;
  }

  const server = Bun.serve<WebSocketData>({
    port,
    hostname,
    development,
    routes,
    ...(tlsOptions ? { tls: tlsOptions } : {}),
    async fetch(request) {
      const url = new URL(request.url);

      // Authenticate all requests (HTTP and WebSocket upgrades) when auth is configured.
      if (authenticatorPromise) {
        const authenticator = await authenticatorPromise;
        const authResult = await authenticator(request);
        if (!authResult.authenticated) {
          return new Response(JSON.stringify({ error: authResult.error }), {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': 'Bearer',
            },
          });
        }
      }

      // WebSocket upgrade
      if (request.headers.get('upgrade') === 'websocket') {
        const classification = classifyConnection(url.pathname);
        const upgraded = server.upgrade(request, {
          data: { pathname: url.pathname, ...classification },
        });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // Long-poll task endpoints (handled here because they need task queue access)
      if (request.method === 'GET') {
        const pollMatch = TASK_POLL_RE.exec(url.pathname);
        if (pollMatch?.[1]) {
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
          return Response.json(task);
        }
      }

      if (request.method === 'POST') {
        const completeMatch = TASK_COMPLETE_RE.exec(url.pathname);
        if (completeMatch?.[1]) {
          let body: Record<string, unknown>;
          try {
            body = (await request.json()) as Record<string, unknown>;
          } catch {
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

          taskQueue.complete({
            operationId,
            status: status as TaskResult['status'],
            value: body['value'],
            error: typeof body['error'] === 'string' ? body['error'] : undefined,
          });

          return Response.json({ ok: true });
        }
      }

      // API routes via existing platform-agnostic handler
      return handleRequest(request, options.engine);
    },
    websocket: {
      open(ws) {
        const { pathname, connectionType, workflowId } = ws.data;
        if (pathname) {
          ws.subscribe(pathname);
        }

        // For stream connections, replay existing token events from storage
        if (connectionType === 'stream' && workflowId) {
          void replayTokenEvents(ws, workflowId);
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

            ws.data.workerId = workerId;
            registry.register({
              id: workerId,
              queue: ws.data.queue ?? 'default',
              activities: Array.isArray(activities) ? (activities as string[]) : [],
              concurrency: typeof concurrency === 'number' ? concurrency : 10,
            });
            workerSockets.set(workerId, ws);
            break;
          }
          case 'taskResult': {
            const operationId = parsed['operationId'];
            if (typeof operationId === 'string') {
              // Remove in-flight tracking and decrement the worker's counter.
              registry.completeTask(operationId);
              // Remove persisted in-flight record from storage.
              void options.engine.storage.delete(KEYS.operationInflight(operationId));
            } else {
              // Fallback: decrement counter by worker ID when operationId is missing.
              const workerId = ws.data.workerId;
              if (workerId) {
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
                registry.extendVisibility(task.operationId, task.visibilityTimeout);

                // Update persisted storage record with the new deadline.
                void (async () => {
                  const inflightKey = KEYS.operationInflight(task.operationId);
                  const existing = await options.engine.storage.get(inflightKey);
                  if (existing) {
                    const record = decode(existing) as Record<string, unknown>;
                    record['deadline'] = Date.now() + task.visibilityTimeout;
                    await options.engine.storage.put(inflightKey, encode(record));
                  }
                })();
              }
            }
            break;
          }
        }
      },
      close(ws) {
        const workerId = ws.data.workerId;
        if (workerId) {
          // Capture in-flight tasks before cleanup so they can be reassigned.
          const inFlightTasks = registry.getWorkerTasks(workerId);

          // Remove in-flight tracking synchronously to allow re-dispatch.
          for (const task of inFlightTasks) {
            registry.completeTask(task.operationId);
          }

          registry.unregister(workerId);
          workerSockets.delete(workerId);

          // Requeue each in-flight task with incremented attempt, respecting retry policy.
          for (const task of inFlightTasks) {
            void (async () => {
              try {
                const inflightKey = KEYS.operationInflight(task.operationId);
                const existing = await options.engine.storage.get(inflightKey);
                await options.engine.storage.delete(inflightKey);

                if (existing) {
                  const record = decode(existing) as {
                    operationId: string;
                    activityName: string;
                    input: unknown;
                    queue: string;
                    attempt: number;
                    visibilityTimeout: number;
                    retryPolicy?: RetryPolicy;
                  };

                  const nextAttempt = (record.attempt ?? 1) + 1;
                  const policy = record.retryPolicy;

                  // Check maxAttempts — if exceeded, the task permanently fails (no re-dispatch).
                  if (policy && nextAttempt > policy.maxAttempts) {
                    return;
                  }

                  const taskDispatch: TaskDispatch = {
                    operationId: record.operationId,
                    activityName: record.activityName,
                    input: record.input,
                    queue: record.queue,
                    attempt: nextAttempt,
                    visibilityTimeout: record.visibilityTimeout,
                    ...(policy ? { retryPolicy: policy } : {}),
                  };

                  // Apply backoff delay before re-dispatching.
                  if (policy) {
                    const delay = calculateBackoff(record.attempt ?? 1, policy);
                    setTimeout(() => dispatchTaskImpl(taskDispatch), delay);
                  } else {
                    dispatchTaskImpl(taskDispatch);
                  }
                }
              } catch (error) {
                console.error(
                  `[weft] Failed to reassign task "${task.operationId}" after worker "${workerId}" disconnected:`,
                  error,
                );
              }
            })();
          }
        }
      },
    },
  });

  // Wire up engine events → WebSocket broadcasting.
  // If wiring throws after the server is already listening, clean up both
  // the server and listeners before propagating the error.
  let cleanupBroadcasting: () => void;
  try {
    cleanupBroadcasting = wireEventBroadcasting(options.engine, server);
  } catch (error) {
    void server.stop();
    throw error;
  }

  // Restore persisted in-flight records from storage so visibility timeout
  // tracking survives server restarts. Records whose deadline has already
  // passed are removed from storage (the task will be retried by the engine).
  void (async () => {
    try {
      for await (const [key, value] of options.engine.storage.scan('op:inflight:')) {
        const record = decode(value) as {
          operationId: string;
          workerId: string;
          deadline: number;
          visibilityTimeout?: number;
        };
        const now = Date.now();
        if (record.deadline <= now) {
          // Expired while the server was down — remove from storage.
          void options.engine.storage.delete(key);
        } else {
          // Still within the visibility window — seed the registry with the
          // remaining time so `checkExpiredTasks` can track it.
          const remaining = record.deadline - now;
          registry.assignTask(record.workerId, record.operationId, remaining);
        }
      }
    } catch (error) {
      console.error('[weft] Failed to restore in-flight tasks from storage:', error);
    }
  })();

  // ---------------------------------------------------------------------------
  // Visibility timeout expiry scanner
  // ---------------------------------------------------------------------------

  const visibilityPollMs = options.visibilityPollIntervalMs ?? 5_000;

  /** Scan `op:inflight:*` in storage for expired deadlines and reassign tasks. */
  async function scanExpiredTasks(): Promise<void> {
    try {
      const now = Date.now();

      for await (const [key, value] of options.engine.storage.scan('op:inflight:')) {
        const record = decode(value) as {
          operationId: string;
          workerId: string;
          deadline: number;
          activityName: string;
          queue: string;
          input: unknown;
          attempt: number;
          visibilityTimeout: number;
          retryPolicy?: RetryPolicy;
        };

        if (record.deadline > now) continue;

        // Expired — remove from registry and storage.
        registry.completeTask(record.operationId);
        await options.engine.storage.delete(key);

        const nextAttempt = (record.attempt ?? 1) + 1;
        const policy = record.retryPolicy;

        // Check maxAttempts — if exceeded, the task permanently fails (no re-dispatch).
        if (policy && nextAttempt > policy.maxAttempts) {
          continue;
        }

        const taskDispatch: TaskDispatch = {
          operationId: record.operationId,
          activityName: record.activityName,
          input: record.input,
          queue: record.queue,
          attempt: nextAttempt,
          visibilityTimeout: record.visibilityTimeout,
          ...(policy ? { retryPolicy: policy } : {}),
        };

        // Apply backoff delay before re-dispatching.
        if (policy) {
          const delay = calculateBackoff(record.attempt ?? 1, policy);
          setTimeout(() => dispatchTaskImpl(taskDispatch), delay);
        } else {
          dispatchTaskImpl(taskDispatch);
        }
      }
    } catch (error) {
      console.error('[weft] Visibility timeout scanner error:', error);
    }
  }

  const visibilityPollHandle = setInterval(() => {
    void scanExpiredTasks();
  }, visibilityPollMs);

  function dispatchTaskImpl(task: TaskDispatch): boolean {
    const queue = task.queue ?? 'default';
    const visibilityTimeout = task.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT;

    // Each task assigned to exactly one worker — reject duplicates.
    if (registry.isAssigned(task.operationId) || taskQueue.isTracked(task.operationId)) {
      return false;
    }

    // Resolve sticky preference: look up the last worker for this workflow.
    let stickyWorkerId: string | undefined;
    if (task.sticky && task.workflowId) {
      stickyWorkerId = workerAffinity.get(task.workflowId);
    }

    // Try WebSocket workers first (lowest latency)
    const routingOptions =
      stickyWorkerId !== undefined ? { queue, sticky: stickyWorkerId } : { queue };
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
          }),
        );
        registry.assignTask(worker.id, task.operationId, visibilityTimeout);

        // Persist in-flight record to storage so it survives server restart.
        const deadline = Date.now() + visibilityTimeout;
        const inflightKey = KEYS.operationInflight(task.operationId);
        const inflightRecord = {
          operationId: task.operationId,
          workerId: worker.id,
          deadline,
          activityName: task.activityName,
          queue,
          input: task.input,
          attempt: task.attempt ?? 1,
          visibilityTimeout,
          retryPolicy: task.retryPolicy,
        };
        void options.engine.storage.put(inflightKey, encode(inflightRecord));

        // Record affinity for future sticky routing.
        if (task.workflowId) {
          workerAffinity.set(task.workflowId, worker.id);
        }

        return true;
      }
    }

    // Fall back to long-poll task queue
    return taskQueue.enqueue(queue, {
      operationId: task.operationId,
      activityName: task.activityName,
      input: task.input,
      attempt: task.attempt,
    });
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
    stop() {
      clearInterval(visibilityPollHandle);
      cleanupBroadcasting();
      void server.stop();
    },
    dispatchTask: dispatchTaskImpl,
    [Symbol.dispose]() {
      clearInterval(visibilityPollHandle);
      cleanupBroadcasting();
      void server.stop();
    },
  };
}
