/** Durable deployment versions and deterministic, revision-aware selection. */
import { storageConditionalBatch, type Storage } from "../embedded/storage/src/index.ts";
import { encode } from '../core/codec/index.ts';
import { hashString } from '../runtime/portable.ts';
import { countBuildReferences } from './deployment-build-references.ts';
import {
  decodeRouting,
  decodeVersion,
  routingKey,
  versionKey,
  WORKER_DEPLOYMENT_VERSION_PREFIX,
} from './deployment-records.ts';
import { removeWorkerDeploymentVersion } from './deployment-removal.ts';
import type { WorkerExecutionRequirement, WorkerManifest } from './manifest/types.ts';

export type WorkerDeploymentVersionState = 'ready' | 'draining' | 'removed';

export type WorkerDeploymentVersion = Readonly<{
  deploymentName: string;
  buildId: string;
  artifactDigest: string;
  manifestDigest: string;
  manifest: WorkerManifest;
  state: WorkerDeploymentVersionState;
  firstSeenAt: number;
}>;

/**
 * A version as the catalog reports it: `executionReferences` is computed from the durable work
 * that is bound to the build at the moment of the read (see `deployment-build-references.ts`),
 * never stored.
 */
export type WorkerDeploymentVersionReport = WorkerDeploymentVersion &
  Readonly<{ executionReferences: number }>;

/** Why a removal did not happen, or that it did. */
export type WorkerDeploymentRemovalOutcome =
  | Readonly<{ outcome: 'removed' }>
  | Readonly<{ outcome: 'not-found' }>
  | Readonly<{ outcome: 'not-draining'; state: WorkerDeploymentVersionState }>
  | Readonly<{ outcome: 'routed' }>
  | Readonly<{ outcome: 'referenced'; references: number }>
  | Readonly<{ outcome: 'busy' }>;

/**
 * A deployment's durable routing pointer: which build takes new unpinned traffic, which build
 * (if any) takes a share of it, and the generation every write is fenced by.
 */
export type WorkerDeploymentRouting = Readonly<{
  /** The deployment the pointer routes. */
  deploymentName: string;
  /** The build that takes the traffic the ramp does not. */
  currentBuildId: string;
  /** The build that takes `rampBasisPoints` of new unpinned traffic, when one is ramping. */
  rampingBuildId?: string;
  /** The ramping build's share of new unpinned traffic, from 0 to 10000. */
  rampBasisPoints: number;
  /**
   * The build that was current before the latest change of `currentBuildId`, which a rollback
   * returns to. Set by {@link WorkerDeploymentCatalog.setRouting} whenever the current build
   * changes and carried over unchanged by a write that keeps it, so a ramp never erases it. Absent
   * until the current build has changed once, and on every record written before the field existed.
   */
  previousBuildId?: string;
  /** Increases by one on every write; a write names the generation it read to fence itself. */
  generation: number;
  /** When the pointer was last written, in epoch milliseconds. */
  updatedAt: number;
}>;

/** What a caller of {@link WorkerDeploymentCatalog.setRouting} supplies: `previousBuildId` is derived. */
export type WorkerDeploymentRoutingWrite = Omit<
  WorkerDeploymentRouting,
  'generation' | 'previousBuildId'
> & { expectedGeneration?: number };

export type DeploymentRoutingCandidate = Readonly<{
  workerId: string;
  buildId: string;
  manifest: WorkerManifest;
  availableCapacity: number;
  draining?: boolean;
}>;

export type DeploymentSelection = Readonly<{
  candidate: DeploymentRoutingCandidate;
  buildId: string;
  generation: number;
}>;

export type DeploymentSelectionFailure = Readonly<{
  candidate: undefined;
  reason:
    | 'deployment-required'
    | 'version-unavailable'
    | 'revision-incompatible'
    | 'activity-incompatible'
    | 'no-capacity';
  deploymentName?: string;
  buildId?: string;
  workflowRevision?: string;
  message: string;
}>;

export type DeploymentSelectionResult = DeploymentSelection | DeploymentSelectionFailure;

/**
 * A build id registered again with an artifact or manifest digest that differs
 * from the stored one. Versions are immutable, so the second registration is
 * refused rather than overwriting the first.
 */
