import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import type { WorkflowState } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { resolveWorkflowWorkerStartBinding } from '../../worker/versioning-policy.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromStdioLocal } from '../principal.ts';
import {
  createWorkerStartOverridePreviewOperation,
  workerStartOverridePreviewRestBinding,
} from './worker-start-override-preview.ts';

const WORKFLOW_ID = 'preview-workflow';
const WORKFLOW_TYPE = 'preview-workflow-type';
const WORKFLOW_REVISION = 'revision-1';

describe('weft.worker.startoverrides.preview operation', () => {
  it('requires server signing configuration', async () => {
    const registry = createOperationRegistry([createWorkerStartOverridePreviewOperation()]);

    const result = await executeOperation(
      'weft.worker.startoverrides.preview',
      { workflowId: WORKFLOW_ID },
      {
        principal: principalFromStdioLocal(),
        engine: {},
        transport: 'http-rest',
        registry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected preview operation to fail.');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('issues a scoped preview for a terminal auto-upgrade workflow', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await registerManifest(catalog, 'build-1', 'sha256:current-workflow');
    await registerManifest(catalog, 'build-2', 'sha256:target-workflow');
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const currentBinding = await resolveWorkflowWorkerStartBinding(storage, {
      workflowId: WORKFLOW_ID,
      workflowType: WORKFLOW_TYPE,
      workflowRevision: WORKFLOW_REVISION,
      policy: { mode: 'pinned' },
      checkpointId: WORKFLOW_ID,
      boundAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
      expectedGeneration: 1,
    });
    const targetBinding = await resolveWorkflowWorkerStartBinding(storage, {
      workflowId: WORKFLOW_ID,
      workflowType: WORKFLOW_TYPE,
      workflowRevision: WORKFLOW_REVISION,
      policy: { mode: 'pinned' },
      checkpointId: WORKFLOW_ID,
      boundAt: 2,
    });
    await storage.put(
      KEYS.workflow(WORKFLOW_ID),
      encode({
        id: WORKFLOW_ID,
        type: WORKFLOW_TYPE,
        status: 'completed',
        input: null,
        result: 'ok',
        versionTuple: { workflowVersion: '0.0.0' },
        revision: WORKFLOW_REVISION,
        workflowExecutionToken: 'token-1',
        createdAt: 1,
        startedAt: 1,
        updatedAt: 2,
        workerVersioningPolicy: {
          mode: 'auto-upgrade',
          compatibility: {
            deploymentName: targetBinding.deploymentName,
            buildId: targetBinding.buildId,
            artifactDigest: targetBinding.artifactDigest,
            manifestDigest: targetBinding.manifestDigest,
            workflowRevision: targetBinding.workflowRevision,
            activityContractHash: targetBinding.activityContractHash,
          },
        },
        workerBinding: { current: currentBinding, history: [] },
      } satisfies WorkflowState),
    );
    const registry = createOperationRegistry([
      createWorkerStartOverridePreviewOperation({
        storage,
        serverSecret: 'secret',
        clock: () => 10,
      }),
    ]);

    const result = await executeOperation(
      'weft.worker.startoverrides.preview',
      { workflowId: WORKFLOW_ID, ttlMs: 50 },
      {
        principal: principalFromStdioLocal(),
        engine: {},
        transport: 'http-rest',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.fault.message);
    const value = result.value as { preview: { [key: string]: unknown } };
    expect(value.preview).toMatchObject({
      scope: 'destructive:workflow-worker-version-binding',
      workflowId: WORKFLOW_ID,
      previousRoutingGeneration: currentBinding.routingGeneration,
      targetRoutingGeneration: targetBinding.routingGeneration,
      targetWorkflowContractHash: targetBinding.workflowContractHash,
      expiresAt: 60,
    });
  });

  it('rejects invalid durable workflow state before issuing a preview', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflow(WORKFLOW_ID), encode('not-a-workflow-state'));

    const result = await executePreview(storage);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected preview operation to fail.');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('rejects missing, live, unbound, and non-auto-upgrade workflows', async () => {
    const missing = await executePreview(new MemoryStorage());
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('Expected missing workflow preview to fail.');
    expect(missing.fault.code).toBe('EngineFailure');

    const currentBinding = await seedPreviewCatalogAndBinding();

    const liveStorage = new MemoryStorage();
    await seedWorkflowState(liveStorage, {
      status: 'running',
      workerVersioningPolicy: {
        mode: 'auto-upgrade',
        compatibility: compatibilityFromBinding(currentBinding),
      },
      workerBinding: { current: currentBinding, history: [] },
    });
    const live = await executePreview(liveStorage);
    expect(live.ok).toBe(false);
    if (live.ok) throw new Error('Expected live workflow preview to fail.');
    expect(live.fault.code).toBe('EngineFailure');

    const unboundStorage = new MemoryStorage();
    await seedWorkflowState(unboundStorage, { status: 'completed' });
    const unbound = await executePreview(unboundStorage);
    expect(unbound.ok).toBe(false);
    if (unbound.ok) throw new Error('Expected unbound workflow preview to fail.');
    expect(unbound.fault.code).toBe('EngineFailure');

    const pinnedStorage = new MemoryStorage();
    await seedWorkflowState(pinnedStorage, {
      status: 'completed',
      workerVersioningPolicy: { mode: 'pinned' },
      workerBinding: { current: currentBinding, history: [] },
    });
    const pinned = await executePreview(pinnedStorage);
    expect(pinned.ok).toBe(false);
    if (pinned.ok) throw new Error('Expected pinned workflow preview to fail.');
    expect(pinned.fault.code).toBe('EngineFailure');
  });

  it('rejects a resolved target that does not satisfy the workflow compatibility contract', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await registerManifest(catalog, 'build-1', 'sha256:workflow');
    await registerManifest(catalog, 'build-2', 'sha256:workflow');
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const currentBinding = await resolveWorkflowWorkerStartBinding(storage, {
      workflowId: WORKFLOW_ID,
      workflowType: WORKFLOW_TYPE,
      workflowRevision: WORKFLOW_REVISION,
      policy: { mode: 'pinned' },
      checkpointId: WORKFLOW_ID,
      boundAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
      expectedGeneration: 1,
    });
    await seedWorkflowState(storage, {
      status: 'completed',
      workerVersioningPolicy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: 'test-deployment',
          buildId: 'build-2',
          artifactDigest: 'sha256:build-2',
          manifestDigest: 'sha256:manifest-build-2',
          workflowRevision: WORKFLOW_REVISION,
          activityContractHash: currentBinding.activityContractHash,
        },
      },
      workerBinding: { current: currentBinding, history: [] },
    });

    const result = await executePreview(storage);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected incompatible preview to fail.');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('extracts preview requests from the HTTP JSON body', async () => {
    const request = new Request('http://example.test/v1/worker-start-overrides/preview', {
      method: 'POST',
      body: JSON.stringify({ workflowId: WORKFLOW_ID, ttlMs: 50 }),
    });

    expect(await workerStartOverridePreviewRestBinding.extractInput(request, {}, {})).toEqual({
      workflowId: WORKFLOW_ID,
      ttlMs: 50,
    });
  });
});

