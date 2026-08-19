/**
 * Bun.serve() wrapper with WebSocket and SSE support, optional external UI
 * mounting, and clean shutdown.
 *
 * @module server
 */

import type { Engine, RegistryAgnosticEngine } from '../core/engine.ts';
import type { RetryPolicy } from '../core/types.ts';
import type { PrometheusExporter } from '../observability/metrics.ts';
import { requireStorageCapability } from '../storage/interface.ts';
import type { RoutingPolicy } from '../worker/registry.ts';
import { WorkerRegistry } from '../worker/registry.ts';
import type { AuthConfig, RateLimitConfig } from './authentication.ts';
import {
  createDashboardAssetRoute,
  resolveDashboardAssets,
  type DashboardAssets,
} from './dashboard-assets.ts';
import type { DiscoveryInfo } from './discovery-info.ts';
import type { WebSocketData } from './json-rpc-websocket-runtime.ts';
import { createServerWebSocketHandlers } from './runtime/authentication-bridge.ts';
import type { CorsOptions } from './runtime/cors.ts';
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
import { publishTokenMessage, publishWatchMessage } from './runtime/websocket-stream.ts';
import {
  buildBunServeConfig,
  buildFetchHandler,
  buildServerContext,
  cleanupWorkflowIndex,
  registerStackDisposers,
  resolveNetworkConfig,
} from './serve-internals.ts';
import type { SchedulingPolicy } from './task-queue-types.ts';
import { TaskQueue } from './task-queue.ts';
import type { WorkerAdmissionPolicy } from './worker-admission-policy.ts';

export {
  wireEventBroadcasting,
  type EventBroadcastingHandle,
} from './runtime/event-broadcasting.ts';

export type { DashboardAssets } from './dashboard-assets.ts';
export type { CorsOptions } from './runtime/cors.ts';
export type {
  WorkerAdmissionDecision,
  WorkerAdmissionPolicy,
  WorkerAdmissionRequest,
} from './worker-admission-policy.ts';

export {
  AUTHORIZATION_SCOPES,
  isAuthorizationScope,
  type AuthorizationScope,
} from './authorization-scope.ts';

export type { GetPrincipalOutput } from './operations/get-principal.ts';

export {
  createRateLimiter,
  createRotatingApiKeyStore,
  defaultAuthAuditSink,
  isSensitiveHeader,
  redactCredential,
  redactHeaders,
  validateRateLimitConfig,
  type ApiKeyRegistration,
  type AuthAuditEvent,
  type AuthAuditSink,
  type AuthConfig,
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimiter,
  type RotatingApiKeyStore,
} from './authentication.ts';

// Re-export every option/handle *type* named in ServeOptions / WeftServer /
// TaskDispatch so a consumer of `@lostgradient/weft/server` can name them all
// from this entry point. (AuthConfig/RateLimitConfig ship from the auth block
// above; CorsOptions from its own export above.) The `Engine` instance you pass
// to `serve()` comes from the root `@lostgradient/weft` — its canonical home —
// not from here. WorkerRegistry stays a value to match the root export, and
// TaskQueue is a value so direct `handleRequest()` hosts can construct the live
// worker infrastructure exposed through HandlerOptions.
export type { RetryPolicy } from '../core/types.ts';
export type { PrometheusExporter } from '../observability/metrics.ts';
export { WorkerRegistry } from '../worker/registry.ts';
export type { RoutingPolicy } from '../worker/registry.ts';
export type { DiscoveryInfo } from './discovery-info.ts';
export type { SchedulingPolicy } from './task-queue-types.ts';
export { TaskQueue } from './task-queue.ts';

/**
 * Static route patterns at which an externally supplied dashboard shell is
 * served. Weft no longer bundles a dashboard, but `serve({ dashboard })`
 * keeps a same-origin mounting point for packages that provide one.
 *
 * They are intentionally specific (no blanket `/*`) so they cannot shadow the
 * API served under the `/api` prefix or the root-stable discovery endpoints —
 * those fall through to the `fetch` handler.
 * The supported page routes are `/`, `/workflows`, `/workflows/*`, `/reviews`,
 * `/workers`, `/schedules`, `/storage`, and `/system`.
 *
 * @example
 * ```ts
 * import { DASHBOARD_PAGE_ROUTES } from '@lostgradient/weft/server';
 *
 * // A mounted dashboard shell owns these specific page routes.
 * console.log(DASHBOARD_PAGE_ROUTES[0]); // '/'
 * console.log(DASHBOARD_PAGE_ROUTES.includes('/workflows')); // true
 * ```
 */
