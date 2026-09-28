import { describe, expect, it } from 'bun:test';
import { encode } from '../core/codec.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  bindingFromExecution,
  inheritWorkflowWorkerBinding,
  selectWorkflowActivityBinding,
} from './binding-helpers.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';
import {
  buildWorkflowWorkerStartOverrideConsumption,
  consumeWorkflowWorkerStartOverridePreview,
  issueWorkflowWorkerStartOverridePreview,
  verifyWorkflowWorkerStartOverridePreview,
} from './start-override-preview.ts';
import {
  bindWorkflowWorkerAtStart,
  DEFAULT_WORKFLOW_WORKER_VERSIONING_POLICY,
  evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint,
  evaluateWorkflowWorkerUpgrade,
  readWorkflowWorkerBinding,
  recordWorkflowWorkerUpgrade,
  type WorkflowWorkerBinding,
} from './versioning-policy.ts';

const binding = (buildId: string, revision = 'workflow-revision'): WorkflowWorkerBinding => ({
  workflowId: 'workflow-1',
  workflowType: 'orders',
  deploymentName: 'orders',
  buildId,
  artifactDigest: `sha256:${buildId}`,
  manifestDigest: `sha256:manifest-${buildId}`,
  routingGeneration: 1,
  workflowRevision: revision,
  workflowContractHash: 'sha256:workflow-contract',
  activityContracts: { charge: 'sha256:charge-contract' },
  activityName: 'charge',
  activityContractHash: 'sha256:charge-contract',
  boundAt: 1,
  checkpointId: `checkpoint-${buildId}`,
});

async function seedWorkflow(storage: MemoryStorage): Promise<void> {
  await storage.put(
    KEYS.workflow('workflow-1'),
    encode({
      id: 'workflow-1',
      type: 'orders',
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '1' },
      createdAt: 1,
      updatedAt: 1,
    }),
  );
}

async function seedVersionedWorkflow(
  storage: MemoryStorage,
  current = binding('build-1'),
): Promise<void> {
  await storage.put(
    KEYS.workflow('workflow-1'),
    encode({
      id: 'workflow-1',
      type: 'orders',
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '1' },
      revision: current.workflowRevision,
      createdAt: 1,
      updatedAt: 1,
      workerVersioningPolicy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: 'orders',
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

function manifest(
  buildId: string,
  activityContractHash = 'sha256:charge-contract',
): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: 'orders', buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      orders: {
        workflowVersion: '1',
        workflowRevision: 'workflow-revision',
        contractHash: 'sha256:workflow-contract',
        activities: {
          charge: { contractHash: activityContractHash, implementationRevision: buildId },
        },
      },
    },
    capabilities: {},
  };
}