export class WorkerDeploymentVersionConflictError extends Error {
  constructor(deploymentName: string, buildId: string) {
    super(
      `Deployment version ${deploymentName}/${buildId} is immutable and conflicts with the stored identity.`,
    );
    this.name = 'WorkerDeploymentVersionConflictError';
  }
}

function bucket(deploymentName: string, workflowId: string, generation: number): number {
  return (
    Number.parseInt(
      hashString(`worker-rollout-v1\0${deploymentName}\0${workflowId}\0${generation}`).slice(-8),
      16,
    ) % 10_000
  );
}

export const workerDeploymentRolloutBucket = bucket;

function hasWorkflow(
  candidate: DeploymentRoutingCandidate,
  workflowRevision: string | undefined,
  activityName: string | undefined,
): boolean {
  if (workflowRevision === undefined && activityName === undefined) return true;
  const workflow = Object.values(candidate.manifest.workflows).find(
    (entry) => workflowRevision === undefined || entry.workflowRevision === workflowRevision,
  );
  if (workflow === undefined) return false;
  return activityName === undefined || Object.hasOwn(workflow.activities, activityName);
}

function matchesRequirement(
  candidate: DeploymentRoutingCandidate,
  requirement: WorkerExecutionRequirement,
): boolean {
  const deployment = candidate.manifest.deployment;
  return (
    (requirement.deploymentName === undefined || deployment.name === requirement.deploymentName) &&
    (requirement.buildId === undefined || deployment.buildId === requirement.buildId) &&
    (requirement.artifactDigest === undefined ||
      deployment.artifactDigest === requirement.artifactDigest) &&
    (requirement.workflowRevision === undefined ||
      Object.values(candidate.manifest.workflows).some(
        (w) => w.workflowRevision === requirement.workflowRevision,
      )) &&
    (requirement.activityContractHash === undefined ||
      Object.values(candidate.manifest.workflows).some((w) =>
        Object.values(w.activities).some(
          (a) => a.contractHash === requirement.activityContractHash,
        ),
      ))
  );
}

function selectedBuild(
  options: Readonly<{
    deploymentName: string;
    workflowId: string;
    requirement: WorkerExecutionRequirement;
    routing: WorkerDeploymentRouting;
  }>,
): string {
  if (options.requirement.buildId !== undefined) return options.requirement.buildId;
  const ramping = options.routing.rampingBuildId;
  const inRamp =
    ramping !== undefined &&
    bucket(options.deploymentName, options.workflowId, options.routing.generation) <
      options.routing.rampBasisPoints;
  return inRamp ? ramping : options.routing.currentBuildId;
}

function selectionFailure(
  options: Readonly<{
    deploymentName: string;
    buildId: string;
    requirement: WorkerExecutionRequirement;
    candidates: readonly DeploymentRoutingCandidate[];
    activityName?: string;
  }>,
): DeploymentSelectionFailure {
  const compatible = options.candidates.some(
    (candidate) =>
      candidate.buildId === options.buildId &&
      hasWorkflow(candidate, options.requirement.workflowRevision, options.activityName),
  );
  return {
    candidate: undefined,
    reason: compatible ? 'no-capacity' : 'revision-incompatible',
    deploymentName: options.deploymentName,
    buildId: options.buildId,
    ...(options.requirement.workflowRevision === undefined
      ? {}
      : { workflowRevision: options.requirement.workflowRevision }),
    message: compatible
      ? `Deployment "${options.deploymentName}" build "${options.buildId}" has no available capacity.`
      : `No eligible worker in build "${options.buildId}" provides the requested workflow revision or activity.`,
  };
}

/** Select a worker only after exact deployment-version and workflow eligibility. */
export function selectWorkerDeployment(
  options: Readonly<{
    deploymentName: string;
    workflowId: string;
    requirement?: WorkerExecutionRequirement;
    activityName?: string;
    routing: WorkerDeploymentRouting;
    candidates: readonly DeploymentRoutingCandidate[];
  }>,
): DeploymentSelectionResult {
  const requirement = options.requirement ?? {};
  if (
    requirement.deploymentName !== undefined &&
    requirement.deploymentName !== options.deploymentName
  ) {
    return {
      candidate: undefined,
      reason: 'deployment-required',
      message: `Requirement targets deployment "${requirement.deploymentName}", not "${options.deploymentName}".`,
    };
  }
  const buildId = selectedBuild({ ...options, requirement });
  const matching = options.candidates.filter(
    (candidate) =>
      candidate.buildId === buildId &&
      !candidate.draining &&
      candidate.availableCapacity > 0 &&
      matchesRequirement(candidate, requirement),
  );
  if (matching.length === 0) {
    return selectionFailure({ ...options, requirement, buildId });
  }
  const candidate = matching.toSorted((left, right) =>
    left.workerId.localeCompare(right.workerId),
  )[0]!;
  return { candidate, buildId, generation: options.routing.generation };
}

