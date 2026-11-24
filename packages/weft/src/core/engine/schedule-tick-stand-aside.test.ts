/**
 * COR-1925: an engine that stands aside from a backfill tick because another engine went on with
 * the catch-up must not take the schedule's only timer with it. The catch-up commits each
 * occurrence (`lastFireAt`) and replaces the tick entry only with its last, so the fired entry is
 * the one thing that wakes the schedule if the other engine dies in between. The entry is kept
 * until the stored schedule shows the next timer, and the engine that kept it finishes the
 * occurrences left, without a restart and without starting one twice.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import {
  closeOpenedEngines,
  nextTimerArmed,
  openEngines,
  parkResumedSectionDrain,
  SCHEDULE_ID,
  stateOf,
} from './schedule-across-engines.test-support.ts';
import { drainEngine, listRunningWorkflowIds, MINUTE } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

/** How many tick entries the store holds for the schedule. */
async function tickEntries(shared: {
  scan(prefix: string): AsyncIterable<[string, Uint8Array]>;
}): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of shared.scan('schedule-due:')) keys.push(key);
  return keys;
}

/**
 * A backfilled `queue` schedule with three occurrences overdue and a run holding the slot. Engine
 * A's write for the second occurrence and engine B's write for the last are parked; B has
 * committed the second. Releasing A's write makes A stand aside.
 */
async function parkBeforeBsLastWrite() {
  const opened = await openEngines({ overlap: 'queue', backfill: true });
  const { clock, shared, a, b, engineA, engineB } = opened;
  const triggered = await engineA.triggerSchedule(SCHEDULE_ID);
  if (triggered.outcome !== 'started') throw new Error('The run now should start.');
  await drainEngine();
  const { nextFireAt } = await stateOf(shared);
  const first = nextFireAt!;
  clock.now = first + 2 * MINUTE;
  const firstWrite = a.holdScheduleWrite();
  const tickingA = engineA.scheduler.tick(clock.now);
  await firstWrite.reached;
  const aSecondWrite = a.holdScheduleWrite();
  firstWrite.release();
  await aSecondWrite.reached;

  const bFirstWrite = b.holdScheduleWrite();
  const tickingB = engineB.scheduler.tick(clock.now);
  await bFirstWrite.reached;
  const bLastWrite = b.holdScheduleWrite();
  bFirstWrite.release();
  await bLastWrite.reached;
  const committed = await stateOf(shared);
  expect(committed.lastFireAt).toBe(first + MINUTE);
  return { ...opened, first, tickingA, tickingB, aSecondWrite, bLastWrite };
}

describe('an engine stands aside from a catch-up the other engine goes on with', () => {
  it('finishes the occurrences left after the other engine dies, with no restart', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { shared, engineA, engineB, clock, first, tickingA, aSecondWrite } =
        await parkBeforeBsLastWrite();
      aSecondWrite.release();
      await tickingA;
      await drainEngine();
      // A lost its write to B's and stood aside; the entry that fired is the schedule's timer still.
      const stoodAside = await stateOf(shared);
      expect(stoodAside.lastFireAt).toBe(first + MINUTE);
      expect(stoodAside.nextFireAt).toBe(first);
      expect(await shared.get(KEYS.scheduleTick(first, SCHEDULE_ID))).not.toBeNull();

      // B dies at its last write, which never lands.
      engineB[Symbol.dispose]();
      await engineA.scheduler.tick(clock.now);
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.nextFireAt).toBe(first + 3 * MINUTE);
      expect(state.queuedRuns.map((run) => run.occurrence)).toEqual([
        first,
        first + MINUTE,
        first + 2 * MINUTE,
      ]);
      expect(await nextTimerArmed(shared)).toBe(true);
      expect(await tickEntries(shared)).toEqual([
        KEYS.scheduleTick(first + 3 * MINUTE, SCHEDULE_ID),
      ]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('starts nothing twice when the engine it stood aside for finishes first', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { shared, engineA, clock, first, tickingA, tickingB, aSecondWrite, bLastWrite } =
        await parkBeforeBsLastWrite();
      aSecondWrite.release();
      await tickingA;
      await drainEngine();
      bLastWrite.release();
      await tickingB;
      await drainEngine();
      // The entry A kept is gone with B's last write, and A's next scan finds nothing to do.
      await engineA.scheduler.tick(clock.now);
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.nextFireAt).toBe(first + 3 * MINUTE);
      expect(state.queuedRuns.map((run) => run.occurrence)).toEqual([
        first,
        first + MINUTE,
        first + 2 * MINUTE,
      ]);
      expect(await tickEntries(shared)).toEqual([
        KEYS.scheduleTick(first + 3 * MINUTE, SCHEDULE_ID),
      ]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('starts nothing twice when the engine that kept the entry finishes first', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { shared, engineA, clock, first, tickingA, tickingB, aSecondWrite, bLastWrite } =
        await parkBeforeBsLastWrite();
      aSecondWrite.release();
      await tickingA;
      await drainEngine();
      await engineA.scheduler.tick(clock.now);
      await drainEngine();
      // B's last write was decided before A finished, and loses.
      bLastWrite.release();
      await tickingB;
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.nextFireAt).toBe(first + 3 * MINUTE);
      expect(state.queuedRuns.map((run) => run.occurrence)).toEqual([
        first,
        first + MINUTE,
        first + 2 * MINUTE,
      ]);
      expect(await tickEntries(shared)).toEqual([
        KEYS.scheduleTick(first + 3 * MINUTE, SCHEDULE_ID),
      ]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('an engine whose drain loses to the other engine’s catch-up', () => {
  it('finishes the occurrences left after the other engine dies, with no restart', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { shared, clock, b, engineA, engineB, first, tickingA, draining } =
        await parkResumedSectionDrain();
      // B drains the queued run, queues the second occurrence, and is parked at its last write.
      const drainWrite = b.holdScheduleWrite();
      void engineB.scheduler.tick(clock.now);
      await drainWrite.reached;
      const secondWrite = b.holdScheduleWrite();
      drainWrite.release();
      await secondWrite.reached;
      const lastWrite = b.holdScheduleWrite();
      secondWrite.release();
      await lastWrite.reached;

      // A's drain is decided from before B's, and loses; A stands aside.
      draining.release();
      await tickingA;
      await drainEngine();
      const stoodAside = await stateOf(shared);
      expect(stoodAside.lastFireAt).toBe(first + MINUTE);
      expect(stoodAside.nextFireAt).toBe(first);
      expect(await shared.get(KEYS.scheduleTick(first, SCHEDULE_ID))).not.toBeNull();

      engineB[Symbol.dispose]();
      await engineA.scheduler.tick(clock.now);
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.status).toBe('active');
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.nextFireAt).toBe(first + 3 * MINUTE);
      expect(state.queuedRuns.map((run) => run.occurrence)).toEqual([
        first + MINUTE,
        first + 2 * MINUTE,
      ]);
      expect(await listRunningWorkflowIds(engineA)).toEqual([state.currentWorkflowId!]);
      expect(await nextTimerArmed(shared)).toBe(true);
      expect(await tickEntries(shared)).toEqual([
        KEYS.scheduleTick(first + 3 * MINUTE, SCHEDULE_ID),
      ]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
