/**
 * COR-1482: a backfilled tick waits for its run's turn with the schedule's serialization released,
 * so the scheduler must not deliver any entry of that schedule to a second callback meanwhile.
 * These are the invariants that guard buys: an entry is processed at most once per process, the
 * tick writes back only what it read after its wait, a run queued during the wait does not
 * strand, and the schedule keeps exactly one timer.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { EngineDisposedError } from './errors.ts';
import { getInternals } from './internals.ts';
import {
  createEngine,
  MINUTE,
  registerWorkflow,
  requireNextFireAt,
  START,
} from './schedule.test-support.ts';

const turns = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

async function scheduleDueKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('schedule-due:')) keys.push(key);
  return keys;
}

/** A workflow whose one activity waits on `gate`, counting how many times it started. */
function gatedWorkflow(engine: Engine, gate: Promise<void>) {
  const counts = { starts: 0 };
  registerWorkflow(engine, 'slow', async function* (ctx: WorkflowContext) {
    yield* ctx.run(async function slowWork() {
      counts.starts += 1;
      await gate;
      return null;
    });
    return 'done';
  });
  return counts;
}

describe('overlapping scheduler scans of one backfilled schedule', () => {
  for (const overlap of ['allow', 'skip', 'queue', 'cancel-running'] as const) {
    it(`start each due occurrence once, with nothing skipped, queued twice, or cancelled (overlap ${overlap})`, async () => {
      const clock = { now: START };
      const storage = new MemoryStorage();
      const engine = createEngine(clock, storage);
      const gate = Promise.withResolvers<void>();
      const counts = gatedWorkflow(engine, gate.promise);
      try {
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'catch-up',
          backfill: true,
          overlap,
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first + 2 * MINUTE; // three occurrences due
        const dueBefore = await scheduleDueKeys(storage);

        const scanA = engine.scheduler.tick(clock.now);
        await turns(20);
        const startsAfterA = counts.starts;
        const scanB = engine.scheduler.tick(clock.now); // the next poll, while scan A waits
        await turns(20);

        // The second delivery changed nothing: no run started, and the entry it met is as it was.
        expect(counts.starts).toBe(startsAfterA);
        for (const key of dueBefore) expect(storage.get(key)).not.toBeNull();
        const midway = await engine.getSchedule('catch-up');
        expect(midway?.skippedCount).toBe(0);

        gate.resolve();
        await Promise.all([scanA, scanB]);
        await turns(60);

        const after = await engine.getSchedule('catch-up');
        const runs = await engine.list({ type: 'slow' });
        expect(counts.starts).toBe(3);
        expect(runs.items).toHaveLength(3);
        expect(runs.items.every((run) => run.status === 'completed')).toBe(true);
        expect(after).toMatchObject({ skippedCount: 0, nextFireAt: first + 3 * MINUTE });
        expect(after?.queuedRuns).toEqual([]);
      } finally {
        engine[Symbol.dispose]();
      }
    });
  }
});

