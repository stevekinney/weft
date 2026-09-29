import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';
import {
  buildWorkflowWorkerStartOverrideConsumption,
  issueWorkflowWorkerStartOverridePreview,
} from './start-override-preview.ts';
import {
  evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint,
  readWorkflowWorkerBinding,
  resolveWorkflowWorkerStartBinding,
  type WorkflowWorkerBinding,
} from './versioning-policy.ts';

const WORKFLOW_ID = 'workflow-edge-1';
const WORKFLOW_TYPE = 'orders-edge';
const WORKFLOW_REVISION = 'workflow-revision-edge';

describe('workflow worker versioning edge policies', () => {
  it('rejects starts when no accepted routed deployment provides the workflow revision', async () => {
    using storage = new MemoryStorage();

    expect(
      await throwingRejectionOf(
        resolveWorkflowWorkerStartBinding(storage, {
          workflowId: WORKFLOW_ID,
          workflowType: WORKFLOW_TYPE,
          workflowRevision: WORKFLOW_REVISION,
          policy: { mode: 'pinned' },
          checkpointId: WORKFLOW_ID,
          boundAt: 1,
        }),
      ),
    ).toThrow('No accepted routed worker deployment provides workflow');
  });

  it('uses the workflow contract as the binding activity contract when no activities are declared', async () => {
    using storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: 'orders-edge',
      buildId: 'build-1',
      artifactDigest: 'sha256:build-1',
      manifestDigest: 'sha256:manifest-build-1',
      manifest: manifestWithoutActivities('build-1'),
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'orders-edge',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const resolved = await resolveWorkflowWorkerStartBinding(storage, {
      workflowId: WORKFLOW_ID,
      workflowType: WORKFLOW_TYPE,
      workflowRevision: WORKFLOW_REVISION,
      policy: { mode: 'pinned' },
      checkpointId: WORKFLOW_ID,
      boundAt: 1,
    });

    expect(resolved).toMatchObject({
      activityName: '*',
      activityContractHash: 'sha256:workflow-contract',
      activityContracts: {},
    });
  });

  it('selects and stores activity contracts in stable sorted order', async () => {
    using storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: 'orders-edge',
      buildId: 'build-1',
      artifactDigest: 'sha256:build-1',
      manifestDigest: 'sha256:manifest-build-1',
      manifest: manifestWithMultipleActivities('build-1'),
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'orders-edge',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const resolved = await resolveWorkflowWorkerStartBinding(storage, {
      workflowId: WORKFLOW_ID,
      workflowType: WORKFLOW_TYPE,
      workflowRevision: WORKFLOW_REVISION,
      policy: { mode: 'pinned' },
      checkpointId: WORKFLOW_ID,
      boundAt: 1,
    });

    expect(resolved).toMatchObject({
      activityName: 'charge',
      activityContractHash: 'sha256:charge-contract',
      activityContracts: {
        charge: 'sha256:charge-contract',
        refund: 'sha256:refund-contract',
      },
    });
    expect(Object.keys(resolved.activityContracts)).toEqual(['charge', 'refund']);
  });

  it('leaves the binding unchanged when no post-checkpoint candidate can be resolved', async () => {
    using storage = new MemoryStorage();
    await seedVersionedWorkflow(storage, binding('build-1'));

    const result = await evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
      storage,
      WORKFLOW_ID,
      'checkpoint-2',
      2,
    );

    expect(result).toEqual({ upgraded: false, evaluation: null });
    const stored = await readWorkflowWorkerBinding(storage, WORKFLOW_ID);
    expect(stored?.current.buildId).toBe('build-1');
  });

  it('leaves the binding unchanged when a concurrent writer wins the upgrade CAS', async () => {
    using storage = new UpgradeLostCasStorage();
    await seedVersionedWorkflow(storage, binding('build-1'));
    await seedDeploymentCatalog(storage);
    storage.failWorkflowConditionalBatchFor(WORKFLOW_ID);

    const result = await evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
      storage,
      WORKFLOW_ID,
      'checkpoint-2',
      2,
    );

    expect(result).toMatchObject({ upgraded: false });
    const stored = await readWorkflowWorkerBinding(storage, WORKFLOW_ID);
    expect(stored?.current.buildId).toBe('build-1');
  });

  it('digests activity contracts canonically when validating override previews', () => {
    const previousBinding = {
      ...binding('build-1'),
      activityContracts: { refund: 'sha256:refund', charge: 'sha256:charge' },
    };
    const targetBinding = {
      ...binding('build-2'),
      routingGeneration: 2,
      activityContracts: { charge: 'sha256:charge-v2', refund: 'sha256:refund-v2' },
    };
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: WORKFLOW_ID,
      previousBinding,
      targetBinding,
      serverSecret: 'secret',
      now: 1,
    });

    expect(
      buildWorkflowWorkerStartOverrideConsumption({
        workflowId: WORKFLOW_ID,
        preview,
        previousBinding,
        targetBinding: {
          ...targetBinding,
          activityContracts: { refund: 'sha256:refund-v2', charge: 'sha256:charge-v2' },
        },
        serverSecret: 'secret',
        now: 2,
      }),
    ).not.toBeNull();
  });
});

