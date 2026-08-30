/**
 * Shared manifest-building helper for conformance worker fixtures.
 *
 * These fixtures speak the raw WebSocket wire protocol directly (no SDK), so
 * they cannot use `buildQualifiedActivityTable()` or `RemoteWorker`. Protocol
 * v3 requires a manifest instead of a flat `activities` list; this builds the
 * minimal manifest shape from the same comma-separated activity names the
 * fixtures already read from `WEFT_WORKER_ACTIVITIES`.
 */

type WorkflowActivities = Record<string, { contractHash: string; implementationRevision: string }>;

type WorkflowContract = {
  workflowVersion: string;
  workflowRevision: string;
  contractHash: string;
  activities: WorkflowActivities;
};

/**
 * Build a minimal manifest from qualified `${workflowType}.${activityName}`
 * names, splitting each on its first `.`.
 */
export function conformanceManifest(activities: readonly string[]): Record<string, unknown> {
  const workflows: Record<string, WorkflowContract> = {};

  for (const qualifiedName of activities) {
    const dotIndex = qualifiedName.indexOf('.');
    if (dotIndex === -1) continue;
    const workflowType = qualifiedName.slice(0, dotIndex);
    const activityName = qualifiedName.slice(dotIndex + 1);

    const workflow = (workflows[workflowType] ??= {
      workflowVersion: '0.0.0',
      workflowRevision: 'conformance-fixture',
      contractHash: 'conformance-fixture',
      activities: {},
    });
    workflow.activities[activityName] = {
      contractHash: 'conformance-fixture',
      implementationRevision: 'conformance-fixture',
    };
  }

  return {
    manifestVersion: 1,
    protocolVersion: Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '3'),
    sdkVersion: '0.0.0',
    runtime: { name: 'bun', version: Bun.version },
    deployment: {
      name: 'conformance',
      buildId: 'conformance-fixture',
      artifactDigest: 'sha256:conformance-fixture',
    },
    workflows,
    capabilities: {},
  };
}
