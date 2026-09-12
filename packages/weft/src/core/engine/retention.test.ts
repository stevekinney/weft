import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { Engine } from '../engine.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';
import {
  ensureRetentionSweepInterval,
  getRetentionOverview,
  hasConfiguredRetention,
  resolveWorkflowTypeRetention,
  runRetentionSweep,
} from './retention.ts';

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

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

  it("picks up a registerSource()-registered type's own retention policy once resolved", async () => {
    // Regression: a dynamic definition's `retention` never lands in
    // `internals.registrations` (only `internals.sources.resolved` once loaded), so a
    // lookup scoped to `internals.registrations` alone silently ignored it — both for the
    // "is any retention configured at all" check and for the per-type policy itself.
    const type = 'dynamic-retention';
    const definition = workflow({ name: type, retention: { completed: '2h' } }).execute(
      async function* () {
        return 'dynamic';
      },
    );
    const revision = await revisionFor(definition);

    const engine = new Engine();
    engine.registerSource(
      workflowSource(
        { name: type, location: './dynamic-retention.ts', exportName: 'dyn', revision },
        async () => ({ dyn: definition }),
      ),
    );

    // Not yet resolved: no policy visible yet (lazy loading pays nothing extra).
    expect(hasConfiguredRetention(getInternals(engine))).toBe(false);

    await engine.start(type, null, { id: 'dynamic-retention-run' });

    expect(hasConfiguredRetention(getInternals(engine))).toBe(true);
    expect(resolveWorkflowTypeRetention(getInternals(engine), type)).toEqual({
      type,
      source: 'workflow',
      retention: { completed: 7_200_000 },
    });

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
