// ---------------------------------------------------------------------------
// Shared public types for the worker registry
// ---------------------------------------------------------------------------

import type { WorkerExecutionRequirement, WorkerManifest } from '../manifest/types.ts';
import type { RemoteWorkerCapabilities } from '../protocol.ts';

/** Lifecycle health state of a connected worker. */
export type WorkerHealth = 'active' | 'draining' | 'drained';

/** Transport that owns a registered worker session. */
export type WorkerTransport = 'websocket' | 'long-poll';

/**
 * Identity of ONE worker-session — the connection-level lease (COR-230),
 * distinct from `ActivityAttemptLease` (`core/task-ledger/task-ledger-types.ts`),
 * which identifies one ATTEMPT of one operation independently of which
 * session currently holds it.
 *
 * `sessionGeneration` increments on every accepted `register()` call for a
 * given `workerId` — including a reconnect of the same process under the
 * same id — so a session that has been superseded (a fresh registration
 * landed after this one, whether inside or outside the reconnect grace
 * window) can be told apart from the one currently live, even though both
 * share `workerId`. `transport` names the registered session transport that
 * owns this identity; WebSocket and long-poll workers use the same registry
 * and the same attempt-fenced task ledger.
 */
export interface WorkerSessionIdentity {
  readonly workerId: string;
  readonly sessionGeneration: number;
  readonly manifestDigest: string;
  readonly transport: WorkerTransport;
}

/**
 * Full internal state record for a connected worker, held by the registry.
 * `drainReason` and `drainStartedAt` are present only when a worker-level
 * drain marker has been set.
 *
 * `manifest` and `acceptedManifestDigest` are internal — not part of
 * {@link WorkerSummary} or any REST/JSON-RPC surface. Exposing bounded
 * worker/deployment detail from the accepted manifest is a diagnostics
 * concern, not a registration concern.
 */
export interface WorkerInfo {
  id: string;
  queue: string;
  transport: WorkerTransport;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
  startedAt: number;
  /** Session generation (COR-230) — see `WorkerSessionIdentity`'s doc comment. Starts at 1 on first registration. */
  sessionGeneration: number;
  capabilities: RemoteWorkerCapabilities;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  manifest: WorkerManifest;
  acceptedManifestDigest: string;
  drainReason?: string;
  drainStartedAt?: number;
  /**
   * The `startedAt` of the drain {@link drainFinishedTasks} and {@link drainedAt} were counted
   * under. A drain cleared and set again starts both afresh, so they never carry over.
   */
  drainCountedFrom?: number;
  /** How many tasks the worker finished while the drain counted from `drainCountedFrom` held. */
  drainFinishedTasks?: number;
  /** When the worker's last task under that drain finished, leaving nothing in flight. */
  drainedAt?: number;
}

/** Shape accepted by {@link WorkerRegistry.register}. */
export type WorkerRegistrationInfo = {
  id: string;
  queue: string;
  transport?: WorkerTransport;
  activities: string[];
  concurrency: number;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  manifest: WorkerManifest;
  acceptedManifestDigest: string;
  startedAt?: number;
  capabilities?: RemoteWorkerCapabilities;
};

/**
 * Per-worker projection reported by {@link WorkerRegistry.getWorkerSummaries}.
 * Derived view used by the public `weft.workers.list` operation and joined
 * into `weft.task.queues.list` to compute per-queue in-flight totals. The
 * `now` parameter passed to `getWorkerSummaries` is the same `now` the
 * operation uses for queue-age math, so a single response is internally
 * consistent across both data sources.
 */
