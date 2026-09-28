/** Durable deployment versions and deterministic, revision-aware selection. */
import { decode, encode } from '../core/codec/index.ts';
import { hashString } from '../runtime/portable.ts';
import { storageConditionalBatch, type Storage } from '../storage/interface.ts';
import type { WorkerExecutionRequirement, WorkerManifest } from './manifest/types.ts';

export const WORKER_DEPLOYMENT_VERSION_PREFIX = 'worker-deployment-version:';
export const WORKER_DEPLOYMENT_ROUTING_PREFIX = 'worker-deployment-routing:';

export type WorkerDeploymentVersionState = 'ready' | 'draining' | 'removed';

export type WorkerDeploymentVersion = Readonly<{
  deploymentName: string;
  buildId: string;
  artifactDigest: string;
  manifestDigest: string;
  manifest: WorkerManifest;
  state: WorkerDeploymentVersionState;
  firstSeenAt: number;
  executionReferences: number;
}>;

export type WorkerDeploymentRouting = Readonly<{
  deploymentName: string;
  currentBuildId: string;
  rampingBuildId?: string;
  rampBasisPoints: number;
  generation: number;
  updatedAt: number;
}>;

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

type StoredVersion = Omit<WorkerDeploymentVersion, 'manifest'> & { manifest: WorkerManifest };

function decodeVersion(value: Uint8Array): WorkerDeploymentVersion {
  const decoded = decode(value) as Partial<WorkerDeploymentVersion>;
  const valid = [
    typeof decoded.deploymentName === 'string',
    typeof decoded.buildId === 'string',
    typeof decoded.artifactDigest === 'string',
    typeof decoded.manifestDigest === 'string',
    typeof decoded.firstSeenAt === 'number',
    Number.isInteger(decoded.executionReferences),
    (decoded.executionReferences ?? -1) >= 0,
    ['ready', 'draining', 'removed'].includes(decoded.state ?? ''),
    typeof decoded.manifest === 'object',
    decoded.manifest !== null,
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker deployment version record.');
  const deployment = decoded.manifest!.deployment;
  if (
    deployment.name !== decoded.deploymentName ||
    deployment.buildId !== decoded.buildId ||
    deployment.artifactDigest !== decoded.artifactDigest
  )
    throw new Error('Worker deployment version manifest identity disagrees with its storage key.');
  return decoded as WorkerDeploymentVersion;
}

function decodeRouting(value: Uint8Array): WorkerDeploymentRouting {
  const decoded = decode(value) as Partial<WorkerDeploymentRouting>;
  const valid = [
    typeof decoded.deploymentName === 'string',
    typeof decoded.currentBuildId === 'string',
    Number.isInteger(decoded.generation),
    (decoded.generation ?? 0) >= 1,
    Number.isInteger(decoded.rampBasisPoints),
    (decoded.rampBasisPoints ?? -1) >= 0,
    (decoded.rampBasisPoints ?? 10_001) <= 10_000,
    typeof decoded.updatedAt === 'number',
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker deployment routing record.');
  return decoded as WorkerDeploymentRouting;
}

function versionKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_VERSION_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

function routingKey(deploymentName: string): string {
  return `${WORKER_DEPLOYMENT_ROUTING_PREFIX}${encodeURIComponent(deploymentName)}`;
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
  return activityName === undefined || workflow.activities[activityName] !== undefined;
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

  async registerVersion(
    version: Omit<WorkerDeploymentVersion, 'executionReferences'>,
  ): Promise<WorkerDeploymentVersion> {
    const key = versionKey(version.deploymentName, version.buildId);
    const existing = await this.#storage.get(key);
    if (existing !== null) {
      const current = decodeVersion(existing) as StoredVersion;
      if (
        current.artifactDigest !== version.artifactDigest ||
        current.manifestDigest !== version.manifestDigest
      )
        throw new Error(
          `Deployment version ${version.deploymentName}/${version.buildId} is immutable and conflicts with the stored identity.`,
        );
      return current;
    }
    const stored: StoredVersion = { ...version, executionReferences: 0 };
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: null }],
      [{ type: 'put', key, value: encode(stored) }],
    );
    if (!applied) return this.registerVersion(version);
    return stored;
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

  async setRouting(
    routing: Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number },
  ): Promise<WorkerDeploymentRouting | null> {
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
    const next: WorkerDeploymentRouting = {
      deploymentName: routing.deploymentName,
      currentBuildId: routing.currentBuildId,
      ...(routing.rampingBuildId === undefined ? {} : { rampingBuildId: routing.rampingBuildId }),
      rampBasisPoints: routing.rampBasisPoints,
      generation: (current?.generation ?? 0) + 1,
      updatedAt: routing.updatedAt,
    };
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: currentBytes }, ...targetConditions],
      [{ type: 'put', key, value: encode(next) }],
    );
    return applied ? next : null;
  }

  async markDraining(
    deploymentName: string,
    buildId: string,
  ): Promise<WorkerDeploymentVersion | null> {
    const current = await this.getVersion(deploymentName, buildId);
    if (current === null || current.executionReferences > 0) return current;
    const key = versionKey(deploymentName, buildId);
    const next = { ...current, state: 'draining' as const };
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: encode(current) }],
      [{ type: 'put', key, value: encode(next) }],
    );
    return applied ? next : this.markDraining(deploymentName, buildId);
  }

  async reference(
    deploymentName: string,
    buildId: string,
    delta: 1 | -1,
  ): Promise<WorkerDeploymentVersion | null> {
    const current = await this.getVersion(deploymentName, buildId);
    if (current === null) return null;
    const next = {
      ...current,
      executionReferences: Math.max(0, current.executionReferences + delta),
    };
    const key = versionKey(deploymentName, buildId);
    const applied = await storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: encode(current) }],
      [{ type: 'put', key, value: encode(next) }],
    );
    return applied ? next : this.reference(deploymentName, buildId, delta);
  }

  async removeVersion(deploymentName: string, buildId: string): Promise<boolean> {
    const current = await this.getVersion(deploymentName, buildId);
    if (current === null || current.executionReferences > 0) return false;
    const key = versionKey(deploymentName, buildId);
    return storageConditionalBatch(
      this.#storage,
      [{ key, expectedValue: encode(current) }],
      [{ type: 'put', key, value: encode({ ...current, state: 'removed' as const }) }],
    );
  }

  async diagnostics(deploymentName?: string): Promise<ReadonlyArray<WorkerDeploymentVersion>> {
    return this.listVersions(deploymentName);
  }
}

async function routingTargetConditions(
  storage: Storage,
  routing: Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number },
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
  routing: Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number },
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
