import type { ServerWebSocket } from 'bun';

import type { McpSessionManager } from '../../mcp/session.ts';
import type { MetricsCollector } from '../../observability/metrics.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import type { Authenticator, RateLimiter } from '../authentication.ts';
import type { DeadlineTracker } from '../deadline-tracker.ts';
import type { createEngineEventFeedBackend } from '../engine-event-feed-backend.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { JsonRpcWebSocketSession } from '../json-rpc-websocket.ts';
import type { OpenApiSecuritySchemeName } from '../openapi.ts';
import type { createLiveOperationRegistry, createLiveRestBindings } from '../rest-bindings.ts';
import type { TaskQueue } from '../task-queue.ts';
import type { WorkflowEventFeed } from '../workflow-event-feed.ts';
import type { ResolvedCorsPolicy } from './cors.ts';

/**
 * Internal closure state for a single `serve()` invocation.
 *
 * Extracted runtime helpers receive this record explicitly so they do not
 * rely on closure capture from `serve()`.
 */
export interface ServerContext {
  readonly registry: WorkerRegistry;
  readonly taskQueue: TaskQueue;
  readonly workerSockets: Map<string, ServerWebSocket<WebSocketData>>;
  readonly streamSockets: Map<string, Set<ServerWebSocket<WebSocketData>>>;
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
  readonly eventFeedBackend: ReturnType<typeof createEngineEventFeedBackend>;
  readonly workflowEventFeed: WorkflowEventFeed;
  readonly activeJsonRpcSessions: Set<JsonRpcWebSocketSession>;
  readonly mcpSessionManager: McpSessionManager;
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
  /** Engine-level cap for activity results delivered by remote workers. */
  readonly payloadSizeMaxBytes: number | null;
  /**
   * Pending requeue timers keyed by `workerId`. A successful re-register clears
   * the timer for that worker, suppressing the deferred requeue.
   */
  readonly pendingWorkerRequeues: Map<string, ReturnType<typeof setTimeout>>;
  /** Mutex: prevents concurrent visibility scans from running simultaneously. */
  scanRunning: boolean;
  /** Fine-grained mutex for in-flight operation IDs being processed by expiry paths. */
  readonly processingOperations: Set<string>;
  /** Mutex: prevents concurrent reconciliation scans from running simultaneously. */
  reconciliationRunning: boolean;
}
