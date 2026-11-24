// ---------------------------------------------------------------------------
// Pure summary projections over a registry snapshot
// ---------------------------------------------------------------------------

import type { RemoteWorkerCapabilities } from '../protocol.ts';
import type { WorkerHealth, WorkerSummary, WorkerTransport } from './types.ts';

/**
 * Minimal read-only snapshot of a single worker's state, as held by the
 * registry. The projection functions below operate on this shape so they
 * remain pure and independently testable without a live registry instance.
 */
export type WorkerSnapshot = {
  id: string;
  queue: string;
  transport: WorkerTransport;
  activities: readonly string[];
  concurrency: number;
  inFlight: number;
  connectedAt: number;
  lastHeartbeat: number;
  startedAt: number;
  capabilities: RemoteWorkerCapabilities;
  health: WorkerHealth;
  /** The workflow types the accepted manifest declares, when it declares any. */
  workflows?: readonly string[] | undefined;
  /** When the session ended; present only for a worker that went away. */
  disconnectedAt?: number | undefined;
  deploymentName?: string | undefined;
  buildId?: string | undefined;
  runtimeVersion?: string | undefined;
  /** Tasks finished since the drain started; present while `draining` or `drained`. */
  drainFinishedTasks?: number | undefined;
  /** When the drain finished; present while `drained`. */
  drainedAt?: number | undefined;
};

/**
 * The name a worker advertised for itself: the string capability `name`, trimmed, or `undefined`
 * when it advertised none or an empty one.
 */
