/**
 * COR-1482: with the engine's own poller, no manual ticks, and a backfilled run that takes longer
 * than the poll interval, every owed occurrence starts once. This is real elapsed time, which is
 * why it is a slow lane.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { quietFor } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { MINUTE, registerWorkflow, requireNextFireAt, START } from './schedule.test-support.ts';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('the engine’s own poller over a backfilled schedule whose runs outlast the poll interval', () => {
  for (const overlap of ['skip', 'queue', 'cancel-running'] as const) {
    it(`starts each owed occurrence once (overlap ${overlap})`, async () => {
      const clock = { now: START };
      const engine = new Engine({
        storage: new MemoryStorage(),
        getNow: () => clock.now,
        schedulerPollIntervalMs: 20,
      });
      let activityStarts = 0;
      try {
        registerWorkflow(engine, 'slow', async function* (ctx: WorkflowContext) {
          yield* ctx.run(async function slowWork() {
            activityStarts += 1;
            await sleep(120); // several polls long
            return null;
          });
          return 'done';
        });
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'catch-up',
          backfill: true,
          overlap,
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first + 2 * MINUTE; // three occurrences due
        engine.scheduler.start();
        // Three runs of 120 ms in turn, with room for the polls in between.
        while (activityStarts < 3) await sleep(20);
        await quietFor(500);
        await engine.scheduler.stop();
        await quietFor(200);

        const final = await handle.describe();
        const runs = await engine.list({ type: 'slow' });
        const cancelled = runs.items.filter((run) => run.status === 'cancelled');
        expect(activityStarts).toBe(3);
        expect(runs.items).toHaveLength(3);
        expect(cancelled).toEqual([]);
        expect(final).toMatchObject({ skippedCount: 0, nextFireAt: first + 3 * MINUTE });
        expect(final?.queuedRuns).toEqual([]);
      } finally {
        await engine.scheduler.stop();
        engine[Symbol.dispose]();
      }
    });
  }
});
