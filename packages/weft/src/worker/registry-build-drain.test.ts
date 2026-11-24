/**
 * Build-scoped drain markers in the worker registry (COR-277): one version of
 * a deployment can be drained and resumed while its siblings stay routable.
 */
import { describe, expect, it } from 'bun:test';

import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from './registry-fixtures.test-support.ts';
import { WorkerRegistry } from './registry.ts';

function registerWorker(
  registry: WorkerRegistry,
  id: string,
  buildId: string,
  deploymentName = 'payments',
): void {
  registry.register({
    manifest: testWorkerManifest(),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id,
    queue: 'default',
    activities: ['charge'],
    concurrency: 2,
    deploymentName,
    buildId,
  });
}

function healthById(registry: WorkerRegistry): Record<string, string> {
  return Object.fromEntries(
    registry.getWorkerSummaries(1).map((worker) => [worker.id, worker.health]),
  );
}

describe('WorkerRegistry — build drain', () => {
  it('drains only the named build, current and future, and leaves the other builds routable', () => {
    const registry = new WorkerRegistry();
    registerWorker(registry, 'old-1', 'build-1');
    registerWorker(registry, 'new-1', 'build-2');

    const result = registry.markBuildDraining('payments', 'build-1', {
      updatedAt: 1_000,
      reason: 'bad build',
    });
    expect(result).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      buildId: 'build-1',
      affectedWorkers: 1,
      inFlight: 0,
      health: 'drained',
    });
    expect(healthById(registry)).toEqual({ 'old-1': 'drained', 'new-1': 'active' });
    expect(registry.findWorker('charge', { queue: 'default' })?.id).toBe('new-1');

    // A worker of the drained build that connects later is drained too.
    registerWorker(registry, 'old-2', 'build-1');
    expect(healthById(registry)['old-2']).toBe('drained');
    expect(registry.findWorker('charge', { queue: 'default' })?.id).toBe('new-1');
  });

  it('keeps in-flight work visible: a draining build with a task reports draining, not drained', () => {
    const registry = new WorkerRegistry();
    registerWorker(registry, 'old-1', 'build-1');
    registry.assignTask('old-1', 'op-1', 30_000, undefined, 'attempt-1');

    expect(registry.markBuildDraining('payments', 'build-1').health).toBe('draining');
    expect(healthById(registry)['old-1']).toBe('draining');
  });

  it('resumes the build, restoring routing, without touching a wider marker', () => {
    const registry = new WorkerRegistry();
    registerWorker(registry, 'old-1', 'build-1');
    registerWorker(registry, 'new-1', 'build-2');
    registry.markBuildDraining('payments', 'build-1');

    expect(registry.clearBuildDrain('payments', 'build-1')).toMatchObject({
      buildId: 'build-1',
      health: 'active',
    });
    expect(healthById(registry)).toEqual({ 'old-1': 'active', 'new-1': 'active' });

    // A deployment-wide drain outlives a build resume.
    registry.markDeploymentDraining('payments');
    registry.markBuildDraining('payments', 'build-1');
    expect(registry.clearBuildDrain('payments', 'build-1').health).toBe('drained');
    expect(healthById(registry)).toEqual({ 'old-1': 'drained', 'new-1': 'drained' });
  });

  it('leaves the deployment-wide drain unchanged when no build is named', () => {
    const registry = new WorkerRegistry();
    registerWorker(registry, 'old-1', 'build-1');
    registerWorker(registry, 'new-1', 'build-2');

    const result = registry.markDeploymentDraining('payments', { updatedAt: 1_000 });
    expect(result).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      affectedWorkers: 2,
      inFlight: 0,
      health: 'drained',
    });
    expect(result).not.toHaveProperty('buildId');
  });

  it('does not let one deployment’s build marker reach a same-named build in another deployment', () => {
    const registry = new WorkerRegistry();
    registerWorker(registry, 'pay-1', 'build-1', 'payments');
    registerWorker(registry, 'ship-1', 'build-1', 'shipping');

    registry.markBuildDraining('payments', 'build-1');
    expect(healthById(registry)).toEqual({ 'pay-1': 'drained', 'ship-1': 'active' });
  });

  it('shows a drained build as its own deployment group, and a pre-drained empty build as drained', () => {
    const registry = new WorkerRegistry();
    registerWorker(registry, 'old-1', 'build-1');
    registerWorker(registry, 'new-1', 'build-2');
    registry.markBuildDraining('payments', 'build-1');

    const byBuild = Object.fromEntries(
      registry.getDeploymentSummaries(1).map((group) => [group.buildId, group.health]),
    );
    expect(byBuild).toEqual({ 'build-1': 'drained', 'build-2': 'active' });

    expect(registry.markBuildDraining('payments', 'build-9')).toMatchObject({
      affectedWorkers: 0,
      health: 'drained',
    });
    expect(registry.clearBuildDrain('payments', 'build-9')).toMatchObject({
      affectedWorkers: 0,
      health: 'active',
    });
  });

  it('keeps two builds apart when their names would run together under a separator', () => {
    const registry = new WorkerRegistry();
    // ('a\0b', 'c') and ('a', 'b\0c') read the same once joined with a NUL; they are different builds.
    registerWorker(registry, 'first', 'c', 'a\u0000b');
    registerWorker(registry, 'second', 'b\u0000c', 'a');

    registry.markBuildDraining('a\u0000b', 'c');

    expect(healthById(registry)).toEqual({ first: 'drained', second: 'active' });
    registry.clearBuildDrain('never', 'drained');
    registry.markBuildDraining('a', 'b\u0000c');
    registry.clearBuildDrain('a\u0000b', 'c');
    expect(healthById(registry)).toEqual({ first: 'active', second: 'drained' });
  });
});
