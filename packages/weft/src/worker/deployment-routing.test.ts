import { describe, expect, it } from 'bun:test';
import { Engine } from '../core/engine.ts';
import { serve } from '../server/index.ts';
import {
  createPreviewWorkerDeploymentRoutingOperation,
  createPromoteWorkerDeploymentOperation,
  createRollbackWorkerDeploymentOperation,
  createSetWorkerDeploymentRoutingOperation,
  createWorkerDeploymentDiagnosticsOperation,
  workerDeploymentDiagnosticsRestBinding,
  workerDeploymentRoutingRestBinding,
} from '../server/operations/worker-deployment-routing.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  selectWorkerDeployment,
  WorkerDeploymentCatalog,
  type DeploymentRoutingCandidate,
  type WorkerDeploymentRouting,
} from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';

class DrainBeforeConditionalStorage extends MemoryStorage {
  #beforeCommit: (() => Promise<void>) | undefined;
  arm(beforeCommit: () => Promise<void>): void {
    this.#beforeCommit = beforeCommit;
  }
  override async conditionalBatch(...args: Parameters<MemoryStorage['conditionalBatch']>) {
    const beforeCommit = this.#beforeCommit;
    this.#beforeCommit = undefined;
    if (beforeCommit !== undefined) await beforeCommit();
    return super.conditionalBatch(...args);
  }
}

function manifest(buildId: string, workflowRevision = 'revision-a'): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: 'billing', buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      checkout: {
        workflowVersion: '1',
        workflowRevision,
        contractHash: 'sha256:workflow',
        activities: {
          charge: { contractHash: 'sha256:activity', implementationRevision: buildId },
        },
      },
    },
    capabilities: {},
  };
}
function routing(rampingBuildId?: string, rampBasisPoints = 10_000): WorkerDeploymentRouting {
  return {
    deploymentName: 'billing',
    currentBuildId: 'build-a',
    ...(rampingBuildId ? { rampingBuildId } : {}),
    rampBasisPoints,
    generation: 1,
    updatedAt: 1,
  };
}
function candidate(
  workerId: string,
  buildId: string,
  availableCapacity = 1,
): DeploymentRoutingCandidate {
  return { workerId, buildId, manifest: manifest(buildId), availableCapacity };
}