export type WorkerSummary = {
  id: string;
  queue: string;
  transport: WorkerTransport;
  activities: string[];
  concurrency: number;
  inFlight: number;
  availableCapacity: number;
  connectedAt: number;
  lastHeartbeatAt: number;
  heartbeatAgeMs: number;
  startedAt: number;
  capabilities: RemoteWorkerCapabilities;
  health: WorkerHealth;
  /**
   * The worker's name as a person reads it, advertised as the string capability `name` when it
   * registered; absent when it advertised none.
   */
  name?: string | undefined;
  /**
   * When the worker's session ended. Present only for a worker that went away: it stays listed
   * until an operator forgets it or it registers again, and its `lastHeartbeatAt` is when it was
   * last heard from.
   */
  disconnectedAt?: number | undefined;
  /**
   * The workflow types the worker's accepted manifest says it can execute, sorted; absent when it
   * declared none. Kept with a worker that went away, whose manifest is no longer readable.
   */
  workflows?: string[] | undefined;
  deploymentName?: string | undefined;
  buildId?: string | undefined;
  runtimeVersion?: string | undefined;
  /**
   * How many tasks the worker finished since its drain started, present while it is `draining` or
   * `drained`, so a list can say a drained worker "finished its 2 tasks".
   */
  drainFinishedTasks?: number | undefined;
  /**
   * When the drained worker's last task finished, or when the drain started if nothing was in
   * flight then; present only while it is `drained`. The worker stays listed until it disconnects.
   */
  drainedAt?: number | undefined;
};

export type WorkerDrainMutationResult =
  | {
      target: 'worker';
      workerId: string;
      affectedWorkers: number;
      inFlight: number;
      health: WorkerHealth;
    }
  | {
      target: 'deployment';
      deploymentName: string;
      /** Present when the drain or resume named one build rather than the whole deployment. */
      buildId?: string | undefined;
      affectedWorkers: number;
      inFlight: number;
      health: WorkerHealth;
    };

export type WorkerDrainOptions = {
  reason?: string;
  updatedAt?: number;
};

/**
 * Strategy used by {@link WorkerRegistry.findWorker} to pick among eligible workers.
 *
 * - `'least-loaded'` (default) picks the worker with the lowest `inFlight` count.
 *   Best general-purpose policy when tasks are roughly uniform.
 * - `'round-robin'` rotates through workers in registration order, giving each
 *   equal opportunity regardless of load. Useful when tasks are uniform and you
 *   want deterministic distribution for debugging or fairness across workers.
 * - `'fair-share'` picks the worker whose in-flight count for the current
 *   `fairShareKey` (e.g. customer id) is lowest, preventing any single key from
 *   monopolizing capacity when tasks are heterogeneous.
 */
export type RoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share';

export interface RoutingOptions {
  /** Preferred worker ID for cache locality (wins when it still has capacity). */
  sticky?: string;
  queue?: string;
  /**
   * Partition key for `'fair-share'` routing. Typically a customer id.
   * Ignored by other policies. When omitted under `'fair-share'` the policy
   * degrades gracefully to `'least-loaded'`.
   */
  fairShareKey?: string;
  /**
   * Worker IDs to exclude from eligibility — used by `serve()` to skip
   * workers currently in the reconnect grace window so dispatches do not
   * land on a dead socket while peers are available.
   */
  excludeWorkerIds?: ReadonlySet<string>;
  /** Durable routing generation selected before worker policy is applied. */
  deploymentRouting?: {
    deploymentName: string;
    currentBuildId: string;
    rampingBuildId?: string;
    rampBasisPoints: number;
    generation: number;
    updatedAt: number;
  };
  /** Stable workflow/run identifier used for deterministic rollout bucketing. */
  workflowId?: string;
  /** Exact deployment/build/revision constraints captured by the task lease. */
  executionRequirement?: WorkerExecutionRequirement;
}

export interface InFlightTask {
  operationId: string;
  workerId: string;
  deadline: number; // absolute timestamp
  visibilityTimeout: number; // original timeout duration in ms
  /** Optional fair-share partition key the task was assigned under. */
  fairShareKey?: string;
  /** Unique, unguessable token for this dispatch attempt. */
  attemptToken: string;
  /** The dispatching workflow run's persisted revision (WFT-20), when the `TaskDispatch` carried one. */
  workflowRevision?: string;
}

export interface WorkerRegistryOptions {
  /** Routing policy used by {@link WorkerRegistry.findWorker}. Default: `'least-loaded'`. */
  policy?: RoutingPolicy;
  /**
   * Receives the lifecycle events this registry raises itself, today a
   * {@link WorkerRegistrationRejectedEvent} each time {@link WorkerRegistry.recordRejection}
   * appends. `serve()` passes the engine's `dispatchEvent`. Omitted, the registry raises none.
   */
  dispatchEvent?: (event: Event) => void;
}
