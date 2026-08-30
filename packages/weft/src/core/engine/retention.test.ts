import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
import { getInternals } from './internals.ts';
import {
  ensureRetentionSweepInterval,
  getRetentionOverview,
  hasConfiguredRetention,
  runRetentionSweep,
} from './retention.ts';

describe('retention helpers', () => {
  it('treats workflow-level retention as configured retention', () => {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'retained-workflow', retention: { completed: '1m' } }).execute(
        async function* () {
          return 'done';
        },
      ),
    );

    expect(hasConfiguredRetention(getInternals(engine))).toBe(true);

    engine[Symbol.dispose]();
  });

  it('clears an existing retention sweep interval when retention is no longer configured', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    internals.retentionSweepInterval = setInterval(() => undefined, 1_000);
    internals.nextRetentionSweepAt = 123;

    ensureRetentionSweepInterval(internals, {
      hasConfiguredRetention: () => false,
      runRetentionSweep: async () => undefined,
      setNextRetentionSweepAt: () => undefined,
    });

    expect(internals.retentionSweepInterval).toBeNull();
    expect(internals.nextRetentionSweepAt).toBeNull();

    engine[Symbol.dispose]();
  });

  it('reports purge failures through the cleanup error callback', async () => {
    const underlyingStorage = new MemoryStorage();
    const purgeError = new Error('scan failed during retention sweep');
    const storage = {
      capabilities: underlyingStorage.capabilities.bind(underlyingStorage),
      batch: underlyingStorage.batch.bind(underlyingStorage),
      conditionalBatch: underlyingStorage.conditionalBatch.bind(underlyingStorage),
      delete: underlyingStorage.delete.bind(underlyingStorage),
      get: underlyingStorage.get.bind(underlyingStorage),
      put: underlyingStorage.put.bind(underlyingStorage),
      scan: async function* () {
        throw purgeError;
      },
      [Symbol.dispose]() {
        underlyingStorage[Symbol.dispose]();
      },
    };
    const engine = new Engine({
      retention: { completed: 0 },
      storage,
    });
    let cleanupErrorCall: [string, unknown] | null = null;
    const handleCleanupError = mock((source: string, error: unknown) => {
      cleanupErrorCall = [source, error];
    });

    await runRetentionSweep(getInternals(engine), handleCleanupError, () => undefined);

    expect(handleCleanupError).toHaveBeenCalledTimes(1);
    expect(cleanupErrorCall).not.toBeNull();
    expect(cleanupErrorCall![0]).toBe('retentionSweep');
    expect(cleanupErrorCall![1]).toBe(purgeError);

    engine[Symbol.dispose]();
  });

  it('builds retention overviews with the default type resolver', () => {
    const engine = new Engine({
      retention: { completed: '5m' },
      retentionSweepBatchSize: 7,
      retentionSweepInterval: '10s',
    });
    engine.register(
      workflow({ name: 'default-retention' }).execute(async function* () {
        return 'default';
      }),
    );
    engine.register(
      workflow({ name: 'workflow-retention', retention: { completed: '1h' } }).execute(
        async function* () {
          return 'workflow';
        },
      ),
    );

    const overview = getRetentionOverview(getInternals(engine));

    expect(overview.sweepBatchSize).toBe(7);
    expect(overview.workflowTypes).toEqual([
      {
        type: 'default-retention',
        source: 'engine',
        retention: { completed: 300_000 },
      },
      {
        type: 'workflow-retention',
        source: 'workflow',
        retention: { completed: 3_600_000 },
      },
    ]);

    engine[Symbol.dispose]();
  });
});
