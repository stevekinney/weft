/** Durable, per-workflow worker-version binding policy. */

import { decode, encode } from '../core/codec/index.ts';
import type { WorkflowWorkerVersioningPolicy } from '../core/versioning.ts';
import { KEYS, storageConditionalBatch, type Storage } from '../storage/interface.ts';
import {
  WorkerDeploymentCatalog,
  selectWorkerDeployment,
  type DeploymentRoutingCandidate,
  type DeploymentSelection,
  type WorkerDeploymentVersion,
} from './deployment-routing.ts';
import type { WorkerExecutionRequirement } from './manifest/types.ts';

export const DEFAULT_WORKFLOW_WORKER_VERSIONING_POLICY = {
  mode: 'pinned',
  maxBindingHistory: 8,
} as const satisfies WorkflowWorkerVersioningPolicy;

const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 64;

export type WorkflowWorkerBinding = Readonly<{
  workflowId: string;
  workflowType: string;
  deploymentName: string;
  buildId: string;
  artifactDigest: string;
  manifestDigest: string;
  routingGeneration: number;
  workflowRevision: string;
  workflowContractHash: string;
  activityContracts: Readonly<Record<string, string>>;
  activityName: string;
  activityContractHash: string;
  boundAt: number;
  checkpointId: string;
}>;

export type WorkflowWorkerBindingRecord = Readonly<{
  current: WorkflowWorkerBinding;
  history: readonly WorkflowWorkerBinding[];
}>;

/** Resolve a start binding from an accepted, routed deployment manifest. */
export async function resolveWorkflowWorkerStartBinding(
  storage: Storage,
  options: Readonly<{
    workflowId: string;
    workflowType: string;
    workflowRevision: string;
    policy: WorkflowWorkerVersioningPolicy;
    boundAt?: number;
    checkpointId: string;
  }>,
): Promise<WorkflowWorkerBinding> {
  const catalog = new WorkerDeploymentCatalog(storage);
  const versions = await catalog.listVersions();
  const deploymentNames = matchingDeploymentNames(versions, options);
  for (const deploymentName of deploymentNames) {
    const routing = await catalog.getRouting(deploymentName);
    if (routing === null) continue;
    const selection = selectWorkerDeployment({
      deploymentName,
      workflowId: options.workflowId,
      requirement: workerStartRequirement(options),
      routing,
      candidates: deploymentCandidates(versions, deploymentName, options),
    });
    if (selection.candidate === undefined) continue;
    return bindingFromDeploymentSelection(selection, versions, options);
  }
  throw new Error(
    `No accepted routed worker deployment provides workflow "${options.workflowType}" revision "${options.workflowRevision}".`,
  );
}

function matchingDeploymentNames(
  versions: readonly WorkerDeploymentVersion[],
  options: Readonly<{ workflowType: string; workflowRevision: string }>,
): string[] {
  return versions
    .filter(
      (version) =>
        version.state === 'ready' &&
        version.manifest.workflows[options.workflowType]?.workflowRevision ===
          options.workflowRevision,
    )
    .map((version) => version.deploymentName)
    .filter((name, index, names) => names.indexOf(name) === index)
    .toSorted();
}

function deploymentCandidates(
  versions: readonly WorkerDeploymentVersion[],
  deploymentName: string,
  options: Readonly<{ workflowType: string; workflowRevision: string }>,
): DeploymentRoutingCandidate[] {
  return versions
    .filter(
      (version) =>
        version.deploymentName === deploymentName &&
        version.state === 'ready' &&
        version.manifest.workflows[options.workflowType]?.workflowRevision ===
          options.workflowRevision,
    )
    .map((version) => ({
      workerId: `deployment:${version.deploymentName}:${version.buildId}`,
      buildId: version.buildId,
      manifest: version.manifest,
      availableCapacity: 1,
    }));
}

function workerStartRequirement(
  options: Readonly<{ policy: WorkflowWorkerVersioningPolicy; workflowRevision: string }>,
): WorkerExecutionRequirement {
  if (options.policy.mode !== 'auto-upgrade') return { workflowRevision: options.workflowRevision };
  return {
    deploymentName: options.policy.compatibility.deploymentName,
    buildId: options.policy.compatibility.buildId,
    artifactDigest: options.policy.compatibility.artifactDigest,
    workflowRevision: options.workflowRevision,
  };
}

