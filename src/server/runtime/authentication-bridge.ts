import type { ServerWebSocket } from 'bun';

import { decode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import { WorkerDisconnectedEvent } from '../../core/events.ts';
import { handleMcpHttpRequest } from '../../mcp/http.ts';
import type { PrometheusExporter } from '../../observability/metrics.ts';
import { KEYS } from '../../storage/interface.ts';
import type { AuthConfig, AuthContext } from '../authentication.ts';
import type { HandlerOptions } from '../handler.ts';
import { authContextToPrincipal, handleRequest } from '../handler.ts';
import type { ServeOptions } from '../index.ts';
import { handleJsonRpcHttpRequestSafely } from '../json-rpc-transport-helpers.ts';
import {
  closeJsonRpcWebSocketSession,
  handleJsonRpcWebSocketMessage,
  openJsonRpcWebSocketSession,
  type WebSocketData,
} from '../json-rpc-websocket-runtime.ts';
import type { OpenApiSecuritySchemeName } from '../openapi.ts';
import { API_PREFIX } from '../route-model.ts';
import type { ServerContext } from './context.ts';
import { buildPreflightResponse, decorateResponseWithCors, isPreflightRequest } from './cors.ts';
import { gateRequest } from './request-gate.ts';
import { handleTaskPollRequest, handleTaskResultRequest } from './task-polling.ts';
import { reassignOrExpireTask } from './task-reconciliation.ts';
import {
  addStreamSocket,
  addWatchSocket,
  removeStreamSocket,
  removeWatchSocket,
  removeWorkflowStreamConnection,
  replayTokenStream,
  replayWatchEvents,
} from './websocket-stream.ts';
import { handleWebSocketUpgrade } from './websocket-upgrade.ts';
import { handleWorkerWebSocketMessage, isInflightRecord } from './websocket-worker.ts';

type ServerFetchOptions = {
  engine: Engine;
  prometheusExporter?: PrometheusExporter;
  discoveryInfo?: import('../discovery-info.ts').DiscoveryInfo;
  publicOrigin?: string;
  trustedHosts?: ReadonlyArray<string>;
  maxRequestBodyBytes?: number;
};

export function deriveSupportedOpenApiSecuritySchemes(
  auth: AuthConfig | undefined,
): ReadonlySet<OpenApiSecuritySchemeName> {
  const schemes = new Set<OpenApiSecuritySchemeName>();
  if (auth?.jwt !== undefined) {
    schemes.add('bearerAuth');
  }
  if ((auth?.apiKeys?.length ?? 0) > 0 || auth?.resolveApiKeyPrincipal !== undefined) {
    schemes.add('apiKeyAuth');
  }
  return schemes;
}

/**
 * Strip the external {@link API_PREFIX} from a request so all downstream
 * matching — WebSocket-upgrade regexes, the `/mcp` and `/jsonrpc` literals,
 * REST bindings, direct routes, and the authentication allowlist — operates on
 * canonical root-relative paths (`/api/v1/workflows` → `/v1/workflows`).
 *
 * Only `${API_PREFIX}/<non-empty>` is stripped. Bare `/api` and `/api/` are
 * left untouched so they fall through to the canonical 404 rather than aliasing
 * the root. Paths that don't start with the prefix — including the root-stable
 * carve-outs (`/v1/health`, `/openrpc.json`, `/.well-known/*`, …) — are
 * returned unchanged.
 *
 * The rewritten request is constructed via `new Request(url, request)` so the
 * method, headers, body, signal, and duplex flag are copied intact; only the
 * URL changes.
 */
function stripApiPrefix(request: Request): Request {
  const url = new URL(request.url);
  const prefixedRoot = `${API_PREFIX}/`;
  // Require a non-empty, non-slash segment after `${API_PREFIX}/`. The char at
  // `pathname[prefixedRoot.length]` is the first character after `/api/`:
  //   - `/api`        → does not start with `/api/`, returned unchanged
  //   - `/api/`       → char is `undefined` → returned unchanged (canonical 404)
  //   - `/api//v1/x`  → char is `/` → returned unchanged (avoids a `//v1/x`
  //                     pathname that would route surprisingly)
  //   - `/api/v1/x`   → char is `v` → stripped to `/v1/x`
  const nextChar = url.pathname[prefixedRoot.length];
  if (!url.pathname.startsWith(prefixedRoot) || nextChar === undefined || nextChar === '/') {
    return request;
  }
  url.pathname = url.pathname.slice(API_PREFIX.length);
  return new Request(url, request);
}

/**
 * Resolve the principal handed to the long-poll task endpoints. Only `/v1/tasks/`
 * routes consume it, and only when an auth context exists, so other paths skip
 * `authContextToPrincipal` and avoid turning a client auth error into a spurious
 * failure on routes that never needed the principal.
 */
function resolveTaskPrincipal(
  authContext: AuthContext | undefined,
  url: URL,
): ReturnType<typeof authContextToPrincipal> | undefined {
  if (authContext === undefined || !url.pathname.startsWith('/v1/tasks/')) return undefined;
  return authContextToPrincipal(authContext);
}

export async function handleServerFetchRequest(
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  options: ServerFetchOptions,
  originalRequest: Request,
): Promise<Response | undefined> {
  // CORS preflight is answered before authentication: browsers never attach
  // credentials to an `OPTIONS` preflight, so auth-gating it would reject every
  // legitimate cross-origin request. The handler is stateless and bounded.
  if (context.corsPolicy !== null && isPreflightRequest(originalRequest)) {
    return buildPreflightResponse(context.corsPolicy, originalRequest);
  }

  const response = await dispatchServerFetchRequest(server, context, options, originalRequest);

  // Decorate actual (non-preflight) responses with CORS headers for allowed
  // origins. `undefined` (no response produced) is passed through untouched.
  if (context.corsPolicy !== null && response !== undefined) {
    return decorateResponseWithCors(context.corsPolicy, originalRequest, response);
  }
  return response;
}

async function dispatchServerFetchRequest(
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  options: ServerFetchOptions,
  originalRequest: Request,
): Promise<Response | undefined> {
  // Strip the external `/api` prefix before anything else (auth, WS upgrade,
  // `/mcp` & `/jsonrpc` literals, REST/direct dispatch) so every downstream
  // matcher stays canonical and root-relative.
  const request = stripApiPrefix(originalRequest);
  const url = new URL(request.url);

  // Authenticate, then rate-limit. Either step can short-circuit with a
  // response (401 / 429); otherwise the gate yields the resolved auth context.
  // Pass originalRequest for IP lookup — the rewritten request from
  // stripApiPrefix loses Bun's socket handle, so requestIP returns null on it.
  const gate = await gateRequest(server, context, request, originalRequest);
  if (gate.response !== null) {
    return gate.response;
  }
  const authentication = gate.authentication;

  // `handleWebSocketUpgrade` resolves the principal only after the
  // Upgrade-header check and only for WebSocket endpoints that need
  // connection-level authorization. This keeps jwt-without-claims throws
  // out of the HTTP POST `/jsonrpc` path (which has its own try/catch that
  // maps the failure to a -32603 error envelope) while still rejecting raw
  // watch/stream sockets without `events:read` / `streams:read`.
  //
  // The *original* request is handed to `server.upgrade()` — a rebuilt
  // `Request` (from `stripApiPrefix`) loses Bun's internal upgrade handle, so
  // upgrading the synthetic copy fails. Routing/classification still uses the
  // canonical stripped `url`, so `/api/v1/...` sockets match the same patterns.
  const websocketResponse = handleWebSocketUpgrade(
    server,
    context,
    options,
    originalRequest,
    url,
    authentication.authContext,
  );
  if (websocketResponse !== null) {
    return websocketResponse;
  }

  if (url.pathname === '/mcp') {
    return handleMcpHttpRequest({
      request,
      engine: options.engine,
      sessionManager: context.mcpSessionManager,
      authRequired: context.authenticatorPromise !== null,
      ...(authentication.authContext !== undefined
        ? { principal: authContextToPrincipal(authentication.authContext) }
        : {}),
      ...(options.publicOrigin !== undefined ? { publicOrigin: options.publicOrigin } : {}),
      ...(options.trustedHosts !== undefined ? { trustedHosts: options.trustedHosts } : {}),
    });
  }

  const taskPrincipal = resolveTaskPrincipal(authentication.authContext, url);
  const taskPollResponse = await handleTaskPollRequest(
    context,
    options,
    request,
    url,
    taskPrincipal,
  );
  if (taskPollResponse !== null) {
    return taskPollResponse;
  }

  const taskResultResponse = await handleTaskResultRequest(
    context,
    options,
    request,
    url,
    taskPrincipal,
  );
  if (taskResultResponse !== null) {
    return taskResultResponse;
  }

  // JSON-RPC HTTP endpoint. Claimed here so `handleRequest` doesn't
  // see `/jsonrpc` and return 404 from its REST route table. The
  // adapter enforces method (POST only) and content-type internally.
  //
  // Wrap `authContextToPrincipal` + the adapter call in a try/catch so
  // that an authenticator-contract violation (e.g., `{method: 'jwt',
  // claims: undefined}` reaching the pipeline) maps to a 500 JSON-RPC
  // error envelope instead of escaping as an uncaught exception.
  // `handleRequest`'s REST path already does this via its own inner
  // try/catch; `/jsonrpc` has no such boundary without this wrapping.
  if (url.pathname === '/jsonrpc') {
    return handleJsonRpcHttpRequestSafely({
      request,
      registry: context.liveOperationRegistry,
      engine: options.engine,
      authContext: authentication.authContext,
      ...(options.maxRequestBodyBytes !== undefined
        ? { maxBodyBytes: options.maxRequestBodyBytes }
        : {}),
    });
  }

  return handleRequest(
    request,
    options.engine,
    buildHandlerOptions(context, options, authentication),
  );
}

/**
 * Assemble the platform-agnostic `handleRequest` options. Under
 * `exactOptionalPropertyTypes` we can't spread `undefined` values into
 * an options object whose fields are `T?: U` (not `T?: U | undefined`),
 * so each optional field is attached only when present.
 */
function buildHandlerOptions(
  context: ServerContext,
  options: ServerFetchOptions,
  authentication: { authContext?: AuthContext },
): HandlerOptions {
  return {
    ...(authentication.authContext !== undefined
      ? { authContext: authentication.authContext }
      : {}),
    ...(options.prometheusExporter !== undefined
      ? { prometheusExporter: options.prometheusExporter }
      : {}),
    ...(options.discoveryInfo !== undefined ? { discoveryInfo: options.discoveryInfo } : {}),
    ...(options.publicOrigin !== undefined ? { publicOrigin: options.publicOrigin } : {}),
    ...(options.trustedHosts !== undefined ? { trustedHosts: options.trustedHosts } : {}),
    ...(options.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: options.maxRequestBodyBytes }
      : {}),
    operationRegistry: context.liveOperationRegistry,
    restBindings: context.liveRestBindings,
    supportedAuthenticationSchemes: context.supportedAuthenticationSchemes,
  };
}

