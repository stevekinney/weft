import { describe, expect, it } from 'bun:test';

import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from './registry-fixtures.test-support.ts';
import { WorkerRegistry } from './registry.ts';

/**
 * Register `count` workers on the default queue, all capable of handling
 * `activity`, each with spare capacity. Returns the registry and the worker
 * ids in the order they were registered.
 */
function makeRegistryWithWorkers(
  count: number,
  activity: string,
  options?: ConstructorParameters<typeof WorkerRegistry>[0],
) {
  const registry = new WorkerRegistry(options);
  const workerIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `worker-${index}`;
    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id,
      queue: 'default',
      activities: [activity],
      concurrency: 10,
    });
    workerIds.push(id);
  }
  return { registry, workerIds };
}

describe('WorkerRegistry routing policies', () => {
  describe('least-loaded (default)', () => {
    it('picks the worker with the lowest inFlight count', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(3, 'sendEmail');

      // Fill worker-0 to 2, worker-1 to 1, worker-2 stays at 0
      registry.taskAssigned(workerIds[0]!);
      registry.taskAssigned(workerIds[0]!);
      registry.taskAssigned(workerIds[1]!);

      const pick = registry.findWorker('sendEmail');
      expect(pick?.id).toBe(workerIds[2]);
    });

    it('tiebreaks on stable worker id order', () => {
      const { registry } = makeRegistryWithWorkers(3, 'sendEmail');
      const pick = registry.findWorker('sendEmail');
      expect(pick?.id).toBe('worker-0');
    });
  });

  describe('round-robin', () => {
    it('rotates through eligible workers in registration order', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(3, 'sendEmail', {
        policy: 'round-robin',
      });

      const picks: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const worker = registry.findWorker('sendEmail');
        expect(worker).toBeDefined();
        picks.push(worker!.id);
      }

      expect(picks).toEqual([
        workerIds[0]!,
        workerIds[1]!,
        workerIds[2]!,
        workerIds[0]!,
        workerIds[1]!,
        workerIds[2]!,
      ]);
    });

    it('does not skip workers even when they have higher load', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(2, 'sendEmail', {
        policy: 'round-robin',
      });

      // Worker 0 is already more loaded
      registry.taskAssigned(workerIds[0]!);
      registry.taskAssigned(workerIds[0]!);

      // Round-robin should still pick worker-0 first (stable cursor starts at 0)
      const first = registry.findWorker('sendEmail');
      expect(first?.id).toBe(workerIds[0]);

      const second = registry.findWorker('sendEmail');
      expect(second?.id).toBe(workerIds[1]);
    });

    it('keeps independent cursors per queue', () => {
      const registry = new WorkerRegistry({ policy: 'round-robin' });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'a-0',
        queue: 'a',
        activities: ['t'],
        concurrency: 10,
      });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'a-1',
        queue: 'a',
        activities: ['t'],
        concurrency: 10,
      });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'b-0',
        queue: 'b',
        activities: ['t'],
        concurrency: 10,
      });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'b-1',
        queue: 'b',
        activities: ['t'],
        concurrency: 10,
      });

      expect(registry.findWorker('t', { queue: 'a' })?.id).toBe('a-0');
      expect(registry.findWorker('t', { queue: 'b' })?.id).toBe('b-0');
      expect(registry.findWorker('t', { queue: 'a' })?.id).toBe('a-1');
      expect(registry.findWorker('t', { queue: 'b' })?.id).toBe('b-1');
      expect(registry.findWorker('t', { queue: 'a' })?.id).toBe('a-0');
    });

    it('keeps independent cursors per (queue, activity) pair', () => {
      // Two activities sharing one queue: A is handled by 3 workers, B by 1.
      // Interleaving requests for A and B must not let B's request advance
      // A's cursor (or vice versa) — otherwise A-only requests would skip
      // workers because the previous request for B nudged the cursor past
      // an A-only worker.
      const registry = new WorkerRegistry({ policy: 'round-robin' });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'multi-0',
        queue: 'shared',
        activities: ['a', 'b'],
        concurrency: 5,
      });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'a-only-1',
        queue: 'shared',
        activities: ['a'],
        concurrency: 5,
      });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'a-only-2',
        queue: 'shared',
        activities: ['a'],
        concurrency: 5,
      });

      // Activity A rotates over all three eligible workers.
      expect(registry.findWorker('a', { queue: 'shared' })?.id).toBe('multi-0');

      // Interleave a B request — only one worker is eligible for B.
      expect(registry.findWorker('b', { queue: 'shared' })?.id).toBe('multi-0');

      // The A cursor must continue from where it left off, ignoring the B
      // request entirely.
      expect(registry.findWorker('a', { queue: 'shared' })?.id).toBe('a-only-1');
      expect(registry.findWorker('b', { queue: 'shared' })?.id).toBe('multi-0');
      expect(registry.findWorker('a', { queue: 'shared' })?.id).toBe('a-only-2');
      expect(registry.findWorker('a', { queue: 'shared' })?.id).toBe('multi-0');
    });

    it('respects sticky over round-robin', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(3, 'sendEmail', {
        policy: 'round-robin',
      });
      const pick = registry.findWorker('sendEmail', { sticky: workerIds[2]! });
      expect(pick?.id).toBe(workerIds[2]);
    });
  });

  describe('fair-share', () => {
    it('spreads a share across workers', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(3, 'runAgent', {
        policy: 'fair-share',
      });

      const picks: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const worker = registry.findWorker('runAgent', { fairShareKey: 'share-alpha' });
        expect(worker).toBeDefined();
        registry.assignTask(worker!.id, `op-${index}`, 30_000, 'share-alpha', 'attempt-token');
        picks.push(worker!.id);
      }

      // All three workers should have been chosen exactly once — the per-key
      // load was 0, 0, 0 at first and only climbed above 0 once the key was
      // already placed on a given worker.
      expect(new Set(picks).size).toBe(3);
      const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
      const expected: string[] = [workerIds[0]!, workerIds[1]!, workerIds[2]!];
      expect(picks.toSorted(compareStrings)).toEqual(expected.toSorted(compareStrings));
    });

    it('prefers the worker carrying fewer tasks for this key', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(2, 'runAgent', {
        policy: 'fair-share',
      });

      // Pre-load worker-0 with two share-alpha tasks
      registry.assignTask(workerIds[0]!, 'op-a', 30_000, 'share-alpha', 'attempt-token');
      registry.assignTask(workerIds[0]!, 'op-b', 30_000, 'share-alpha', 'attempt-token');

      const pick = registry.findWorker('runAgent', { fairShareKey: 'share-alpha' });
      expect(pick?.id).toBe(workerIds[1]);
    });

    it('does not confuse two shares sharing workers', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(2, 'runAgent', {
        policy: 'fair-share',
      });

      // Stack share-alpha on worker-0 and share-beta on worker-1
      registry.assignTask(workerIds[0]!, 'alpha-1', 30_000, 'share-alpha', 'attempt-token');
      registry.assignTask(workerIds[0]!, 'alpha-2', 30_000, 'share-alpha', 'attempt-token');
      registry.assignTask(workerIds[1]!, 'beta-1', 30_000, 'share-beta', 'attempt-token');

      // Share-gamma has no history — pick should use inFlight tiebreak, which
      // makes worker-1 (1 inflight) win over worker-0 (2 inflight).
      const pick = registry.findWorker('runAgent', { fairShareKey: 'share-gamma' });
      expect(pick?.id).toBe(workerIds[1]);
    });

    it('releases fair-share counts on completion', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(2, 'runAgent', {
        policy: 'fair-share',
      });

      registry.assignTask(workerIds[0]!, 'op-a', 30_000, 'share-alpha', 'attempt-token');
      registry.assignTask(workerIds[0]!, 'op-b', 30_000, 'share-alpha', 'attempt-token');
      registry.completeTask('op-a');
      registry.completeTask('op-b');

      // After release, both workers tie at 0; least-loaded tiebreak by id wins.
      const pick = registry.findWorker('runAgent', { fairShareKey: 'share-alpha' });
      expect(pick?.id).toBe(workerIds[0]);
    });

    it('falls back to least-loaded when fairShareKey is omitted', () => {
      const { registry, workerIds } = makeRegistryWithWorkers(2, 'runAgent', {
        policy: 'fair-share',
      });

      // Load worker-0 more heavily
      registry.taskAssigned(workerIds[0]!);
      registry.taskAssigned(workerIds[0]!);

      const pick = registry.findWorker('runAgent');
      expect(pick?.id).toBe(workerIds[1]);
    });
  });

  it('exposes the configured policy', () => {
    expect(new WorkerRegistry().policy).toBe('least-loaded');
    expect(new WorkerRegistry({ policy: 'round-robin' }).policy).toBe('round-robin');
    expect(new WorkerRegistry({ policy: 'fair-share' }).policy).toBe('fair-share');
  });

  describe('zero eligible workers', () => {
    const policies: Array<ConstructorParameters<typeof WorkerRegistry>[0]> = [
      { policy: 'least-loaded' },
      { policy: 'round-robin' },
      { policy: 'fair-share' },
    ];

    for (const options of policies) {
      const label = options?.policy ?? 'least-loaded';

      it(`${label} returns undefined when every worker is saturated`, () => {
        const { registry, workerIds } = makeRegistryWithWorkers(2, 'sendEmail', options);
        for (let index = 0; index < 10; index += 1) {
          registry.taskAssigned(workerIds[0]!);
          registry.taskAssigned(workerIds[1]!);
        }
        expect(registry.findWorker('sendEmail', { fairShareKey: 'share-x' })).toBeUndefined();
      });

      it(`${label} returns undefined when no worker advertises the activity`, () => {
        const { registry } = makeRegistryWithWorkers(2, 'sendEmail', options);
        expect(registry.findWorker('nonexistent', { fairShareKey: 'share-x' })).toBeUndefined();
      });

      it(`${label} returns undefined when the registry is empty`, () => {
        const registry = new WorkerRegistry(options);
        expect(registry.findWorker('sendEmail', { fairShareKey: 'share-x' })).toBeUndefined();
      });
    }
  });

  describe('qualified-name exact match (protocol v2)', () => {
    // Phase 4: workers advertise `${workflowType}.${activityName}` qualified
    // names. The server matches the dispatched activity name against the
    // advertised list with EXACT string equality — not substring, not prefix.
    // These tests pin that contract so a future routing refactor cannot drift
    // into "contains"-style matching, which would silently break cross-workflow
    // isolation.

    it('matches a qualified activity name exactly against the advertised list', () => {
      const registry = new WorkerRegistry();
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'worker-welcome',
        queue: 'default',
        activities: ['welcome.formatGreeting'],
        concurrency: 5,
      });

      const pick = registry.findWorker('welcome.formatGreeting');
      expect(pick?.id).toBe('worker-welcome');
    });

    it('does not match a bare activity name when the worker advertised a qualified name', () => {
      const registry = new WorkerRegistry();
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'worker-welcome',
        queue: 'default',
        activities: ['welcome.formatGreeting'],
        concurrency: 5,
      });

      expect(registry.findWorker('formatGreeting')).toBeUndefined();
    });

    it('does not match a prefix or substring of the qualified name', () => {
      const registry = new WorkerRegistry();
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'worker-welcome',
        queue: 'default',
        activities: ['welcome.formatGreeting'],
        concurrency: 5,
      });

      expect(registry.findWorker('welcome')).toBeUndefined();
      expect(registry.findWorker('welcome.format')).toBeUndefined();
      expect(registry.findWorker('formatGreeting')).toBeUndefined();
    });

    it('isolates identical activity keys across workflows', () => {
      // A worker advertising only welcome.formatGreeting must not serve
      // other.formatGreeting, and vice versa. This is the load-bearing
      // promise of qualified names.
      const registry = new WorkerRegistry();
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'worker-welcome',
        queue: 'default',
        activities: ['welcome.formatGreeting'],
        concurrency: 5,
      });
      registry.register({
        manifest: testWorkerManifest(),
        acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
        id: 'worker-other',
        queue: 'default',
        activities: ['other.formatGreeting'],
        concurrency: 5,
      });

      expect(registry.findWorker('welcome.formatGreeting')?.id).toBe('worker-welcome');
      expect(registry.findWorker('other.formatGreeting')?.id).toBe('worker-other');
    });
  });
});
