/**
 * Internal helpers extracted from `serve()` to reduce its cyclomatic complexity.
 * These are implementation details — do not import from outside `src/server/`.
 *
 * @internal
 */

import { decode } from '../core/codec.ts';
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
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';
import { reconcileOrphanedRecords, scanExpiredTasks } from './runtime/task-reconciliation.ts';
import { isInflightRecord, withRetry } from './runtime/websocket-worker.ts';
import { TaskQueue } from './task-queue.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reconciliation full-scan runs at this multiple of the visibility poll interval (~60s at default). */
const RECONCILIATION_MULTIPLIER = 12;

const DEFAULT_WORKER_RECONNECT_GRACE_PERIOD_MS = 100;
const MAX_WORKER_RECONNECT_GRACE_PERIOD_MS = 5_000;
const AUTHENTICATION_REQUIRED_ENVIRONMENT_VARIABLE = 'WEFT_SERVER_AUTHENTICATION_REQUIRED';
const NO_AUTHENTICATION_WARNING =
  '[weft] WARNING: server started with NO authentication; all non-public operations are publicly accessible. Configure serve({ auth }) to lock down, or set unauthenticatedAccess: "reject" in production to fail closed.';
const NO_AUTHENTICATION_REJECT_ERROR =
  '[weft] Refusing to start server with no authentication. Configure serve({ auth }) or set unauthenticatedAccess: "allow" only for trusted local development.';
const NO_AUTHENTICATION_ENVIRONMENT_ERROR =
  '[weft] Refusing to start server with no authentication because WEFT_SERVER_AUTHENTICATION_REQUIRED requires authentication. Configure serve({ auth }) or unset WEFT_SERVER_AUTHENTICATION_REQUIRED only for trusted local development.';
const TRUTHY_AUTHENTICATION_REQUIREMENT_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSY_AUTHENTICATION_REQUIREMENT_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Clamp a user-supplied `workerReconnectGracePeriodMs` into `[0, 5_000]`.
 * Returns the default when undefined or non-finite.
 */
export function clampWorkerReconnectGracePeriod(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_WORKER_RECONNECT_GRACE_PERIOD_MS;
  }
  if (value < 0) return 0;
  if (value > MAX_WORKER_RECONNECT_GRACE_PERIOD_MS) return MAX_WORKER_RECONNECT_GRACE_PERIOD_MS;
  return Math.floor(value);
}

function authenticationRequiredByEnvironment(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return false;
  const normalizedValue = rawValue.trim().toLowerCase();
  if (normalizedValue === '') return false;
  if (TRUTHY_AUTHENTICATION_REQUIREMENT_VALUES.has(normalizedValue)) return true;
  if (FALSY_AUTHENTICATION_REQUIREMENT_VALUES.has(normalizedValue)) return false;
  throw new Error(
    `[weft] Invalid ${AUTHENTICATION_REQUIRED_ENVIRONMENT_VARIABLE} value "${rawValue}". Use one of: 1, true, yes, on, 0, false, no, off.`,
  );
}

export function assertAuthenticationPosture(
  options: ServeOptions,
  environmentRequirement = Bun.env[AUTHENTICATION_REQUIRED_ENVIRONMENT_VARIABLE],
): void {
  if (options.auth) return;
  const environmentRequiresAuthentication =
    authenticationRequiredByEnvironment(environmentRequirement);
  if (environmentRequiresAuthentication) {
    throw new Error(NO_AUTHENTICATION_ENVIRONMENT_ERROR);
  }
  if (options.unauthenticatedAccess === 'reject') {
    throw new Error(NO_AUTHENTICATION_REJECT_ERROR);
  }
  if (options.unauthenticatedAccess === 'allow') return;
  console.warn(NO_AUTHENTICATION_WARNING);
}

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
  assertAuthenticationPosture(options);
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
    workerReconnectGracePeriodMs: clampWorkerReconnectGracePeriod(
      options.workerReconnectGracePeriodMs,
    ),
    pendingWorkerRequeues: new Map(),
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
 * Registers all `AsyncDisposableStack` entries and periodic intervals for a
 * running server. The stack disposes entries in reverse registration order so
 * the most-recently-registered item is torn down first.
 */
export function registerStackDisposers(
  stack: AsyncDisposableStack,
  context: ServerContext,
  options: ServeOptions,
  broadcastingHandle: EventBroadcastingHandle,
  onOperationCleanup: (operationId: string) => void,
): void {
  // The caller has already registered the server-stop disposer so a failure
  // during broadcasting setup can still release the port. Disposers added here
  // run before it (LIFO).
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
    // Clear any pending worker-reconnect grace timers so they cannot fire
    // against a torn-down registry/storage.
    for (const timer of context.pendingWorkerRequeues.values()) {
      clearTimeout(timer);
    }
    context.pendingWorkerRequeues.clear();
    // Tear down the task queue: clears expiration timers and settles any parked
    // long-poll waiters with null so no timer fires and no poll promise leaks
    // against a stopped server.
    context.taskQueue[Symbol.dispose]();
  });
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
