import { describe, expect, it } from 'bun:test';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { Engine } from '../engine.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { EngineDisposedError } from './errors.ts';
import { getInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';
import { getWorkflowRetentionDeadline } from './workflow-retention-deadline.ts';

describe('getWorkflowRetentionDeadline', () => {
  it('a retention deadline whose pinned revision is still loading when the engine is disposed rejects with EngineDisposedError, not "unresolvable" (COR-1338)', async () => {
    // `getWorkflowRetentionDeadline()`'s catch maps only the two "this pin
    // cannot be resolved here" errors to `unresolvable`; anything else is
    // rethrown. Disposal is the one error the source loader passes through
    // unwrapped (`loadAndInstallSourceRevision`): it aborts every in-flight
    // load with an `EngineDisposedError`. Before this test, only a retention
    // sweep that happened to race a synchronous dispose elsewhere in the suite
    // reached that rethrow, so its coverage flipped with host load. Here the
    // loader is held open until disposal has landed, so the race is fixed.
    const storage = new MemoryStorage();
    const type = 'disposed-mid-load-retention';
    const definition = workflow({
      name: type,
      description: 'the pinned revision, never resolved by the disposed engine',
      retention: { completed: '1s' },
    }).execute(async function* () {
      return 'done';
    });
    const revision = await (async () => {
      const entry = buildRegistrationEntry(type, definition);
      const registered = copyWorkflowDefinition(type, entry);
      const manifest = await buildWorkflowManifestFromDefinition(
        registered,
        new ActivityRegistry().listDefinitions(),
      );
      return manifest.revision;
    })();
    const workflowId = 'disposed-mid-load-retention-run';

    {
      // A separate engine completes the run, so the disposed engine below
      // has never resolved this revision and must load it for the deadline.
      await using seedingEngine = new Engine({ storage });
      seedingEngine.registerSource(
        workflowSource(
          { name: type, location: './pinned.ts', exportName: 'pinned', revision },
          async () => ({ pinned: definition }),
        ),
      );
      const seededHandle = await seedingEngine.start(type, null, { id: workflowId });
      await seededHandle.result();
    }

    const loaderStarted = Promise.withResolvers<void>();
    const releaseLoader = Promise.withResolvers<void>();
    const engine = new Engine({ storage, backgroundTasks: 'manual' });
    engine.registerSource(
      workflowSource(
        { name: type, location: './pinned.ts', exportName: 'pinned', revision },
        async () => {
          loaderStarted.resolve();
          await releaseLoader.promise;
          return { pinned: definition };
        },
      ),
    );
    const state = await engine.get(workflowId);
    if (state === null) throw new Error('seeded run is missing');
    expect(state.revision).toBe(revision);

    const deadline = getWorkflowRetentionDeadline(getInternals(engine), state);
    await loaderStarted.promise;
    engine[Symbol.dispose]();
    releaseLoader.resolve();

    await expect(deadline).rejects.toBeInstanceOf(EngineDisposedError);
  });
});