export function createServerWebSocketHandlers(
  context: ServerContext,
  options: ServerFetchOptions,
  cleanupWorkflowIndex: (operationId: string) => void,
): {
  open: (ws: ServerWebSocket<WebSocketData>) => void;
  message: (ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) => void;
  close: (ws: ServerWebSocket<WebSocketData>) => void;
} {
  return {
    open(ws) {
      const { pathname, connectionType, workflowId } = ws.data;
      if (connectionType === 'watch' && workflowId && !addWatchSocket(context, workflowId, ws)) {
        return;
      }
      if (connectionType === 'watch' && workflowId) {
        ws.data.watchReplayInProgress = true;
        ws.data.pendingWatchMessages = [];
        void replayWatchEvents(context, options.engine, ws, workflowId);
      }

      // Worker sockets ride Bun pub/sub by pathname. Stream and watch sockets
      // do not: `serve()` wires delivery through per-workflow socket
      // registries so reconnect replay can buffer concurrent live frames.
      if (
        pathname &&
        connectionType !== 'stream' &&
        connectionType !== 'watch' &&
        connectionType !== 'jsonrpc'
      ) {
        ws.subscribe(pathname);
      }

      // Stream sockets track replay state individually so reconnects can
      // catch up from durable storage without duplicate live tokens.
      if (connectionType === 'stream' && workflowId) {
        ws.data.streamReplayInProgress = true;
        ws.data.pendingStreamMessages = [];
        if (!addStreamSocket(context, workflowId, ws)) {
          return;
        }
        void replayTokenStream(context, options.engine, ws, workflowId);
      }

      if (connectionType === 'jsonrpc') {
        openJsonRpcWebSocketSession({
          ws,
          registry: context.liveOperationRegistry,
          engine: options.engine,
          feed: context.workflowEventFeed,
          fleetFeed: context.fleetEventFeed,
          activeSessions: context.activeJsonRpcSessions,
        });
        return;
      }
    },
    message(ws, rawMessage) {
      // Explicit dispatch on connection type so control flow is
      // visible in the handler (rather than threaded through
      // helper bool returns). `stream`/`watch`/`generic`
      // connections do not receive client → server messages — the
      // stream/watch paths are unidirectional server → client —
      // so there's no branch for them.
      switch (ws.data.connectionType) {
        case 'jsonrpc':
          handleJsonRpcWebSocketMessage(ws, rawMessage);
          return;
        case 'worker':
          handleWorkerWebSocketMessage(context, options, ws, rawMessage, cleanupWorkflowIndex);
          return;
        case 'stream':
        case 'watch':
        case 'generic':
          return;
      }
    },
    close(ws) {
      if (ws.data.connectionType === 'jsonrpc') {
        closeJsonRpcWebSocketSession({
          session: ws.data.jsonRpcSession,
          activeSessions: context.activeJsonRpcSessions,
        });
        return;
      }

      if (ws.data.connectionType === 'stream') {
        removeStreamSocket(context, ws);
        removeWorkflowStreamConnection(context, ws);
      }

      if (ws.data.connectionType === 'watch') {
        removeWatchSocket(context, ws);
        removeWorkflowStreamConnection(context, ws);
      }

      const workerId = ws.data.workerId;
      if (workerId) {
        // Stale-socket guard: if the worker already reconnected with a fresh
        // socket, this close event is for the displaced connection — skip
        // cleanup entirely. Object identity is sufficient because
        // `workerSockets[workerId]` is only ever populated on successful
        // register and Bun's `ServerWebSocket` instances are unique per
        // upgrade.
        if (context.workerSockets.get(workerId) !== ws) {
          console.warn(
            `[weft] Ignoring stale socket close for worker "${workerId}" — already reconnected`,
          );
          return;
        }

        // Reconnect grace period: defer the requeue so a same-`workerId`
        // re-register inside the window keeps its in-flight work. `0`
        // disables the grace period and runs the requeue inline.
        if (context.workerReconnectGracePeriodMs <= 0) {
          runWorkerDisconnectRequeue(context, options, workerId, ws, cleanupWorkflowIndex);
          return;
        }

        // Cancel any previously-scheduled requeue for this worker before
        // scheduling a new one (defensive — close should only fire once per
        // socket, but a future change could break that invariant silently).
        const existing = context.pendingWorkerRequeues.get(workerId);
        if (existing !== undefined) clearTimeout(existing);

        const timer = setTimeout(() => {
          context.pendingWorkerRequeues.delete(workerId);
          // Re-verify: another register may have completed during the grace
          // period. If so, the fresh socket replaces `workerSockets[workerId]`
          // and the timer becomes a no-op.
          if (context.workerSockets.get(workerId) !== ws) return;
          runWorkerDisconnectRequeue(context, options, workerId, ws, cleanupWorkflowIndex);
        }, context.workerReconnectGracePeriodMs);
        context.pendingWorkerRequeues.set(workerId, timer);
      }
    },
  };
}

