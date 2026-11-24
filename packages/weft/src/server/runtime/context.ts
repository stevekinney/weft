import type { ServerWebSocket } from 'bun';

import type { Authenticator, Principal, RateLimiter } from "../../embedded/backchannel/src/index.ts";
import type {
  ConnectionLease,
  JsonRpcWebSocketSession,
  OpenApiSecuritySchemeName,
  ResolvedCorsPolicy,
} from "../../embedded/backchannel/src/internals.ts";
import type { McpEndpoint } from '../../mcp/http.ts';
import type { MetricsCollector } from '../../observability/metrics.ts';
import type { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/index.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import type { DeadlineTracker } from '../deadline-tracker.ts';
import type { FleetEventFeed } from '../fleet-event-feed.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { createLiveOperationRegistry, createLiveRestBindings } from '../rest-bindings.ts';
import type { TaskQueue } from '../task-queue.ts';
import type { WatchEventFeed } from '../watch-event-feed-backend.ts';
import type { WorkflowEventFeed } from '../workflow-event-feed.ts';

/**
 * Startup task-ledger recovery gate (WFT-23). `ready` resolves once every
 * non-terminal ledger record has been reconstructed into the in-memory
 * registry, deadline tracker, and task queue indexes; it rejects
 * (permanently — a settled promise replays the same outcome to every future
 * awaiter) if the recovery scan itself failed. Task-plane entry points
 * (`dispatchTaskImpl`, long-poll claim/result, and worker registration) await
 * this before touching the ledger, so a scan failure blocks new claims with
 * an actionable error instead of silently continuing with partial indexes.
 */
export type TaskLedgerRecoveryGate = Readonly<{ ready: Promise<void> }>;

export type LongPollWorkerSession = Readonly<{
  sessionId: string;
  credential: string;
  principal: Principal | undefined;
  queue: string;
  activities: readonly string[];
  concurrency: number;
  manifest: WorkerManifest;
  acceptedManifestDigest: string;
  sessionGeneration: number;
  createdAt: number;
  lastHeartbeatAt: number;
}>;

/**
 * A deferred worker-disconnect requeue: the timer that will run it and the
 * instant it fires. `endsAt` is when the reconnect grace window closes, which
 * `weft.workers.diagnostics` reports as `reconnectGraceEndsAt`.
 */
export interface PendingWorkerRequeue {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly endsAt: number;
}

/** Point-in-time live transport subscriber/connection counts owned by `serve()`. */
export interface ServerConnectionCounts {
  fleetSse: number;
  fleetWebSocket: number;
  workflowSse: number;
  workflowWebSocket: number;
  workers: number;
}

/**
 * Internal closure state for a single `serve()` invocation.
 *
 * Extracted runtime helpers receive this record explicitly so they do not
 * rely on closure capture from `serve()`.
 */
export interface ServerContext {
  readonly registry: WorkerRegistry;
  readonly longPollWorkerSessions: Map<string, LongPollWorkerSession>;
  readonly taskQueue: TaskQueue;
  readonly workerSockets: Map<string, ServerWebSocket<WebSocketData>>;
  readonly streamSockets: Map<string, Set<ServerWebSocket<WebSocketData>>>;
  readonly watchSockets: Map<string, Set<ServerWebSocket<WebSocketData>>>;
  readonly workflowStreamConnectionCounts: Map<string, number>;
  readonly maxStreamConnectionsPerWorkflow: number;
  /** Tracks per-workflow worker affinity for sticky routing. Maps workflowId to workerId. */
  readonly workerAffinity: Map<string, string>;
  /** Reverse index: workflowId to set of operationIds currently in-flight for that workflow. */
  readonly workflowOperations: Map<string, Set<string>>;
  /** Reverse lookup: operationId to workflowId for O(1) cleanup on task completion. */
  readonly operationToWorkflow: Map<string, string>;
  /** Tracks pending backoff-delay timers so they can be cleared on shutdown. */
  readonly pendingTimers: Set<ReturnType<typeof setTimeout>>;
  /** In-memory min-heap for inflight task deadlines, avoiding full storage scans on each visibility tick. */
  readonly deadlineTracker: DeadlineTracker;
  readonly liveOperationRegistry: ReturnType<typeof createLiveOperationRegistry>;
  readonly liveRestBindings: ReturnType<typeof createLiveRestBindings>;
  readonly supportedAuthenticationSchemes: ReadonlySet<OpenApiSecuritySchemeName>;
  /** Resolved CORS policy, or `null` when `serve()` was called without `cors` (same-origin only). */
  readonly corsPolicy: ResolvedCorsPolicy | null;
  /** Server-owned process-local metrics collector used by runtime diagnostics. */
  readonly metricsCollector: MetricsCollector;
  readonly connectionCounts: ServerConnectionCounts;
  readonly refreshConnectionMetrics: () => void;
  /** Serves the REST `/events/sse` route from the watch events `/watch` clients read. */
  readonly watchEventFeed: WatchEventFeed;
  /** Serves the JSON-RPC subscriptions from the engine's own event log. */
  readonly workflowEventFeed: WorkflowEventFeed;
  readonly fleetEventFeed: FleetEventFeed;
  readonly activeJsonRpcSessions: Set<JsonRpcWebSocketSession>;
  readonly mcpEndpoint: McpEndpoint;
  readonly authenticatorPromise: Promise<Authenticator> | null;
  /**
   * Per-key request rate limiter, or `null` when `serve()` was called without
   * `rateLimit`. Keyed by authenticated principal subject when available, else
   * by client address. Disposed on `server.stop()`.
   */
  readonly rateLimiter: RateLimiter | null;
  /** Visibility poll interval in milliseconds. */
  readonly visibilityPollMs: number;
  /**
   * Grace period (in ms) before the close handler requeues a disconnected
   * worker's in-flight tasks. A re-register from the same worker id within
   * this window cancels the pending requeue. `0` means inline requeue.
   */
  readonly workerReconnectGracePeriodMs: number;
  /** Cancellation grace period in milliseconds (COR-230, acceptance criterion 15). See `ServeOptions.cancellationGracePeriodMs`. */
  readonly cancellationGracePeriodMs: number;
  /** Engine-level cap for activity results delivered by remote workers. */
  readonly payloadSizeMaxBytes: number | null;
  /**
   * Pending requeue timers keyed by `workerId`. A successful re-register clears
   * the timer for that worker, suppressing the deferred requeue.
   */
  readonly pendingWorkerRequeues: Map<string, PendingWorkerRequeue>;
  /**
   * The durable deployment catalog. An accepted worker registration records its
   * `(deploymentName, buildId)` version here (`deployment-version-registration.ts`).
   * Absent only on a hand-built context that has no catalog to record into.
   */
  readonly workerDeploymentCatalog?: WorkerDeploymentCatalog;
  /** Mutex: prevents concurrent visibility scans from running simultaneously. */
  scanRunning: boolean;
  /** Fine-grained mutex for in-flight operation IDs being processed by expiry paths. */
  readonly processingOperations: Set<string>;
  /** Mutex: prevents concurrent reconciliation scans from running simultaneously. */
  reconciliationRunning: boolean;
  /**
   * Long-poll queues a drain is currently moving onto WebSocket workers, each
   * with a flag a trigger sets when it arrives mid-drain — see
   * `drainLongPollQueue` in `long-poll-drain.ts`.
   */
  readonly longPollDrains: Map<string, { rerun: boolean }>;
  /** Startup task-ledger recovery gate — see {@link TaskLedgerRecoveryGate}. */
  readonly taskLedgerRecovery: TaskLedgerRecoveryGate;
  /**
   * Set once `server.stop()`'s timer-clearing disposer has run. Startup
   * recovery's scan loop, `scheduleDelayedDispatch`, the worker socket close
   * handler, and `runWorkerDisconnectRequeue` all check this before doing
   * further work so a still-running recovery scan, a reconciliation pass
   * racing shutdown, or a worker socket closed by the stop itself cannot arm
   * a new timer or issue a durable write after `pendingTimers` has already
   * been cleared.
   */
  stopping: boolean;
}

export function acquireFleetSseConnection(context: ServerContext): ConnectionLease {
  return acquireConnection(context, 'fleetSse');
}

export function acquireFleetWebSocketConnection(context: ServerContext): ConnectionLease {
  return acquireConnection(context, 'fleetWebSocket');
}

export function acquireWorkflowSseConnection(context: ServerContext): ConnectionLease {
  return acquireConnection(context, 'workflowSse');
}

export function acquireWorkflowWebSocketConnection(context: ServerContext): ConnectionLease {
  return acquireConnection(context, 'workflowWebSocket');
}

function acquireConnection(
  context: ServerContext,
  key: keyof Omit<ServerConnectionCounts, 'workers'>,
): ConnectionLease {
  context.connectionCounts[key] += 1;
  context.refreshConnectionMetrics();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      context.connectionCounts[key] = Math.max(0, context.connectionCounts[key] - 1);
      context.refreshConnectionMetrics();
    },
  };
}
