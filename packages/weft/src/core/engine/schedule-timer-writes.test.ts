/**
 * COR-1925: how a schedule timer tick writes the schedule it fires when another engine changed the
 * schedule meanwhile, or the store refuses the write. A skip another engine recorded is carried
 * into the tick's write and moves past the occurrences the tick already accounted for; a drain that
 * loses to a run another engine started ends there; a catch-up with nothing left moves the cadence
 * on; a write the store refuses is reported, never answered with a pause the store would refuse too.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import type { ScheduleState } from '../types.ts';
import {
  closeOpenedEngines,
  nextTimerArmed,
  openEngines,
  parkResumedSectionDrain,
  SCHEDULE_ID,
  stateOf,
  tickB,
} from './schedule-across-engines.test-support.ts';
import { carryConcurrentRecords, ScheduleStatePersistenceError } from './schedule-timer-writes.ts';
import { drainEngine, listRunningWorkflowIds, MINUTE } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

function occurrencesOf(state: { queuedRuns: ReadonlyArray<{ occurrence?: number }> }) {
  return state.queuedRuns.map((run) => run.occurrence);
}

describe('a skip another engine records while a tick queues the occurrence it names', () => {
  it('drops the skip when the tick queued the last occurrence it had to account for', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { clock, shared, b, engineA, engineB } = await openEngines({ overlap: 'queue' });
      await engineA.triggerSchedule(SCHEDULE_ID);
      await drainEngine();
      const { nextFireAt } = await stateOf(shared);
      const first = nextFireAt!;
      const hold = b.holdScheduleWrite();
      const ticking = tickB(clock, engineB, shared);
      await hold.reached;
      await engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
      const skipped = await stateOf(shared);
      expect(skipped.skippedOccurrences).toEqual([first]);
      hold.release();
      await ticking;
      await drainEngine();

      // The occurrence was already decided: queued, not skipped. The skip named it, so it is
      // dropped rather than moved onto the next one, which nobody asked to skip.
      const carried = await stateOf(shared);
      expect(occurrencesOf(carried)).toEqual([first]);
      expect(carried.skippedOccurrences).toBeUndefined();
      expect(carried.nextFireAt).toBe(first + MINUTE);

      await tickB(clock, engineB, shared);
      await drainEngine();
      const next = await stateOf(shared);
      expect(occurrencesOf(next)).toEqual([first, first + MINUTE]);
      expect(next.skippedOccurrences).toBeUndefined();
      expect(next.nextFireAt).toBe(first + 2 * MINUTE);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('drops the skip when the tick has more of a catch-up to go', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { clock, shared, b, engineA, engineB } = await openEngines({
        overlap: 'queue',
        backfill: true,
      });
      await engineA.triggerSchedule(SCHEDULE_ID);
      await drainEngine();
      const { nextFireAt } = await stateOf(shared);
      const first = nextFireAt!;
      const hold = b.holdScheduleWrite();
      // Three occurrences are overdue; the write that queues the first is parked.
      const ticking = tickB(clock, engineB, shared, 2 * MINUTE);
      await hold.reached;
      await engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
      const skipped = await stateOf(shared);
      expect(skipped.skippedOccurrences).toEqual([first]);
      hold.release();
      await ticking;
      await drainEngine();

      // The first was queued before the skip was seen, so the skip, which named it, is dropped
      // and the later occurrences of the catch-up are not skipped.
      const state = await stateOf(shared);
      expect(occurrencesOf(state)).toEqual([first, first + MINUTE, first + 2 * MINUTE]);
      expect(state.skippedOccurrences).toBeUndefined();
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.nextFireAt).toBe(first + 3 * MINUTE);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('a resumed backfill whose drain loses to a run another engine records', () => {
  it('goes on with the slot the other engine filled, and starts the queued run once', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { shared, engineA, engineB, first, tickingA, draining } =
        await parkResumedSectionDrain();
      const parked = await stateOf(shared);
      const queuedFirst = parked.queuedRuns[0]!;
      expect(queuedFirst.occurrence).toBe(first);

      // A run now starts the run queued first and queues its own behind it, while A's drain waits.
      const runNow = await engineB.triggerSchedule(SCHEDULE_ID);
      expect(runNow.outcome).toBe('queued');
      draining.release();
      await tickingA;
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.currentWorkflowId).toBe(queuedFirst.workflowId);
      expect(state.queuedRuns.map((run) => run.manual === true || run.occurrence)).toEqual([
        true,
        first + MINUTE,
        first + 2 * MINUTE,
      ]);
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.nextFireAt).toBe(first + 3 * MINUTE);
      expect(await listRunningWorkflowIds(engineA)).toEqual([queuedFirst.workflowId]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('a tick that finds a catch-up fired through the last occurrence due', () => {
  it('moves the cadence past it and starts no run', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { clock, shared, engineB } = await openEngines({ backfill: true, overlap: 'allow' });
      const state = await stateOf(shared);
      const first = state.nextFireAt!;
      // The engine committed the second occurrence's run (`lastFireAt`) and stopped before the
      // section that moves `nextFireAt` past it, so `lastFireAt` is past `nextFireAt` and the first
      // timer is still armed. A clock that reads earlier than the engine's has nothing else due.
      await shared.put(
        KEYS.schedule(SCHEDULE_ID),
        encode({ ...state, lastFireAt: first + MINUTE }),
      );
      clock.now = first + MINUTE + 1000;
      await engineB.scheduler.tick(clock.now);
      await drainEngine();

      const after = await stateOf(shared);
      expect(after.status).toBe('active');
      expect(after.lastFireAt).toBe(first + MINUTE);
      expect(after.nextFireAt).toBe(first + 2 * MINUTE);
      expect(await nextTimerArmed(shared)).toBe(true);
      expect(await shared.get(KEYS.scheduleTick(first, SCHEDULE_ID))).toBeNull();
      expect(await listRunningWorkflowIds(engineB)).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('a tick whose schedule write the store refuses', () => {
  it('reports the refused write with the schedule it belongs to, and leaves the schedule active', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { clock, shared, a, engineA } = await openEngines({ overlap: 'allow' });
      const before = await stateOf(shared);
      a.failScheduleWrites();
      // Late enough that the tick only counts what it missed, which is a plain write of the state.
      clock.now = before.nextFireAt! + 10 * MINUTE;
      await engineA.scheduler.tick(clock.now);
      await drainEngine();

      const reported = errors.mock.calls
        .map(([, error]) => error as unknown)
        .filter((error) => error instanceof ScheduleStatePersistenceError);
      expect(reported).toHaveLength(1);
      const [failure] = reported;
      expect(failure!.scheduleId).toBe(SCHEDULE_ID);
      expect(failure!.message).toBe(
        `Failed to persist schedule "${SCHEDULE_ID}" while processing its timer`,
      );
      expect((failure!.cause as Error).message).toBe('simulated schedule write failure');
      // Pausing would be one more write the store refuses: the tick does not try.
      const after = await stateOf(shared);
      expect(after.status).toBe('active');
      expect(after.revision).toBe(before.revision);
      expect(after.nextFireAt).toBe(before.nextFireAt);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the skipped occurrences a tick carries from a write it lost to (COR-2018)', () => {
  const HOUR = 60 * MINUTE;
  const base: ScheduleState = {
    id: 'hourly',
    workflowType: 'report',
    input: null,
    status: 'active',
    overlap: 'skip',
    backfill: false,
    intervalMs: HOUR,
    timeZone: 'UTC',
    revisionPolicy: 'active-at-fire',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    nextFireAt: HOUR,
    missedFireCount: 0,
    skippedCount: 0,
    queuedRuns: [],
    skippedOccurrences: [HOUR, 3 * HOUR],
  };
  // The tick fired nothing at 1:00 (it was skipped), so it spent that skip and moved on to 2:00.
  const ours: ScheduleState = { ...base, nextFireAt: 2 * HOUR, skippedOccurrences: [3 * HOUR] };

  it('keeps what the tick spent spent, and applies what the other writer added and took back', () => {
    // Meanwhile a person took 3:00 back and skipped 4:00.
    const theirs: ScheduleState = { ...base, skippedOccurrences: [HOUR, 4 * HOUR] };

    expect(carryConcurrentRecords(ours, base, theirs).skippedOccurrences).toEqual([4 * HOUR]);
  });

  it('drops a skip the other writer added for an occurrence the tick has already moved past', () => {
    const theirs: ScheduleState = { ...base, skippedOccurrences: [HOUR, 3 * HOUR, HOUR / 2] };

    expect(carryConcurrentRecords(ours, base, theirs).skippedOccurrences).toEqual([3 * HOUR]);
  });

  it('carries no field when nothing is left skipped', () => {
    const theirs: ScheduleState = { ...base, skippedOccurrences: [HOUR] };

    expect('skippedOccurrences' in carryConcurrentRecords(ours, base, theirs)).toBe(false);
  });
});