class UpgradeLostCasStorage extends MemoryStorage {
  #workflowIdToFail: string | null = null;

  failWorkflowConditionalBatchFor(workflowId: string): void {
    this.#workflowIdToFail = workflowId;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (
      this.#workflowIdToFail !== null &&
      operations.some((operation) => operation.key === KEYS.workflow(this.#workflowIdToFail!))
    ) {
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

async function seedVersionedWorkflow(
  storage: MemoryStorage,
  current: WorkflowWorkerBinding,
): Promise<void> {
  await storage.put(
    KEYS.workflow(WORKFLOW_ID),
    encode({
      id: WORKFLOW_ID,
      type: WORKFLOW_TYPE,
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '1' },
      revision: current.workflowRevision,
      createdAt: 1,
      updatedAt: 1,
      workerVersioningPolicy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: current.deploymentName,
          buildId: 'build-2',
          artifactDigest: 'sha256:build-2',
          manifestDigest: 'sha256:manifest-build-2',
          workflowRevision: current.workflowRevision,
          activityContractHash: current.activityContractHash,
        },
      },
      workerBinding: { current, history: [] },
    }),
  );
}

async function seedDeploymentCatalog(storage: MemoryStorage): Promise<void> {
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of ['build-1', 'build-2']) {
    await catalog.registerVersion({
      deploymentName: 'orders-edge',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: manifest(buildId),
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  await catalog.setRouting({
    deploymentName: 'orders-edge',
    currentBuildId: 'build-2',
    rampBasisPoints: 10_000,
    updatedAt: 2,
  });
}

function manifest(buildId: string): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: 'orders-edge', buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      [WORKFLOW_TYPE]: {
        workflowVersion: '1',
        workflowRevision: WORKFLOW_REVISION,
        contractHash: 'sha256:workflow-contract',
        activities: {
          charge: { contractHash: 'sha256:charge-contract', implementationRevision: buildId },
        },
      },
    },
    capabilities: {},
  };
}

function manifestWithoutActivities(buildId: string): WorkerManifest {
  return {
    ...manifest(buildId),
    workflows: {
      [WORKFLOW_TYPE]: {
        workflowVersion: '1',
        workflowRevision: WORKFLOW_REVISION,
        contractHash: 'sha256:workflow-contract',
        activities: {},
      },
    },
  };
}

function manifestWithMultipleActivities(buildId: string): WorkerManifest {
  return {
    ...manifest(buildId),
    workflows: {
      [WORKFLOW_TYPE]: {
        workflowVersion: '1',
        workflowRevision: WORKFLOW_REVISION,
        contractHash: 'sha256:workflow-contract',
        activities: {
          refund: { contractHash: 'sha256:refund-contract', implementationRevision: buildId },
          charge: { contractHash: 'sha256:charge-contract', implementationRevision: buildId },
        },
      },
    },
  };
}

function binding(buildId: string): WorkflowWorkerBinding {
  return {
    workflowId: WORKFLOW_ID,
    workflowType: WORKFLOW_TYPE,
    deploymentName: 'orders-edge',
    buildId,
    artifactDigest: `sha256:${buildId}`,
    manifestDigest: `sha256:manifest-${buildId}`,
    routingGeneration: buildId === 'build-1' ? 1 : 2,
    workflowRevision: WORKFLOW_REVISION,
    workflowContractHash: 'sha256:workflow-contract',
    activityContracts: { charge: 'sha256:charge-contract' },
    activityName: 'charge',
    activityContractHash: 'sha256:charge-contract',
    boundAt: 1,
    checkpointId: `checkpoint-${buildId}`,
  };
}
