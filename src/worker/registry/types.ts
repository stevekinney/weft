// ---------------------------------------------------------------------------
// Shared public types for the worker registry
// ---------------------------------------------------------------------------

import type { RemoteWorkerCapabilities } from '../protocol.ts';

/** Lifecycle health state of a connected worker. */
export type WorkerHealth = 'active' | 'draining' | 'drained';

/**
 * Full internal state record for a connected worker, held by the registry.
 * `drainReason` and `drainStartedAt` are present only when a worker-level
 * drain marker has been set.
 */
export interface WorkerInfo {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
  startedAt: number;
  capabilities: RemoteWorkerCapabilities;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  gitSha?: string;
  drainReason?: string;
  drainStartedAt?: number;
}

/** Shape accepted by {@link WorkerRegistry.register}. */
export type WorkerRegistrationInfo = {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  gitSha?: string;
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
  deploymentName?: string | undefined;
  buildId?: string | undefined;
  runtimeVersion?: string | undefined;
  gitSha?: string | undefined;
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
 *   `fairShareKey` (e.g. tenant id) is lowest, preventing any single tenant from
 *   monopolizing capacity when tasks are heterogeneous.
 */
export type RoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share';

export interface RoutingOptions {
  /** Preferred worker ID for cache locality (wins when it still has capacity). */
  sticky?: string;
  queue?: string;
  /**
   * Partition key for `'fair-share'` routing. Typically a tenant or customer id.
   * Ignored by other policies. When omitted under `'fair-share'` the policy
   * degrades gracefully to `'least-loaded'`.
   */
  fairShareKey?: string;
}

export interface InFlightTask {
  operationId: string;
  workerId: string;
  deadline: number; // absolute timestamp
  visibilityTimeout: number; // original timeout duration in ms
  /** Optional fair-share partition key the task was assigned under. */
  fairShareKey?: string;
}

export interface WorkerRegistryOptions {
  /** Routing policy used by {@link WorkerRegistry.findWorker}. Default: `'least-loaded'`. */
  policy?: RoutingPolicy;
}