export function workerNameOf(capabilities: RemoteWorkerCapabilities): string | undefined {
  const name = capabilities['name'];
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Project a single worker snapshot into a {@link WorkerSummary}.
 *
 * `now` should be the same timestamp used for all workers in a single response
 * so heartbeat ages are consistent across the payload.
 */
export function projectWorkerSummary(snapshot: WorkerSnapshot, now: number): WorkerSummary {
  const { inFlight, concurrency } = snapshot;
  const name = workerNameOf(snapshot.capabilities);
  return {
    id: snapshot.id,
    queue: snapshot.queue,
    transport: snapshot.transport,
    activities: [...snapshot.activities],
    concurrency,
    inFlight,
    availableCapacity: Math.max(0, concurrency - inFlight),
    connectedAt: snapshot.connectedAt,
    lastHeartbeatAt: snapshot.lastHeartbeat,
    heartbeatAgeMs: now - snapshot.lastHeartbeat,
    startedAt: snapshot.startedAt,
    capabilities: { ...snapshot.capabilities },
    health: snapshot.health,
    ...(name !== undefined ? { name } : {}),
    ...(snapshot.workflows !== undefined && snapshot.workflows.length > 0
      ? { workflows: [...snapshot.workflows] }
      : {}),
    ...(snapshot.disconnectedAt !== undefined ? { disconnectedAt: snapshot.disconnectedAt } : {}),
    ...(snapshot.deploymentName !== undefined ? { deploymentName: snapshot.deploymentName } : {}),
    ...(snapshot.buildId !== undefined ? { buildId: snapshot.buildId } : {}),
    ...(snapshot.runtimeVersion !== undefined ? { runtimeVersion: snapshot.runtimeVersion } : {}),
    ...(snapshot.drainFinishedTasks !== undefined
      ? { drainFinishedTasks: snapshot.drainFinishedTasks }
      : {}),
    ...(snapshot.drainedAt !== undefined ? { drainedAt: snapshot.drainedAt } : {}),
  };
}

/**
 * Project an array of worker snapshots into sorted {@link WorkerSummary} entries.
 *
 * Output is sorted ascending by worker id so the list is stable across calls.
 */
export function projectWorkerSummaries(snapshots: WorkerSnapshot[], now: number): WorkerSummary[] {
  return snapshots
    .map((snapshot) => projectWorkerSummary(snapshot, now))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Deployment-group summary helpers
// ---------------------------------------------------------------------------

/**
 * Deployment-level summary for operator views. Workers without deployment
 * metadata are grouped under `null` identity fields.
 */
export type WorkerDeploymentSummary = {
  deploymentName: string | null;
  buildId: string | null;
  runtimeVersion: string | null;
  transports: WorkerTransport[];
  health: WorkerHealth;
  workers: number;
  activeWorkers: number;
  drainingWorkers: number;
  drainedWorkers: number;
  inFlight: number;
  oldestStartedAt: number | null;
};

type WorkerDeploymentIdentity = {
  deploymentName?: string | null | undefined;
  buildId?: string | null | undefined;
  runtimeVersion?: string | null | undefined;
};

/** Stable composite key for grouping workers by deployment identity. */
export function deploymentIdentityKey(identity: WorkerDeploymentIdentity): string {
  return [
    identity.deploymentName ?? '',
    identity.buildId ?? '',
    identity.runtimeVersion ?? '',
  ].join('\u{1f}');
}

/** Count workers per health state. */
export function countWorkerHealth(healthValues: WorkerHealth[]): Record<WorkerHealth, number> {
  return healthValues.reduce<Record<WorkerHealth, number>>(
    (counts, health) => {
      counts[health] += 1;
      return counts;
    },
    { active: 0, draining: 0, drained: 0 },
  );
}

/**
 * Compute the aggregate health of a deployment from its individual worker health values.
 *
 * `drainActive` should be `true` when the deployment-level drain marker is set
 * and there are no connected workers, so the result reports `'drained'` rather
 * than `'active'` for a pre-drained empty deployment.
 */
export function deploymentHealth(healthValues: WorkerHealth[], drainActive = false): WorkerHealth {
  if (healthValues.includes('draining')) return 'draining';
  if (healthValues.length === 0) return drainActive ? 'drained' : 'active';
  if (healthValues.every((health) => health === 'drained')) return 'drained';
  return 'active';
}

/** Comparator for sorting deployment summaries by their identity key. */
export function compareDeploymentSummaries(
  left: WorkerDeploymentSummary,
  right: WorkerDeploymentSummary,
): number {
  const leftKey = deploymentIdentityKey(left);
  const rightKey = deploymentIdentityKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Project a group of worker snapshots that share the same deployment identity
 * into a single {@link WorkerDeploymentSummary}.
 */
export function projectDeploymentSummary(
  workers: WorkerSnapshot[],
  drainActive: boolean,
): WorkerDeploymentSummary {
  const [first] = workers;
  const healthValues = workers.map((w) => w.health);
  const healthCounts = countWorkerHealth(healthValues);

  return {
    deploymentName: first?.deploymentName ?? null,
    buildId: first?.buildId ?? null,
    runtimeVersion: first?.runtimeVersion ?? null,
    transports: [...new Set(workers.map((worker) => worker.transport))].toSorted(),
    health: deploymentHealth(healthValues, drainActive),
    workers: workers.length,
    activeWorkers: healthCounts.active,
    drainingWorkers: healthCounts.draining,
    drainedWorkers: healthCounts.drained,
    inFlight: workers.reduce((total, w) => total + w.inFlight, 0),
    oldestStartedAt: workers.length === 0 ? null : Math.min(...workers.map((w) => w.startedAt)),
  };
}

/**
 * Project a flat list of worker snapshots into grouped, sorted
 * {@link WorkerDeploymentSummary} entries.
 *
 * `isDrainActive` receives a group's deployment name and build id and returns
 * whether a deployment-level or build-level drain marker is set for it.
 */
export function projectDeploymentSummaries(
  snapshots: WorkerSnapshot[],
  isDrainActive: (deploymentName: string, buildId: string | undefined) => boolean,
): WorkerDeploymentSummary[] {
  const groups = new Map<string, WorkerSnapshot[]>();

  for (const snapshot of snapshots) {
    const key = deploymentIdentityKey(snapshot);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [snapshot]);
    } else {
      group.push(snapshot);
    }
  }

  return [...groups.values()]
    .map((group) => {
      const deploymentName = group[0]?.deploymentName;
      const drainActive =
        deploymentName !== undefined ? isDrainActive(deploymentName, group[0]?.buildId) : false;
      return projectDeploymentSummary(group, drainActive);
    })
    .toSorted(compareDeploymentSummaries);
}
