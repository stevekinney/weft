/**
 * Internal helpers extracted from `serve()` to reduce its cyclomatic complexity.
 * These are implementation details — do not import from outside `src/server/`.
 *
 * @internal
 */

import { decode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import { createMcpSessionManager } from '../mcp/session.ts';
import { createMetricsCollectorExporter, MetricsCollector } from '../observability/metrics.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import { buildTLSOptions, createAuthenticator, validateAuthConfig } from './authentication.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import type { ServeOptions } from './index.ts';
import type { WebSocketData } from './json-rpc-websocket-runtime.ts';
import { closeJsonRpcSessionsForShutdown } from './json-rpc-websocket-runtime.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';
import {
  createServerWebSocketHandlers,
  deriveSupportedOpenApiSecuritySchemes,
  handleServerFetchRequest,
} from './runtime/authentication-bridge.ts';
import type { ServerContext } from './runtime/context.ts';
import {
  registerWorkflowEventLifecycle,
  wireEventBroadcasting,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';
import { stopBunServerForShutdown } from './runtime/stop-server.ts';
import { reconcileOrphanedRecords, scanExpiredTasks } from './runtime/task-reconciliation.ts';
import { publishTokenMessage } from './runtime/websocket-stream.ts';
import { isInflightRecord, withRetry } from './runtime/websocket-worker.ts';
import { TaskQueue } from './task-queue.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reconciliation full-scan runs at this multiple of the visibility poll interval (~60s at default). */
const RECONCILIATION_MULTIPLIER = 12;

/**
 * A mutable holder for the Bun server instance. The `fetch` handler needs to
 * call back into the server (for WebSocket upgrades) but the server isn't
 * created until `Bun.serve()` is called. The holder is populated immediately
 * after `Bun.serve()` returns, before any requests can be handled.
 */
export type ServerHolder = { current: ReturnType<typeof Bun.serve> | null };

/** `ServeOptions` with `prometheusExporter` guaranteed present. */
export type ResolvedServeOptions = ServeOptions & {
  prometheusExporter: NonNullable<ServeOptions['prometheusExporter']>;
};

/**
 * Resolved network parameters plus the TLS config derived from auth options.
 * Extracted so `serve()` does not need ternaries for defaults or TLS.
 */
export type ResolvedNetworkConfig = {
  port: number;
  hostname: string;
  development: boolean;
  tlsOptions: ReturnType<typeof buildTLSOptions>;
  serverOptions: ResolvedServeOptions;
  serverMetricsCollector: MetricsCollector;
};

/**
 * Type for a function that registers a process signal handler. Injectable so
 * tests can intercept signal registration without touching `process.on`.
 */
export type SignalRegistrar = (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves all network configuration defaults and validates the auth config
 * synchronously so misconfigurations fail fast before `Bun.serve()` binds.
 */
export function resolveNetworkConfig(options: ServeOptions): ResolvedNetworkConfig {
  if (options.auth) {
    validateAuthConfig(options.auth);
  }
  const port = options.port ?? 7233;
  const hostname = options.hostname ?? '0.0.0.0';
  const development = options.development ?? false;
  const serverMetricsCollector = new MetricsCollector();
  const prometheusExporter =
    options.prometheusExporter ?? createMetricsCollectorExporter(serverMetricsCollector);
  const serverOptions: ResolvedServeOptions = { ...options, prometheusExporter };
  const tlsOptions = buildTLSOptions(options.auth);
  return { port, hostname, development, tlsOptions, serverOptions, serverMetricsCollector };
}

/**
 * Builds the initial `ServerContext` from resolved options. All mutable state
 * maps and the metrics collector are allocated here so `serve()` stays linear.
 */
export function buildServerContext(
  options: ResolvedServeOptions,
  serverMetricsCollector: MetricsCollector,
): ServerContext {
  const workerRegistry = new WorkerRegistry(
    options.routingPolicy !== undefined ? { policy: options.routingPolicy } : undefined,
  );
  const taskQueue = new TaskQueue(
    options.schedulingPolicy !== undefined
      ? { schedulingPolicy: options.schedulingPolicy }
      : undefined,
  );
  const eventFeedBackend = createEngineEventFeedBackend(options.engine);
  return {
    registry: workerRegistry,
    taskQueue,
    workerSockets: new Map(),
    streamSockets: new Map(),
    workerAffinity: new Map(),
    workflowOperations: new Map(),
    operationToWorkflow: new Map(),
    pendingTimers: new Set(),
    deadlineTracker: new DeadlineTracker(),
    liveOperationRegistry: createLiveOperationRegistry({
      workerRegistry,
      taskQueue,
      metricsCollector: serverMetricsCollector,
    }),
    liveRestBindings: createLiveRestBindings(),
    supportedAuthenticationSchemes: deriveSupportedOpenApiSecuritySchemes(options.auth),
    metricsCollector: serverMetricsCollector,
    eventFeedBackend,
    workflowEventFeed: createWorkflowEventFeed(eventFeedBackend),
    activeJsonRpcSessions: new Set(),
    mcpSessionManager: createMcpSessionManager(options.engine),
    // The authenticator is initialized asynchronously (key import) but the
    // promise is created eagerly and resolved before the first request completes.
    authenticatorPromise: options.auth ? createAuthenticator(options.auth) : null,
    visibilityPollMs: options.visibilityPollIntervalMs ?? 5_000,
    scanRunning: false,
    processingOperations: new Set(),
    reconciliationRunning: false,
  };
}

/**
 * Returns the `fetch` handler for `Bun.serve()`. The handler reads the server
 * instance from `serverHolder.current`, which is populated right after
 * `Bun.serve()` returns. This avoids a circular dependency between the server
 * reference and its own fetch callback.
 */
export function buildFetchHandler(
  serverHolder: ServerHolder,
  context: ServerContext,
  options: ResolvedServeOptions,
): (request: Request) => Promise<Response | undefined> {
  return (request: Request) => {
    const server = serverHolder.current;
    if (server === null) {
      return Promise.resolve(new Response('Server not ready', { status: 503 }));
    }
    return handleServerFetchRequest(server, context, options, request);
  };
}

/**
 * Returns the WebSocket lifecycle callbacks for `Bun.serve()`. Delegates to
 * `createServerWebSocketHandlers` in `authentication-bridge.ts` with the
 * workflow index cleanup callback.
 */
export function buildWebSocketCallbacks(
  context: ServerContext,
  options: ResolvedServeOptions,
  onOperationCleanup: (operationId: string) => void,
): ReturnType<typeof createServerWebSocketHandlers> {
  return createServerWebSocketHandlers(context, options, onOperationCleanup);
}

/**
 * Removes an operationId from the workflow→operations reverse index.
 * Module-scope so it does not contribute to `serve()`'s cyclomatic complexity.
 */
export function cleanupWorkflowIndex(context: ServerContext, operationId: string): void {
  const workflowId = context.operationToWorkflow.get(operationId);
  if (!workflowId) return;
  const opIds = context.workflowOperations.get(workflowId);
  if (opIds) {
    opIds.delete(operationId);
    if (opIds.size === 0) context.workflowOperations.delete(workflowId);
  }
  context.operationToWorkflow.delete(operationId);
}

/**
 * Assembles the `Bun.serve()` options object. Separating this avoids a
 * conditional spread (`...(tlsOptions ? { tls } : {})`) inside `serve()`.
 */
export function buildBunServeConfig(
  port: number,
  hostname: string,
  development: boolean,
  routes: Record<string, unknown>,
  tlsOptions: ReturnType<typeof buildTLSOptions>,
  fetchHandler: (request: Request) => Promise<Response | undefined>,
  websocketCallbacks: ReturnType<typeof createServerWebSocketHandlers>,
): Parameters<typeof Bun.serve<WebSocketData>>[0] {
  const config: Parameters<typeof Bun.serve<WebSocketData>>[0] = {
    port,
    hostname,
    development,
    routes,
    fetch: fetchHandler,
    websocket: websocketCallbacks,
  };
  if (tlsOptions) {
    config.tls = tlsOptions;
  }
  return config;
}

/**
 * Wires event broadcasting from the engine into the Bun server. If wiring
 * throws, the already-listening server is torn down via the stack before the
 * error propagates — preventing a leaked server binding.
 */
export function wireEventBroadcastingWithGuard(
  engine: Engine,
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  stack: AsyncDisposableStack,
): EventBroadcastingHandle {
  try {
    return wireEventBroadcasting(engine, server, {
      publishTokenMessage: (workflowId, sequence, message) => {
        publishTokenMessage(context, workflowId, sequence, message);
      },
    });
  } catch (error) {
    void stack[Symbol.asyncDispose]();
    throw error;
  }
}

/**
 * Registers all `AsyncDisposableStack` entries and periodic intervals for a
 * running server. The stack disposes entries in reverse registration order so
 * the most-recently-registered item is torn down first.
 */
export function registerStackDisposers(
  stack: AsyncDisposableStack,
  context: ServerContext,
  options: ServeOptions,
  server: ReturnType<typeof Bun.serve>,
  broadcastingHandle: EventBroadcastingHandle,
  onOperationCleanup: (operationId: string) => void,
): void {
  // Registered first — disposed last: stop the HTTP server.
  stack.defer(() => stopBunServerForShutdown(server));

  // Registered second — disposed second-to-last.
  stack.defer(broadcastingHandle.dispose);
  stack.defer(() => context.workflowEventFeed.dispose());
  // Registered third — disposed third. Close every active `/jsonrpc` WS session
  // and wait for its subscription pumps to drain before the shared
  // `WorkflowEventFeed` disposes or the server force-closes sockets. Without
  // this, `server.stop(true)` would tear down sockets mid-pump, producing
  // noisy post-dispose callbacks on the engine's listener registry.
  stack.defer(async () => {
    await closeJsonRpcSessionsForShutdown(context.activeJsonRpcSessions);
  });
  stack.defer(() => context.mcpSessionManager[Symbol.asyncDispose]());

  stack.defer(registerWorkflowEventLifecycle(options.engine, context, broadcastingHandle));

  const visibilityPollHandle = setInterval(() => {
    void scanExpiredTasks(context, options, onOperationCleanup);
  }, context.visibilityPollMs);

  // Periodic full-storage reconciliation to catch orphaned inflight records
  // that were never tracked in the heap (e.g., written by another process or
  // left over from a crash). Runs at 12x the visibility poll interval to keep
  // cost low while still providing a safety net.
  const reconciliationIntervalMs = context.visibilityPollMs * RECONCILIATION_MULTIPLIER;
  const reconciliationHandle = setInterval(() => {
    void reconcileOrphanedRecords(context, options, onOperationCleanup);
  }, reconciliationIntervalMs);

  // Registered last — disposed first: clear all intervals and pending timers.
  stack.defer(() => {
    clearInterval(visibilityPollHandle);
    clearInterval(reconciliationHandle);
    context.deadlineTracker.clear();
    // Clear all pending backoff-delay timers to prevent callbacks firing
    // against a stopped server.
    for (const timer of context.pendingTimers) {
      clearTimeout(timer);
    }
    context.pendingTimers.clear();
  });
}

const defaultSignalRegistrar: SignalRegistrar = (signal, handler) => {
  process.on(signal, handler);
};

/**
 * Registers SIGINT and SIGTERM handlers so the server shuts down cleanly on
 * process termination. The `stack` is disposed at most once regardless of
 * how many signals arrive.
 *
 * An optional `signalRegistrar` is accepted for testability — pass your own
 * to capture registrations without touching the global `process` object.
 * This parameter is intentionally not part of the public `ServeOptions` type.
 */
export function wireShutdownHandlers(
  stack: AsyncDisposableStack,
  signalRegistrar: SignalRegistrar = defaultSignalRegistrar,
): void {
  let shutdownTriggered = false;

  const handleSignal = (): void => {
    if (shutdownTriggered) return;
    shutdownTriggered = true;
    void stack[Symbol.asyncDispose]();
  };

  signalRegistrar('SIGINT', handleSignal);
  signalRegistrar('SIGTERM', handleSignal);
}

/**
 * Restores persisted in-flight task records from storage into the in-memory
 * context. Records whose deadline has already elapsed are removed from storage;
 * the engine will retry them on the next dispatch cycle.
 */
export function restoreInflightTasks(context: ServerContext, options: ServeOptions): void {
  void withRetry(async () => {
    for await (const [key, value] of options.engine.storage.scan('op:inflight:')) {
      const decoded = decode(value);
      if (!isInflightRecord(decoded)) {
        console.error(`[weft] Corrupt inflight record at "${key}" during restore — skipping`);
        continue;
      }
      const record = decoded;
      const now = Date.now();
      if (record.deadline <= now) {
        // Expired while the server was down — remove from storage.
        void options.engine.storage.delete(key);
        continue;
      }
      // Still within the visibility window — use remaining time so the
      // deadline matches the original persisted value. Then patch the
      // stored visibilityTimeout to the original value so future heartbeat
      // extensions use the full duration, not the diminished remainder.
      const remaining = record.deadline - now;
      context.registry.assignTask(record.workerId, record.operationId, remaining);
      context.deadlineTracker.add({ operationId: record.operationId, deadline: record.deadline });
      const tracked = context.registry
        .getWorkerTasks(record.workerId)
        .find((t) => t.operationId === record.operationId);
      if (tracked) {
        tracked.visibilityTimeout = record.visibilityTimeout;
      }
      // Rebuild workflow→operations reverse index so WorkflowCancelledEvent
      // can propagate cancels to tasks restored from storage after a restart.
      rebuildWorkflowIndex(context, record.operationId, record.workflowId);
    }
  }, 'restore in-flight tasks from storage').catch((error) => {
    console.error('[weft] Failed to restore in-flight tasks from storage:', error);
  });
}

/**
 * Rebuilds the workflow→operations reverse index for a single restored
 * in-flight record. Only invoked when the record has a `workflowId`.
 */
function rebuildWorkflowIndex(
  context: ServerContext,
  operationId: string,
  workflowId: string | undefined,
): void {
  if (!workflowId) return;
  let opIds = context.workflowOperations.get(workflowId);
  if (!opIds) {
    opIds = new Set();
    context.workflowOperations.set(workflowId, opIds);
  }
  opIds.add(operationId);
  context.operationToWorkflow.set(operationId, workflowId);
}