describe('revision-aware worker deployment routing', () => {
  it('selects exact versions and excludes draining or unavailable workers', () => {
    const result = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'run-1',
      activityName: 'charge',
      routing: routing(),
      candidates: [
        candidate('z', 'build-a'),
        candidate('y', 'build-a'),
        candidate('a', 'build-a', 0),
        { ...candidate('draining', 'build-a'), draining: true },
      ],
    });
    expect(result.candidate?.workerId).toBe('y');
    const pinned = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'run-1',
      requirement: { buildId: 'build-b' },
      routing: routing('build-b'),
      candidates: [candidate('worker-a', 'build-a')],
    });
    expect(pinned).toMatchObject({
      candidate: undefined,
      reason: 'revision-incompatible',
      buildId: 'build-b',
    });
  });
  it('uses deterministic basis-point rollout boundaries and revision checks', () => {
    const ramp = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 10_000),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(ramp.buildId).toBe('build-b');
    const noRamp = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 0),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(noRamp.buildId).toBe('build-a');
    const oneBasisPoint = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 1),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(oneBasisPoint.buildId).toBe('build-a');
    const almostComplete = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 9_999),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(almostComplete.buildId).toBe('build-b');
    const incompatible = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      requirement: { workflowRevision: 'missing' },
      routing: routing(),
      candidates: [candidate('a', 'build-a')],
    });
    expect(incompatible).toMatchObject({ candidate: undefined, reason: 'revision-incompatible' });
    const contractMatch = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      requirement: { activityContractHash: 'sha256:activity' },
      routing: routing(),
      candidates: [candidate('contract', 'build-a')],
    });
    expect(contractMatch.candidate?.workerId).toBe('contract');
  });
  it('protects references while draining and removing a version', async () => {
    const catalog = new WorkerDeploymentCatalog(new MemoryStorage());
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-a',
      artifactDigest: 'sha256:build-a',
      manifestDigest: 'sha256:m',
      manifest: manifest('build-a'),
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.reference('billing', 'build-a', 1);
    const retained = await catalog.markDraining('billing', 'build-a');
    expect(retained?.state).toBe('ready');
    expect(await catalog.removeVersion('billing', 'build-a')).toBe(false);
    await catalog.reference('billing', 'build-a', -1);
    const draining = await catalog.markDraining('billing', 'build-a');
    expect(draining?.state).toBe('draining');
    expect(await catalog.removeVersion('billing', 'build-a')).toBe(true);
  });
  it('covers catalog boundaries and operation mutations', async () => {
    const catalog = new WorkerDeploymentCatalog(new MemoryStorage());
    const buildA = {
      deploymentName: 'billing',
      buildId: 'build-a',
      artifactDigest: 'sha256:build-a',
      manifestDigest: 'sha256:m-a',
      manifest: manifest('build-a'),
      state: 'ready' as const,
      firstSeenAt: 1,
    };
    await catalog.registerVersion(buildA);
    await catalog.registerVersion({
      ...buildA,
      buildId: 'build-b',
      artifactDigest: 'sha256:build-b',
      manifestDigest: 'sha256:m-b',
      manifest: manifest('build-b'),
      firstSeenAt: 2,
    });
    const versions = await catalog.listVersions();
    expect(versions.map((version) => version.buildId)).toEqual(['build-a', 'build-b']);
    expect(await catalog.reference('billing', 'missing', 1)).toBeNull();
    expect(await catalog.markDraining('billing', 'missing')).toBeNull();
    expect(await catalog.removeVersion('billing', 'missing')).toBe(false);
    await expect(
      catalog.setRouting({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        rampBasisPoints: 10_001,
        updatedAt: 3,
      }),
    ).rejects.toThrow('rampBasisPoints');
    await expect(
      catalog.setRouting({
        deploymentName: 'billing',
        currentBuildId: 'missing',
        rampBasisPoints: 0,
        updatedAt: 4,
      }),
    ).rejects.toThrow('not eligible');
    await expect(
      catalog.setRouting({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        rampingBuildId: 'build-a',
        rampBasisPoints: 1,
        updatedAt: 5,
      }),
    ).rejects.toThrow('differ');

    const invoke = (operation: { invoke: (context: never) => Promise<unknown> }, input: unknown) =>
      operation.invoke({ input } as never);
    const routingInput = {
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampingBuildId: 'build-b',
      rampBasisPoints: 500,
      expectedGeneration: 0,
    };
    await expect(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), routingInput),
    ).resolves.toMatchObject({ valid: true });
    const set = await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), routingInput);
    expect(set).toMatchObject({ generation: 1, rampingBuildId: 'build-b' });
    expect(
      await invoke(createPromoteWorkerDeploymentOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    ).toMatchObject({ currentBuildId: 'build-b' });
    expect(
      await invoke(createRollbackWorkerDeploymentOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-a',
      }),
    ).toMatchObject({ currentBuildId: 'build-a' });
    expect(await invoke(createWorkerDeploymentDiagnosticsOperation({ catalog }), {})).toMatchObject(
      { routing: null },
    );
    await expect(invoke(createSetWorkerDeploymentRoutingOperation(), routingInput)).rejects.toThrow(
      'live worker deployment catalog',
    );
    await expect(
      invoke(createPromoteWorkerDeploymentOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'missing',
      }),
    ).rejects.toThrow('does not exist');
    await expect(
      invoke(createRollbackWorkerDeploymentOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'missing',
      }),
    ).rejects.toThrow('does not exist');
    await expect(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), {
        ...routingInput,
        rampingBuildId: 'missing',
      }),
    ).rejects.toThrow('does not exist');
    await expect(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), {
        ...routingInput,
        currentBuildId: 'missing',
      }),
    ).rejects.toThrow('does not exist');
    const extracted = await workerDeploymentRoutingRestBinding.extractInput(
      new Request('http://localhost/v1/worker-deployments/routing', {
        method: 'POST',
        body: JSON.stringify(routingInput),
      }),
      {},
      {},
    );
    expect(extracted).toEqual(routingInput);
    await expect(
      workerDeploymentDiagnosticsRestBinding.extractInput(
        new Request('http://localhost/v1/worker-deployments/diagnostics'),
        {},
        {},
      ),
    ).resolves.toEqual({});
    await expect(
      workerDeploymentDiagnosticsRestBinding.extractInput(
        new Request('http://localhost/v1/worker-deployments/diagnostics?deploymentName=billing'),
        {},
        {},
      ),
    ).resolves.toEqual({ deploymentName: 'billing' });
  });
  it('recovers immutable versions and routing pointers from durable storage', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-a',
      artifactDigest: 'sha256:build-a',
      manifestDigest: 'sha256:m',
      manifest: manifest('build-a'),
      state: 'ready',
      firstSeenAt: 1,
    });
    const pointer = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampBasisPoints: 0,
      updatedAt: 2,
    });
    expect(pointer?.generation).toBe(1);
    const recovered = new WorkerDeploymentCatalog(storage);
    const versions = await recovered.listVersions('billing');
    expect(versions.map((version) => version.buildId)).toEqual(['build-a']);
    const recoveredRouting = await recovered.getRouting('billing');
    expect(recoveredRouting?.currentBuildId).toBe('build-a');
    expect(
      await recovered.setRouting({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        rampBasisPoints: 0,
        updatedAt: 3,
        expectedGeneration: 0,
      }),
    ).toBeNull();
  });
  it('wires the durable catalog through the public live server path', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['routing-test-key'], defaultApiKeyScopes: ['system:admin', 'system:read'] },
    });
    try {
      const catalog = new WorkerDeploymentCatalog(storage);
      await catalog.registerVersion({
        deploymentName: 'billing',
        buildId: 'build-a',
        artifactDigest: 'sha256:build-a',
        manifestDigest: 'sha256:m',
        manifest: manifest('build-a'),
        state: 'ready',
        firstSeenAt: 1,
      });
      const response = await fetch(`${server.url}/api/v1/worker-deployments/routing`, {
        method: 'POST',
        headers: { Authorization: 'Bearer routing-test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deploymentName: 'billing',
          currentBuildId: 'build-a',
          rampBasisPoints: 0,
        }),
      });
      expect(response.status).toBe(200);
      const diagnostics = await fetch(
        `${server.url}/api/v1/worker-deployments/diagnostics?deploymentName=billing`,
        {
          headers: { Authorization: 'Bearer routing-test-key' },
        },
      );
      expect(diagnostics.status).toBe(200);
      expect(await diagnostics.json()).toMatchObject({ routing: { currentBuildId: 'build-a' } });
    } finally {
      await server.stop();
      await engine[Symbol.asyncDispose]();
    }
  });
  it('serializes routing targets with lifecycle transitions in one CAS', async () => {
    let storage!: DrainBeforeConditionalStorage;
    let lifecycle!: WorkerDeploymentCatalog;
    storage = new DrainBeforeConditionalStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    lifecycle = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-a', 'build-b']) {
      await catalog.registerVersion({
        deploymentName: 'billing',
        buildId,
        artifactDigest: `sha256:${buildId}`,
        manifestDigest: `sha256:${buildId}`,
        manifest: manifest(buildId),
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    storage.arm(async () => {
      await lifecycle.markDraining('billing', 'build-b');
    });
    expect(
      await catalog.setRouting({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        rampingBuildId: 'build-b',
        rampBasisPoints: 100,
        updatedAt: 1,
      }),
    ).toBeNull();
    expect(await catalog.getRouting('billing')).toBeNull();
    const drainedVersion = await catalog.getVersion('billing', 'build-b');
    expect(drainedVersion?.state).toBe('draining');
  });
});
