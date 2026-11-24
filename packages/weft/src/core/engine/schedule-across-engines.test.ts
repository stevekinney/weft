/**
 * COR-1594: a schedule's writes hold across engines that share a store. Each case runs two engines
 * over one store, with engine A's (or B's) write to the schedule key parked between its read and
 * its write while the other engine commits. A write that is not conditioned on the bytes it read
 * lands on top of the other engine's change.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import type { Engine } from '../engine.ts';
import { getInternals } from './internals.ts';
import {
  closeOpenedEngines,
  openEngines,
  SCHEDULE_ID,
  stateOf,
  tickB,
} from './schedule-across-engines.test-support.ts';
import * as scheduleOccurrence from './schedule-occurrence.ts';
import { ScheduleStaleRevisionError } from './schedule-stale-revision-error.ts';
import { recoverOrphanedScheduleTimers } from './schedule-timer-recovery.ts';
import { drainEngine, tickEngine } from './schedule.test-support.ts';
import { createScheduleTimerId } from './state-utilities.ts';

afterEach(closeOpenedEngines);

type Transition = {
  readonly name: string;
  /** Changes the schedule before the race, so the transition has something to do. */
  readonly prepare?: (engine: Engine) => Promise<void>;
  readonly run: (engine: Engine, expectedRevision?: number) => Promise<void>;
};

const TRANSITIONS: readonly Transition[] = [
  {
    name: 'pause',
    run: (engine, expectedRevision) =>
      engine.pauseSchedule(SCHEDULE_ID, expectedRevision === undefined ? {} : { expectedRevision }),
  },
  {
    name: 'resume',
    prepare: (engine) => engine.pauseSchedule(SCHEDULE_ID),
    run: (engine, expectedRevision) =>
      engine.resumeSchedule(
        SCHEDULE_ID,
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
  },
  {
    name: 'cancel',
    run: (engine, expectedRevision) =>
      engine.cancelSchedule(
        SCHEDULE_ID,
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
  },
  {
    name: 'update',
    run: (engine, expectedRevision) =>
      engine.updateSchedule(
        SCHEDULE_ID,
        '*/5 * * * *',
        expectedRevision === undefined ? {} : { expectedRevision },
      ),
  },
];

describe('two engines naming the same expectedRevision', () => {
  for (const transition of TRANSITIONS) {
    it(`${transition.name}: exactly one wins and the other is stale`, async () => {
      const { shared, a, engineA, engineB } = await openEngines();
      await transition.prepare?.(engineA);
      const { revision: before } = await stateOf(shared);
      const hold = a.holdScheduleWrite();

      const loser = transition.run(engineA, before);
      const rejection = rejectionOf(loser);
      await hold.reached;
      await transition.run(engineB, before);
      hold.release();
      const error = await rejection;

      expect(error).toBeInstanceOf(ScheduleStaleRevisionError);
      expect(error).toMatchObject({ expectedRevision: before, currentRevision: before + 1 });
      const { revision: after } = await stateOf(shared);
      expect(after).toBe(before + 1);
    });
  }
});

describe('a transition with no expectedRevision', () => {
  it('update: applies on top of the change that landed first, as the later of two', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const first = engineA.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
    await hold.reached;
    await engineB.updateSchedule(SCHEDULE_ID, '*/10 * * * *');
    hold.release();
    await first;

    const state = await stateOf(shared);
    expect(state.revision).toBe(3);
    expect(state.cronExpression).toBe('*/5 * * * *');
  });

  it('pause: finds the schedule paused after the retry and changes nothing', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const first = engineA.pauseSchedule(SCHEDULE_ID);
    await hold.reached;
    await engineB.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await first;

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
  });
});