async function executePreview(storage: MemoryStorage) {
  const registry = createOperationRegistry([
    createWorkerStartOverridePreviewOperation({
      storage,
      serverSecret: 'secret',
      clock: () => 10,
    }),
  ]);

  return executeOperation(
    'weft.worker.startoverrides.preview',
    { workflowId: WORKFLOW_ID },
    {
      principal: principalFromStdioLocal(),
      engine: {},
      transport: 'http-rest',
      registry,
    },
  );
}

async function seedPreviewCatalogAndBinding() {
  const storage = new MemoryStorage();
  const catalog = new WorkerDeploymentCatalog(storage);
  await registerManifest(catalog, 'build-1', 'sha256:workflow');
  await catalog.setRouting({
    deploymentName: 'test-deployment',
    currentBuildId: 'build-1',
    rampBasisPoints: 10_000,
    updatedAt: 1,
  });
  return resolveWorkflowWorkerStartBinding(storage, {
    workflowId: WORKFLOW_ID,
    workflowType: WORKFLOW_TYPE,
    workflowRevision: WORKFLOW_REVISION,
    policy: { mode: 'pinned' },
    checkpointId: WORKFLOW_ID,
    boundAt: 1,
  });
}

async function seedWorkflowState(
  storage: MemoryStorage,
  overrides: Partial<WorkflowState>,
): Promise<void> {
  await storage.put(
    KEYS.workflow(WORKFLOW_ID),
    encode({
      id: WORKFLOW_ID,
      type: WORKFLOW_TYPE,
      status: 'completed',
      input: null,
      versionTuple: { workflowVersion: '0.0.0' },
      revision: WORKFLOW_REVISION,
      workflowExecutionToken: 'token-1',
      createdAt: 1,
      startedAt: 1,
      updatedAt: 2,
      ...overrides,
    } satisfies WorkflowState),
  );
}

function compatibilityFromBinding(
  binding: Awaited<ReturnType<typeof seedPreviewCatalogAndBinding>>,
) {
  return {
    deploymentName: binding.deploymentName,
    buildId: binding.buildId,
    artifactDigest: binding.artifactDigest,
    manifestDigest: binding.manifestDigest,
    workflowRevision: binding.workflowRevision,
    activityContractHash: binding.activityContractHash,
  };
}

async function registerManifest(
  catalog: WorkerDeploymentCatalog,
  buildId: string,
  workflowContractHash: string,
): Promise<void> {
  const manifest: WorkerManifest = {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: {
      name: 'test-deployment',
      buildId,
      artifactDigest: `sha256:${buildId}`,
    },
    workflows: {
      [WORKFLOW_TYPE]: {
        workflowVersion: '0.0.0',
        workflowRevision: WORKFLOW_REVISION,
        contractHash: workflowContractHash,
        activities: {
          charge: { contractHash: `sha256:charge-${buildId}`, implementationRevision: buildId },
        },
      },
    },
    capabilities: {},
  };
  await catalog.registerVersion({
    deploymentName: manifest.deployment.name,
    buildId,
    artifactDigest: manifest.deployment.artifactDigest,
    manifestDigest: `sha256:manifest-${buildId}`,
    manifest,
    state: 'ready',
    firstSeenAt: 1,
  });
}