/**
 * Run the worker-disconnect requeue path for `workerId`: remove its in-flight
 * tracking, unregister it, drop affinity, and reassign each in-flight task.
 * Called either inline from the close handler (when the grace period is 0) or
 * from the deferred-requeue timer after the grace period elapses without a
 * reconnect.
 */
function runWorkerDisconnectRequeue(
  context: ServerContext,
  options: ServeOptions,
  workerId: string,
  _ws: ServerWebSocket<WebSocketData>,
  cleanupWorkflowIndex: (operationId: string) => void,
): void {
  // Capture in-flight tasks from the in-memory registry (source of truth)
  // before cleanup so they can be reassigned even if storage hasn't committed yet.
  const inFlightTasks = context.registry.getWorkerTasks(workerId);

  // Remove in-flight tracking synchronously to allow re-dispatch.
  for (const task of inFlightTasks) {
    context.registry.completeTask(task.operationId);
    context.deadlineTracker.remove(task.operationId);
  }

  context.registry.unregister(workerId);
  context.workerSockets.delete(workerId);
  options.engine.dispatchEvent(new WorkerDisconnectedEvent(workerId, inFlightTasks.length));

  // Clean up affinity entries that pointed at this worker.
  for (const [workflowId, affinityWorkerId] of context.workerAffinity) {
    if (affinityWorkerId === workerId) {
      context.workerAffinity.delete(workflowId);
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
          if (!isInflightRecord(record)) {
            console.error(
              `[weft] Corrupt inflight record for task "${task.operationId}" — skipping reassignment`,
            );
            return;
          }
          await reassignOrExpireTask(
            context,
            options,
            task.operationId,
            record,
            'worker-disconnect',
          );
        } else {
          // Storage write hadn't committed — clean up the key just in case.
          console.warn(
            `[weft] No inflight record found in storage for task "${task.operationId}" — skipping reassignment`,
          );
          await options.engine.storage.delete(inflightKey);
        }
      } catch (error) {
        console.error(
          `[weft] Failed to reassign task "${task.operationId}" from worker "${workerId}":`,
          error,
        );
      }
    })();
  }
}
