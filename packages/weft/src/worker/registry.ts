/* oxlint-disable max-lines -- Worker lifecycle, leases, and routing share one cohesive registry state machine. */
// Server-side worker tracking and pluggable routing policies.
import { WorkerRegistrationRejectedEvent } from '../core/events/fleet-state-events.ts';
import { workerDeploymentRolloutBucket } from './deployment-routing.ts';
import { DepartedWorkers } from './registry/departed.ts';
import {
  DeploymentConsistencyGuard,
  type DeploymentConsistencyResult,
} from './registry/deployment-consistency.ts';
import {
  createDrainRecord,
  deleteBuildDrain,
  drainProgressOf,
  drainRecordForWorker,
  getBuildDrain,
  isWorkerDraining,
  setBuildDrain,
  workerHealth,
  type BuildDrainMarkers,
  type DrainRecord,
  type DrainStates,
} from './registry/drain.ts';
import { FairShareCounters } from './registry/fair-share.ts';
import {
  appendRegistrationRejection,
  recentRegistrationRejections,
  type RegistrationRejectionEntry,
} from './registry/rejections.ts';
import {
  matchesWorkerCapabilities,
  pickFairShare,
  pickLeastLoaded,
  pickRoundRobin,
  workerMatchesRequirement,
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
  WorkerSessionIdentity,
  WorkerSummary,
} from './registry/types.ts';