export const DASHBOARD_PAGE_ROUTES = [
  '/',
  '/workflows',
  '/workflows/*',
  '/reviews',
  '/workers',
  '/schedules',
  '/storage',
  '/system',
] as const satisfies readonly string[];

/**
 * Route pattern owned by an externally supplied dashboard shell.
 *
 * Weft mounts a caller-provided `serve({ dashboard })` target only at these
 * page routes, leaving API and discovery routes to the server fetch handler.
 *
 * @example
 * ```ts
 * import type { DashboardPageRoute } from '@lostgradient/weft/server';
 *
 * const workflowRoute: DashboardPageRoute = '/workflows/*';
 * void workflowRoute;
 * ```
 */
export type DashboardPageRoute = (typeof DASHBOARD_PAGE_ROUTES)[number];

/**
 * Bun route target accepted by `serve({ dashboard })`.
 *
 * Pass a static `Response` or a Bun route handler supplied by an external
 * dashboard package. Weft serves that target only at {@link DASHBOARD_PAGE_ROUTES}.
 *
 * @example
 * ```ts
 * import type { DashboardRouteTarget } from '@lostgradient/weft/server';
 *
 * const dashboard: DashboardRouteTarget = new Response('<!doctype html><div id="app"></div>', {
 *   headers: { 'Content-Type': 'text/html; charset=utf-8' },
 * });
 * void dashboard;
 * ```
 */
export type DashboardRouteTarget = Bun.Serve.Routes<unknown, string>[string];