/** Storage-backed deployment catalog. All routing pointer writes are CAS-protected. */
export class WorkerDeploymentCatalog {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async registerVersion(version: WorkerDeploymentVersion): Promise<WorkerDeploymentVersion> {
    const key = versionKey(version.deploymentName, version.buildId);
    const existing = await this.#storage.get(key);
    if (existing !== null) {
      const current = decodeVersion(existing);
      if (
        current.artifactDigest !== version.artifactDigest ||
        current.manifestDigest !== version.manifestDigest
      )
        throw new WorkerDeploymentVersionConflictError(version.deploymentName, version.buildId);
      return current;
    }
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: null }],
      [{ type: 'put', key, value: encode(version) }],
    );
    if (!applied) return this.registerVersion(version);
    return version;
  }

  async getVersion(
    deploymentName: string,
    buildId: string,
  ): Promise<WorkerDeploymentVersion | null> {
    const value = await this.#storage.get(versionKey(deploymentName, buildId));
    return value === null ? null : decodeVersion(value);
  }

  async listVersions(deploymentName?: string): Promise<WorkerDeploymentVersion[]> {
    const versions: WorkerDeploymentVersion[] = [];
    for await (const [, value] of this.#storage.scan(WORKER_DEPLOYMENT_VERSION_PREFIX)) {
      const version = decodeVersion(value);
      if (deploymentName === undefined || version.deploymentName === deploymentName)
        versions.push(version);
    }
    return versions.toSorted((left, right) =>
      `${left.deploymentName}\0${left.buildId}`.localeCompare(
        `${right.deploymentName}\0${right.buildId}`,
      ),
    );
  }

  async getRouting(deploymentName: string): Promise<WorkerDeploymentRouting | null> {
    const value = await this.#storage.get(routingKey(deploymentName));
    return value === null ? null : decodeRouting(value);
  }

  /**
   * Write the routing pointer, or return `null` when `expectedGeneration` is stale or another writer
   * got there first. `previousBuildId` is never taken from the caller: it becomes the build that
   * was current when this write changes `currentBuildId`, and otherwise carries over from the record
   * the write replaces, all inside the same conditional batch.
   */
  async setRouting(routing: WorkerDeploymentRoutingWrite): Promise<WorkerDeploymentRouting | null> {
    validateRouting(routing.rampBasisPoints);
    await validateRoutingVersions(this, routing);
    const key = routingKey(routing.deploymentName);
    const targetConditions = await routingTargetConditions(this.#storage, routing);
    const currentBytes = await this.#storage.get(key);
    const current = currentBytes === null ? null : decodeRouting(currentBytes);
    if (
      routing.expectedGeneration !== undefined &&
      (current?.generation ?? 0) !== routing.expectedGeneration
    )
      return null;
    const next = nextRouting(routing, current);
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: currentBytes }, ...targetConditions],
      [{ type: 'put', key, value: encode(next) }],
    );
    return applied ? next : null;
  }

  /**
   * Move a build between `ready` and `draining`, whatever work is bound to it: a drain keeps
   * existing work visible and only stops new untargeted work, so it never waits for the build's
   * references to reach zero. A build that is unknown or `removed` is returned untouched, and
   * never revived. The write is conditioned on the exact bytes read, so a record that carries a
   * field this version no longer writes still matches.
   */
  async setVersionState(
    deploymentName: string,
    buildId: string,
    state: 'ready' | 'draining',
  ): Promise<WorkerDeploymentVersion | null> {
    const key = versionKey(deploymentName, buildId);
    const currentBytes = await this.#storage.get(key);
    if (currentBytes === null) return null;
    const current = decodeVersion(currentBytes);
    if (current.state === 'removed') return current;
    if (current.state === state) return current;
    const next = { ...current, state };
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: currentBytes }],
      [{ type: 'put', key, value: encode(next) }],
    );
    return applied ? next : this.setVersionState(deploymentName, buildId, state);
  }

  /**
   * Mark a build removed, irreversibly: only a draining build, by optimistic concurrency against
   * everything that binds work to it (`deployment-removal.ts`). Reports why it did not, when it
   * did not, and `busy` when bindings kept landing on the build during its scans.
   */
  removeVersion(deploymentName: string, buildId: string): Promise<WorkerDeploymentRemovalOutcome> {
    return removeWorkerDeploymentVersion(this.#storage, deploymentName, buildId);
  }

  /** Every version with the count of durable work bound to its build, computed by one scan. */
  async diagnostics(
    deploymentName?: string,
  ): Promise<ReadonlyArray<WorkerDeploymentVersionReport>> {
    const versions = await this.listVersions(deploymentName);
    const counts = await countBuildReferences(this.#storage, versions);
    return versions.map((version, index) => ({
      ...version,
      executionReferences: counts[index] ?? 0,
    }));
  }
}

/**
 * The `previousBuildId` of the pointer that replaces `current` with `nextCurrentBuildId` as its
 * current build: the build being replaced when the current build changes, else what `current`
 * already recorded (nothing, for a first write or a record written before the field existed).
 */
function previousBuildIdAfter(
  current: WorkerDeploymentRouting | null,
  nextCurrentBuildId: string,
): string | undefined {
  if (current === null) return undefined;
  return current.currentBuildId === nextCurrentBuildId
    ? current.previousBuildId
    : current.currentBuildId;
}

/** The pointer a write produces, one generation after `current` (the first generation when there is none). */
function nextRouting(
  routing: WorkerDeploymentRoutingWrite,
  current: WorkerDeploymentRouting | null,
): WorkerDeploymentRouting {
  const previousBuildId = previousBuildIdAfter(current, routing.currentBuildId);
  return {
    deploymentName: routing.deploymentName,
    currentBuildId: routing.currentBuildId,
    ...(routing.rampingBuildId === undefined ? {} : { rampingBuildId: routing.rampingBuildId }),
    ...(previousBuildId === undefined ? {} : { previousBuildId }),
    rampBasisPoints: routing.rampBasisPoints,
    generation: (current?.generation ?? 0) + 1,
    updatedAt: routing.updatedAt,
  };
}

async function routingTargetConditions(
  storage: Storage,
  routing: WorkerDeploymentRoutingWrite,
): Promise<ReadonlyArray<{ key: string; expectedValue: Uint8Array }>> {
  const buildIds = [
    routing.currentBuildId,
    ...(routing.rampingBuildId === undefined ? [] : [routing.rampingBuildId]),
  ];
  const conditions: Array<{ key: string; expectedValue: Uint8Array }> = [];
  for (const buildId of buildIds) {
    const key = versionKey(routing.deploymentName, buildId);
    const value = await storage.get(key);
    if (value === null) throw new Error('Routing target disappeared during validation.');
    conditions.push({ key, expectedValue: value });
  }
  return conditions;
}

async function validateRoutingVersions(
  catalog: WorkerDeploymentCatalog,
  routing: WorkerDeploymentRoutingWrite,
): Promise<void> {
  const currentVersion = await catalog.getVersion(routing.deploymentName, routing.currentBuildId);
  if (currentVersion === null || currentVersion.state !== 'ready') {
    throw new Error(
      `Current deployment build ${routing.deploymentName}/${routing.currentBuildId} is not eligible for routing.`,
    );
  }
  if (routing.rampingBuildId === routing.currentBuildId) {
    throw new Error('Ramping deployment build must differ from the current build.');
  }
  if (routing.rampingBuildId === undefined) return;
  const rampingVersion = await catalog.getVersion(routing.deploymentName, routing.rampingBuildId);
  if (rampingVersion === null || rampingVersion.state !== 'ready') {
    throw new Error(
      `Ramping deployment build ${routing.deploymentName}/${routing.rampingBuildId} is not eligible for routing.`,
    );
  }
}

function validateRouting(rampBasisPoints: number): void {
  if (!Number.isInteger(rampBasisPoints) || rampBasisPoints < 0 || rampBasisPoints > 10_000)
    throw new Error('rampBasisPoints must be an integer between 0 and 10000.');
}