function bindingFromDeploymentSelection(
  selection: DeploymentSelection,
  versions: readonly WorkerDeploymentVersion[],
  options: Readonly<{
    workflowId: string;
    workflowType: string;
    workflowRevision: string;
    boundAt?: number;
    checkpointId: string;
  }>,
): WorkflowWorkerBinding {
  const workflow = selection.candidate.manifest.workflows[options.workflowType]!;
  const activity = Object.entries(workflow.activities).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )[0];
  const version = versions.find(
    (candidate) =>
      candidate.deploymentName === selection.candidate.manifest.deployment.name &&
      candidate.buildId === selection.buildId,
  )!;
  return {
    workflowId: options.workflowId,
    workflowType: options.workflowType,
    deploymentName: selection.candidate.manifest.deployment.name,
    buildId: selection.candidate.manifest.deployment.buildId,
    artifactDigest: selection.candidate.manifest.deployment.artifactDigest,
    manifestDigest: version.manifestDigest,
    routingGeneration: selection.generation,
    workflowRevision: workflow.workflowRevision,
    workflowContractHash: workflow.contractHash,
    activityContracts: Object.fromEntries(
      Object.entries(workflow.activities)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, contract]) => [name, contract.contractHash]),
    ),
    activityName: activity?.[0] ?? '*',
    activityContractHash: activity?.[1].contractHash ?? workflow.contractHash,
    boundAt: options.boundAt ?? Date.now(),
    checkpointId: options.checkpointId,
  };
}

export type WorkerUpgradeBlockedReason =
  | 'policy-pinned'
  | 'not-checkpoint-boundary'
  | 'realm-already-acquired'
  | 'incompatible-contract'
  | 'stale-binding';

export type WorkerUpgradeEvaluation =
  | { allowed: true; binding: WorkflowWorkerBinding }
  | {
      allowed: false;
      reason: WorkerUpgradeBlockedReason;
      message: string;
      current: WorkflowWorkerBinding;
    };

export type WorkerUpgradeAttempt =
  | { upgraded: true; binding: WorkflowWorkerBinding }
  | { upgraded: false; evaluation: WorkerUpgradeEvaluation | null };

function historyLimit(policy: WorkflowWorkerVersioningPolicy): number {
  const limit = policy.maxBindingHistory ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new RangeError(`maxBindingHistory must be an integer from 1 to ${MAX_HISTORY_LIMIT}.`);
  }
  return limit;
}

function bindingEquals(left: WorkflowWorkerBinding, right: WorkflowWorkerBinding): boolean {
  const equalFields = [
    left.workflowId === right.workflowId,
    left.workflowType === right.workflowType,
    left.deploymentName === right.deploymentName,
    left.buildId === right.buildId,
    left.artifactDigest === right.artifactDigest,
    left.manifestDigest === right.manifestDigest,
    left.routingGeneration === right.routingGeneration,
    left.workflowRevision === right.workflowRevision,
    left.workflowContractHash === right.workflowContractHash,
    left.activityName === right.activityName,
    left.activityContractHash === right.activityContractHash,
    JSON.stringify(left.activityContracts) === JSON.stringify(right.activityContracts),
  ];
  return equalFields.every(Boolean);
}

