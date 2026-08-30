/**
 * Shared registration fixtures for `WorkerRegistry` tests.
 *
 * `WorkerRegistrationInfo` requires `manifest` and `acceptedManifestDigest`
 * since protocol v3 — most registry tests care about routing mechanics, not
 * manifest content, so this supplies an always-valid minimal manifest rather
 * than every call site constructing its own.
 *
 * @module worker/registry-fixtures.test-support
 */

import type { WorkerManifest, WorkerWorkflowContract } from './manifest/index.ts';
import { WORKER_MANIFEST_VERSION } from './manifest/index.ts';

export function testWorkerManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: 3,
    sdkVersion: '0.18.0',
    runtime: { name: 'bun', version: '1.3.14' },
    deployment: { name: 'test-deployment', buildId: 'b1', artifactDigest: 'sha256:test' },
    workflows: {},
    capabilities: {},
    ...overrides,
  };
}

export const TEST_ACCEPTED_MANIFEST_DIGEST = 'sha256:test-accepted-digest';

/**
 * Build a manifest advertising exactly the given qualified activity names, for
 * tests that send raw wire frames and assert on dispatch routing by a
 * specific `${workflowType}.${activityName}` string. Each name may already be
 * qualified (split on its first `.`) or bare, which is grouped under a
 * synthetic `test` workflow.
 */
export function manifestForActivities(
  activities: readonly string[],
  overrides: Partial<WorkerManifest> = {},
): WorkerManifest {
  const activityNamesByWorkflow: Record<string, Set<string>> = {};
  for (const qualifiedName of activities) {
    const dotIndex = qualifiedName.indexOf('.');
    const workflowType = dotIndex === -1 ? 'test' : qualifiedName.slice(0, dotIndex);
    const activityName = dotIndex === -1 ? qualifiedName : qualifiedName.slice(dotIndex + 1);
    (activityNamesByWorkflow[workflowType] ??= new Set()).add(activityName);
  }

  const workflows: Record<string, WorkerWorkflowContract> = {};
  for (const [workflowType, activityNames] of Object.entries(activityNamesByWorkflow)) {
    const workflowActivities: Record<string, WorkerWorkflowContract['activities'][string]> = {};
    for (const activityName of activityNames) {
      workflowActivities[activityName] = { contractHash: 'hash', implementationRevision: 'rev' };
    }
    workflows[workflowType] = {
      workflowVersion: '0.0.0',
      workflowRevision: 'rev',
      contractHash: 'hash',
      activities: workflowActivities,
    };
  }

  return testWorkerManifest({ workflows, ...overrides });
}