describe('a transition that read a schedule another engine has since changed', () => {
  for (const name of ['pause', 'cancel'] as const) {
    it(`${name}: removes no timer the other engine armed`, async () => {
      const { shared, a, engineA, engineB } = await openEngines();
      const hold = a.holdTimerRemoval();

      const stale = rejectionOf(
        name === 'pause'
          ? engineA.pauseSchedule(SCHEDULE_ID, { expectedRevision: 1 })
          : engineA.cancelSchedule(SCHEDULE_ID, { expectedRevision: 1 }),
      );
      await hold.reached;
      await engineB.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
      hold.release();

      expect(await stale).toBeInstanceOf(ScheduleStaleRevisionError);
      const state = await stateOf(shared);
      expect(state.status).toBe('active');
      expect(await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`)).not.toBeNull();
    });
  }
});

describe('a timer tick on one engine while another changes the schedule', () => {
  it('does not write the schedule back to active after a pause', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
    expect(await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`)).toBeNull();
  });

  it('does not write a missed fire back over a pause either', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const hold = b.holdScheduleWrite();

    // Ten minutes late: the occurrence is missed, and only the counts and the next fire are written.
    const ticking = tickB(clock, engineB, shared, 10 * 60_000);
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.missedFireCount).toBe(0);
  });

  it('does not write the end of a backfilled occurrence back over a pause', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines({ backfill: true });
    const first = b.holdScheduleWrite();

    // The one due occurrence starts a run and writes the schedule; the tick then waits for the
    // run's turn with the serialization released, and writes again when it comes back.
    const ticking = tickB(clock, engineB, shared);
    await first.reached;
    first.release();
    const second = b.holdScheduleWrite();
    await second.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    second.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
  });

  it('commits its write when the schedule changed only in bytes, not in revision', async () => {
    const { clock, shared, b, engineB } = await openEngines();
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const current = await stateOf(shared);
    await shared.put(
      KEYS.schedule(SCHEDULE_ID),
      encode({ ...current, updatedAt: current.updatedAt + 5 }),
    );
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('active');
    expect(state.lastFireAt).toBe(clock.now);
    expect(state.nextFireAt).toBeGreaterThan(clock.now);
  });

  it('still pauses a schedule that changed only in bytes while its failure was handled', async () => {
    const { clock, shared, b, engineB } = await openEngines();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      b.failRunStarts();
      const hold = b.holdScheduleWrite();

      const ticking = tickB(clock, engineB, shared);
      await hold.reached;
      const current = await stateOf(shared);
      await shared.put(
        KEYS.schedule(SCHEDULE_ID),
        encode({ ...current, updatedAt: current.updatedAt + 5 }),
      );
      hold.release();
      await ticking;
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.status).toBe('paused');
      expect(state.revision).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not pause over an update that landed while its failure was handled', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      b.failRunStarts();
      const hold = b.holdScheduleWrite();

      const ticking = tickB(clock, engineB, shared);
      await hold.reached;
      await engineA.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
      hold.release();
      await ticking;
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.status).toBe('active');
      expect(state.revision).toBe(2);
      expect(state.cronExpression).toBe('*/5 * * * *');
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('a timer tick that cannot make sense of a schedule', () => {
  it('leaves a schedule alone when the occurrence collector finds nothing due at its fire time', async () => {
    const { clock, shared, engineB } = await openEngines();
    const before = await stateOf(shared);
    const due = spyOn(scheduleOccurrence, 'collectDueScheduleTicks').mockImplementationOnce(
      () => [],
    );
    try {
      await tickB(clock, engineB, shared);
      await drainEngine();

      expect(await stateOf(shared)).toEqual(before);
      expect(due).toHaveBeenCalledTimes(1);
    } finally {
      due.mockRestore();
    }
  });

  it('pauses a schedule whose cadence stops advancing while it counts a missed fire', async () => {
    const { clock, shared, engineB } = await openEngines();
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const next = spyOn(scheduleOccurrence, 'getNextScheduleOccurrence').mockImplementationOnce(
      (_state, from) => from,
    );
    try {
      const ticking = tickB(clock, engineB, shared, 10 * 60_000);
      await ticking;
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.status).toBe('paused');
      expect(consoleError).toHaveBeenCalled();
    } finally {
      next.mockRestore();
      consoleError.mockRestore();
    }
  });
});

describe('a timer recovered on one engine while another changes the schedule', () => {
  it('does not write a schedule that was paused after the scan back to active', async () => {
    const { shared, b, engineA, engineB } = await openEngines();
    // The timer is lost, as a crash between a schedule write and its timer leaves it.
    const { nextFireAt } = await stateOf(shared);
    await shared.batch([
      { type: 'delete', key: `timer-idx:${createScheduleTimerId(SCHEDULE_ID)}` },
      { type: 'delete', key: KEYS.scheduleTick(nextFireAt!, SCHEDULE_ID) },
    ]);
    const hold = b.holdScheduleWrite();

    const recovering = recoverOrphanedScheduleTimers(getInternals(engineB));
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await recovering;

    const { status } = await stateOf(shared);
    expect(status).toBe('paused');
    expect(await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`)).toBeNull();
  });
});

describe('a run that ends on one engine while another changes the schedule', () => {
  it('clears the current run on top of a pause instead of undoing it', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const { nextFireAt } = await stateOf(shared);
    await tickEngine(engineB, clock, nextFireAt!);
    const { currentWorkflowId: runId } = await stateOf(shared);
    expect(runId).toBeDefined();
    const hold = b.holdScheduleWrite();

    const signalled = engineB.signal(runId!, 'release');
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await signalled;
    await drainEngine();
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.currentWorkflowId).toBeUndefined();
    expect(state.revision).toBe(2);
  });
});