/**
 * Startup policy for `serve()` when no `auth` configuration is supplied.
 *
 * @example
 * ```ts
 * import type { UnauthenticatedAccessPolicy } from '@lostgradient/weft/server';
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
 * import { serve, type ServeOptions } from '@lostgradient/weft/server';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
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
  /**
   * The engine `serve()` hosts. Typed as {@link RegistryAgnosticEngine}
   * (see its JSDoc) rather than the plain default `Engine`, so both
   * documented construction patterns type-check: `new Engine({ storage })`
   * (registry inferred as the default, empty registry) and
   * `Engine.create({ workflows })` (registry narrowed to the concrete
   * workflow map). `serve()` never calls registry-typed methods
   * (`register`, `start`, etc.) on this value — only registry-erased ones
   * (`storage`, event listening, `dispatchEvent`). See #708.
   */
  engine: RegistryAgnosticEngine;
  port?: number;
  hostname?: string;
  /** Enable Bun's development mode (HMR, source maps, detailed errors). */
  development?: boolean;
  /** Optional external dashboard shell served at {@link DASHBOARD_PAGE_ROUTES}. */
  dashboard?: DashboardRouteTarget;
  /**
   * Static files served below an explicit prefix for the supplied dashboard.
   * The directory and prefix are validated synchronously before the port binds.
   */
  dashboardAssets?: DashboardAssets;
  /** Authentication configuration. When provided, all non-public endpoints require valid credentials. */
  auth?: AuthConfig;
  /**
   * In-process request rate limiting. When provided, the server throttles
   * requests per key — the authenticated principal's subject when available,
   * otherwise the client address — returning HTTP `429` with `Retry-After`
   * once a key exceeds its window budget. Public-path requests (health,
   * metrics, discovery) and CORS preflight are exempt.
   *
   * **This is a single-process load-shedding guardrail, not a distributed
   * quota.** Behind multiple instances each process keeps its own counters;
   * deployments needing a global budget should still front Weft with a
   * shared reverse-proxy limiter. Omitting `rateLimit` disables limiting (the
   * historical behavior). See {@link RateLimitConfig}.
   */
  rateLimit?: RateLimitConfig;
  /**
   * Cross-Origin Resource Sharing policy for browser clients (external
   * dashboards and the Service Worker / IndexedDB browser runtime) that call
   * the server from a different origin. **Omitting `cors` is the safe default:
   * the server emits no `Access-Control-*` headers and only same-origin browser requests
   * succeed — it never defaults to `Access-Control-Allow-Origin: *`.** When set,
   * `serve()` answers CORS preflight (`OPTIONS`) requests and decorates
   * responses for allowed origins, and rejects cross-origin WebSocket upgrades
   * from disallowed origins. Validated synchronously: a wildcard origin with
   * `credentials: true`, or with an `Authorization` allowed-header, throws
   * before the port binds. See {@link CorsOptions}.
   */
  cors?: CorsOptions;
  /**
   * Startup policy when `auth` is omitted. Defaults to `'warn'`, which starts
   * the server and logs a loud warning. Set `'reject'` for production
   * deployments so an omitted auth configuration fails closed before binding.
   * Set `'allow'` only for explicitly trusted local process boundaries.
   */
  unauthenticatedAccess?: UnauthenticatedAccessPolicy;
  /**
   * Maximum request body size in bytes for REST operation routes and JSON-RPC
   * HTTP. Defaults to 1 MB. Oversized requests are rejected before the full body
   * is buffered.
   */
  maxRequestBodyBytes?: number;
  /**
   * Maximum concurrent `/v1/workflows/:id/stream`,
   * `/v1/workflows/:id/watch`, and `/v1/workflows/:id/events/sse`
   * connections for a single workflow. Defaults to 100. Excess WebSockets are
   * closed with policy-violation code `1008` after the upgrade opens; excess
   * workflow SSE requests return `429`.
   */
  maxStreamConnectionsPerWorkflow?: number;
  /** How often (in ms) the server scans `op:inflight:*` for expired visibility deadlines. Defaults to 5 000. */
  visibilityPollIntervalMs?: number;
  /**
   * Grace period (in ms) between a worker WebSocket close and the requeue of
   * its in-flight tasks. A re-`register` from the same `workerId` within this
   * window cancels the pending requeue so the reconnect keeps the work it
   * already started. Defaults to `2_000`. Set to `0` to disable the grace
   * period entirely — close handler runs requeue inline as in earlier versions
   * of the server. Use `100` only for low-latency test or embedded scenarios;
   * use `5_000` for cloud or load-balancer deployments where replacement
   * workers commonly need several seconds to reconnect. Values are clamped to
   * `[0, 5_000]`.
   */
  workerReconnectGracePeriodMs?: number;
  /**
   * Maximum time (in ms) `server.stop()` waits for connected remote workers to
   * drain in-flight task results after receiving a shutdown frame before the
   * Bun server is stopped. Defaults to `30_000`.
   */
  workerShutdownTimeoutMs?: number;
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
   * Gate on which workers may become routing-eligible, evaluated after the
   * manifest is validated and checked for deployment consistency and before
   * registry insertion. Defaults to `undefined`, which accepts every worker
   * that already passed authentication — the behavior before this option
   * existed.
   */
  workerAdmissionPolicy?: WorkerAdmissionPolicy;
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
 * `operationId`, `activityName`, and `workflowType` are required; all other
 * fields refine routing, retry behaviour, and priority.  Set `sticky: true`
 * together with `workflowId` to route the task to the worker that last
 * handled tasks for that workflow.
 *
 * @example
 * ```ts
 * import { type TaskDispatch } from '@lostgradient/weft/server';
 *
 * const task: TaskDispatch = {
 *   operationId: crypto.randomUUID(),
 *   activityName: 'sendEmail',
 *   workflowType: 'notifications',
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
  /** Queue to dispatch the task to. Defaults to `'default'`. */
  queue?: string;
  /**
   * The dispatching workflow's registered type. Required — the durable task
   * ledger's envelope (`RemoteTaskBase.workflowType`) is required, and
   * `buildWorkerExecutionIdentity` needs it to look up the claiming worker's
   * manifest entry (`manifest.workflows[workflowType].activities[activityName]`).
   * `dispatchTaskImpl` rejects a call missing this field with an actionable
   * error rather than defaulting it — there is no safe placeholder value.
   */
  workflowType: string;
  /** Workflow ID. Required for sticky routing to track worker affinity. */
  workflowId?: string | undefined;
  /** Durable token for the workflow run that launched this task, when known. */
  workflowExecutionToken?: string | undefined;
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
 * Both `registry` ({@link WorkerRegistry}) and `taskQueue` ({@link TaskQueue})
 * are re-exported from `'@lostgradient/weft/server'`, so you can name these
 * types without a second import. Still prefer `WeftServer` methods
 * (`dispatchTask`, `shutdownWorker`, etc.) over reaching into `taskQueue`
 * directly — it is exposed for inspection, not as a stable mutation surface.
 *
 * @example
 * ```ts
 * import { serve, type WeftServer } from '@lostgradient/weft/server';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
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
  /**
   * Resolves once startup task-ledger recovery (WFT-23) has reconstructed
   * every non-terminal task's in-memory indexes from durable storage;
   * rejects if the recovery scan itself failed. `dispatchTask`, long-poll
   * claim/result handling, and worker registration all await this
   * internally before touching the ledger, so awaiting it explicitly is
   * optional — it exists for callers (health checks, orchestration) that
   * want to observe readiness without dispatching a probe task.
   */
  readonly ready: Promise<void>;
  /**
   * Drain connected remote workers, then stop the underlying Bun server.
   *
   * During the drain, each connected worker receives a shutdown frame and may
   * still deliver in-flight `taskResult` messages. The drain waits up to
   * {@link ServeOptions.workerShutdownTimeoutMs}, defaulting to 30 seconds,
   * before teardown continues.
   */
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
 * Start the Weft HTTP + WebSocket + SSE server.
 *
 * `serve()` validates the supplied `auth` configuration synchronously and
 * throws `Error` before binding the port if any auth setting is invalid.
 * Every non-terminal task record from previous server runs is recovered from
 * durable storage on startup so no task is silently lost across restarts —
 * see `WeftServer.ready`. Task dispatch, claim, completion, and worker
 * registration all wait for that recovery to finish (or fail loudly if it
 * doesn't) before touching the ledger.
 *
 * The returned `WeftServer.taskQueue` is exposed for inspection, not as a stable
 * mutation surface — prefer `WeftServer` methods (`dispatchTask`,
 * `shutdownWorker`, etc.) over reaching into it directly.
 *
 * @example
 * ```ts
 * import { Engine, MemoryStorage, workflow } from '@lostgradient/weft';
 * import { serve } from '@lostgradient/weft/server';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(
 *   workflow({ name: 'greet' }).execute(async function* (
 *     _ctx: import('@lostgradient/weft').WorkflowContext,
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
  // Every serve() call constructs a WorkerRegistry/TaskQueue that dispatches
  // through the durable remote task ledger (WFT-22) — claim, heartbeat,
  // completion, and requeue all commit through `storage.conditionalBatch`.
  // Fail fast, synchronously, before binding a port, rather than at the
  // first dispatch: "Remote activity execution fails construction or server
  // attachment with an actionable capability error" (project brief).
  requireStorageCapability(
    options.engine.storage,
    'conditionalBatch',
    'Remote task ledger (durable dispatch, claim, heartbeat, completion, and requeue)',
  );
  const dashboardAssets =
    options.dashboardAssets === undefined
      ? undefined
      : resolveDashboardAssets(options.dashboardAssets, DASHBOARD_PAGE_ROUTES);
  const { port, hostname, development, tlsOptions, serverOptions, serverMetricsCollector } =
    resolveNetworkConfig(options);

  const context = buildServerContext(serverOptions, serverMetricsCollector);
  const boundCleanup = (operationId: string): void => cleanupWorkflowIndex(context, operationId);

  const routes: Bun.Serve.Routes<WebSocketData, string> = {};
  if (options.dashboard != null) {
    // Mount a supplied dashboard shell at known top-level page routes — never a blanket
    // `/*`. Bun matches the static `routes` map before the `fetch` fallback
    // (where the entire API is dispatched), and `fetch` never runs for a path a
    // route already matched. A global `/*` would therefore swallow `/api/...`
    // and return the dashboard shell instead of the API response. These
    // specific page routes can't collide with `/api/...` or the root-stable
    // carve-outs, so `fetch` still owns everything else.
    for (const path of DASHBOARD_PAGE_ROUTES) {
      routes[path] = options.dashboard;
    }
  }
  if (dashboardAssets !== undefined) {
    routes[`${dashboardAssets.prefix}/*`] = createDashboardAssetRoute(dashboardAssets);
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
    // Registry-erase the widened `ServeOptions.engine` back to the plain
    // default `Engine` `wireEventBroadcasting` expects — see the field's
    // JSDoc / #708. Every caller in this module only exercises
    // registry-erased `Engine` behavior.
    broadcastingHandle = wireEventBroadcasting(options.engine as Engine, server, {
      publishTokenMessage: (workflowId, sequence, message) => {
        publishTokenMessage(context, workflowId, sequence, message);
      },
      publishWatchMessage: (workflowId, sequence, message) => {
        publishWatchMessage(context, workflowId, sequence, message);
      },
      fleetEventFeed: context.fleetEventFeed,
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
  // Startup task-ledger recovery (WFT-23) was already started inside
  // `buildServerContext`, as early as possible relative to context
  // construction — see that function's doc comment.
  // Process-level signal handling is the CLI's responsibility (`cli-main.ts`);
  // installing it here would race with the CLI and leak handlers across
  // repeated `serve()` calls in library/test contexts.

  const resolvedPort = server.port ?? port;
  const resolvedHostname = server.hostname ?? hostname;
  const scheme = tlsOptions ? 'https' : 'http';

  const weftServer: WeftServer = {
    port: resolvedPort,
    hostname: resolvedHostname,
    url: `${scheme}://${resolvedHostname}:${resolvedPort}`,
    registry: context.registry,
    taskQueue: context.taskQueue,
    ready: context.taskLedgerRecovery.ready,
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
  return weftServer;
}
