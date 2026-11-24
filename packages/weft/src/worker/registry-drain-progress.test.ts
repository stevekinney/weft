/**
 * COR-2009 — a worker's drain, as the Workers list reads it: while it drains it counts the tasks it
 * finishes, and once nothing is left in flight it is `drained` with the time that happened, so the
 * list can read "Stopped · Drained · finished its 2 tasks". It stays listed until it disconnects,
 * and nothing counted under one drain carries into the next.
 */
import { describe, expect, it } from 'bun:test';

import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from './registry-fixtures.test-support.ts';
import { WorkerRegistry } from './registry.ts';

function registryWith(id: string, deploymentName?: string): WorkerRegistry {
  const registry = new WorkerRegistry();
  registry.register({
    manifest: testWorkerManifest(),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id,
    queue: 'search',
    activities: ['index'],
    concurrency: 4,
    ...(deploymentName === undefined ? {} : { deploymentName, buildId: 'build-1' }),
  });
  return registry;
}

function summaryOf(registry: WorkerRegistry, id: string) {
  const summary = registry.getWorkerSummaries(Date.now()).find((worker) => worker.id === id);
  if (summary === undefined) throw new Error(`No worker ${id} is listed.`);
  return summary;
}

describe('a worker’s drain', () => {
  it('counts the tasks it finishes and records when the last one finished', () => {
    const registry = registryWith('search-worker');
    registry.taskAssigned('search-worker');
    registry.taskAssigned('search-worker');
    expect(summaryOf(registry, 'search-worker')).not.toHaveProperty('drainFinishedTasks');

    registry.markWorkerDraining('search-worker', { updatedAt: 1_000 });
    expect(summaryOf(registry, 'search-worker')).toMatchObject({
      health: 'draining',
      inFlight: 2,
      drainFinishedTasks: 0,
    });
    expect(summaryOf(registry, 'search-worker')).not.toHaveProperty('drainedAt');

    registry.taskCompleted('search-worker');
    expect(summaryOf(registry, 'search-worker')).toMatchObject({
      health: 'draining',
      drainFinishedTasks: 1,
    });

    const before = Date.now();
    registry.taskCompleted('search-worker');
    const summary = summaryOf(registry, 'search-worker');

    expect(summary).toMatchObject({ health: 'drained', inFlight: 0, drainFinishedTasks: 2 });
    expect(summary.drainedAt).toBeGreaterThanOrEqual(before);
    expect(summary.drainedAt).toBeLessThanOrEqual(Date.now());
  });

  it('reads as drained at once, with no tasks, when nothing was in flight', () => {
    const registry = registryWith('idle-worker');

    registry.markWorkerDraining('idle-worker', { updatedAt: 5_000 });

    expect(summaryOf(registry, 'idle-worker')).toMatchObject({
      health: 'drained',
      drainFinishedTasks: 0,
      drainedAt: 5_000,
    });
  });

  it('leaves the list when the drained worker disconnects', () => {
    const registry = registryWith('search-worker');
    registry.markWorkerDraining('search-worker', { updatedAt: 1_000 });

    registry.unregister('search-worker');

    expect(registry.getWorkerSummaries(Date.now())).toEqual([]);
  });

  it('starts a later drain afresh, and keeps nothing once the drain is cleared', () => {
    const registry = registryWith('search-worker');
    registry.taskAssigned('search-worker');
    registry.taskAssigned('search-worker');
    registry.markWorkerDraining('search-worker', { updatedAt: 1_000 });
    registry.taskCompleted('search-worker');

    registry.clearWorkerDrain('search-worker');
    expect(summaryOf(registry, 'search-worker')).not.toHaveProperty('drainFinishedTasks');

    registry.markWorkerDraining('search-worker', { updatedAt: 2_000 });
    expect(summaryOf(registry, 'search-worker')).toMatchObject({
      health: 'draining',
      drainFinishedTasks: 0,
    });
    registry.taskCompleted('search-worker');
    expect(summaryOf(registry, 'search-worker')).toMatchObject({
      health: 'drained',
      drainFinishedTasks: 1,
    });
  });

  it('counts under a deployment’s drain as under the worker’s own', () => {
    const registry = registryWith('search-worker', 'search');
    registry.taskAssigned('search-worker');
    registry.markDeploymentDraining('search');

    registry.taskCompleted('search-worker');

    expect(summaryOf(registry, 'search-worker')).toMatchObject({
      health: 'drained',
      drainFinishedTasks: 1,
      drainedAt: expect.any(Number),
    });
  });
});
