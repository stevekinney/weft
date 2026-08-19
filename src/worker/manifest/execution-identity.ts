/**
 * Deriving and matching worker execution identity.
 *
 * Routing asks a question — {@link WorkerExecutionRequirement} — and a lease
 * answers it completely — {@link WorkerExecutionIdentity}. Keeping the two
 * types apart is what stops a partially specified routing hint from being
 * mistaken for an observed fact, and building the identity from the accepted
 * manifest rather than from a worker's result is what stops a worker from
 * claiming it ran something it did not.
 *
 * @module worker/manifest/execution-identity
 */

import type {
  WorkerExecutionIdentity,
  WorkerExecutionRequirement,
  WorkerManifest,
} from './types.ts';

/**
 * Build the complete execution identity for an attempt.
 *
 * Every field comes from the accepted manifest, the accepted manifest digest,
 * and the live session — never from anything the worker reports later.
 * Returns `undefined` when the manifest does not actually advertise the
 * workflow and activity being leased, which is the caller's signal that the
 * worker was never eligible for this task.
 *
 * @example
 * ```ts
 * import { buildWorkerExecutionIdentity, WORKER_MANIFEST_VERSION } from '@lostgradient/weft';
 *
 * const identity = buildWorkerExecutionIdentity({
 *   manifest: {
 *     manifestVersion: WORKER_MANIFEST_VERSION,
 *     protocolVersion: 2,
 *     sdkVersion: '0.18.0',
 *     runtime: { name: 'bun', version: '1.3.14' },
 *     deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
 *     workflows: {
 *       checkout: {
 *         workflowVersion: '1.0.0',
 *         workflowRevision: 'rev-8',
 *         contractHash: 'sha256:aa',
 *         activities: { charge: { contractHash: 'sha256:bb', implementationRevision: 'r1' } },
 *       },
 *     },
 *     capabilities: {},
 *   },
 *   manifestDigest: 'sha256:deadbeef',
 *   workerId: 'worker-1',
 *   workflowType: 'checkout',
 *   activityName: 'charge',
 * });
 *
 * console.log(identity?.activityContractHash); // 'sha256:bb'
 * ```
 */
export function buildWorkerExecutionIdentity(
  source: Readonly<{
    manifest: WorkerManifest;
    manifestDigest: string;
    workerId: string;
    workflowType: string;
    activityName: string;
  }>,
): WorkerExecutionIdentity | undefined {
  const workflow = source.manifest.workflows[source.workflowType];
  if (workflow === undefined) return undefined;

  const activity = workflow.activities[source.activityName];
  if (activity === undefined) return undefined;

  return {
    workerId: source.workerId,
    manifestDigest: source.manifestDigest,
    protocolVersion: source.manifest.protocolVersion,
    sdkVersion: source.manifest.sdkVersion,
    runtimeName: source.manifest.runtime.name,
    runtimeVersion: source.manifest.runtime.version,
    deploymentName: source.manifest.deployment.name,
    buildId: source.manifest.deployment.buildId,
    artifactDigest: source.manifest.deployment.artifactDigest,
    workflowRevision: workflow.workflowRevision,
    activityName: source.activityName,
    activityContractHash: activity.contractHash,
  };
}

/**
 * Test whether an execution identity satisfies a routing requirement.
 *
 * An omitted requirement field means policy may choose any eligible value, so
 * it matches anything. It is deliberately not treated as a demand for an empty
 * string, which is why this cannot be written as a plain field-by-field
 * equality check.
 *
 * @example
 * ```ts
 * import { executionIdentitySatisfies, type WorkerExecutionIdentity } from '@lostgradient/weft';
 *
 * const identity: WorkerExecutionIdentity = {
 *   workerId: 'worker-1',
 *   manifestDigest: 'sha256:deadbeef',
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtimeName: 'bun',
 *   runtimeVersion: '1.3.14',
 *   deploymentName: 'billing',
 *   buildId: 'b3',
 *   artifactDigest: 'sha256:41d0',
 *   workflowRevision: 'rev-8',
 *   activityName: 'charge',
 *   activityContractHash: 'sha256:bb',
 * };
 *
 * console.log(executionIdentitySatisfies({ deploymentName: 'billing' }, identity)); // true
 * console.log(executionIdentitySatisfies({ buildId: 'b4' }, identity)); // false
 * ```
 */
export function executionIdentitySatisfies(
  requirement: WorkerExecutionRequirement,
  identity: WorkerExecutionIdentity,
): boolean {
  return ROUTING_FIELDS.every((field) => {
    const required = requirement[field];
    return required === undefined || required === identity[field];
  });
}

/**
 * The routing fields a requirement may pin.
 *
 * Each name is deliberately identical on both types, so adding a routing
 * dimension is one entry here rather than a new branch — and a name that
 * exists on only one of the two types fails to compile.
 */
const ROUTING_FIELDS = [
  'deploymentName',
  'buildId',
  'artifactDigest',
  'workflowRevision',
  'activityContractHash',
] as const satisfies readonly (keyof WorkerExecutionRequirement & keyof WorkerExecutionIdentity)[];
