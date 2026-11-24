/**
 * COR-2018 (B10, Workers rows 78k, 78t, 79i): a worker that went away stays listed as
 * disconnected, with when it was last heard from, until an operator forgets it or it registers
 * again; a connected worker that finished draining can be forgotten too; and a worker still taking
 * work cannot. The list also names each worker by the `name` it advertised and carries the
 * workflow types its manifest declares, which a worker that went away keeps.
 */
import { describe, expect, it } from 'bun:test';

import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  manifestForActivities,
  testWorkerManifest,
} from './registry-fixtures.test-support.ts';
import { WorkerRegistry } from './registry.ts';
import { MAX_DEPARTED_WORKERS } from './registry/departed.ts';

function register(
  registry: WorkerRegistry,
  id: string,
  options: { name?: string; queue?: string } = {},
): void {
  registry.register({
    manifest: manifestForActivities(['release-notes.render']),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id,
    queue: options.queue ?? 'reports',
    activities: ['release-notes.render'],
    concurrency: 4,
    ...(options.name === undefined ? {} : { capabilities: { name: options.name } }),
  });
}

function listed(registry: WorkerRegistry, id: string) {
  return registry.getWorkerListing(Date.now()).find((worker) => worker.id === id);
}

describe('a worker that went away', () => {
  it('stays listed with when it was last heard from and the name and workflows it had', () => {
    const registry = new WorkerRegistry();
    register(registry, 'reports-worker', { name: 'Reports worker' });
    registry.unregister('reports-worker');

    const summary = listed(registry, 'reports-worker');
    expect(summary).toMatchObject({
      id: 'reports-worker',
      name: 'Reports worker',
      queue: 'reports',
      inFlight: 0,
      workflows: ['release-notes'],
    });
    expect(typeof summary?.disconnectedAt).toBe('number');
    expect(summary?.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    // The live fleet that routing and the queue totals count no longer holds it.
    expect(registry.getWorkerSummaries(Date.now())).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('is listed as connected again when it registers again', () => {
    const registry = new WorkerRegistry();
    register(registry, 'reports-worker');
    registry.unregister('reports-worker');
    register(registry, 'reports-worker');

    expect(listed(registry, 'reports-worker')).not.toHaveProperty('disconnectedAt');
    expect(registry.getWorkerListing(Date.now())).toHaveLength(1);
  });

  it('is dropped by forgetting it, and forgetting it again finds nothing', () => {
    const registry = new WorkerRegistry();
    register(registry, 'reports-worker');
    registry.unregister('reports-worker');

    expect(registry.forgetWorker('reports-worker')).toBe('forgotten');
    expect(listed(registry, 'reports-worker')).toBeUndefined();
    expect(registry.forgetWorker('reports-worker')).toBeUndefined();
  });

  it('keeps only the most recent departures once more than the limit have gone', () => {
    const registry = new WorkerRegistry();
    for (let index = 0; index < MAX_DEPARTED_WORKERS + 1; index += 1) {
      register(registry, `worker-${String(index).padStart(3, '0')}`);
      registry.unregister(`worker-${String(index).padStart(3, '0')}`);
    }
    const ids = registry.getWorkerListing(Date.now()).map((worker) => worker.id);
    expect(ids).toHaveLength(MAX_DEPARTED_WORKERS);
    expect(ids).not.toContain('worker-000');
    expect(ids).toContain(`worker-${String(MAX_DEPARTED_WORKERS).padStart(3, '0')}`);
  });
});

describe('forgetting a connected worker', () => {
  it('refuses one that still takes work', () => {
    const registry = new WorkerRegistry();
    register(registry, 'payments-worker-1');

    expect(registry.forgetWorker('payments-worker-1')).toBe('connected');
    expect(listed(registry, 'payments-worker-1')).toBeDefined();
  });

  it('refuses one that is draining with a task in flight', () => {
    const registry = new WorkerRegistry();
    register(registry, 'search-worker');
    registry.taskAssigned('search-worker');
    registry.markWorkerDraining('search-worker');

    expect(registry.forgetWorker('search-worker')).toBe('connected');
  });

  it('hides one that finished draining until it registers again', () => {
    const registry = new WorkerRegistry();
    register(registry, 'search-worker');
    registry.markWorkerDraining('search-worker');

    expect(registry.forgetWorker('search-worker')).toBe('forgotten');
    expect(listed(registry, 'search-worker')).toBeUndefined();
    // Still connected, so routing and the queue totals still count it.
    expect(registry.getWorkerSummaries(Date.now())).toHaveLength(1);

    register(registry, 'search-worker');
    expect(listed(registry, 'search-worker')).toBeDefined();
  });

  it('lists a forgotten worker again once it is resumed', () => {
    const registry = new WorkerRegistry();
    register(registry, 'search-worker');
    registry.markWorkerDraining('search-worker');
    registry.forgetWorker('search-worker');
    registry.clearWorkerDrain('search-worker');

    expect(listed(registry, 'search-worker')).toMatchObject({ health: 'active' });
  });

  it('finds nothing for an id no listed worker has', () => {
    expect(new WorkerRegistry().forgetWorker('nobody')).toBeUndefined();
  });
});

describe('a worker’s name', () => {
  it('is the string capability it advertised, trimmed, and absent when it advertised none', () => {
    const registry = new WorkerRegistry();
    register(registry, 'named', { name: '  Payments worker EU  ' });
    register(registry, 'unnamed');
    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'odd',
      queue: 'reports',
      activities: [],
      concurrency: 1,
      capabilities: { name: 7 },
    });

    expect(listed(registry, 'named')?.name).toBe('Payments worker EU');
    expect(listed(registry, 'unnamed')).not.toHaveProperty('name');
    expect(listed(registry, 'odd')).not.toHaveProperty('name');
    expect(listed(registry, 'odd')).not.toHaveProperty('workflows');
  });
});
