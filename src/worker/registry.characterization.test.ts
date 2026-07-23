/**
 * Characterization tests for WorkerRegistry golden behaviors.
 *
 * These tests pin the exact observable outputs of `findWorker`,
 * `pickFairShare` (exercised via `findWorker`), and `getWorkerSummaries`
 * over curated fixture states. They must pass on the unchanged source and
 * continue to pass after the refactor — acting as a safety net that the
 * extracted modules preserve identical semantics.
 */
import { describe, expect, it } from 'bun:test';

import { WorkerRegistry } from './registry.ts';
import { compareScores, FairShareCounters, scoreWorker } from './registry/fair-share.ts';
import { projectWorkerSummaries } from './registry/summary.ts';

// ---------------------------------------------------------------------------
// findWorker — golden ordering over the full candidate matrix
// ---------------------------------------------------------------------------

describe('findWorker characterization', () => {
  it('drained workers are never eligible', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'drained', queue: 'q', activities: ['a'], concurrency: 5 });
    registry.register({ id: 'active', queue: 'q', activities: ['a'], concurrency: 5 });
    registry.markWorkerDraining('drained', { updatedAt: 1000 });

    expect(registry.findWorker('a', { queue: 'q' })?.id).toBe('active');
  });

  it('capacity-zero workers are excluded before policy selection', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'full', queue: 'q', activities: ['a'], concurrency: 1 });
    registry.register({ id: 'spare', queue: 'q', activities: ['a'], concurrency: 1 });
    registry.taskAssigned('full'); // full is now at concurrency limit

    expect(registry.findWorker('a', { queue: 'q' })?.id).toBe('spare');
  });

  it('share-scope (queue) filter excludes workers on other queues', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'wrong-queue', queue: 'other', activities: ['a'], concurrency: 5 });
    registry.register({ id: 'right-queue', queue: 'target', activities: ['a'], concurrency: 5 });

    expect(registry.findWorker('a', { queue: 'target' })?.id).toBe('right-queue');
    expect(registry.findWorker('a', { queue: 'other' })?.id).toBe('wrong-queue');
  });

  it('activity-set superset: only workers advertising the activity are eligible', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'partial', queue: 'q', activities: ['b', 'c'], concurrency: 5 });
    registry.register({ id: 'has-it', queue: 'q', activities: ['a', 'b'], concurrency: 5 });

    expect(registry.findWorker('a')?.id).toBe('has-it');
    expect(registry.findWorker('c')?.id).toBe('partial');
    expect(registry.findWorker('z')).toBeUndefined();
  });

  it('queue-set membership: worker with matching queue wins over queue-less search', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'billing', queue: 'billing', activities: ['charge'], concurrency: 5 });
    registry.register({
      id: 'shipping',
      queue: 'shipping',
      activities: ['charge'],
      concurrency: 5,
    });

    // When queue is specified only the matching worker is eligible
    expect(registry.findWorker('charge', { queue: 'billing' })?.id).toBe('billing');
    expect(registry.findWorker('charge', { queue: 'shipping' })?.id).toBe('shipping');

    // When queue is omitted both are eligible; least-loaded tiebreak by id picks 'billing'
    expect(registry.findWorker('charge')?.id).toBe('billing');
  });

  it('sticky wins regardless of load when within capacity', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'w-a', queue: 'q', activities: ['x'], concurrency: 10 });
    registry.register({ id: 'w-b', queue: 'q', activities: ['x'], concurrency: 10 });
    // Load w-b heavily — sticky should still pick it
    for (let index = 0; index < 7; index += 1) registry.taskAssigned('w-b');

    expect(registry.findWorker('x', { sticky: 'w-b' })?.id).toBe('w-b');
  });

  it('sticky falls back to policy when sticky worker is at capacity', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'w-a', queue: 'q', activities: ['x'], concurrency: 1 });
    registry.register({ id: 'w-b', queue: 'q', activities: ['x'], concurrency: 1 });
    registry.taskAssigned('w-a'); // fill sticky target

    expect(registry.findWorker('x', { sticky: 'w-a' })?.id).toBe('w-b');
  });

  it('sticky falls back to policy when sticky worker is draining', () => {
    const registry = new WorkerRegistry();
    registry.register({ id: 'sticky-drain', queue: 'q', activities: ['x'], concurrency: 5 });
    registry.register({ id: 'available', queue: 'q', activities: ['x'], concurrency: 5 });
    registry.markWorkerDraining('sticky-drain', { updatedAt: 1000 });

    expect(registry.findWorker('x', { sticky: 'sticky-drain' })?.id).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// pickFairShare — golden ordering via findWorker with policy: 'fair-share'
// ---------------------------------------------------------------------------

describe('pickFairShare characterization', () => {
  it('equal-score tie-breaker: lowest inFlight wins, then lexicographic id', () => {
    const registry = new WorkerRegistry({ policy: 'fair-share' });
    // All three have keyLoad=0 for 'share-x'; inFlight differs
    registry.register({ id: 'w-c', queue: 'q', activities: ['a'], concurrency: 10 });
    registry.register({ id: 'w-a', queue: 'q', activities: ['a'], concurrency: 10 });
    registry.register({ id: 'w-b', queue: 'q', activities: ['a'], concurrency: 10 });
    registry.taskAssigned('w-c'); // 1 in-flight
    // w-a and w-b both at 0 — w-a wins by id

    expect(registry.findWorker('a', { fairShareKey: 'share-x' })?.id).toBe('w-a');
  });

  it('drained workers are not scored', () => {
    const registry = new WorkerRegistry({ policy: 'fair-share' });
    registry.register({ id: 'drained', queue: 'q', activities: ['a'], concurrency: 5 });
    registry.register({ id: 'active', queue: 'q', activities: ['a'], concurrency: 5 });
    registry.markWorkerDraining('drained', { updatedAt: 1000 });

    expect(registry.findWorker('a', { fairShareKey: 'share-x' })?.id).toBe('active');
  });

  it('capacity boundary: full workers are excluded from scoring', () => {
    const registry = new WorkerRegistry({ policy: 'fair-share' });
    registry.register({ id: 'full', queue: 'q', activities: ['a'], concurrency: 1 });
    registry.register({ id: 'spare', queue: 'q', activities: ['a'], concurrency: 5 });
    registry.taskAssigned('full');

    expect(registry.findWorker('a', { fairShareKey: 'share-x' })?.id).toBe('spare');
  });

  it('score function over curated workload snapshot: key-load dominates', () => {
    const registry = new WorkerRegistry({ policy: 'fair-share' });
    registry.register({ id: 'heavy-key', queue: 'q', activities: ['a'], concurrency: 10 });
    registry.register({ id: 'light-key', queue: 'q', activities: ['a'], concurrency: 10 });

    // heavy-key has 2 tasks for share-alpha but only 2 overall
    registry.assignTask('heavy-key', 'op-1', 30_000, 'share-alpha', 'attempt-token');
    registry.assignTask('heavy-key', 'op-2', 30_000, 'share-alpha', 'attempt-token');
    // light-key has 0 tasks for share-alpha but 5 overall (different key)
    for (let index = 0; index < 5; index += 1) {
      registry.assignTask('light-key', `other-${index}`, 30_000, 'share-beta', 'attempt-token');
    }

    // keyLoad (share-alpha) for light-key is 0 vs 2 for heavy-key
    // Even though light-key has higher overall inFlight, keyLoad wins
    expect(registry.findWorker('a', { fairShareKey: 'share-alpha' })?.id).toBe('light-key');
  });

  it('fair-share degrades to least-loaded when fairShareKey is omitted', () => {
    const registry = new WorkerRegistry({ policy: 'fair-share' });
    registry.register({ id: 'loaded', queue: 'q', activities: ['a'], concurrency: 10 });
    registry.register({ id: 'idle', queue: 'q', activities: ['a'], concurrency: 10 });
    registry.taskAssigned('loaded');
    registry.taskAssigned('loaded');

    expect(registry.findWorker('a')?.id).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// scoreWorker + compareScores — pure unit tests for the extracted module
// ---------------------------------------------------------------------------

describe('scoreWorker and compareScores', () => {
  it('scoreWorker captures all fields from the snapshot', () => {
    const snapshot = { id: 'w1', inFlight: 3, keyLoad: 1 };
    const score = scoreWorker(snapshot);
    expect(score).toEqual({ snapshot, keyLoad: 1, inFlight: 3, id: 'w1' });
  });

  it('compareScores: lower keyLoad wins', () => {
    const a = scoreWorker({ id: 'w1', inFlight: 0, keyLoad: 0 });
    const b = scoreWorker({ id: 'w2', inFlight: 0, keyLoad: 2 });
    expect(compareScores(a, b)).toBeLessThan(0);
    expect(compareScores(b, a)).toBeGreaterThan(0);
  });

  it('compareScores: equal keyLoad — lower inFlight wins', () => {
    const a = scoreWorker({ id: 'w1', inFlight: 1, keyLoad: 0 });
    const b = scoreWorker({ id: 'w2', inFlight: 3, keyLoad: 0 });
    expect(compareScores(a, b)).toBeLessThan(0);
  });

  it('compareScores: equal keyLoad and inFlight — lexicographic id wins', () => {
    const a = scoreWorker({ id: 'alpha', inFlight: 2, keyLoad: 1 });
    const b = scoreWorker({ id: 'zebra', inFlight: 2, keyLoad: 1 });
    expect(compareScores(a, b)).toBeLessThan(0);
    expect(compareScores(b, a)).toBeGreaterThan(0);
  });

  it('compareScores: identical scores return 0', () => {
    const a = scoreWorker({ id: 'same', inFlight: 2, keyLoad: 1 });
    const b = scoreWorker({ id: 'same', inFlight: 2, keyLoad: 1 });
    expect(compareScores(a, b)).toBe(0);
  });
});

describe('FairShareCounters', () => {
  it('increments, releases, and purges worker fair-share counters', () => {
    const counters = new FairShareCounters();

    expect(counters.load('worker-a', 'tenant-a')).toBe(0);

    counters.increment('worker-a', 'tenant-a');
    counters.increment('worker-a', 'tenant-a');
    counters.increment('worker-a', 'tenant-b');
    expect(counters.load('worker-a', 'tenant-a')).toBe(2);
    expect(counters.load('worker-a', 'tenant-b')).toBe(1);

    counters.release('worker-a', 'tenant-a');
    expect(counters.load('worker-a', 'tenant-a')).toBe(1);

    counters.release('worker-a', 'tenant-a');
    counters.release('worker-a', 'tenant-b');
    expect(counters.load('worker-a', 'tenant-a')).toBe(0);
    expect(counters.load('worker-a', 'tenant-b')).toBe(0);

    counters.increment('worker-b', 'tenant-c');
    counters.purge('worker-b');
    expect(counters.load('worker-b', 'tenant-c')).toBe(0);

    counters.release('missing-worker', 'missing-key');
    expect(counters.load('missing-worker', 'missing-key')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// projectWorkerSummaries — registry-summary projection golden output
// ---------------------------------------------------------------------------

describe('projectWorkerSummaries characterization', () => {
  it('projects byte-identical output over a curated registry state', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'charlie',
      queue: 'default',
      activities: ['a'],
      concurrency: 3,
      deploymentName: 'deploy-c',
      buildId: 'build-c',
      runtimeVersion: '1.0.0',
      gitSha: 'ccc',
    });
    registry.register({
      id: 'alpha',
      queue: 'mail',
      activities: ['send'],
      concurrency: 2,
    });
    registry.register({
      id: 'bravo',
      queue: 'default',
      activities: ['a', 'b'],
      concurrency: 4,
    });

    // Pin heartbeats for deterministic age math
    registry.getWorker('alpha')!.lastHeartbeat = 1000;
    registry.getWorker('bravo')!.lastHeartbeat = 2000;
    registry.getWorker('charlie')!.lastHeartbeat = 3000;

    registry.assignTask('bravo', 'op-1', 30_000, undefined, 'attempt-token');
    registry.assignTask('bravo', 'op-2', 30_000, undefined, 'attempt-token');

    const now = 5000;

    // Ground truth from registry.getWorkerSummaries
    const expected = registry.getWorkerSummaries(now);

    // Build snapshots the same way summary.ts expects them
    const snapshots = registry.getAll().map((worker) => ({
      id: worker.id,
      queue: worker.queue,
      activities: worker.activities,
      concurrency: worker.concurrency,
      inFlight: worker.inFlight,
      connectedAt: worker.connectedAt,
      lastHeartbeat: worker.lastHeartbeat,
      startedAt: worker.startedAt,
      capabilities: worker.capabilities,
      health: registry.getWorkerSummaries(now).find((s) => s.id === worker.id)!.health,
      deploymentName: worker.deploymentName,
      buildId: worker.buildId,
      runtimeVersion: worker.runtimeVersion,
      gitSha: worker.gitSha,
    }));

    const projected = projectWorkerSummaries(snapshots, now);

    expect(projected).toEqual(expected);
  });

  it('sorts output ascending by id regardless of registration order', () => {
    const snapshots = [
      {
        id: 'zebra',
        queue: 'q',
        activities: ['x'] as const,
        concurrency: 1,
        inFlight: 0,
        connectedAt: 0,
        lastHeartbeat: 0,
        startedAt: 0,
        capabilities: {},
        health: 'active' as const,
      },
      {
        id: 'apple',
        queue: 'q',
        activities: ['x'] as const,
        concurrency: 1,
        inFlight: 0,
        connectedAt: 0,
        lastHeartbeat: 0,
        startedAt: 0,
        capabilities: {},
        health: 'active' as const,
      },
    ];

    const result = projectWorkerSummaries(snapshots, 0);
    expect(result.map((s) => s.id)).toEqual(['apple', 'zebra']);
  });

  it('clamps availableCapacity to zero when inFlight exceeds concurrency', () => {
    const snapshot = {
      id: 'w1',
      queue: 'q',
      activities: ['a'] as const,
      concurrency: 1,
      inFlight: 5,
      connectedAt: 0,
      lastHeartbeat: 0,
      startedAt: 0,
      capabilities: {},
      health: 'active' as const,
    };

    const result = projectWorkerSummaries([snapshot], 0);
    expect(result[0]!.availableCapacity).toBe(0);
  });

  it('returns a defensive copy of activities', () => {
    const activities = ['process', 'send'] as const;
    const snapshot = {
      id: 'w1',
      queue: 'q',
      activities,
      concurrency: 1,
      inFlight: 0,
      connectedAt: 0,
      lastHeartbeat: 0,
      startedAt: 0,
      capabilities: {},
      health: 'active' as const,
    };

    const result = projectWorkerSummaries([snapshot], 0);
    result[0]!.activities.push('mutated');
    // Original snapshot array is unchanged
    expect(snapshot.activities).toHaveLength(2);
  });

  it('computes heartbeatAgeMs correctly from now and lastHeartbeat', () => {
    const snapshot = {
      id: 'w1',
      queue: 'q',
      activities: [] as const,
      concurrency: 1,
      inFlight: 0,
      connectedAt: 0,
      lastHeartbeat: 3000,
      startedAt: 0,
      capabilities: {},
      health: 'active' as const,
    };

    const result = projectWorkerSummaries([snapshot], 5000);
    expect(result[0]!.heartbeatAgeMs).toBe(2000);
    expect(result[0]!.lastHeartbeatAt).toBe(3000);
  });
});
