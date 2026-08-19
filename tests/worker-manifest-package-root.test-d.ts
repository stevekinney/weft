import {
  buildWorkerExecutionIdentity,
  executionIdentitySatisfies,
  parseWorkerManifest,
  WORKER_MANIFEST_VERSION,
  type WorkerExecutionIdentity,
  type WorkerExecutionRequirement,
  type WorkerManifest,
  type WorkerManifestRejectionReason,
} from '@lostgradient/weft';

const manifest: WorkerManifest = {
  manifestVersion: WORKER_MANIFEST_VERSION,
  protocolVersion: 2,
  sdkVersion: '0.18.0',
  runtime: { name: 'bun', version: '1.3.14' },
  deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
  workflows: {
    checkout: {
      workflowVersion: '1.0.0',
      workflowRevision: 'rev-8',
      contractHash: 'sha256:aa',
      activities: { charge: { contractHash: 'sha256:bb', implementationRevision: 'r1' } },
    },
  },
  capabilities: {},
};

// Validation narrows without a cast at the call site.
const result = parseWorkerManifest(manifest);
if (result.ok) {
  const accepted: WorkerManifest = result.manifest;
  void accepted;
} else {
  const reason: WorkerManifestRejectionReason = result.reason;
  void reason;
}

const identity = buildWorkerExecutionIdentity({
  manifest,
  manifestDigest: 'sha256:deadbeef',
  workerId: 'worker-1',
  workflowType: 'checkout',
  activityName: 'charge',
});

const requirement: WorkerExecutionRequirement = { buildId: 'b3' };
if (identity !== undefined) {
  const eligible: boolean = executionIdentitySatisfies(requirement, identity);
  void eligible;
}

// @ts-expect-error the requirement argument comes before the identity argument.
executionIdentitySatisfies(identity as WorkerExecutionIdentity, requirement);
