import { describe, expect, it } from 'bun:test';

import {
  claimNextSequence,
  evictOldestAffinityEntries,
  restoreExtendedDeadline,
  restoreExtendedDeadlineIfStillActive,
} from './runtime-helpers.ts';

describe('claimNextSequence', () => {
  it('returns the current sequence and increments it for the next event', () => {
    const sequenceCounters = new Map([['wf-1', 4]]);

    expect(claimNextSequence(sequenceCounters, 'wf-1')).toBe(4);
    expect(sequenceCounters.get('wf-1')).toBe(5);
  });

  it('throws when the sequence counter has not been initialized', () => {
    expect(() => claimNextSequence(new Map(), 'wf-missing')).toThrow(
      'Sequence counter for workflow "wf-missing" accessed before initialization',
    );
  });
});

describe('evictOldestAffinityEntries', () => {
  it('keeps the cache unchanged while it is within the configured cap', () => {
    const workerAffinity = new Map([
      ['wf-1', 'worker-1'],
      ['wf-2', 'worker-2'],
    ]);

    evictOldestAffinityEntries(workerAffinity, 2);

    expect([...workerAffinity.entries()]).toEqual([
      ['wf-1', 'worker-1'],
      ['wf-2', 'worker-2'],
    ]);
  });

  it('evicts the oldest affinity entry when the cache exceeds the cap', () => {
    const workerAffinity = new Map([
      ['wf-1', 'worker-1'],
      ['wf-2', 'worker-2'],
      ['wf-3', 'worker-3'],
    ]);

    evictOldestAffinityEntries(workerAffinity, 2);

    expect([...workerAffinity.entries()]).toEqual([
      ['wf-2', 'worker-2'],
      ['wf-3', 'worker-3'],
    ]);
  });
});

describe('restoreExtendedDeadline', () => {
  it('re-adds an extended deadline to the tracker', () => {
    const added: Array<{ operationId: string; deadline: number }> = [];

    restoreExtendedDeadline(
      {
        add(entry) {
          added.push(entry);
        },
      },
      'op-1',
      1234,
    );

    expect(added).toEqual([{ operationId: 'op-1', deadline: 1234 }]);
  });

  it('restoreExtendedDeadlineIfStillActive requeues future deadlines and reports that it handled the entry', () => {
    const added: Array<{ operationId: string; deadline: number }> = [];

    const restored = restoreExtendedDeadlineIfStillActive(
      {
        add(entry) {
          added.push(entry);
        },
      },
      'op-1',
      2500,
      2000,
    );

    expect(restored).toBe(true);
    expect(added).toEqual([{ operationId: 'op-1', deadline: 2500 }]);
  });

  it('restoreExtendedDeadlineIfStillActive leaves expired deadlines alone', () => {
    const added: Array<{ operationId: string; deadline: number }> = [];

    const restored = restoreExtendedDeadlineIfStillActive(
      {
        add(entry) {
          added.push(entry);
        },
      },
      'op-1',
      1500,
      2000,
    );

    expect(restored).toBe(false);
    expect(added).toEqual([]);
  });
});
