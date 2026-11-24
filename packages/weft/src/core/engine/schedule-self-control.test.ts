/**
 * COR-1482: a scheduled run that calls `pauseSchedule`, `cancelSchedule`, or `updateSchedule` on
 * its own schedule must not wedge it. On the backfill path the timer callback waits for the run's
 * turn to finish, and pause, resume, cancel, and update take the schedule's serialization, so the
 * timer callback must not hold that serialization while it waits.
 *
 * A hang fails these tests through the runner's own per-test timeout.
 */
import { describe, expect, it } from 'bun:test';

import { quietFor, waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import type { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import {
  createEngine,
  MINUTE,
  registerWorkflow,
  requireNextFireAt,
  START,
} from './schedule.test-support.ts';

type Control = 'pause' | 'cancel' | 'update';

async function control(engine: Engine, id: string, what: Control): Promise<void> {
  if (what === 'pause') await engine.pauseSchedule(id);
  else if (what === 'cancel') await engine.cancelSchedule(id);
  else await engine.updateSchedule(id, '*/5 * * * *');
}

const EXPECTED = {
  pause: { status: 'paused', revision: 2 },
  cancel: { status: 'cancelled', revision: 2 },
  update: { status: 'active', revision: 2 },
} as const;

for (const overlap of ['skip', 'queue', 'cancel-running', 'allow'] as const) {
  for (const what of ['pause', 'cancel', 'update'] as const) {
    describe(`a backfilled run (overlap ${overlap}) that calls ${what} on its own schedule`, () => {
      it('settles the tick, keeps what the run did, and leaves the schedule open to later changes', async () => {
        const clock = { now: START };
        const engine = createEngine(clock);
        const id = `self-${what}`;
        let called = 0;
        let controlled = 0;
        try {
          registerWorkflow(engine, 'self-control', async function* (ctx: WorkflowContext) {
            yield* ctx.run(async function selfControl() {
              called += 1;
              await control(engine, id, what);
              controlled += 1;
              return null;
            });
            return 'done';
          });
          const handle = await engine.schedule('self-control', null, '* * * * *', {
            id,
            backfill: true,
            overlap,
          });
          const first = requireNextFireAt(await handle.describe());
          clock.now = first + 2 * MINUTE;

          await engine.scheduler.tick(clock.now);
          await waitUntil(() => controlled >= 1, { message: 'the run to change the schedule' });
          // load-proof: a further run could only start later, so a longer wait cannot fail the count below
          await quietFor(20);

          // What the run did stays: the tick does not write the schedule back as it loaded it.
          const after = await engine.getSchedule(id);
          expect(after?.status).toBe(EXPECTED[what].status);
          // `allow` starts every due occurrence at once, so each run changes the schedule too;
          // every other policy settles one run before it starts the next, and the change stops it.
          if (overlap !== 'allow') {
            expect(after?.revision).toBe(EXPECTED[what].revision);
            expect(called).toBe(1);
          }

          // The schedule is not wedged: a later change from outside settles, and counts.
          if (what !== 'cancel') {
            await engine.pauseSchedule(id);
            const paused = await engine.getSchedule(id);
            expect(paused?.status).toBe('paused');
            if (overlap !== 'allow') expect(paused?.revision).toBe(what === 'pause' ? 2 : 3);
          }
        } finally {
          engine[Symbol.dispose]();
        }
      });
    });
  }
}

describe('a backfilled run that does not touch its schedule', () => {
  it('still settles every occurrence inside the tick', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    try {
      let ran = 0;
      registerWorkflow(engine, 'plain', async function* () {
        ran += 1;
        return 'done';
      });
      const handle = await engine.schedule('plain', null, '* * * * *', {
        id: 'plain',
        backfill: true,
        overlap: 'skip',
      });
      const first = requireNextFireAt(await handle.describe());
      clock.now = first + 2 * MINUTE;
      await engine.scheduler.tick(clock.now);

      expect(ran).toBeGreaterThanOrEqual(3);
      const after = await engine.getSchedule('plain');
      expect(after).toMatchObject({ status: 'active', revision: 1 });
      expect(after?.currentWorkflowId).toBeUndefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