async function seedDeploymentCatalog(storage: MemoryStorage): Promise<void> {
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of ['build-1', 'build-2']) {
    const buildManifest = manifest(buildId);
    await catalog.registerVersion({
      deploymentName: 'orders',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: buildManifest,
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  await catalog.setRouting({
    deploymentName: 'orders',
    currentBuildId: 'build-2',
    rampBasisPoints: 10_000,
    updatedAt: 2,
  });
}

describe('workflow worker versioning policy', () => {
  it('defaults to pinned and binds start atomically and idempotently', async () => {
    expect(DEFAULT_WORKFLOW_WORKER_VERSIONING_POLICY.mode).toBe('pinned');
    using storage = new MemoryStorage();
    await seedWorkflow(storage);
    const first = await bindWorkflowWorkerAtStart(storage, binding('build-1'));
    const retry = await bindWorkflowWorkerAtStart(storage, binding('build-1'));
    expect(retry).toEqual(first);
    await expect(bindWorkflowWorkerAtStart(storage, binding('build-2'))).rejects.toThrow(
      'already has a different worker binding',
    );
  });

  it('rejects a lost concurrent start binding CAS during the initial batch', async () => {
    class LostCasStorage extends MemoryStorage {
      override async conditionalBatch(): Promise<boolean> {
        return false;
      }
    }
    using storage = new LostCasStorage();
    await seedWorkflow(storage);
    await expect(bindWorkflowWorkerAtStart(storage, binding('build-1'))).rejects.toThrow(
      'Concurrent worker binding changed workflow',
    );
  });

  it('records bounded upgrades only under the exact contract at a checkpoint boundary', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage);
    const first = binding('build-1');
    await bindWorkflowWorkerAtStart(storage, first);
    const candidate = binding('build-2');
    const evaluation = evaluateWorkflowWorkerUpgrade({
      policy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: candidate.deploymentName,
          buildId: candidate.buildId,
          artifactDigest: candidate.artifactDigest,
          manifestDigest: candidate.manifestDigest,
          workflowRevision: first.workflowRevision,
          activityContractHash: first.activityContractHash,
        },
      },
      current: first,
      candidate,
      checkpointCommitted: true,
      realmAcquired: false,
    });
    expect(evaluation.allowed).toBe(true);
    const upgraded = await recordWorkflowWorkerUpgrade(
      storage,
      {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: candidate.deploymentName,
          buildId: candidate.buildId,
          artifactDigest: candidate.artifactDigest,
          manifestDigest: candidate.manifestDigest,
          workflowRevision: first.workflowRevision,
          activityContractHash: first.activityContractHash,
        },
        maxBindingHistory: 1,
      },
      first,
      candidate,
    );
    expect(upgraded.current.buildId).toBe('build-2');
    expect(upgraded.history).toHaveLength(1);
    const stored = await readWorkflowWorkerBinding(storage, first.workflowId);
    expect(stored?.current.buildId).toBe('build-2');
    await expect(
      recordWorkflowWorkerUpgrade(
        storage,
        {
          mode: 'auto-upgrade',
          maxBindingHistory: 0,
          compatibility: {
            deploymentName: candidate.deploymentName,
            buildId: candidate.buildId,
            artifactDigest: candidate.artifactDigest,
            manifestDigest: candidate.manifestDigest,
            workflowRevision: first.workflowRevision,
            activityContractHash: first.activityContractHash,
          },
        },
        candidate,
        binding('build-3'),
      ),
    ).rejects.toThrow('maxBindingHistory');
  });

  it('automatically records a compatible upgrade after a checkpoint commit', async () => {
    using storage = new MemoryStorage();
    await seedVersionedWorkflow(storage);
    await seedDeploymentCatalog(storage);

    const result = await evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
      storage,
      'workflow-1',
      'checkpoint-2',
      2,
    );

    expect(result).toMatchObject({ upgraded: true, binding: { buildId: 'build-2' } });
    const stored = await readWorkflowWorkerBinding(storage, 'workflow-1');
    expect(stored?.current.buildId).toBe('build-2');
    expect(stored?.history[0]?.buildId).toBe('build-1');
  });

  it('leaves the binding unchanged when post-checkpoint compatibility fails', async () => {
    using storage = new MemoryStorage();
    await seedVersionedWorkflow(storage);
    const catalog = new WorkerDeploymentCatalog(storage);
    const incompatibleManifest = manifest('build-2', 'sha256:other-contract');
    await catalog.registerVersion({
      deploymentName: 'orders',
      buildId: 'build-2',
      artifactDigest: 'sha256:build-2',
      manifestDigest: 'sha256:manifest-build-2',
      manifest: incompatibleManifest,
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'orders',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
    });

    const result = await evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
      storage,
      'workflow-1',
      'checkpoint-2',
      2,
    );

    expect(result).toMatchObject({
      upgraded: false,
      evaluation: { allowed: false, reason: 'incompatible-contract' },
    });
    const stored = await readWorkflowWorkerBinding(storage, 'workflow-1');
    expect(stored?.current.buildId).toBe('build-1');
    expect(stored?.history).toHaveLength(0);
  });

  it('derives a complete binding from an accepted worker execution identity', () => {
    expect(
      bindingFromExecution(
        {
          workerId: 'worker-1',
          deploymentName: 'orders',
          buildId: 'build-1',
          artifactDigest: 'sha256:artifact',
          manifestDigest: 'sha256:manifest',
          protocolVersion: 1,
          sdkVersion: 'weft-test',
          runtimeName: 'bun',
          runtimeVersion: '1.4.2',
          workflowType: 'orders',
          activityName: 'charge',
          workflowRevision: 'revision-1',
          activityContractHash: 'sha256:contract',
        },
        'workflow-1',
        'orders',
        'charge',
        'checkpoint-1',
        42,
      ),
    ).toMatchObject({
      workflowId: 'workflow-1',
      workflowType: 'orders',
      deploymentName: 'orders',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact',
      manifestDigest: 'sha256:manifest',
      routingGeneration: 0,
      workflowRevision: 'revision-1',
      workflowContractHash: 'sha256:contract',
      activityContracts: { charge: 'sha256:contract' },
      activityName: 'charge',
      activityContractHash: 'sha256:contract',
      boundAt: 42,
      checkpointId: 'checkpoint-1',
    });
  });

  it('blocks upgrades outside a checkpoint boundary, after realm acquisition, or for a mismatch', () => {
    const current = binding('build-1');
    const policy = {
      mode: 'auto-upgrade' as const,
      compatibility: {
        deploymentName: current.deploymentName,
        buildId: 'build-2',
        artifactDigest: 'sha256:build-2',
        manifestDigest: 'sha256:manifest-build-2',
        workflowRevision: current.workflowRevision,
        activityContractHash: current.activityContractHash,
      },
    };
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: binding('build-2'),
        checkpointCommitted: false,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'not-checkpoint-boundary' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: binding('build-2'),
        checkpointCommitted: true,
        realmAcquired: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'realm-already-acquired' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: binding('build-2', 'other-revision'),
        checkpointCommitted: true,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'incompatible-contract' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy: { mode: 'pinned' },
        current,
        candidate: binding('build-2'),
        checkpointCommitted: true,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'policy-pinned' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: { ...binding('build-2'), workflowId: 'other-workflow' },
        checkpointCommitted: true,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'stale-binding' });
  });

  it('inherits one immutable binding across derived workflow executions', () => {
    const original = binding('build-1');
    const inherited = inheritWorkflowWorkerBinding(original);
    expect(inherited).toEqual(original);
    expect(inherited).not.toBe(original);
  });

  it('couples activities to the workflow unless explicitly selected', () => {
    const workflow = binding('build-1');
    expect(selectWorkflowActivityBinding(workflow)).toBe(workflow);
    const activity = { ...workflow, activityName: 'refund' };
    expect(selectWorkflowActivityBinding(workflow, activity)).toBe(activity);
    expect(() =>
      selectWorkflowActivityBinding(workflow, { ...activity, workflowId: 'other' }),
    ).toThrow('belong to the bound workflow');
  });

  it('requires a scoped, server-issued preview token for a start override', () => {
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: 'workflow-1',
      previousBinding: binding('build-1'),
      targetBinding: binding('build-2'),
      serverSecret: 'secret',
      now: 1000,
      ttlMs: 100,
    });
    expect(preview.scope).toBe('destructive:workflow-worker-version-binding');
    expect(verifyWorkflowWorkerStartOverridePreview(preview, 'secret', 1050)).toBe(true);
    expect(verifyWorkflowWorkerStartOverridePreview(preview, 'wrong-secret', 1050)).toBe(false);
    expect(verifyWorkflowWorkerStartOverridePreview(preview, 'secret', 1101)).toBe(false);
  });

  it('consumes a start override once and rejects replay', async () => {
    using storage = new MemoryStorage();
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: 'workflow-1',
      previousBinding: binding('build-1'),
      targetBinding: binding('build-2'),
      serverSecret: 'secret',
      now: 10,
    });
    expect(await consumeWorkflowWorkerStartOverridePreview(storage, preview, 'secret', 20)).toBe(
      true,
    );
    expect(await consumeWorkflowWorkerStartOverridePreview(storage, preview, 'secret', 20)).toBe(
      false,
    );
  });

  it('builds atomic start override consumption only for the issued scope and contracts', () => {
    const previousBinding = binding('build-1');
    const targetBinding = { ...binding('build-2'), routingGeneration: 2 };
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: 'workflow-1',
      previousBinding,
      targetBinding,
      serverSecret: 'secret',
      now: 10,
    });

    const consumption = buildWorkflowWorkerStartOverrideConsumption({
      workflowId: 'workflow-1',
      preview,
      previousBinding,
      targetBinding,
      serverSecret: 'secret',
      now: 20,
    });
    expect(consumption?.conditions).toHaveLength(1);
    expect(consumption?.operations).toHaveLength(1);
    expect(
      buildWorkflowWorkerStartOverrideConsumption({
        workflowId: 'workflow-1',
        preview,
        previousBinding: { ...previousBinding, routingGeneration: 3 },
        targetBinding,
        serverSecret: 'secret',
        now: 20,
      }),
    ).toBeNull();
    expect(
      buildWorkflowWorkerStartOverrideConsumption({
        workflowId: 'workflow-1',
        preview,
        previousBinding,
        targetBinding: { ...targetBinding, workflowContractHash: 'sha256:changed' },
        serverSecret: 'secret',
        now: 20,
      }),
    ).toBeNull();
  });
});
