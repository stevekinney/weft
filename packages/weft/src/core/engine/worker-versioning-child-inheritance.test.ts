import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { decode } from '../codec.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('workflow worker versioning child inheritance', () => {
  it('inherits a same-revision parent worker binding for ctx.startChild starts', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(
      workflow({
        name: 'versioned-child-inheritance',
        workerVersioningPolicy: { mode: 'pinned' },
      }).execute(async function* (ctx: WorkflowContext, input: { role: 'parent' | 'child' }) {
        if (input.role === 'child') return 'child-done';
        yield* ctx.waitForSignal('spawn');
        return yield* ctx.startChild(
          'versioned-child-inheritance',
          { role: 'child' },
          { id: 'versioned-child-inheritance-child' },
        );
      }),
    );
    const revisions = await engine.workflows.listRevisions('versioned-child-inheritance');
    const revision = revisions[0]?.manifest.revision ?? '';
    const catalog = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-1', 'build-2']) {
      const buildManifest = manifest('versioned-child-inheritance', revision, buildId);
      await catalog.registerVersion({
        deploymentName: buildManifest.deployment.name,
        buildId,
        artifactDigest: buildManifest.deployment.artifactDigest,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest,
        state: 'ready',
        firstSeenAt: buildId === 'build-1' ? 1 : 2,
      });
    }
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-1',
      rampBasisPoints: 10_000,
      updatedAt: 1,
    });

    const parent = await engine.start(
      'versioned-child-inheritance',
      { role: 'parent' },
      { id: 'versioned-child-inheritance-parent' },
    );
    await catalog.setRouting({
      deploymentName: 'test-deployment',
      currentBuildId: 'build-2',
      rampBasisPoints: 10_000,
      updatedAt: 2,
    });

    await parent.signal('spawn');
    expect(await parent.result()).toBe('child-done');

    const childState = decode(
      (await storage.get(KEYS.workflow('versioned-child-inheritance-child')))!,
    ) as WorkflowState;
    expect(childState.workerBinding?.current).toMatchObject({
      workflowId: childState.id,
      workflowType: 'versioned-child-inheritance',
      buildId: 'build-1',
      workflowRevision: revision,
    });
  });
});

function manifest(workflowType: string, workflowRevision: string, buildId: string): WorkerManifest {
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
      [workflowType]: {
        workflowVersion: '0.0.0',
        workflowRevision,
        contractHash: 'sha256:workflow',
        activities: {},
      },
    },
    capabilities: {},
  };
}
