import type {
  WorkerExecutionIdentity,
  WorkerExecutionRequirement,
  WorkerManifest,
} from '../../index.ts';

const manifest: WorkerManifest = {
  manifestVersion: 1,
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
  capabilities: { gpu: true },
};

// A requirement pins only what the task cares about; every field is optional.
const requirement: WorkerExecutionRequirement = { deploymentName: 'billing' };
const emptyRequirement: WorkerExecutionRequirement = {};

// An identity is always complete — no field may be omitted.
const identity: WorkerExecutionIdentity = {
  workerId: 'worker-1',
  manifestDigest: 'sha256:deadbeef',
  protocolVersion: 2,
  sdkVersion: '0.18.0',
  runtimeName: 'bun',
  runtimeVersion: '1.3.14',
  deploymentName: 'billing',
  buildId: 'b3',
  artifactDigest: 'sha256:41d0',
  workflowType: 'checkout',
  workflowRevision: 'rev-8',
  activityName: 'charge',
  activityContractHash: 'sha256:bb',
};

// @ts-expect-error the manifest version is pinned to the supported schema version.
const wrongManifestVersion: WorkerManifest = { ...manifest, manifestVersion: 2 };
// @ts-expect-error a manifest is deeply read-only.
manifest.deployment.buildId = 'b4';
// @ts-expect-error a partial execution identity is not an observed identity.
const partialIdentity: WorkerExecutionIdentity = { workerId: 'worker-1' };
// @ts-expect-error a routing requirement is not an observed execution identity.
const requirementAsIdentity: WorkerExecutionIdentity = requirement;
// @ts-expect-error requirements only carry the five documented routing fields.
const unknownRequirementField: WorkerExecutionRequirement = { workerId: 'worker-1' };

void manifest;
void requirement;
void emptyRequirement;
void identity;
void wrongManifestVersion;
void partialIdentity;
void requirementAsIdentity;
void unknownRequirementField;
