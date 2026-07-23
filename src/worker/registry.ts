// Server-side worker tracking and pluggable routing policies.
import { FairShareCounters } from './registry/fair-share.ts';
import {
  matchesWorkerCapabilities,
  pickFairShare,
  pickLeastLoaded,
  pickRoundRobin,
} from './registry/routing.ts';
import {
  deploymentHealth,
  projectDeploymentSummaries,
  projectWorkerSummaries,
  type WorkerDeploymentSummary,
  type WorkerSnapshot,
} from './registry/summary.ts';
import type {
  InFlightTask,
  RoutingOptions,
  RoutingPolicy,
  WorkerDrainMutationResult,
  WorkerDrainOptions,
  WorkerHealth,
  WorkerInfo,
  WorkerRegistrationInfo,
  WorkerRegistryOptions,
  WorkerSummary,
} from './registry/types.ts';

export type { WorkerDeploymentSummary } from './registry/summary.ts';
export type {
  InFlightTask,
  RoutingOptions,
  RoutingPolicy,
  WorkerDrainMutationResult,
  WorkerDrainOptions,
  WorkerHealth,
  WorkerInfo,
  WorkerRegistrationInfo,
  WorkerRegistryOptions,
  WorkerSummary,
} from './registry/types.ts';

type DrainRecord = {
  reason?: string;
  startedAt: number;
};

/**
 * Server-side registry of connected remote workers with pluggable routing
 * policies. Tracks which workers are connected, which activities they support,
 * and how many tasks they have in flight. `findWorker` selects the best worker
 * for a given activity per the configured {@link RoutingPolicy} (default
 * `'least-loaded'`). Used internally by `serve()`; most applications access it
 * through {@link WeftServer.registry}.
 *
 * @example
 * ```ts
 * import { WorkerRegistry } from '@lostgradient/weft';
 * const registry = new WorkerRegistry({ policy: 'least-loaded' });
 * registry.register({ id: 'worker-1', queue: 'default', activities: ['sendEmail'], concurrency: 10 });
 * const best = registry.findWorker('sendEmail', { queue: 'default' });
 * ```
 */
export class WorkerRegistry {
  #workers: Map<string, WorkerInfo>;
  #inFlightTasks: Map<string, InFlightTask>;
  #deploymentDrainStates: Map<string, DrainRecord>;
  #policy: RoutingPolicy;
  /** Keyed by `${queue}::${activity}` — independent cursors per (queue, activity) pair. */
  #roundRobinCursor: Map<string, number>;
  /** Per-worker, per-key in-flight counts for fair-share routing. */
  #fairShareCounts: FairShareCounters;

  constructor(options?: WorkerRegistryOptions) {
    this.#workers = new Map();
    this.#inFlightTasks = new Map();
    this.#deploymentDrainStates = new Map();
    this.#policy = options?.policy ?? 'least-loaded';
    this.#roundRobinCursor = new Map();
    this.#fairShareCounts = new FairShareCounters();
  }

  /** The routing policy this registry was configured with. */
  get policy(): RoutingPolicy {
    return this.#policy;
  }

