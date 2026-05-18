// Server-side worker tracking and pluggable routing policies.
import { compareScores, scoreWorker } from './registry/fair-share.ts';
import { matchesWorkerCapabilities, pickLeastLoaded } from './registry/routing.ts';
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
 * policies.
 *
 * Tracks which workers are connected, which activities they support, and how
 * many tasks they have in flight.  The `findWorker` method selects the best
 * worker for a given activity according to the configured {@link RoutingPolicy}
 * (`'least-loaded'` by default).  Used internally by `serve()` — most
 * applications access it through {@link WeftServer.registry}.
 *
 * @example
 * ```ts
 * import { WorkerRegistry } from 'weft';
 *
 * const registry = new WorkerRegistry({ policy: 'least-loaded' });
 *
 * registry.register({
 *   id: 'worker-1',
 *   queue: 'default',
 *   activities: ['sendEmail'],
 *   concurrency: 10,
 * });
 *
 * const best = registry.findWorker('sendEmail', { queue: 'default' });
 * console.log(best?.id); // 'worker-1'
 * ```
 */
export class WorkerRegistry {
  #workers: Map<string, WorkerInfo>;
  #inFlightTasks: Map<string, InFlightTask>;
  #deploymentDrainStates: Map<string, DrainRecord>;
  #policy: RoutingPolicy;
  /** Keyed by `${queue}::${activity}` — independent cursors per (queue, activity) pair. */
  #roundRobinCursor: Map<string, number>;
  /** Per-worker, per-key in-flight counts for fair-share routing. Outer key = workerId. */
  #fairShareCounts: Map<string, Map<string, number>>;

  constructor(options?: WorkerRegistryOptions) {
    this.#workers = new Map();
    this.#inFlightTasks = new Map();
    this.#deploymentDrainStates = new Map();
    this.#policy = options?.policy ?? 'least-loaded';
    this.#roundRobinCursor = new Map();
    this.#fairShareCounts = new Map();
  }

  /** The routing policy this registry was configured with. */
  get policy(): RoutingPolicy {
    return this.#policy;
  }

  /** Register a worker. */
  register(info: WorkerRegistrationInfo): void {
    const now = Date.now();

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
      inFlight: 0,
      connectedAt: now,
      lastHeartbeat: now,
    });
  }

  /**
   * Unregister a worker and return its info. Purges fair-share counters and
   * in-flight task entries for this worker to avoid stale registry state after
   * crash recovery or forced removal.
   */
  unregister(workerId: string): WorkerInfo | undefined {
    const info = this.#workers.get(workerId);
    if (info === undefined) return undefined;

    this.#workers.delete(workerId);
    this.#fairShareCounts.delete(workerId);

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
    const { queue, sticky: stickyId, fairShareKey } = options;

    const eligible: WorkerInfo[] = [];
    let stickyCandidate: WorkerInfo | undefined;

    for (const worker of this.#workers.values()) {
      if (!matchesWorkerCapabilities(worker, activityName, queue)) continue;
      if (this.#isWorkerDraining(worker)) continue;
      if (stickyId !== undefined && worker.id === stickyId) stickyCandidate = worker;
      eligible.push(worker);
    }

    if (stickyCandidate !== undefined) return stickyCandidate;
    if (eligible.length === 0) return undefined;
    return this.#selectByPolicy(eligible, queue, activityName, fairShareKey);
  }

  /** Dispatch to the configured routing policy. Called only when `eligible` is non-empty. */
  #selectByPolicy(
    eligible: WorkerInfo[],
    queue: string | undefined,
    activityName: string,
    fairShareKey: string | undefined,
  ): WorkerInfo {
    if (this.#policy === 'round-robin') {
      return this.#pickRoundRobin(eligible, queue, activityName);
    }
    if (this.#policy === 'fair-share' && fairShareKey !== undefined) {
      return this.#pickFairShare(eligible, fairShareKey);
    }
    return pickLeastLoaded(eligible);
  }

  /** Round-robin with a per-(queue, activity) cursor so two activities sharing a queue don't interfere. */
  #pickRoundRobin(
    eligible: WorkerInfo[],
    queue: string | undefined,
    activityName: string,
  ): WorkerInfo {
    const key = `${queue ?? '__default__'}::${activityName}`;
    const cursor = this.#roundRobinCursor.get(key) ?? 0;
    const pick = eligible[cursor % eligible.length]!;
    this.#roundRobinCursor.set(key, cursor + 1);
    return pick;
  }

  /**
   * Fair-share: fewest in-flight tasks for `fairShareKey` wins. Ties broken by
   * overall inFlight then stable id order. Snapshot is built synchronously so
   * the ranking is consistent across the full candidate set.
   */
  #pickFairShare(eligible: WorkerInfo[], fairShareKey: string): WorkerInfo {
    const scores = eligible.map((worker) =>
      scoreWorker({
        id: worker.id,
        inFlight: worker.inFlight,
        keyLoad: this.#fairShareCounts.get(worker.id)?.get(fairShareKey) ?? 0,
      }),
    );
    const winner = scores.reduce((best, candidate) =>
      compareScores(candidate, best) < 0 ? candidate : best,
    );
    return this.#workers.get(winner.id)!;
  }

  /** Track a task assignment with a visibility timeout deadline. */
  assignTask(
    workerId: string,
    operationId: string,
    visibilityTimeout: number,
    fairShareKey?: string,
  ): void {
    const deadline = Date.now() + visibilityTimeout;

    const task: InFlightTask = {
      operationId,
      workerId,
      deadline,
      visibilityTimeout,
    };
    if (fairShareKey !== undefined) {
      task.fairShareKey = fairShareKey;
      let workerCounts = this.#fairShareCounts.get(workerId);
      if (workerCounts === undefined) {
        workerCounts = new Map();
        this.#fairShareCounts.set(workerId, workerCounts);
      }
      workerCounts.set(fairShareKey, (workerCounts.get(fairShareKey) ?? 0) + 1);
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
    const workerCounts = this.#fairShareCounts.get(task.workerId);
    if (workerCounts === undefined) return;
    const current = workerCounts.get(task.fairShareKey) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      workerCounts.delete(task.fairShareKey);
      if (workerCounts.size === 0) {
        this.#fairShareCounts.delete(task.workerId);
      }
    } else {
      workerCounts.set(task.fairShareKey, next);
    }
  }
}

function createDrainRecord(options?: WorkerDrainOptions): DrainRecord {
  return {
    startedAt: options?.updatedAt ?? Date.now(),
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
  };
}