export type { RegistrationRejectionEntry } from './registry/rejections.ts';
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
  WorkerSessionIdentity,
  WorkerSummary,
  WorkerTransport,
} from './registry/types.ts';

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
 * import { WorkerRegistry, type WorkerManifest } from '@lostgradient/weft';
 *
 * const manifest: WorkerManifest = {
 *   manifestVersion: 1,
 *   protocolVersion: 6,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *   workflows: {},
 *   capabilities: {},
 * };
 *
 * const registry = new WorkerRegistry({ policy: 'least-loaded' });
 * registry.register({
 *   id: 'worker-1',
 *   queue: 'default',
 *   activities: ['sendEmail'],
 *   concurrency: 10,
 *   manifest,
 *   acceptedManifestDigest: 'sha256:deadbeef',
 * });
 * const best = registry.findWorker('sendEmail', { queue: 'default' });
 * ```
 */
export class WorkerRegistry {
  #workers: Map<string, WorkerInfo>;
  #inFlightTasks: Map<string, InFlightTask>;
  #deploymentDrainStates: Map<string, DrainRecord>;
  #buildDrainStates: BuildDrainMarkers;
  #policy: RoutingPolicy;
  /** Keyed by `${queue}::${activity}` — independent cursors per (queue, activity) pair. */
  #roundRobinCursor: Map<string, number>;
  /** Per-worker, per-key in-flight counts for fair-share routing. */
  #fairShareCounts: FairShareCounters;
  /** One `(deploymentName, buildId)` pair never registers two artifact digests. */
  #deploymentConsistency: DeploymentConsistencyGuard;
  /** Bounded, in-memory log of declined `register` attempts (WFT-29). */
  #rejections: RegistrationRejectionEntry[];
  #dispatchEvent: ((event: Event) => void) | undefined;
  /** Workers that went away and are still listed, and drained workers an operator forgot. */
  #departed: DepartedWorkers;

  constructor(options?: WorkerRegistryOptions) {
    this.#workers = new Map();
    this.#inFlightTasks = new Map();
    this.#deploymentDrainStates = new Map();
    this.#buildDrainStates = new Map();
    this.#policy = options?.policy ?? 'least-loaded';
    this.#roundRobinCursor = new Map();
    this.#fairShareCounts = new FairShareCounters();
    this.#deploymentConsistency = new DeploymentConsistencyGuard();
    this.#rejections = [];
    this.#departed = new DepartedWorkers();
    this.#dispatchEvent = options?.dispatchEvent;
  }

  /** The routing policy this registry was configured with. */
  get policy(): RoutingPolicy {
    return this.#policy;
  }

  /**
   * Read-only check of a manifest's `(deploymentName, buildId,
   * artifactDigest)` against digests previously seen for that deployment and
   * build. Callers with a later rejection gate must call
   * {@link recordDeploymentConsistency} only once every such gate has
   * passed, so a declined worker cannot poison a deployment/build slot.
   */
  checkDeploymentConsistency(
    deploymentName: string,
    buildId: string,
    artifactDigest: string,
  ): DeploymentConsistencyResult {
    return this.#deploymentConsistency.check(deploymentName, buildId, artifactDigest);
  }

  /** Record `artifactDigest` for `(deploymentName, buildId)` once every rejection gate has passed. */
  recordDeploymentConsistency(
    deploymentName: string,
    buildId: string,
    artifactDigest: string,
  ): void {
    this.#deploymentConsistency.record(deploymentName, buildId, artifactDigest);
  }

  /**
   * Register a worker.
   *
   * `resumingSessionGeneration` (COR-220) names the generation the CALLER has
   * already verified this registration is a PROVEN resume of — the caller
   * (`commitWorkerRegistration`) is the one that checks a `register` frame's
   * `resumeSessionGeneration` echo against the pending disconnected session's
   * generation and a still-live grace window; this method only ever trusts
   * that decision, it never re-derives it. When it is supplied AND still
   * matches the current session's generation at the moment this call
   * actually commits (the two can only differ if the caller's earlier check
   * has gone stale — see the doc comment on the generation line below), the
   * session's generation is left UNCHANGED — a proven resume is the same
   * session continuing, not a new one — and `inFlight` is derived from
   * whatever is still tracked for this `workerId`, exactly as before COR-220,
   * so its in-flight attempts and their leases are untouched. Any other case
   * (omitted, or genuinely stale) is an ordinary new session: `inFlight` is
   * still derived from `#inFlightTasks` for compatibility with any caller
   * that has not yet released them, but a caller taking the unproven-forfeit
   * path must call `unregister()`/release its in-flight tasks BEFORE this,
   * or the fresh session's derived `inFlight` count double-counts work that
   * is about to be reassigned elsewhere.
   */
  register(info: WorkerRegistrationInfo, resumingSessionGeneration?: number): void {
    const now = Date.now();
    // Reconnect during grace preserves in-flight tasks under the same workerId;
    // derive `inFlight` rather than resetting to 0 so concurrency limits hold.
    let inFlight = 0;
    for (const task of this.#inFlightTasks.values()) if (task.workerId === info.id) inFlight += 1;
    // Session generation (COR-230, widened COR-220): every accepted
    // `register()` for this `workerId` is a NEW session UNLESS the caller has
    // already proven this is a resume of the CURRENT session — the only case
    // that leaves the generation unchanged. Starts at 1 rather than 0 so an
    // absent prior session reads as "session #1", not "session #0".
    const currentGeneration = this.#workers.get(info.id)?.sessionGeneration;
    const sessionGeneration =
      resumingSessionGeneration !== undefined && resumingSessionGeneration === currentGeneration
        ? resumingSessionGeneration
        : (currentGeneration ?? 0) + 1;
    // A worker that registers is connected, so nothing lists it as gone, and a forget no longer applies.
    this.#departed.clear(info.id);
    this.#workers.set(info.id, {
      id: info.id,
      queue: info.queue,
      transport: info.transport ?? 'websocket',
      activities: [...info.activities],
      concurrency: info.concurrency,
      ...(info.deploymentName !== undefined ? { deploymentName: info.deploymentName } : {}),
      ...(info.buildId !== undefined ? { buildId: info.buildId } : {}),
      ...(info.runtimeVersion !== undefined ? { runtimeVersion: info.runtimeVersion } : {}),
      manifest: info.manifest,
      acceptedManifestDigest: info.acceptedManifestDigest,
      startedAt: info.startedAt ?? now,
      capabilities: { ...info.capabilities },
      inFlight,
      connectedAt: now,
      lastHeartbeat: now,
      sessionGeneration,
    });
  }

  /**
   * The {@link WorkerSessionIdentity} of the currently connected session for
   * `workerId`, or `undefined` if no session is currently registered —
   * `unregister()`'d, never registered, or a stale generation that has
   * since been superseded (this always reflects the CURRENT one, by
   * construction, since `#workers` holds exactly one entry per `workerId`).
   */
  sessionIdentity(workerId: string): WorkerSessionIdentity | undefined {
    const info = this.#workers.get(workerId);
    if (info === undefined) return undefined;
    return {
      workerId: info.id,
      sessionGeneration: info.sessionGeneration,
      manifestDigest: info.acceptedManifestDigest,
      transport: info.transport,
    };
  }

  /** Unregister a worker. Purges fair-share counters and in-flight task entries for this worker. */
  unregister(workerId: string): WorkerInfo | undefined {
    const info = this.#workers.get(workerId);
    if (info === undefined) return undefined;

    // Kept, as it stood, so the list can say the worker went away rather than lose it.
    this.#departed.record(this.#snapshotOf(info), Date.now());
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

  /**
   * Decrement in-flight count. While the worker drains, the task is counted as finished under the
   * drain, and the moment nothing is left in flight is recorded as when the drain finished.
   */
  taskCompleted(workerId: string): void {
    const info = this.#workers.get(workerId);
    if (info === undefined) return;
    info.inFlight = Math.max(0, info.inFlight - 1);
    const drain = drainRecordForWorker(info, this.#drainStates);
    if (drain === undefined) {
      delete info.drainCountedFrom;
      delete info.drainFinishedTasks;
      delete info.drainedAt;
      return;
    }
    if (info.drainCountedFrom !== drain.startedAt) {
      info.drainCountedFrom = drain.startedAt;
      info.drainFinishedTasks = 0;
      delete info.drainedAt;
    }
    info.drainFinishedTasks = (info.drainFinishedTasks ?? 0) + 1;
    if (info.inFlight === 0) info.drainedAt = Date.now();
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
    const eligible = this.#eligibleWorkers(activityName, options);
    const sticky = eligible.find((worker) => worker.id === options.sticky);
    if (sticky !== undefined) return sticky;
    if (eligible.length === 0) return undefined;
    return this.#selectByPolicy(eligible, options.queue, activityName, options.fairShareKey);
  }

  /**
   * Whether {@link findWorker} has an eligible worker that `include` accepts,
   * without running the routing policy — so asking never advances round-robin
   * or fair-share state.
   */
  hasEligibleWorker(
    activityName: string,
    options: RoutingOptions = {},
    include: (worker: WorkerInfo) => boolean = () => true,
  ): boolean {
    return this.#eligibleWorkers(activityName, options).some(include);
  }

  #eligibleWorkers(activityName: string, options: RoutingOptions): WorkerInfo[] {
    return [...this.#workers.values()].filter((worker) =>
      this.#workerIsEligible(worker, activityName, options),
    );
  }

  #workerIsEligible(
    worker: WorkerInfo,
    activityName: string,
    {
      queue,
      excludeWorkerIds,
      executionRequirement,
      deploymentRouting,
      workflowId,
    }: RoutingOptions,
  ): boolean {
    if (excludeWorkerIds?.has(worker.id)) return false;
    if (!matchesWorkerCapabilities(worker, activityName, queue)) return false;
    if (isWorkerDraining(worker, this.#drainStates)) return false;
    if (
      executionRequirement !== undefined &&
      !workerMatchesRequirement(worker, executionRequirement, activityName)
    )
      return false;
    if (deploymentRouting !== undefined) {
      const bucket = workerDeploymentRolloutBucket(
        deploymentRouting.deploymentName,
        workflowId ?? activityName,
        deploymentRouting.generation,
      );
      const selectedBuild =
        deploymentRouting.rampingBuildId !== undefined && bucket < deploymentRouting.rampBasisPoints
          ? deploymentRouting.rampingBuildId
          : deploymentRouting.currentBuildId;
      if (worker.manifest.deployment.name !== deploymentRouting.deploymentName) return false;
      if (worker.manifest.deployment.buildId !== selectedBuild) return false;
    }
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
    workflowRevision?: string,
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
    if (workflowRevision !== undefined) {
      task.workflowRevision = workflowRevision;
    }
    this.#inFlightTasks.set(operationId, task);

    this.taskAssigned(workerId);
  }

  /**
   * Undo exactly `assignTask`'s effects — capacity increment, fair-share
   * count, and the in-flight entry — when the durable claim that was
   * supposed to follow the reservation never committed. Distinct from
   * {@link completeTask} even though the body is identical: this path means
   * "the reservation was never realized," not "the task finished," and
   * keeping the names apart stops a reader from mistaking an aborted claim
   * for a normal completion at the call site.
   */
  releaseReservation(operationId: string): InFlightTask | undefined {
    const task = this.#inFlightTasks.get(operationId);
    if (task === undefined) return undefined;

    this.#inFlightTasks.delete(operationId);
    this.taskCompleted(task.workerId);
    this.#releaseFairShare(task);
    return task;
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

  /** Record one declined `register` attempt, evicting the oldest once the bounded log is full. */
  recordRejection(entry: RegistrationRejectionEntry): void {
    appendRegistrationRejection(this.#rejections, entry);
    this.#dispatchEvent?.(new WorkerRegistrationRejectedEvent(entry.workerId, entry.code));
  }

  /** Return the `limit` most recently recorded rejections, newest first. */
  getRecentRejections(limit: number): RegistrationRejectionEntry[] {
    return recentRegistrationRejections(this.#rejections, limit);
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
      health: workerHealth(worker, this.#drainStates),
    };
  }

  /** Clear an explicit worker drain marker. Deployment-level drains can still apply. */
  clearWorkerDrain(workerId: string): WorkerDrainMutationResult | undefined {
    const worker = this.#workers.get(workerId);
    if (worker === undefined) return undefined;

    delete worker.drainReason;
    delete worker.drainStartedAt;
    this.#departed.restore(workerId);

    return {
      target: 'worker',
      workerId,
      affectedWorkers: 1,
      inFlight: worker.inFlight,
      health: workerHealth(worker, this.#drainStates),
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
   * Mark every current and future worker of one build as draining, leaving the
   * deployment's other builds routable. A deployment-level marker still covers
   * the build too, so draining a build never overrides a wider drain.
   */
  markBuildDraining(
    deploymentName: string,
    buildId: string,
    options?: WorkerDrainOptions,
  ): WorkerDrainMutationResult {
    setBuildDrain(this.#buildDrainStates, deploymentName, buildId, createDrainRecord(options));
    return this.#buildDrainResult(deploymentName, buildId);
  }

  /**
   * Drain one build only if no marker is set, so an operator's own reason and start time survive
   * a worker of the build registering again. Used when the deployment catalog already records the
   * build as draining or removed.
   */
  ensureBuildDraining(deploymentName: string, buildId: string, options?: WorkerDrainOptions): void {
    if (getBuildDrain(this.#buildDrainStates, deploymentName, buildId) === undefined) {
      setBuildDrain(this.#buildDrainStates, deploymentName, buildId, createDrainRecord(options));
    }
  }

  /**
   * Clear one build's drain marker. A deployment-level or worker-level marker
   * that still applies keeps the affected workers drained.
   */
  clearBuildDrain(deploymentName: string, buildId: string): WorkerDrainMutationResult {
    deleteBuildDrain(this.#buildDrainStates, deploymentName, buildId);
    return this.#buildDrainResult(deploymentName, buildId);
  }

  /**
   * Drain state of one deployment, or of one of its builds when `buildId` is given, as the
   * deployment drain operations report it. `'active'` when no marker applies, including when no
   * worker of the deployment is connected.
   */
  deploymentDrainState(deploymentName: string, buildId?: string): WorkerHealth {
    return (
      buildId === undefined
        ? this.#deploymentDrainResult(deploymentName)
        : this.#buildDrainResult(deploymentName, buildId)
    ).health;
  }

  get #drainStates(): DrainStates {
    return { deployments: this.#deploymentDrainStates, builds: this.#buildDrainStates };
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
    return [...this.#workers.values()].map((worker) => this.#snapshotOf(worker));
  }

  #snapshotOf(worker: WorkerInfo): WorkerSnapshot {
    return {
      id: worker.id,
      queue: worker.queue,
      transport: worker.transport,
      activities: worker.activities,
      concurrency: worker.concurrency,
      inFlight: worker.inFlight,
      connectedAt: worker.connectedAt,
      lastHeartbeat: worker.lastHeartbeat,
      startedAt: worker.startedAt,
      capabilities: worker.capabilities,
      health: workerHealth(worker, this.#drainStates),
      workflows: Object.keys(worker.manifest.workflows).toSorted(),
      deploymentName: worker.deploymentName,
      buildId: worker.buildId,
      runtimeVersion: worker.runtimeVersion,
      ...drainProgressOf(worker, this.#drainStates),
    };
  }

  /**
   * What `weft.workers.list` reports: every connected worker the operator has not forgotten, and
   * every worker that went away and has not been forgotten or registered again, sorted by id. A
   * worker that went away reads `disconnected`, with its last heartbeat as when it was last heard
   * from. Unlike {@link WorkerRegistry.getWorkerSummaries}, which is the live fleet that routing
   * and the queue totals count, this is the list an operator reads and manages.
   */
  getWorkerListing(now: number): WorkerSummary[] {
    const live = this.#workerSnapshots().filter(
      (snapshot) =>
        !(
          snapshot.health === 'drained' &&
          this.#departed.isForgotten(
            snapshot.id,
            this.#workers.get(snapshot.id)?.sessionGeneration ?? -1,
          )
        ),
    );
    const departed = this.#departed.list().map((entry) => entry.snapshot);
    return projectWorkerSummaries([...live, ...departed], now);
  }

  /**
   * Stop listing one worker. A worker that went away is dropped from the list; a connected worker
   * that finished draining is hidden until it registers again or is resumed. A connected worker
   * still taking work is refused, since forgetting it would not stop it.
   *
   * @returns `forgotten`, `connected` for a worker still routable or draining, or `undefined` when
   * no listed worker has that id.
   */
  forgetWorker(workerId: string): 'forgotten' | 'connected' | undefined {
    if (this.#departed.forgetDeparted(workerId)) return 'forgotten';
    const worker = this.#workers.get(workerId);
    if (worker === undefined) return undefined;
    if (workerHealth(worker, this.#drainStates) !== 'drained') return 'connected';
    this.#departed.forgetConnected(workerId, worker.sessionGeneration);
    return 'forgotten';
  }

  /**
   * Deployment-group snapshot for operator views. Workers without deployment
   * metadata are grouped together under `null` identity fields so anonymous
   * fleets remain visible without inventing placeholder names.
   */
  getDeploymentSummaries(_now: number): WorkerDeploymentSummary[] {
    const snapshots = this.#workerSnapshots();
    return projectDeploymentSummaries(
      snapshots,
      (name, buildId) =>
        this.#deploymentDrainStates.has(name) ||
        (buildId !== undefined &&
          getBuildDrain(this.#buildDrainStates, name, buildId) !== undefined),
    );
  }

  /** Get worker count. */
  get size(): number {
    return this.#workers.size;
  }

  #buildDrainResult(deploymentName: string, buildId: string): WorkerDrainMutationResult {
    const workers = [...this.#workers.values()].filter(
      (worker) => worker.deploymentName === deploymentName && worker.buildId === buildId,
    );
    const healthValues = workers.map((worker) => workerHealth(worker, this.#drainStates));
    const drainActive =
      this.#deploymentDrainStates.has(deploymentName) ||
      getBuildDrain(this.#buildDrainStates, deploymentName, buildId) !== undefined;
    return {
      target: 'deployment',
      deploymentName,
      buildId,
      affectedWorkers: workers.length,
      inFlight: workers.reduce((total, worker) => total + worker.inFlight, 0),
      health: deploymentHealth(healthValues, drainActive),
    };
  }

  #deploymentDrainResult(deploymentName: string): WorkerDrainMutationResult {
    const workers = [...this.#workers.values()].filter(
      (worker) => worker.deploymentName === deploymentName,
    );
    const inFlight = workers.reduce((total, worker) => total + worker.inFlight, 0);
    const healthValues = workers.map((worker) => workerHealth(worker, this.#drainStates));
    return {
      target: 'deployment',
      deploymentName,
      affectedWorkers: workers.length,
      inFlight,
      health: deploymentHealth(healthValues, this.#deploymentDrainStates.has(deploymentName)),
    };
  }

  /** Decrement the fair-share count for a completed or expired task. */
  #releaseFairShare(task: InFlightTask): void {
    if (task.fairShareKey === undefined) return;
    this.#fairShareCounts.release(task.workerId, task.fairShareKey);
  }
}