  /** Register a worker. */
  register(info: WorkerRegistrationInfo): void {
    const now = Date.now();
    // Reconnect during grace preserves in-flight tasks under the same workerId;
    // derive `inFlight` rather than resetting to 0 so concurrency limits hold.
    let inFlight = 0;
    for (const task of this.#inFlightTasks.values()) if (task.workerId === info.id) inFlight += 1;
    this.#workers.set(info.id, {
      id: info.id,
      queue: info.queue,
      activities: [...info.activities],
      concurrency: info.concurrency,
      ...(info.deploymentName !== undefined ? { deploymentName: info.deploymentName } : {}),
      ...(info.buildId !== undefined ? { buildId: info.buildId } : {}),
      ...(info.runtimeVersion !== undefined ? { runtimeVersion: info.runtimeVersion } : {}),
      ...(info.gitSha !== undefined ? { gitSha: info.gitSha } : {}),
      startedAt: info.startedAt ?? now,
      capabilities: { ...info.capabilities },
      inFlight,
      connectedAt: now,
      lastHeartbeat: now,
    });
  }

  /** Unregister a worker. Purges fair-share counters and in-flight task entries for this worker. */
  unregister(workerId: string): WorkerInfo | undefined {
    const info = this.#workers.get(workerId);
    if (info === undefined) return undefined;

    this.#workers.delete(workerId);
    this.#fairShareCounts.purge(workerId);

    // Map iteration is safe while deleting: ECMAScript §23.1.3.5 guarantees
    // already-visited entries are not revisited and pre-visit deletes are skipped.
    for (const [operationId, task] of this.#inFlightTasks) {
      if (task.workerId === workerId) this.#inFlightTasks.delete(operationId);
    }

    return info;
  }

  /** Record a heartbeat from a worker. */
  heartbeat(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.lastHeartbeat = Date.now();
    }
  }

  /** Increment in-flight count for a worker. */
  taskAssigned(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.inFlight += 1;
    }
  }

  /** Decrement in-flight count. */
  taskCompleted(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info !== undefined) {
      info.inFlight = Math.max(0, info.inFlight - 1);
    }
  }

  /**
   * Find the best worker for a task using the configured {@link RoutingPolicy}.
   *
   * Common preconditions for every policy:
   * 1. If `options.queue` is set, only workers on that queue are considered.
   * 2. Only workers that advertise `activityName` in their `activities` list are
   *    considered.
   * 3. Workers at `inFlight >= concurrency` are excluded.
   * 4. A `sticky` worker that also satisfies the above wins regardless of policy.
   */
  findWorker(activityName: string, options: RoutingOptions = {}): WorkerInfo | undefined {
    const { queue, sticky: stickyId, fairShareKey, excludeWorkerIds } = options;
    const eligible: WorkerInfo[] = [];
    let stickyCandidate: WorkerInfo | undefined;
    for (const worker of this.#workers.values()) {
      if (!this.#workerIsEligible(worker, activityName, queue, excludeWorkerIds)) continue;
      if (stickyId !== undefined && worker.id === stickyId) stickyCandidate = worker;
      eligible.push(worker);
    }
    if (stickyCandidate !== undefined) return stickyCandidate;
    if (eligible.length === 0) return undefined;
    return this.#selectByPolicy(eligible, queue, activityName, fairShareKey);
  }

  #workerIsEligible(
    worker: WorkerInfo,
    activityName: string,
    queue: string | undefined,
    excludeWorkerIds: ReadonlySet<string> | undefined,
  ): boolean {
    if (excludeWorkerIds?.has(worker.id)) return false;
    if (!matchesWorkerCapabilities(worker, activityName, queue)) return false;
    if (this.#isWorkerDraining(worker)) return false;
    return true;
  }

  /** Dispatch to the configured routing policy. Called only when `eligible` is non-empty. */
  #selectByPolicy(
    eligible: WorkerInfo[],
    queue: string | undefined,
    activityName: string,
    fairShareKey: string | undefined,
  ): WorkerInfo {
    if (this.#policy === 'round-robin') {
      return pickRoundRobin(eligible, this.#roundRobinCursor, queue, activityName);
    }
    if (this.#policy === 'fair-share' && fairShareKey !== undefined) {
      return pickFairShare(eligible, this.#fairShareCounts, fairShareKey);
    }
    return pickLeastLoaded(eligible);
  }

  /** Track a task assignment with a visibility timeout deadline. */
  assignTask(
    workerId: string,
    operationId: string,
    visibilityTimeout: number,
    fairShareKey: string | undefined,
    attemptToken: string,
  ): void {
    const deadline = Date.now() + visibilityTimeout;

    const task: InFlightTask = {
      operationId,
      workerId,
      deadline,
      visibilityTimeout,
      attemptToken,
    };
    if (fairShareKey !== undefined) {
      task.fairShareKey = fairShareKey;
      this.#fairShareCounts.increment(workerId, fairShareKey);
    }
    this.#inFlightTasks.set(operationId, task);

    this.taskAssigned(workerId);
  }

  /** Return tasks whose deadline has passed and remove them from tracking. */
  checkExpiredTasks(now: number): InFlightTask[] {
    const expired: InFlightTask[] = [];

    for (const task of this.#inFlightTasks.values()) {
      if (task.deadline <= now) {
        expired.push(task);
      }
    }

    for (const task of expired) {
      this.#inFlightTasks.delete(task.operationId);
      this.#releaseFairShare(task);
    }

    return expired;
  }

  /**
   * Reset the deadline for an in-flight task to `now + extension`. Returns the
   * new deadline, or `undefined` if the task was not found.
   */
  extendVisibility(operationId: string, extension: number): number | undefined {
    const task = this.#inFlightTasks.get(operationId);
    if (task === undefined) return undefined;
    task.deadline = Date.now() + extension;
    return task.deadline;
  }

  /** Return all in-flight tasks assigned to a given worker. */
  getWorkerTasks(workerId: string): InFlightTask[] {
    const tasks: InFlightTask[] = [];
    for (const task of this.#inFlightTasks.values()) {
      if (task.workerId === workerId) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /** True when `operationId` is in flight on `workerId` — used at the trust boundary to reject stale completions after takeover. */
  isAssignedToWorker(operationId: string, workerId: string): boolean {
    return this.#inFlightTasks.get(operationId)?.workerId === workerId;
  }

  /**
   * True when `operationId` is in flight on `workerId` for the specific dispatch
   * attempt identified by `attemptToken`. Layered after {@link isAssignedToWorker}
   * to reject a stale completion from an EARLIER attempt that was reassigned to the
   * same worker — the only case the workerId guard alone cannot catch.
   *
   * The workerId and token must both match the current assignment exactly.
   */
  isAssignedToAttempt(operationId: string, workerId: string, attemptToken: string): boolean {
    const task = this.#inFlightTasks.get(operationId);
    if (task === undefined || task.workerId !== workerId) {
      return false;
    }
    return task.attemptToken === attemptToken;
  }

  /** Check whether an operation is currently assigned to a worker. */
  isAssigned(operationId: string): boolean {
    return this.#inFlightTasks.has(operationId);
  }

  /** Look up an in-flight task by operationId in O(1). */
  getTask(operationId: string): InFlightTask | undefined {
    return this.#inFlightTasks.get(operationId);
  }

  /** Complete an in-flight task: remove tracking and decrement the worker's counter. */
  completeTask(operationId: string): InFlightTask | undefined {
    const task = this.#inFlightTasks.get(operationId);
    if (task === undefined) return undefined;

    this.#inFlightTasks.delete(operationId);
    this.taskCompleted(task.workerId);
    this.#releaseFairShare(task);
    return task;
  }

  /** Look up a worker by ID. */
  getWorker(workerId: string): WorkerInfo | undefined {
    return this.#workers.get(workerId);
  }

  /** Get all registered workers. */
  getAll(): WorkerInfo[] {
    return [...this.#workers.values()];
  }

  /** Mark one connected worker as draining so routing excludes it from new tasks. */
  markWorkerDraining(
    workerId: string,
    options?: WorkerDrainOptions,
  ): WorkerDrainMutationResult | undefined {
    const worker = this.#workers.get(workerId);
    if (worker === undefined) return undefined;

    const record = createDrainRecord(options);
    worker.drainStartedAt = record.startedAt;
    if (record.reason !== undefined) {
      worker.drainReason = record.reason;
    } else {
      delete worker.drainReason;
    }

    return {
      target: 'worker',
      workerId,
      affectedWorkers: 1,
      inFlight: worker.inFlight,
      health: this.#workerHealth(worker),
    };
  }

  /** Clear an explicit worker drain marker. Deployment-level drains can still apply. */
  clearWorkerDrain(workerId: string): WorkerDrainMutationResult | undefined {
    const worker = this.#workers.get(workerId);
    if (worker === undefined) return undefined;

    delete worker.drainReason;
    delete worker.drainStartedAt;

    return {
      target: 'worker',
      workerId,
      affectedWorkers: 1,
      inFlight: worker.inFlight,
      health: this.#workerHealth(worker),
    };
  }

  /** Mark every current and future worker with this deployment name as draining. */
  markDeploymentDraining(
    deploymentName: string,
    options?: WorkerDrainOptions,
  ): WorkerDrainMutationResult {
    const record = createDrainRecord(options);
    this.#deploymentDrainStates.set(deploymentName, record);
    return this.#deploymentDrainResult(deploymentName);
  }

  /** Clear the deployment-level drain marker for matching current and future workers. */
  clearDeploymentDrain(deploymentName: string): WorkerDrainMutationResult {
    this.#deploymentDrainStates.delete(deploymentName);
    return this.#deploymentDrainResult(deploymentName);
  }

  /**
   * Stable, sorted-by-id snapshot of every connected worker for the public
   * `weft.workers.list` operation. The caller passes a per-request `now`
   * so heartbeat ages across the response use one consistent clock; the
   * same `now` should be reused by the task-queue operation when both run
   * in the same request to keep the join honest.
   */
  getWorkerSummaries(now: number): WorkerSummary[] {
    return projectWorkerSummaries(this.#workerSnapshots(), now);
  }

  /** Build a plain-object snapshot of all workers with computed health. */
  #workerSnapshots(): WorkerSnapshot[] {
    return [...this.#workers.values()].map((worker) => ({
      id: worker.id,
      queue: worker.queue,
      activities: worker.activities,
      concurrency: worker.concurrency,
      inFlight: worker.inFlight,
      connectedAt: worker.connectedAt,
      lastHeartbeat: worker.lastHeartbeat,
      startedAt: worker.startedAt,
      capabilities: worker.capabilities,
      health: this.#workerHealth(worker),
      deploymentName: worker.deploymentName,
      buildId: worker.buildId,
      runtimeVersion: worker.runtimeVersion,
      gitSha: worker.gitSha,
    }));
  }

  /**
   * Deployment-group snapshot for operator views. Workers without deployment
   * metadata are grouped together under `null` identity fields so anonymous
   * fleets remain visible without inventing placeholder names.
   */
  getDeploymentSummaries(_now: number): WorkerDeploymentSummary[] {
    const snapshots = this.#workerSnapshots();
    return projectDeploymentSummaries(snapshots, (name) => this.#deploymentDrainStates.has(name));
  }

  /** Get worker count. */
  get size(): number {
    return this.#workers.size;
  }

  #deploymentDrainResult(deploymentName: string): WorkerDrainMutationResult {
    const workers = [...this.#workers.values()].filter(
      (worker) => worker.deploymentName === deploymentName,
    );
    const inFlight = workers.reduce((total, worker) => total + worker.inFlight, 0);
    const healthValues = workers.map((worker) => this.#workerHealth(worker));
    return {
      target: 'deployment',
      deploymentName,
      affectedWorkers: workers.length,
      inFlight,
      health: deploymentHealth(healthValues, this.#deploymentDrainStates.has(deploymentName)),
    };
  }

  #isWorkerDraining(worker: WorkerInfo): boolean {
    return this.#drainRecordForWorker(worker) !== undefined;
  }

  #workerHealth(worker: WorkerInfo): WorkerHealth {
    if (!this.#isWorkerDraining(worker)) return 'active';
    return worker.inFlight > 0 ? 'draining' : 'drained';
  }

  #drainRecordForWorker(worker: WorkerInfo): DrainRecord | undefined {
    if (worker.drainStartedAt !== undefined) {
      return {
        startedAt: worker.drainStartedAt,
        ...(worker.drainReason !== undefined ? { reason: worker.drainReason } : {}),
      };
    }
    if (worker.deploymentName === undefined) return undefined;
    return this.#deploymentDrainStates.get(worker.deploymentName);
  }

  /** Decrement the fair-share count for a completed or expired task. */
  #releaseFairShare(task: InFlightTask): void {
    if (task.fairShareKey === undefined) return;
    this.#fairShareCounts.release(task.workerId, task.fairShareKey);
  }
}

function createDrainRecord(options?: WorkerDrainOptions): DrainRecord {
  return {
    startedAt: options?.updatedAt ?? Date.now(),
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
  };
}