describe('a queued run', () => {
  for (const backfill of [true, false]) {
    it(`starts when its predecessor ends, when the next occurrence queues it during the wait (backfill ${backfill})`, async () => {
      const clock = { now: START };
      const engine = createEngine(clock);
      const gate = Promise.withResolvers<void>();
      const counts = gatedWorkflow(engine, gate.promise);
      try {
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'minutely',
          backfill,
          overlap: 'queue',
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first;
        const tickA = engine.scheduler.tick(first);
        await turns(20);
        clock.now = first + MINUTE;
        const tickB = engine.scheduler.tick(first + MINUTE);
        await turns(20);
        gate.resolve();
        await Promise.all([tickA, tickB]);
        await turns(60);
        // The delivery that came while the tick waited changed nothing, so the occurrence it
        // would have queued comes due on the next poll.
        await engine.scheduler.tick(first + MINUTE);
        await turns(60);

        const after = await engine.getSchedule('minutely');
        expect(counts.starts).toBe(2);
        expect(after?.queuedRuns).toEqual([]);
      } finally {
        engine[Symbol.dispose]();
      }
    });
  }

  it('is drained by the section that clears the slot, which wins over the finished run’s own terminal handler', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    const gate = Promise.withResolvers<void>();
    const counts = gatedWorkflow(engine, gate.promise);
    try {
      // A prior run P holds the slot: the first occurrence, with no backfill, does not wait for it.
      const handle = await engine.schedule('slow', null, '* * * * *', {
        id: 'minutely',
        overlap: 'queue',
      });
      const first = requireNextFireAt(await handle.describe());
      clock.now = first;
      await engine.scheduler.tick(first);
      await turns(20);
      expect(counts.starts).toBe(1);
      // Backfill is on from here: this tick queues its occurrence behind P, writes, and waits for P.
      await engine.updateSchedule('minutely', '* * * * *', { backfill: true });
      clock.now = first + MINUTE;
      const tick = engine.scheduler.tick(first + MINUTE);
      await turns(20);
      const waiting = await engine.getSchedule('minutely');
      expect(waiting?.queuedRuns).toHaveLength(1);

      gate.resolve();
      await tick;
      await turns(80);

      // P ended; the queued occurrence started, instead of waiting a full cadence for the next tick.
      const after = await engine.getSchedule('minutely');
      expect(counts.starts).toBe(2);
      expect(after?.queuedRuns).toEqual([]);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('what a tick writes after its wait', () => {
  it('is only a state it read after the wait: a pause, a resume, or an update made meanwhile survives', async () => {
    for (const change of ['pause', 'pause-resume', 'update'] as const) {
      const clock = { now: START };
      const engine = createEngine(clock);
      const gate = Promise.withResolvers<void>();
      gatedWorkflow(engine, gate.promise);
      try {
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'changing',
          backfill: true,
          overlap: 'skip',
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first + 2 * MINUTE;
        const tick = engine.scheduler.tick(clock.now);
        await turns(20);

        if (change === 'update') await engine.updateSchedule('changing', '*/10 * * * *');
        else {
          await engine.pauseSchedule('changing');
          if (change === 'pause-resume') await engine.resumeSchedule('changing');
        }
        const changed = await engine.getSchedule('changing');
        const revisionAfterChange = changed?.revision;
        gate.resolve();
        await tick;
        await turns(40);

        const after = await engine.getSchedule('changing');
        expect(after?.revision, change).toBe(revisionAfterChange);
        expect(after?.status, change).toBe(change === 'pause' ? 'paused' : 'active');
        if (change === 'update') expect(after?.cronExpression).toBe('*/10 * * * *');
      } finally {
        engine[Symbol.dispose]();
      }
    }
  });
});

describe('the timer of a schedule whose tick is in flight', () => {
  it('is not moved or deleted by a delivery of the entry the tick re-armed, and fires once afterwards', async () => {
    const clock = { now: START };
    const storage = new MemoryStorage();
    const engine = createEngine(clock, storage);
    const gate = Promise.withResolvers<void>();
    const counts = gatedWorkflow(engine, gate.promise);
    try {
      const handle = await engine.schedule('slow', null, '* * * * *', {
        id: 'rearmed',
        backfill: true,
        overlap: 'skip',
      });
      const first = requireNextFireAt(await handle.describe());
      clock.now = first; // one occurrence due: it is the final one, so the tick re-arms the next timer
      const tickA = engine.scheduler.tick(first);
      await turns(20);
      const next = first + MINUTE;
      const armed = KEYS.scheduleTick(next, 'rearmed');
      expect(await storage.get(armed)).not.toBeNull();

      // The re-armed entry comes due while the first tick still waits, and is delivered.
      clock.now = next;
      await engine.scheduler.tick(next);
      await turns(20);

      const during = await engine.getSchedule('rearmed');
      expect(during?.nextFireAt).toBe(next);
      expect(during?.skippedCount).toBe(0);
      expect(counts.starts).toBe(1);
      expect(await storage.get(armed)).not.toBeNull();

      gate.resolve();
      await tickA;
      await turns(40);

      // After the tick: exactly one timer, at the next occurrence, and the index points at it.
      expect(await scheduleDueKeys(storage)).toEqual([armed]);
      const index = await storage.get('timer-idx:schedule:rearmed');
      expect(index === null ? null : decode(index)).toBe(armed);
      await engine.scheduler.tick(next);
      await turns(40);
      expect(counts.starts).toBe(2);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('is re-armed at boot when the process dies mid-tick, and fires once at its next occurrence', async () => {
    const clock = { now: START };
    const storage = new MemoryStorage();
    const first = await (async () => {
      const crashing = createEngine(clock, storage);
      const gate = Promise.withResolvers<void>();
      gatedWorkflow(crashing, gate.promise);
      const handle = await crashing.schedule('slow', null, '* * * * *', {
        id: 'crash',
        backfill: true,
        overlap: 'skip',
      });
      const at = requireNextFireAt(await handle.describe());
      clock.now = at;
      void crashing.scheduler.tick(at).catch(() => undefined);
      await turns(20);
      // The process dies with the tick in flight: nothing it held is released or cleaned up.
      crashing[Symbol.dispose]();
      return at;
    })();

    const reborn = createEngine(clock, storage);
    const counts = gatedWorkflow(reborn, Promise.resolve());
    try {
      await reborn.recoverAll();
      clock.now = first + MINUTE;
      await reborn.scheduler.tick(first + MINUTE);
      await turns(60);

      const after = await reborn.getSchedule('crash');
      expect(counts.starts).toBeGreaterThanOrEqual(1);
      expect(after?.status).toBe('active');
      expect(after?.nextFireAt).toBe(first + 2 * MINUTE);
      expect(await scheduleDueKeys(storage)).toEqual([
        KEYS.scheduleTick(first + 2 * MINUTE, 'crash'),
      ]);
    } finally {
      reborn[Symbol.dispose]();
    }
  });
});

/**
 * Makes the run's turn reject once, as it does when the engine's handling of the run's message
 * fails (a storage fault while the run is saved), and hands back the way to reject it later.
 */
function rejectNextTurn(
  engine: Engine,
  mode: 'at-once' | 'later',
  failure: Error = new Error('the run’s turn failed'),
) {
  const strategy = getInternals(engine).inlineStrategy!;
  const original = strategy.waitForWorkflowTurn.bind(strategy);
  const pending = Promise.withResolvers<void>();
  let armed = true;
  strategy.waitForWorkflowTurn = (workflowId: string) => {
    if (!armed) return original(workflowId);
    armed = false;
    return mode === 'at-once'
      ? Promise.reject(new Error('the run’s turn failed'))
      : pending.promise;
  };
  return { reject: () => pending.reject(failure) };
}

describe('a backfilled tick whose wait for its run fails', () => {
  for (const overlap of ['skip', 'queue', 'cancel-running'] as const) {
    it(`pauses the schedule once, and later polls do not plan its occurrence again (overlap ${overlap})`, async () => {
      const clock = { now: START };
      const engine = createEngine(clock);
      const gate = Promise.withResolvers<void>();
      const counts = gatedWorkflow(engine, gate.promise);
      const consoleError = spyOn(console, 'error').mockImplementation(() => {});
      try {
        rejectNextTurn(engine, 'at-once');
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'failing',
          backfill: true,
          overlap,
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first + 2 * MINUTE; // three occurrences due

        await engine.scheduler.tick(clock.now);
        await turns(20);
        const paused = await engine.getSchedule('failing');
        expect(paused).toMatchObject({ status: 'paused', revision: 2 });

        // Several more polls: the schedule is paused, so nothing is planned, skipped, or queued.
        for (let poll = 0; poll < 4; poll += 1) {
          await engine.scheduler.tick(clock.now);
          await turns(10);
        }
        gate.resolve();
        await turns(30);
        const after = await engine.getSchedule('failing');
        const runs = await engine.list({ type: 'slow' });
        expect(counts.starts).toBe(1);
        expect(runs.items).toHaveLength(1);
        expect(after).toMatchObject({ status: 'paused', revision: 2, skippedCount: 0 });
        expect(after?.queuedRuns).toEqual([]);
      } finally {
        gate.resolve();
        consoleError.mockRestore();
        engine[Symbol.dispose]();
      }
    });
  }

  it('leaves a transition made during the wait as it is, with no pause on top of it', async () => {
    for (const change of ['pause', 'update'] as const) {
      const clock = { now: START };
      const engine = createEngine(clock);
      const gate = Promise.withResolvers<void>();
      gatedWorkflow(engine, gate.promise);
      const consoleError = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const turn = rejectNextTurn(engine, 'later');
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'changing',
          backfill: true,
          overlap: 'skip',
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first + 2 * MINUTE;
        const tick = engine.scheduler.tick(clock.now);
        await turns(20);

        if (change === 'pause') await engine.pauseSchedule('changing');
        else await engine.updateSchedule('changing', '*/10 * * * *');
        const changed = await engine.getSchedule('changing');
        turn.reject();
        await tick;
        await turns(20);

        const after = await engine.getSchedule('changing');
        expect(after?.revision, change).toBe(changed?.revision);
        expect(after?.status, change).toBe(change === 'pause' ? 'paused' : 'active');
        if (change === 'update') expect(after?.cronExpression).toBe('*/10 * * * *');
      } finally {
        gate.resolve();
        consoleError.mockRestore();
        engine[Symbol.dispose]();
      }
    }
  });

  it('does not pause the schedule for the engine’s own disposal error, or for any failure once the engine is disposed', async () => {
    for (const how of ['disposal-error', 'disposed-engine'] as const) {
      const clock = { now: START };
      const storage = new MemoryStorage();
      const engine = createEngine(clock, storage);
      const gate = Promise.withResolvers<void>();
      gatedWorkflow(engine, gate.promise);
      const consoleError = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const turn = rejectNextTurn(
          engine,
          'later',
          how === 'disposal-error' ? new EngineDisposedError() : new Error('a storage fault'),
        );
        const handle = await engine.schedule('slow', null, '* * * * *', {
          id: 'closing',
          backfill: true,
          overlap: 'skip',
        });
        const first = requireNextFireAt(await handle.describe());
        clock.now = first + 2 * MINUTE;
        const tick = engine.scheduler.tick(clock.now).catch(() => undefined);
        await turns(20);
        if (how === 'disposed-engine') engine[Symbol.dispose]();
        turn.reject();
        await tick;
        await turns(20);

        const survivor = how === 'disposed-engine' ? createEngine(clock, storage) : engine;
        const after = await survivor.getSchedule('closing');
        expect(after, how).toMatchObject({ status: 'active', revision: 1 });
        if (survivor !== engine) survivor[Symbol.dispose]();
      } finally {
        gate.resolve();
        consoleError.mockRestore();
        engine[Symbol.dispose]();
      }
    }
  });

  it('does not pause the schedule when the engine is disposed during the wait, so a new engine fires it once', async () => {
    const clock = { now: START };
    const storage = new MemoryStorage();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const closing = createEngine(clock, storage);
      const gate = Promise.withResolvers<void>();
      gatedWorkflow(closing, gate.promise);
      const handle = await closing.schedule('slow', null, '* * * * *', {
        id: 'shutdown',
        backfill: true,
        overlap: 'skip',
      });
      const first = requireNextFireAt(await handle.describe());
      clock.now = first;
      const tick = closing.scheduler.tick(first).catch(() => undefined);
      await turns(20);
      closing[Symbol.dispose]();
      gate.resolve();
      await tick;
      await turns(20);

      const reborn = createEngine(clock, storage);
      const counts = gatedWorkflow(reborn, Promise.resolve());
      try {
        await reborn.recoverAll();
        // The recovered run finishes before the next occurrence comes due.
        await turns(60);
        const waiting = await reborn.getSchedule('shutdown');
        expect(waiting).toMatchObject({ status: 'active', revision: 1 });
        clock.now = first + MINUTE;
        await reborn.scheduler.tick(first + MINUTE);
        await turns(60);

        const after = await reborn.getSchedule('shutdown');
        const runs = await reborn.list({ type: 'slow' });
        expect(after).toMatchObject({
          status: 'active',
          revision: 1,
          nextFireAt: first + 2 * MINUTE,
        });
        // The run the first engine started, recovered, and the one occurrence due since.
        expect(runs.items).toHaveLength(2);
        expect(counts.starts).toBeGreaterThanOrEqual(2);
      } finally {
        reborn[Symbol.dispose]();
      }
    } finally {
      consoleError.mockRestore();
    }
  });
});
