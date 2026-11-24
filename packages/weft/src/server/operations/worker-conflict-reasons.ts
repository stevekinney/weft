/**
 * The `Conflict` reason strings the worker deployment and worker start override
 * operations answer with (`data.reason`, carried on the JSON-RPC fault envelope).
 *
 * A client branches on these, so they are a wire contract. They live here, once, so the
 * operations that produce them and the console that reads them cannot drift apart.
 *
 * @module server/operations/worker-conflict-reasons
 */

export const WORKER_CONFLICT_REASONS = {
  /** `expectedGeneration` no longer matches the routing pointer; `data.currentGeneration` has the live one. */
  staleGeneration: 'stale-generation',
  /** The named build exists but is not `ready`, so it cannot be a routing target. */
  versionNotReady: 'version-not-ready',
  /** The build is not `draining`, so it cannot be removed; only a draining build can be. */
  versionNotDraining: 'version-not-draining',
  /** Non-terminal durable work is still bound to the build: a run's current binding or a ledger entry's requirement. */
  versionReferenced: 'version-referenced',
  /** Work would be bound to a build that has been removed: a start, restart, fork, child, upgrade, retry or ledger entry. */
  versionRemoved: 'version-removed',
  /** Bindings kept landing on the build while a removal scanned it, so the removal gave up; retry. */
  versionBusy: 'version-busy',
  /** The routing pointer names the build as its current or ramping build. */
  versionRouted: 'version-routed',
  /** A start's override preview is expired, used, for another workflow, stale, or forged. */
  overrideTokenRejected: 'override-token-rejected',
  /** An override preview was requested for a workflow that is not terminal. */
  workflowNotTerminal: 'workflow-not-terminal',
  /** An override preview was requested for a workflow with no durable worker binding. */
  noWorkerBinding: 'no-worker-binding',
  /** An override preview was requested for a workflow whose policy is not auto-upgrade. */
  policyNotAutoUpgrade: 'policy-not-auto-upgrade',
  /** A worker that still takes work cannot be forgotten: forgetting it would not stop it. */
  workerStillConnected: 'worker-still-connected',
  /** No ready, routed deployment build provides the workflow's revision. */
  noRoutedDeployment: 'no-routed-deployment',
} as const;

export type WorkerConflictReason =
  (typeof WORKER_CONFLICT_REASONS)[keyof typeof WORKER_CONFLICT_REASONS];

/**
 * An override preview refused because the build routing selects cannot take the workflow carries
 * `upgrade-` followed by the upgrade evaluation's own reason (for example
 * `upgrade-incompatible-contract`).
 */
export const UPGRADE_REFUSAL_REASON_PREFIX = 'upgrade-';