function isActivityContractMap(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function asBinding(value: unknown): WorkflowWorkerBinding {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid worker binding.');
  const binding = value as Partial<WorkflowWorkerBinding>;
  const valid = [
    typeof binding.workflowId === 'string',
    typeof binding.workflowType === 'string',
    typeof binding.deploymentName === 'string',
    typeof binding.buildId === 'string',
    typeof binding.artifactDigest === 'string',
    typeof binding.manifestDigest === 'string',
    typeof binding.routingGeneration === 'number',
    typeof binding.workflowRevision === 'string',
    typeof binding.workflowContractHash === 'string',
    isActivityContractMap(binding.activityContracts),
    typeof binding.activityName === 'string',
    typeof binding.activityContractHash === 'string',
    typeof binding.boundAt === 'number',
    typeof binding.checkpointId === 'string',
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker binding.');
  return binding as WorkflowWorkerBinding;
}

function decodeRecord(value: Uint8Array): WorkflowWorkerBindingRecord {
  const decoded = decode(value) as Partial<WorkflowWorkerBindingRecord>;
  if (!Array.isArray(decoded.history)) throw new Error('Invalid worker binding history.');
  return { current: asBinding(decoded.current), history: decoded.history.map(asBinding) };
}

function workflowRecord(value: Uint8Array): Record<string, unknown> {
  const decoded = decode(value);
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid workflow state.');
  return decoded as Record<string, unknown>;
}

function satisfiesExactCompatibility(
  binding: WorkflowWorkerBinding,
  compatibility: Extract<WorkflowWorkerVersioningPolicy, { mode: 'auto-upgrade' }>['compatibility'],
): boolean {
  return [
    binding.deploymentName === compatibility.deploymentName,
    binding.buildId === compatibility.buildId,
    binding.artifactDigest === compatibility.artifactDigest,
    binding.manifestDigest === compatibility.manifestDigest,
    binding.workflowRevision === compatibility.workflowRevision,
    binding.activityContractHash === compatibility.activityContractHash,
  ].every(Boolean);
}

/** Read the single authoritative binding record for a workflow. */
export async function readWorkflowWorkerBinding(
  storage: Storage,
  workflowId: string,
): Promise<WorkflowWorkerBindingRecord | null> {
  const value = await storage.get(KEYS.workflow(workflowId));
  if (value === null) return null;
  const state = workflowRecord(value);
  return state['workerBinding'] === undefined ? null : decodeRecord(encode(state['workerBinding']));
}

/** Bind exactly once at start; retries are idempotent, conflicting starts are rejected. */
export async function bindWorkflowWorkerAtStart(
  storage: Storage,
  binding: WorkflowWorkerBinding,
): Promise<WorkflowWorkerBindingRecord> {
  const key = KEYS.workflow(binding.workflowId);
  const existing = await storage.get(key);
  if (existing === null) throw new Error(`Workflow "${binding.workflowId}" does not exist.`);
  const state = workflowRecord(existing);
  if (state['workerBinding'] !== undefined) {
    const record = decodeRecord(encode(state['workerBinding']));
    if (!bindingEquals(record.current, binding)) {
      throw new Error(`Workflow "${binding.workflowId}" already has a different worker binding.`);
    }
    return record;
  }
  const record: WorkflowWorkerBindingRecord = { current: binding, history: [] };
  state['workerBinding'] = record;
  const applied = await storageConditionalBatch(
    storage,
    [{ key, expectedValue: existing }],
    [{ type: 'put', key, value: encode(state) }],
  );
  if (!applied) {
    const raced = await readWorkflowWorkerBinding(storage, binding.workflowId);
    if (raced !== null && bindingEquals(raced.current, binding)) return raced;
    throw new Error(`Concurrent worker binding changed workflow "${binding.workflowId}".`);
  }
  return record;
}

/** Atomically record an upgrade after a durable checkpoint and before realm acquisition. */
export async function recordWorkflowWorkerUpgrade(
  storage: Storage,
  policy: WorkflowWorkerVersioningPolicy,
  current: WorkflowWorkerBinding,
  next: WorkflowWorkerBinding,
): Promise<WorkflowWorkerBindingRecord> {
  if (policy.mode !== 'auto-upgrade')
    throw new Error('Worker upgrade requires auto-upgrade policy.');
  const key = KEYS.workflow(current.workflowId);
  const previousBytes = await storage.get(key);
  if (previousBytes === null) throw new Error('Workflow worker binding is missing.');
  const state = workflowRecord(previousBytes);
  if (state['workerBinding'] === undefined) throw new Error('Workflow worker binding is missing.');
  const previous = decodeRecord(encode(state['workerBinding']));
  if (!bindingEquals(previous.current, current)) throw new Error('Stale workflow worker binding.');
  const limit = historyLimit(policy);
  const record: WorkflowWorkerBindingRecord = {
    current: next,
    history: [current, ...previous.history].slice(0, limit),
  };
  state['workerBinding'] = record;
  const applied = await storageConditionalBatch(
    storage,
    [{ key, expectedValue: previousBytes }],
    [{ type: 'put', key, value: encode(state) }],
  );
  if (!applied) throw new Error('Concurrent workflow worker upgrade lost the binding CAS.');
  return record;
}

/** Evaluate and CAS-record an auto-upgrade after a checkpoint commit, before the next realm/task selection. */
export async function evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
  storage: Storage,
  workflowId: string,
  checkpointId: string,
  boundAt?: number | (() => number),
): Promise<WorkerUpgradeAttempt> {
  const stateBytes = await storage.get(KEYS.workflow(workflowId));
  if (stateBytes === null) return { upgraded: false, evaluation: null };
  const state = workflowRecord(stateBytes);
  const policy = state['workerVersioningPolicy'] as WorkflowWorkerVersioningPolicy | undefined;
  const record =
    state['workerBinding'] === undefined ? null : decodeRecord(encode(state['workerBinding']));
  const startIdentity = workflowStartIdentity(state);
  const context = autoUpgradeContext(policy, record, startIdentity);
  if (context === null) {
    return { upgraded: false, evaluation: null };
  }
  const bindingBoundAt = typeof boundAt === 'function' ? boundAt() : (boundAt ?? Date.now());
  const candidate = await resolveUpgradeCandidateAfterCheckpoint(storage, {
    workflowId,
    workflowType: context.startIdentity.type,
    workflowRevision: context.startIdentity.revision,
    policy: context.policy,
    boundAt: bindingBoundAt,
    checkpointId,
  });
  if (candidate === null) return { upgraded: false, evaluation: null };

  const evaluation = evaluateWorkflowWorkerUpgrade({
    policy: context.policy,
    current: context.record.current,
    candidate,
    checkpointCommitted: true,
    realmAcquired: false,
  });
  if (!evaluation.allowed || bindingEquals(context.record.current, candidate)) {
    return { upgraded: false, evaluation };
  }
  return recordUpgradeAttempt(
    storage,
    context.policy,
    context.record.current,
    candidate,
    evaluation,
  );
}

function autoUpgradeContext(
  policy: WorkflowWorkerVersioningPolicy | undefined,
  record: WorkflowWorkerBindingRecord | null,
  startIdentity: { type: string; revision: string } | null,
): {
  policy: Extract<WorkflowWorkerVersioningPolicy, { mode: 'auto-upgrade' }>;
  record: WorkflowWorkerBindingRecord;
  startIdentity: { type: string; revision: string };
} | null {
  return policy?.mode === 'auto-upgrade' && record !== null && startIdentity !== null
    ? { policy, record, startIdentity }
    : null;
}

async function resolveUpgradeCandidateAfterCheckpoint(
  storage: Storage,
  options: Parameters<typeof resolveWorkflowWorkerStartBinding>[1],
): Promise<WorkflowWorkerBinding | null> {
  try {
    return await resolveWorkflowWorkerStartBinding(storage, options);
  } catch {
    return null;
  }
}

async function recordUpgradeAttempt(
  storage: Storage,
  policy: Extract<WorkflowWorkerVersioningPolicy, { mode: 'auto-upgrade' }>,
  current: WorkflowWorkerBinding,
  candidate: WorkflowWorkerBinding,
  evaluation: WorkerUpgradeEvaluation,
): Promise<WorkerUpgradeAttempt> {
  try {
    const upgraded = await recordWorkflowWorkerUpgrade(storage, policy, current, candidate);
    return { upgraded: true, binding: upgraded.current };
  } catch {
    return { upgraded: false, evaluation };
  }
}

function workflowStartIdentity(
  state: Record<string, unknown>,
): { type: string; revision: string } | null {
  return typeof state['type'] === 'string' && typeof state['revision'] === 'string'
    ? { type: state['type'], revision: state['revision'] }
    : null;
}

/** Evaluate upgrade eligibility at the checkpoint boundary, before acquiring a realm. */
export function evaluateWorkflowWorkerUpgrade(
  options: Readonly<{
    policy: WorkflowWorkerVersioningPolicy;
    current: WorkflowWorkerBinding;
    candidate: WorkflowWorkerBinding;
    checkpointCommitted: boolean;
    realmAcquired: boolean;
  }>,
): WorkerUpgradeEvaluation {
  const { policy, current, candidate } = options;
  if (policy.mode !== 'auto-upgrade') {
    return {
      allowed: false,
      reason: 'policy-pinned',
      message: 'Workflow worker policy is pinned.',
      current,
    };
  }
  if (!options.checkpointCommitted) {
    return {
      allowed: false,
      reason: 'not-checkpoint-boundary',
      message: 'Upgrade requires a durably committed checkpoint.',
      current,
    };
  }
  if (options.realmAcquired) {
    return {
      allowed: false,
      reason: 'realm-already-acquired',
      message: 'Upgrade must be evaluated before realm acquisition.',
      current,
    };
  }
  if (!satisfiesExactCompatibility(candidate, policy.compatibility)) {
    return {
      allowed: false,
      reason: 'incompatible-contract',
      message: 'Candidate does not satisfy the exact workflow/activity compatibility contract.',
      current,
    };
  }
  if (candidate.workflowId !== current.workflowId) {
    return {
      allowed: false,
      reason: 'stale-binding',
      message: 'Candidate belongs to a different workflow.',
      current,
    };
  }
  return { allowed: true, binding: candidate };
}
