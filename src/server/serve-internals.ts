/**
 * Internal helpers extracted from `serve()` to reduce its cyclomatic complexity.
 * These are implementation details — do not import from outside `src/server/`.
 *
 * @internal
 */

import { decode } from '../core/codec.ts';
import type { Engine } from '../core/engine.ts';
import { getEnginePayloadSizeMaxBytes } from '../core/engine/payload-size-policy.ts';
import { createMcpSessionManager } from '../mcp/session.ts';
import { createMetricsCollectorExporter, MetricsCollector } from '../observability/metrics.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import {
  buildTLSOptions,
  createAuthenticator,
  createRateLimiter,
  validateAuthConfig,
  validateRateLimitConfig,
} from './authentication.ts';
import { DeadlineTracker } from './deadline-tracker.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import { createFleetEventFeed } from './fleet-event-feed.ts';
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
import { resolveCorsPolicy, validateCorsOptions } from './runtime/cors.ts';
import {
  registerWorkflowEventLifecycle,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';
import { shutdownAllWorkers } from './runtime/shutdown.ts';
import { reconcileOrphanedRecords, scanExpiredTasks } from './runtime/task-reconciliation.ts';
import { DEFAULT_MAX_STREAM_CONNECTIONS_PER_WORKFLOW } from './runtime/websocket-stream.ts';
import { isInflightRecord, withRetry } from './runtime/websocket-worker.ts';
import { TaskQueue } from './task-queue.ts';
import { createWorkflowEventFeed } from './workflow-event-feed.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reconciliation full-scan runs at this multiple of the visibility poll interval (~60s at default). */
const RECONCILIATION_MULTIPLIER = 12;

const DEFAULT_WORKER_RECONNECT_GRACE_PERIOD_MS = 2_000;
const MAX_WORKER_RECONNECT_GRACE_PERIOD_MS = 5_000;

/**
 * Hard ceiling on the raw WebSocket frame size for every connection (worker
 * stream, `/watch`, token `/stream`, and JSON-RPC). Bun's default is 16 MiB;
 * this caps the frame at the transport layer before any JSON parse, so a
 * malicious peer cannot force a 16 MiB parse per message. A bounded 4 MiB parse
 * is not a CPU-burn, so this constant ceiling fully closes the DoS on its own.
 *
 * This is deliberately NOT derived from `payloadSize.maxBytes`. That option is
 * an application-level admission policy measured on the codec-encoded (msgpack)
 * byte length of the bare value, whereas `maxPayloadLength` bounds the raw
 * UTF-8 JSON frame (envelope plus JSON-serialized value) — different units.
 * Tightening the frame limit down to a smaller `payloadSize.maxBytes` would
 * reject legitimate frames whose value is within the admission cap (JSON and
 * envelope overhead inflate the frame past the msgpack value size) with an
 * opaque transport close instead of a clean `PayloadSizeExceededError`, across
 * every shared WebSocket endpoint — for no additional DoS protection. Value
 * size stays enforced by the post-parse admission check.
 *
 * @internal Exported only for test assertions.
 */
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024; // 4 MiB
const AUTHENTICATION_REQUIRED_ENVIRONMENT_VARIABLE = 'WEFT_SERVER_AUTHENTICATION_REQUIRED';
/**
 * @internal
 *
 * Warning emitted when a server starts with no authentication and no explicit
 * `unauthenticatedAccess` policy. Exported only for internal tests (see
 * `tests/auth-warning-filter.test.ts`) and not part of the public API surface.
 */
export const NO_AUTHENTICATION_WARNING =
  '[weft] WARNING: server started with NO authentication; all non-public operations are publicly accessible. Configure serve({ auth }) to lock down, or set unauthenticatedAccess: "reject" in production to fail closed.';
export const MCP_ORIGIN_CONFIGURATION_WARNING =
  '[weft] WARNING: MCP HTTP transport is enabled without publicOrigin or trustedHosts. Cross-origin /mcp requests are rejected, and discovery routes that emit absolute URLs return 503. Configure serve({ publicOrigin: "https://api.example.com" }) or serve({ trustedHosts: ["api.example.com"] }) before exposing the server through a browser or reverse proxy.';
const NO_AUTHENTICATION_REJECT_ERROR =
  '[weft] Refusing to start server with no authentication. Configure serve({ auth }) or set unauthenticatedAccess: "allow" only for trusted local development.';
const NO_AUTHENTICATION_ENVIRONMENT_ERROR =
  '[weft] Refusing to start server with no authentication because WEFT_SERVER_AUTHENTICATION_REQUIRED requires authentication. Configure serve({ auth }) or unset WEFT_SERVER_AUTHENTICATION_REQUIRED only for trusted local development.';
const TRUTHY_AUTHENTICATION_REQUIREMENT_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSY_AUTHENTICATION_REQUIREMENT_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Clamp a user-supplied `workerReconnectGracePeriodMs` into `[0, 5_000]`.
 * Returns the 2000ms default when undefined or non-finite.
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

export function warnIfMcpOriginConfigurationMissing(options: ServeOptions): void {
  if (options.publicOrigin !== undefined || options.trustedHosts !== undefined) return;
  console.warn(MCP_ORIGIN_CONFIGURATION_WARNING);
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
  if (options.rateLimit) {
    // Fail fast before binding: a non-positive window or budget is a
    // misconfiguration that would otherwise admit an always-zero or
    // accidentally-unlimited limiter.
    validateRateLimitConfig(options.rateLimit);
  }
  if (options.cors) {
    // Fail fast before binding: a wildcard origin paired with credentials or
    // an Authorization allowed-header is rejected here. The auth flag mirrors
    // resolveCorsPolicy's Authorization auto-add, so a wildcard origin under
    // configured auth is rejected even when allowedHeaders omits Authorization.
    validateCorsOptions(options.cors, options.auth !== undefined);
  }
  assertAuthenticationPosture(options);
  warnIfMcpOriginConfigurationMissing(options);
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
  // Registry-erase the widened `ServeOptions.engine` back to the plain
  // default `Engine` these internal helpers expect — see the field's JSDoc /
  // #708. Every helper below only exercises registry-erased `Engine`
  // behavior.
  const engine = options.engine as Engine;
  const eventFeedBackend = createEngineEventFeedBackend(engine);
  return {
    registry: workerRegistry,
    taskQueue,
    workerSockets: new Map(),
    streamSockets: new Map(),
    watchSockets: new Map(),
    workflowStreamConnectionCounts: new Map(),
    maxStreamConnectionsPerWorkflow:
      options.maxStreamConnectionsPerWorkflow ?? DEFAULT_MAX_STREAM_CONNECTIONS_PER_WORKFLOW,
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
    // Resolve the CORS policy once. When `auth` is configured, force
    // `Authorization` into the advertised allowed-headers so authenticated
    // browser clients can preflight successfully. `null` means no CORS.
    corsPolicy: options.cors ? resolveCorsPolicy(options.cors, options.auth !== undefined) : null,
    metricsCollector: serverMetricsCollector,
    eventFeedBackend,
    workflowEventFeed: createWorkflowEventFeed(eventFeedBackend),
    fleetEventFeed: createFleetEventFeed(options.engine.storage),
    activeJsonRpcSessions: new Set(),
    mcpSessionManager: createMcpSessionManager(engine),
    // The authenticator is initialized asynchronously (key import) but the
    // promise is created eagerly and resolved before the first request completes.
    authenticatorPromise: options.auth ? createAuthenticator(options.auth) : null,
    rateLimiter: options.rateLimit ? createRateLimiter(options.rateLimit) : null,
    visibilityPollMs: options.visibilityPollIntervalMs ?? 5_000,
    workerReconnectGracePeriodMs: clampWorkerReconnectGracePeriod(
      options.workerReconnectGracePeriodMs,
    ),
    payloadSizeMaxBytes: getEnginePayloadSizeMaxBytes(engine),
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
 *
 * Sets a constant `maxPayloadLength` of `WEBSOCKET_MAX_PAYLOAD_BYTES` (4 MiB)
 * so Bun rejects oversized frames at the transport layer before any JSON parse
 * occurs. The cap is intentionally a fixed transport-safety ceiling, not
 * derived from `payloadSize.maxBytes` (see that constant's docs for why mixing
 * the raw-frame limit with the application value-size policy would cause false
 * rejections in the wrong unit).
 */
export function buildBunServeConfig(
  port: number,
  hostname: string,
  development: boolean,
  routes: Bun.Serve.Routes<WebSocketData, string>,
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
    websocket: { ...websocketCallbacks, maxPayloadLength: WEBSOCKET_MAX_PAYLOAD_BYTES },
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

  // Registry-erase the widened `ServeOptions.engine` back to the plain
  // default `Engine` `registerWorkflowEventLifecycle` expects — see the
  // field's JSDoc / #708.
  stack.defer(
    registerWorkflowEventLifecycle(options.engine as Engine, context, broadcastingHandle),
  );
  stack.defer(() =>
    shutdownAllWorkers(
      context,
      options.workerShutdownTimeoutMs === undefined
        ? undefined
        : { timeoutMs: options.workerShutdownTimeoutMs, stopWaitingWhenIdle: true },
    ),
  );

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
    // Release the rate limiter's per-key window map.
    context.rateLimiter?.dispose();
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
      // Carry the durable record's attemptToken into the rehydrated registry
      // entry so the stale-attempt guard survives a server restart.
      context.registry.assignTask(
        record.workerId,
        record.operationId,
        remaining,
        undefined,
        record.attemptToken,
      );
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
