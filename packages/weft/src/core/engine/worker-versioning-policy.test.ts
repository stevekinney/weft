import { describe, expect, it } from 'bun:test';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { issueWorkflowWorkerStartOverridePreview } from '../../worker/start-override-preview.ts';
import type { WorkflowWorkerBinding } from '../../worker/versioning-policy.ts';
import { resolveWorkflowWorkerStartBinding } from '../../worker/versioning-policy.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { applyForkWorkerBindingInheritance } from './lifecycle/fork-helpers.ts';
import { createInitialWorkflowState } from './lifecycle/start-state.ts';

describe('workflow worker versioning integration', () => {
  it('persists the default pinned binding in the atomic workflow start batch', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'versioned-start', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* () {
          return 'ok';
        },
      ),
    );
    const revisions = await engine.workflows.listRevisions('versioned-start');
    const manifest = {
      manifestVersion: 1,
      protocolVersion: 1,
      sdkVersion: 'test',
      runtime: { name: 'bun', version: 'test' },
      deployment: {
        name: 'test-deployment',
        buildId: 'build-1',
        artifactDigest: 'sha256:artifact',
      },
      workflows: {
        'versioned-start': {
          workflowVersion: '0.0.0',
          workflowRevision: revisions[0]?.manifest.revision ?? '',
          contractHash: 'sha256:workflow',
          activities: { charge: { contractHash: 'sha256:charge', implementationRevision: '1' } },
        },
      },
      capabilities: {},
    } satisfies WorkerManifest;
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: manifest.deployment.name,
      buildId: manifest.deployment.buildId,
      artifactDigest: manifest.deployment.artifactDigest,
      manifestDigest: 'sha256:manifest',
      manifest,
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: manifest.deployment.name,
      currentBuildId: manifest.deployment.buildId,
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const handle = await engine.start('versioned-start', null, { id: 'versioned-start-1' });
    const state = decode((await storage.get(KEYS.workflow(handle.id)))!) as WorkflowState;
    expect(state.workerVersioningPolicy).toEqual({ mode: 'pinned' });
    expect(state.workerBinding?.current.workflowId).toBe(handle.id);
    expect(state.workerBinding?.current.workflowRevision).toBe(state.revision);
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();
  });

  it('inherits the source worker binding when forking a versioned workflow at the same revision', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage, inlineLaunchScheduling: 'manual' });
    engine.register(
      workflow({ name: 'versioned-fork', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* () {
          return 'ok';
        },
      ),
    );
    const revisions = await engine.workflows.listRevisions('versioned-fork');
    const revision = revisions[0]?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    const buildManifest = manifest('versioned-fork', revision, 'build-1');
    await catalog.registerVersion({
      deploymentName: buildManifest.deployment.name,
      buildId: buildManifest.deployment.buildId,
      artifactDigest: buildManifest.deployment.artifactDigest,
      manifestDigest: 'sha256:manifest-build-1',
      manifest: buildManifest,
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const source = await engine.start('versioned-fork', null, { id: 'versioned-fork-source' });
    const forked = await engine.fork(source.id);

    const sourceState = decode((await storage.get(KEYS.workflow(source.id)))!) as WorkflowState;
    const forkedState = decode((await storage.get(KEYS.workflow(forked.id)))!) as WorkflowState;
    const sourceBinding = sourceState.workerBinding?.current;
    if (sourceBinding === undefined) throw new Error('Expected source worker binding.');
    expect(forkedState.workerVersioningPolicy).toEqual(sourceState.workerVersioningPolicy);
    expect(forkedState.workerBinding?.current).toEqual({
      ...sourceBinding,
      workflowId: forked.id,
      boundAt: forkedState.createdAt,
      checkpointId: 'fork:versioned-fork-source:0',
    });
    expect(forkedState.workerBinding?.history).toEqual(sourceState.workerBinding?.history);
  });

  it('does not inherit a source worker binding when an explicit fork revision differs', () => {
    const sourceBinding = workerBinding('versioned-fork-mismatch-source', 'revision-1');
    const sourceState = {
      id: 'versioned-fork-mismatch-source',
      type: 'versioned-fork-mismatch',
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '0.0.0' },
      revision: sourceBinding.workflowRevision,
      workflowExecutionToken: 'token-source',
      createdAt: 1,
      startedAt: 1,
      updatedAt: 1,
      workerVersioningPolicy: { mode: 'pinned' },
      workerBinding: { current: sourceBinding, history: [] },
    } satisfies WorkflowState;
    const forkedState: WorkflowState = {
      id: 'versioned-fork-mismatch-child',
      type: sourceState.type,
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '0.0.0' },
      revision: 'revision-2',
      workflowExecutionToken: 'token-child',
      createdAt: 2,
      startedAt: 2,
      updatedAt: 2,
    };

    applyForkWorkerBindingInheritance(forkedState, sourceState, {
      persistedRevision: 'revision-2',
      forkedAt: 2,
      checkpointId: 'fork:versioned-fork-mismatch-source:0',
    });

    expect(forkedState.workerBinding).toBeUndefined();
    expect(forkedState.workerVersioningPolicy).toBeUndefined();
  });

  it('requires resolved accepted worker binding before building a versioned initial state', async () => {
    await using engine = new Engine({ getNow: () => 1 });
    engine.register(
      workflow({
        name: 'versioned-missing-binding',
        workerVersioningPolicy: { mode: 'pinned' },
      }).execute(async function* () {
        return 'ok';
      }),
    );
    const internals = getInternals(engine);
    const registration = internals.registrations.get('versioned-missing-binding');
    if (registration === undefined) throw new Error('Expected registered workflow.');
    const callbacks = {} as Parameters<typeof createInitialWorkflowState>[12];

    expect(() =>
      createInitialWorkflowState(
        internals,
        'versioned-missing-binding-1',
        'versioned-missing-binding',
        null,
        { workflowVersion: '0.0.0' },
        'revision-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        callbacks,
        false,
        registration,
        undefined,
      ),
    ).toThrow('Accepted worker deployment binding is required');
  });

  it('persists a worker binding for prepared versioned workflows before launch', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'versioned-prepare', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* () {
          return 'ok';
        },
      ),
    );
    const revisions = await engine.workflows.listRevisions('versioned-prepare');
    const revision = revisions[0]?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    const buildManifest = manifest('versioned-prepare', revision, 'build-1');
    await catalog.registerVersion({
      deploymentName: buildManifest.deployment.name,
      buildId: buildManifest.deployment.buildId,
      artifactDigest: buildManifest.deployment.artifactDigest,
      manifestDigest: 'sha256:manifest-build-1',
      manifest: buildManifest,
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const prepared = await engine.prepare('versioned-prepare', null, {
      id: 'versioned-prepare-1',
    });
    const preparedState = decode((await storage.get(KEYS.workflow(prepared.id)))!) as WorkflowState;

    expect(preparedState.status).toBe('pending');
    expect(preparedState.workerVersioningPolicy).toEqual({ mode: 'pinned' });
    expect(preparedState.workerBinding?.current).toMatchObject({
      workflowId: prepared.id,
      workflowType: 'versioned-prepare',
      buildId: 'build-1',
      workflowRevision: revision,
    });
  });

  it('evaluates automatic worker upgrades through the post-checkpoint commit path', async () => {
    const storage = new MemoryStorage();
    let now = 1;
    await using engine = new Engine({ storage, getNow: () => now });
    engine.register(
      workflow({
        name: 'versioned-checkpoint-upgrade',
        workerVersioningPolicy: { mode: 'pinned' },
      }).execute(async function* (ctx) {
        return yield* ctx.waitForSignal<string>('go');
      }),
    );
    const revisions = await engine.workflows.listRevisions('versioned-checkpoint-upgrade');
    const revision = revisions[0]?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-1', 'build-2']) {
      const buildManifest = manifest('versioned-checkpoint-upgrade', revision, buildId);
      await catalog.registerVersion({
        deploymentName: buildManifest.deployment.name,
        buildId,
        artifactDigest: buildManifest.deployment.artifactDigest,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest,
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const handle = await engine.start('versioned-checkpoint-upgrade', null, {
      id: 'versioned-checkpoint-upgrade-1',
    });
    const startedState = decode((await storage.get(KEYS.workflow(handle.id)))!) as WorkflowState;
    await storage.put(
      KEYS.workflow(handle.id),
      encode({
        ...startedState,
        workerVersioningPolicy: {
          mode: 'auto-upgrade',
          compatibility: {
            deploymentName: 'test-deployment',
            buildId: 'build-2',
            artifactDigest: 'sha256:build-2',
            manifestDigest: 'sha256:manifest-build-2',
            workflowRevision: revision,
            activityContractHash: 'sha256:charge',
          },
        },
      } satisfies WorkflowState),
    );
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
      expectedGeneration: 1,
    });

    now = 5;
    await handle.signal('go', 'done');
    await handle.result();

    const state = decode((await storage.get(KEYS.workflow(handle.id)))!) as WorkflowState;
    expect(state.workerBinding?.current).toMatchObject({
      buildId: 'build-2',
      boundAt: 5,
    });
    expect(state.workerBinding?.history[0]).toMatchObject({ buildId: 'build-1' });
  });

  it('inherits the terminal worker binding for no-preview start-new retries', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'versioned-retry', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* () {
          return 'ok';
        },
      ),
    );
    const revisions = await engine.workflows.listRevisions('versioned-retry');
    const revision = revisions[0]?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-1', 'build-2']) {
      const buildManifest = manifest('versioned-retry', revision, buildId);
      await catalog.registerVersion({
        deploymentName: buildManifest.deployment.name,
        buildId,
        artifactDigest: buildManifest.deployment.artifactDigest,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest,
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const first = await engine.start('versioned-retry', null, { id: 'versioned-retry-1' });
    await first.result();
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
      expectedGeneration: 1,
    });

    const second = await engine.start('versioned-retry', null, {
      id: first.id,
      onTerminalConflict: 'start-new',
    });
    await second.result();

    const restarted = decode((await storage.get(KEYS.workflow(first.id)))!) as WorkflowState;
    expect(restarted.workerBinding?.current.buildId).toBe('build-1');
    expect(restarted.workerBinding?.history).toEqual([]);
  });

  it('consumes a destructive worker start override atomically with terminal replacement', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage, workerStartOverrideSigningSecret: 'secret' });
    engine.register(
      workflow({ name: 'versioned-restart', workerVersioningPolicy: { mode: 'pinned' } }).execute(
        async function* () {
          return 'ok';
        },
      ),
    );
    const revisions = await engine.workflows.listRevisions('versioned-restart');
    const revision = revisions[0]?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-1', 'build-2']) {
      const buildManifest = manifest('versioned-restart', revision, buildId);
      await catalog.registerVersion({
        deploymentName: buildManifest.deployment.name,
        buildId,
        artifactDigest: buildManifest.deployment.artifactDigest,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest,
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });
    const first = await engine.start('versioned-restart', null, { id: 'versioned-restart-1' });
    await first.result();
    const terminal = decode((await storage.get(KEYS.workflow(first.id)))!) as WorkflowState;
    expect(terminal.workerBinding?.current.buildId).toBe('build-1');

    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
      expectedGeneration: 1,
    });
    const targetBinding = await resolveWorkflowWorkerStartBinding(storage, {
      workflowId: first.id,
      workflowType: 'versioned-restart',
      workflowRevision: revision,
      policy: { mode: 'pinned' },
      checkpointId: first.id,
      boundAt: Date.now(),
    });
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: first.id,
      previousBinding: terminal.workerBinding!.current,
      targetBinding,
      serverSecret: 'secret',
    });

    const second = await engine.start('versioned-restart', null, {
      id: first.id,
      onTerminalConflict: 'start-new',
      workerStartOverridePreview: preview,
    });
    await second.result();
    const restarted = decode((await storage.get(KEYS.workflow(first.id)))!) as WorkflowState;
    expect(restarted.workerBinding?.current.buildId).toBe('build-2');
    await expect(
      engine.start('versioned-restart', null, {
        id: first.id,
        onTerminalConflict: 'start-new',
        workerStartOverridePreview: preview,
      }),
    ).rejects.toThrow('workerStartOverridePreview');
  });
});

function manifest(workflowName: string, revision: string, buildId: string): WorkerManifest {
  return {
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
      [workflowName]: {
        workflowVersion: '0.0.0',
        workflowRevision: revision,
        contractHash: 'sha256:workflow',
        activities: { charge: { contractHash: 'sha256:charge', implementationRevision: buildId } },
      },
    },
    capabilities: {},
  };
}

function workerBinding(workflowId: string, revision: string): WorkflowWorkerBinding {
  return {
    workflowId,
    workflowType: 'versioned-fork-mismatch',
    deploymentName: 'test-deployment',
    buildId: 'build-1',
    artifactDigest: 'sha256:build-1',
    manifestDigest: 'sha256:manifest-build-1',
    routingGeneration: 1,
    workflowRevision: revision,
    workflowContractHash: 'sha256:workflow',
    activityContracts: { charge: 'sha256:charge' },
    activityName: 'charge',
    activityContractHash: 'sha256:charge',
    boundAt: 1,
    checkpointId: workflowId,
  };
}
