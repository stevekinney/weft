/**
 * A resume from storage that has not yet adopted its workflow's checkpoint leaves no local mark on
 * the engine: no checkpoint, no inline execution. A second resume of the same run in that window
 * (here, a second `recoverAll()` while the first is held in `resolveWorkflowServices`, as a
 * Bureau's reclaim is held while the Bureau finishes composing) used to drive the run alongside the
 * first, so the later checkpoint commit lost its compare-and-swap and the run was abandoned with
 * `WorkflowCheckpointConflictError`. The second resume must join the first.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { KEYS } from '../../storage/keys.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';

const activityRunsByStore = new WeakMap<MemoryStorage, number>();

function parkedWorkflow(storage: MemoryStorage) {
  return workflow({ name: 'parked-until-go' }).execute(async function* (ctx: WorkflowContext) {
    yield* ctx.waitForSignal('go');
    return yield* ctx.run(() => {
      activityRunsByStore.set(storage, (activityRunsByStore.get(storage) ?? 0) + 1);
      return 'ran';
    });
  });
}

describe.each(['workflow-lease', 'none'] as const)(
  'a resume that starts while another is held in resolveWorkflowServices (%s)',
  (ownership) => {
    it('joins it, so the run is recovered and driven once', async () => {
      const storage = new MemoryStorage();
      const definition = parkedWorkflow(storage);
      {
        await using previousOwner = await Engine.create({
          storage,
          workflows: { 'parked-until-go': definition },
          recover: false,
        });
        await previousOwner.start('parked-until-go', null, {
          id: 'held-run',
          services: { owner: 'previous' },
        });
        await waitForCondition(
          async () => (await storage.get(KEYS.checkpoint('held-run'))) !== null,
          { label: 'the previous owner checkpointed the run' },
        );
      }

      const releaseResolver = Promise.withResolvers<void>();
      let resolverCalls = 0;
      await using engine = await Engine.create({
        storage,
        workflows: { 'parked-until-go': definition },
        ownership,
        recover: false,
        backgroundTasks: 'manual',
        resolveWorkflowServices: async () => {
          resolverCalls++;
          if (resolverCalls === 1) await releaseResolver.promise;
          return { status: 'available', services: { owner: 'recovered' } };
        },
      });

      const first = engine.recoverAll();
      await waitForCondition(() => resolverCalls === 1, { label: 'the first resume is held' });
      const second = engine.recoverAll();
      // Give the second recovery every chance to reach the run while the first is still held. An
      // unguarded second resume gets its services at once and drives the run ahead of the first.
      for (let turn = 0; turn < 20; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      releaseResolver.resolve();
      const [firstHandles, secondHandles] = await Promise.all([first, second]);

      expect(resolverCalls).toBe(1);
      expect(firstHandles.map((handle) => handle.id)).toEqual(['held-run']);
      expect(secondHandles.map((handle) => handle.id)).toEqual(['held-run']);
      await engine.signal('held-run', 'go', null);
      expect(await engine.getHandle('held-run').result()).toBe('ran');
      expect(activityRunsByStore.get(storage)).toBe(1);
    });
  },
);
