import {
  buildWorkerExecutionIdentity,
  executionIdentitySatisfies,
  parseWorkerManifest,
  WORKER_MANIFEST_VERSION,
  type WorkerExecutionIdentity,
  type WorkerExecutionRequirement,
  type WorkerManifest,
  type WorkerManifestParseResult,
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
const result: WorkerManifestParseResult = parseWorkerManifest(manifest);
const accepted: WorkerManifest | undefined = result.ok ? result.manifest : undefined;
const reason: WorkerManifestRejectionReason | undefined = result.ok ? undefined : result.reason;

const identity: WorkerExecutionIdentity | undefined = buildWorkerExecutionIdentity({
  manifest,
  manifestDigest: 'sha256:deadbeef',
  workerId: 'worker-1',
  workflowType: 'checkout',
  activityName: 'charge',
});

const requirement: WorkerExecutionRequirement = { buildId: 'b3' };
const eligible: boolean = identity === undefined ? false : executionIdentitySatisfies(requirement, identity);

// @ts-expect-error the requirement argument comes before the identity argument.
executionIdentitySatisfies(identity as WorkerExecutionIdentity, requirement);

void accepted;
void reason;
void eligible;
