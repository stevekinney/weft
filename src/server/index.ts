/**
 * Bun.serve() wrapper with WebSocket support, dashboard UI, and clean shutdown.
 *
 * @module server
 */

import type { RetryPolicy } from '../core/types.ts';
import { DASHBOARD_MOUNT_PATTERNS } from '../dashboard/route-table.ts';
import type { PrometheusExporter } from '../observability/metrics.ts';
import type { RoutingPolicy } from '../worker/registry.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import type { AuthConfig } from './authentication.ts';
import type { DiscoveryInfo } from './discovery-info.ts';
import type { WebSocketData } from './json-rpc-websocket-runtime.ts';
import { createServerWebSocketHandlers } from './runtime/authentication-bridge.ts';
import {
  wireEventBroadcasting,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';
import {
  shutdownAllWorkers as shutdownAllWorkersImpl,
  shutdownWorker as shutdownWorkerImpl,
} from './runtime/shutdown.ts';
import { stopBunServerForShutdown } from './runtime/stop-server.ts';
import { cancelTask, dispatchTaskImpl } from './runtime/task-dispatch.ts';
import { publishTokenMessage } from './runtime/websocket-stream.ts';
import {
  buildBunServeConfig,
  buildFetchHandler,
  buildServerContext,
  cleanupWorkflowIndex,
  registerStackDisposers,
  resolveNetworkConfig,
  restoreInflightTasks,
} from './serve-internals.ts';
import type { SchedulingPolicy } from './task-queue-types.ts';
import { TaskQueue } from './task-queue.ts';

export {
  wireEventBroadcasting,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';

/**
 * Static route patterns at which the dashboard shell is served, derived
 * directly from the SPA's route table (`DASHBOARD_MOUNT_PATTERNS` in
 * `src/dashboard/route-table.ts`). Deriving from the single source of truth —
 * rather than re-listing the routes here — means a new top-level dashboard
 * page automatically gets a server mount, so a hard reload of it resolves to
 * the shell instead of 404ing.
 *
 * They are intentionally specific (no blanket `/*`) so they cannot shadow the
 * API served under the `/api` prefix or the root-stable discovery endpoints —
 * those fall through to the `fetch` handler.
 *
 * @example
 * ```ts
 * import { DASHBOARD_PAGE_ROUTES } from 'weft/server';
 *
 * // The dashboard owns the origin root via these specific page routes.
 * console.log(DASHBOARD_PAGE_ROUTES[0]); // '/'
 * console.log(DASHBOARD_PAGE_ROUTES.includes('/workflows')); // true
 * ```
 */
export const DASHBOARD_PAGE_ROUTES: readonly string[] = DASHBOARD_MOUNT_PATTERNS;

/**
 * Startup policy for `serve()` when no `auth` configuration is supplied.
 *
 * @example
 * ```ts
 * import type { UnauthenticatedAccessPolicy } from 'weft/server';
 *
 * const unauthenticatedAccess: UnauthenticatedAccessPolicy = 'reject';
 * void unauthenticatedAccess;
 * ```
 */
export type UnauthenticatedAccessPolicy = 'warn' | 'allow' | 'reject';

/**
 * Configuration object for the `serve()` function.
 *
 * At minimum supply an `engine` and optionally a `port`.  Authentication,
 * routing policy, metrics, and worker-dispatch settings are all optional — the
 * server runs with sensible defaults when omitted.
 *
 * @example
 * ```ts
 * import { serve, type ServeOptions } from 'weft/server';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const options: ServeOptions = {
 *   engine,
 *   port: 3000,
 *   auth: { apiKeys: ['secret'] },
 * };
 * await using server = serve(options);
 * console.log(server.url); // http://localhost:3000
 * ```
 */
export interface ServeOptions {
  engine: import('../core/engine.ts').Engine;
  port?: number;
  hostname?: string;
  /** Enable Bun's development mode (HMR, source maps, detailed errors). */
  development?: boolean;
  /** Dashboard HTML import served at the root path `/` (e.g., `import dashboard from './index.html'`). */
  dashboard?: unknown;
  /** Authentication configuration. When provided, all non-public endpoints require valid credentials. */
  auth?: AuthConfig;
  /**
   * Startup policy when `auth` is omitted. Defaults to `'warn'`, which starts
   * the server and logs a loud warning. Set `'reject'` for production
   * deployments so an omitted auth configuration fails closed before binding.
   * Set `'allow'` only for explicitly trusted local process boundaries.
   */
  unauthenticatedAccess?: UnauthenticatedAccessPolicy;
  /** How often (in ms) the server scans `op:inflight:*` for expired visibility deadlines. Defaults to 5 000. */
  visibilityPollIntervalMs?: number;
  /**
   * Grace period (in ms) between a worker WebSocket close and the requeue of
   * its in-flight tasks. A re-`register` from the same `workerId` within this
   * window cancels the pending requeue so the reconnect keeps the work it
   * already started. Defaults to 100 ms. Set to `0` to disable the grace
   * period entirely — close handler runs requeue inline as in earlier versions
   * of the server. Values are clamped to `[0, 5_000]`.
   */
  workerReconnectGracePeriodMs?: number;
  /**
   * Routing policy used by the {@link WorkerRegistry} when dispatching tasks.
   * Defaults to `'least-loaded'`. Set to `'round-robin'` for deterministic
   * rotation across workers.
   *
   * **Note on `'fair-share'`:** fair-share requires a `fairShareKey` to be
   * passed at dispatch time via {@link TaskDispatch.fairShareKey}. `serve()`
   * does not derive that key automatically — call
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
   */
  prometheusExporter?: PrometheusExporter;
  /**
   * Optional metadata applied uniformly to all three discovery documents
   * (`/openapi.json`, `/openrpc.json`, `/asyncapi.json`). When set, the
   * description, contact, license, and externalDocs fields appear in every
   * discovery surface from one source — ensuring zero drift across the
   * three documents.
   */
  discoveryInfo?: DiscoveryInfo;
  /**
   * Explicit public origin used by discovery routes that emit absolute URLs,
   * including `/.well-known/api-catalog` and `/.well-known/mcp.json` (e.g.
   * `https://api.example.com`). Recommended in production. Either this or
   * `trustedHosts` MUST be set or those discovery routes return 503.
   */
  publicOrigin?: string;
  /**
   * Allowlist of `Host` values trusted to source absolute URLs in
   * discovery routes that emit absolute URLs, including
   * `/.well-known/api-catalog` and `/.well-known/mcp.json`. Required (with
   * `publicOrigin` as the alternative) in production — Bun.serve() resolves
   * `request.url` from the incoming Host header so attackers can otherwise
   * poison the discovery URLs.
   */
  trustedHosts?: ReadonlyArray<string>;
}

/**
 * Descriptor for a task dispatched to a remote worker via
 * {@link WeftServer.dispatchTask}.
 *
 * `operationId` and `activityName` are required; all other fields refine
 * routing, retry behaviour, and priority.  Set `sticky: true` together with
 * `workflowId` to route the task to the worker that last handled tasks for
 * that workflow.
 *
 * @example
 * ```ts
 * import { type TaskDispatch } from 'weft/server';
 *
 * const task: TaskDispatch = {
 *   operationId: crypto.randomUUID(),
 *   activityName: 'sendEmail',
 *   input: { to: 'user@example.com', subject: 'Hello' },
 *   queue: 'email',
 *   retryPolicy: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
 * };
 * void task;
 * ```
 */
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
   * Partition key for `'fair-share'` routing — typically a customer
   * id. Ignored by other policies. When omitted under `'fair-share'`, the
   * registry degrades gracefully to `'least-loaded'` for that dispatch.
   */
  fairShareKey?: string;
}

/**
 * Handle returned by `serve()` that exposes the running server's address,
 * worker registry, task dispatch, and shutdown controls.
 *
 * Implements `AsyncDisposable` — `serve()` itself is synchronous, but the
 * returned handle is awaitable for cleanup. Use `await using server = serve(...)`
 * in TypeScript 5.2+ to have the server stop automatically when the enclosing
 * block exits.
 *
 * **Type availability note:** `registry` is typed as `WorkerRegistry`, which
 * is exported from `'weft'` but not from `'weft/server'`. `taskQueue` is typed
 * as `TaskQueue`, which is an internal type not re-exported from any public
 * entry point. Prefer using `WeftServer` methods (`dispatchTask`,
 * `shutdownWorker`, etc.) rather than reaching into `taskQueue` directly.
 *
 * @example
 * ```ts
 * import { serve, type WeftServer } from 'weft/server';
 * import { Engine, MemoryStorage } from 'weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using server: WeftServer = serve({ engine, port: 4000 });
 *
 * console.log(server.url);            // http://localhost:4000
 * console.log(server.registry);       // WorkerRegistry instance
 * await server.stop();
 * ```
 */
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
// Implementation
// ---------------------------------------------------------------------------

/**
 * Start the Weft HTTP + WebSocket server with embedded dashboard.
 *
 * `serve()` validates the supplied `auth` configuration synchronously and
 * throws `Error` before binding the port if any auth setting is invalid.
 * In-flight task records from previous server runs are restored from storage
 * on startup so no tasks are silently lost across restarts.
 *
 * The returned `WeftServer.taskQueue` field is intentionally opaque — prefer
 * `WeftServer` methods (`dispatchTask`, `shutdownWorker`, etc.) over reaching
 * into it directly.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, workflow } from 'weft';
 * import { serve } from 'weft/server';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(
 *   workflow({ name: 'greet' }).execute(async function* (
 *     _ctx: import('weft').WorkflowContext,
 *     input: { name: string },
 *   ) {
 *     return `Hello, ${input.name}!`;
 *   }),
 * );
 *
 * await using server = serve({ engine, port: 7233 });
 * console.log(`Weft listening on ${server.url}`);
 * ```
 */
export function serve(options: ServeOptions): WeftServer {
  const { port, hostname, development, tlsOptions, serverOptions, serverMetricsCollector } =
    resolveNetworkConfig(options);

  const context = buildServerContext(serverOptions, serverMetricsCollector);
  const boundCleanup = (operationId: string): void => cleanupWorkflowIndex(context, operationId);

  const routes: Record<string, unknown> = {};
  if (options.dashboard != null) {
    // Mount the dashboard at its known top-level page routes — never a blanket
    // `/*`. Bun matches the static `routes` map before the `fetch` fallback
    // (where the entire API is dispatched), and `fetch` never runs for a path a
    // route already matched. A global `/*` would therefore swallow `/api/...`
    // and return the dashboard shell instead of the API response. These
    // specific page routes can't collide with `/api/...` or the root-stable
    // carve-outs, so `fetch` still owns everything else.
    //
    // `DASHBOARD_PAGE_ROUTES` is derived from the SPA's route table
    // (`DASHBOARD_MOUNT_PATTERNS` in `src/dashboard/route-table.ts`), so a new
    // top-level page automatically gets a server mount — there is no list to
    // hand-maintain here.
    for (const path of DASHBOARD_PAGE_ROUTES) {
      routes[path] = options.dashboard;
    }
  }

  const serverHolder: { current: ReturnType<typeof Bun.serve> | null } = { current: null };
  const server = Bun.serve<WebSocketData>(
    buildBunServeConfig(
      port,
      hostname,
      development,
      routes,
      tlsOptions,
      buildFetchHandler(serverHolder, context, serverOptions),
      createServerWebSocketHandlers(context, serverOptions, boundCleanup),
    ),
  );
  serverHolder.current = server;

  const stack = new AsyncDisposableStack();
  // Register the server-stop disposer before wiring anything else, so a failure
  // during broadcasting setup still releases the bound port instead of leaking it.
  stack.defer(() => stopBunServerForShutdown(server));

  let broadcastingHandle: EventBroadcastingHandle;
  try {
    broadcastingHandle = wireEventBroadcasting(options.engine, server, {
      publishTokenMessage: (workflowId, sequence, message) => {
        publishTokenMessage(context, workflowId, sequence, message);
      },
    });
  } catch (error) {
    // Stop the server before propagating. The stack's async disposers have not
    // been registered yet and the only resource that needs releasing is the
    // bound server. `serve()` is synchronous, so we kick the stop and rely on
    // Bun's force-stop to release the port promptly; the returned promise is
    // best-effort and the error propagation is what the caller observes.
    void stopBunServerForShutdown(server);
    throw error;
  }

  registerStackDisposers(stack, context, options, broadcastingHandle, boundCleanup);
  restoreInflightTasks(context, options);
  // Process-level signal handling is the CLI's responsibility (`cli-main.ts`);
  // installing it here would race with the CLI and leak handlers across
  // repeated `serve()` calls in library/test contexts.

  const resolvedPort = server.port ?? port;
  const resolvedHostname = server.hostname ?? hostname;
  const scheme = tlsOptions ? 'https' : 'http';

  return {
    port: resolvedPort,
    hostname: resolvedHostname,
    url: `${scheme}://${resolvedHostname}:${resolvedPort}`,
    registry: context.registry,
    taskQueue: context.taskQueue,
    async stop() {
      await stack[Symbol.asyncDispose]();
    },
    dispatchTask: (task) => dispatchTaskImpl(context, options, task),
    shutdownWorker: (workerId, shutdownOptions) =>
      shutdownWorkerImpl(context, workerId, shutdownOptions),
    shutdownAllWorkers: (shutdownOptions) => shutdownAllWorkersImpl(context, shutdownOptions),
    cancelTask: (operationId) => cancelTask(context, operationId),
    [Symbol.asyncDispose]() {
      return stack[Symbol.asyncDispose]();
    },
  };
}
