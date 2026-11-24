/**
 * COR-1829: skipping a run, taking a skip back and running a schedule now hold across engines that share a
 * store, as the other writes to a schedule do (COR-1594). Engine A's write to the schedule key is
 * parked between its read and its write while engine B commits a change.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { BunSQLiteStorage } from "../../embedded/storage-bun-sqlite/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { DEFAULT_POLL_INTERVAL_MS } from '../types/constants.ts';
import {
  closeOpenedEngines,
  engineStorage,
  nextTimerArmed,
  openEngines,
  SCHEDULE_ID,
  stateOf,
  tickB,
} from './schedule-across-engines.test-support.ts';
import { ScheduleOccurrenceNotNextError } from './schedule-occurrence-not-next-error.ts';
import {
  drainEngine,
  listRunningWorkflowIds,
  MINUTE,
  registerWorkflow,
  START,
} from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

describe('skipping the next run while another engine changes the schedule', () => {
  it('reads the schedule again and is refused when the other engine cancelled it', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const skipped = engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    const rejection = rejectionOf(skipped);
    await hold.reached;
    await engineB.cancelSchedule(SCHEDULE_ID);
    hold.release();

    const failure = await rejection;
    expect((failure as Error).message).toContain('has no next occurrence to skip');
    const state = await stateOf(shared);
    expect(state.status).toBe('cancelled');
    expect(state.skippedOccurrences).toBeUndefined();
  });

  it('reads the schedule again and skips on it when the other engine paused it', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const skipped = engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    await hold.reached;
    await engineB.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await skipped;

    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.skippedOccurrences).toEqual([state.nextFireAt!]);
  });

  it('applies to the schedule as the other engine left it when the revision was not named', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const skipped = engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    await hold.reached;
    await engineB.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
    hold.release();
    await skipped;

    const state = await stateOf(shared);
    expect(state.cronExpression).toBe('*/5 * * * *');
    expect(state.skippedOccurrences).toEqual([state.nextFireAt!]);
    // The update's change; a skip is bookkeeping and leaves the revision alone.
    expect(state.revision).toBe(2);
  });
});

describe('skipping a named occurrence while another engine fires it', () => {
  it('reads the schedule again and refuses the occurrence the other engine has fired, writing no skip', async () => {
    const { clock, shared, a, engineA, engineB } = await openEngines();
    const { nextFireAt } = await stateOf(shared);
    const occurrence = nextFireAt!;
    const hold = a.holdScheduleWrite();

    const skipped = engineA.skipNextScheduleOccurrence(SCHEDULE_ID, { occurrence });
    const rejection = rejectionOf(skipped);
    await hold.reached;
    await tickB(clock, engineB, shared);
    await drainEngine();
    hold.release();

    const failure = await rejection;
    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    expect((failure as ScheduleOccurrenceNotNextError).nextOccurrence).toBe(occurrence + MINUTE);
    const state = await stateOf(shared);
    expect(state.lastFireAt).toBe(occurrence);
    expect(state.skippedOccurrences).toBeUndefined();
  });
});

describe('running a schedule now while another engine changes the schedule', () => {
  it('records the run it started on the schedule as the other engine left it', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await engineB.pauseSchedule(SCHEDULE_ID);
    hold.release();
    const result = await triggered;
    await drainEngine();

    expect(result.outcome).toBe('started');
    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
    expect(state.currentWorkflowId).toBe(result.outcome === 'started' ? result.workflowId : '');
  });
});

/** Engine A runs the schedule once, so a run that waits for its signal holds the slot. */
async function occupySlot(opened: Awaited<ReturnType<typeof openEngines>>): Promise<string> {
  const first = await opened.engineA.triggerSchedule(SCHEDULE_ID);
  await drainEngine();
  if (first.outcome !== 'started') throw new Error('The first run did not start.');
  return first.workflowId;
}

describe('running a schedule now while another engine fires it (trigger parked, tick commits)', () => {
  it('skip: decides again from the run the tick started, and starts no second run', async () => {
    const opened = await openEngines();
    const { clock, shared, a, engineA, engineB } = opened;
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await tickB(clock, engineB, shared);
    await drainEngine();
    const byB = await stateOf(shared);
    hold.release();
    const result = await triggered;
    await drainEngine();

    expect(byB.currentWorkflowId).toBeDefined();
    expect(result).toEqual({ outcome: 'skipped', blockingWorkflowId: byB.currentWorkflowId! });
    expect(await listRunningWorkflowIds(engineA)).toEqual([byB.currentWorkflowId!]);
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(byB.currentWorkflowId);
    expect(state.skippedCount).toBe(1);
    expect(state.nextFireAt).toBe(byB.nextFireAt);
  });

  it('queue: keeps the occurrence the tick queued and queues its own run after it', async () => {
    const opened = await openEngines();
    const { clock, shared, a, engineA, engineB } = opened;
    await engineA.updateSchedule(SCHEDULE_ID, '* * * * *', { overlap: 'queue' });
    const running = await occupySlot(opened);
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await tickB(clock, engineB, shared);
    const byB = await stateOf(shared);
    hold.release();
    const result = await triggered;

    expect(byB.queuedRuns).toHaveLength(1);
    expect(result.outcome).toBe('queued');
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(running);
    expect(state.queuedRuns.map((run) => run.workflowId)).toEqual([
      byB.queuedRuns[0]!.workflowId,
      result.outcome === 'queued' ? result.workflowId : '',
    ]);
    expect(state.nextFireAt).toBe(byB.nextFireAt);
  });
});

describe('a timer tick while another engine runs the schedule now (tick parked, trigger commits)', () => {
  it('queue: keeps the run the trigger queued and adds its own occurrence after it', async () => {
    const opened = await openEngines();
    const { clock, shared, b, engineA, engineB } = opened;
    await engineA.updateSchedule(SCHEDULE_ID, '* * * * *', { overlap: 'queue' });
    const running = await occupySlot(opened);
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const result = await engineA.triggerSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    expect(result.outcome).toBe('queued');
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(running);
    expect(state.queuedRuns).toHaveLength(2);
    expect(state.queuedRuns[0]).toMatchObject({
      workflowId: result.outcome === 'queued' ? result.workflowId : '',
      manual: true,
    });
    expect(state.queuedRuns[1]).toMatchObject({ occurrence: before.nextFireAt! });
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });

  it('skip: counts both skips when a run holds the slot', async () => {
    const opened = await openEngines();
    const { clock, shared, b, engineA, engineB } = opened;
    const running = await occupySlot(opened);
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const result = await engineA.triggerSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    expect(result).toEqual({ outcome: 'skipped', blockingWorkflowId: running });
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(running);
    expect(state.skippedCount).toBe(2);
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });

  it('skip: never writes over the run the trigger recorded, and still moves the cadence on', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    // The tick has started its run and is about to record it.
    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const result = await engineA.triggerSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    expect(result.outcome).toBe('started');
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(result.outcome === 'started' ? result.workflowId : '');
    expect(state.lastFireAt).toBe(before.nextFireAt!);
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });
});

describe('a timer tick while another engine clears the run it replaced', () => {
  it('keeps the run the tick started when the other engine only cleared the slot', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    // The schedule still names a run that has finished: the tick clears it and starts its own.
    const finished = await engineA.start('across-workflow', null);
    await engineA.signal(finished.id, 'release');
    await finished.result();
    const before = await stateOf(shared);
    await shared.put(
      KEYS.schedule(SCHEDULE_ID),
      encode({ ...before, currentWorkflowId: finished.id }),
    );
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    // The other engine's terminal handler clears the finished run.
    const { currentWorkflowId: _cleared, ...cleared } = await stateOf(shared);
    await shared.put(
      KEYS.schedule(SCHEDULE_ID),
      encode({ ...cleared, updatedAt: cleared.updatedAt + 1 }),
    );
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    const running = await listRunningWorkflowIds(engineA);
    expect(running).toHaveLength(1);
    expect(state.currentWorkflowId).toBe(running[0]);
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });
});

describe('skipping the next run while another engine fires it (tick parked, skip commits)', () => {
  it('starts no run for the occurrence the skip named, because the tick commits its run with the schedule (COR-1925)', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const before = await stateOf(shared);
    const first = before.nextFireAt!;
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    await engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    const skipped = await stateOf(shared);
    expect(skipped.skippedOccurrences).toEqual([first]);
    hold.release();
    await ticking;
    await drainEngine();

    // The tick's run was not started yet, so the skip landed first and the tick read it again.
    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toEqual([]);
    expect(state.currentWorkflowId).toBeUndefined();
    expect(state.lastFireAt).toBeUndefined();
    expect(state.nextFireAt).toBe(first + MINUTE);
    expect(state.skippedOccurrences).toBeUndefined();
  });
});

describe('skipping the next run while another engine catches up (backfill write parked)', () => {
  it('moves the skip past the occurrence the tick just started, and the tick honors it', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines({
      backfill: true,
      overlap: 'allow',
    });
    const initial = await stateOf(shared);
    const first = initial.nextFireAt!;
    const hold = b.holdScheduleWrite();

    // Three occurrences are overdue; the tick's write after the first run is parked.
    const ticking = tickB(clock, engineB, shared, 2 * MINUTE);
    await hold.reached;
    await engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.lastFireAt).toBe(first + 2 * MINUTE);
    expect(state.nextFireAt).toBe(first + 3 * MINUTE);
    expect(state.skippedOccurrences).toBeUndefined();
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(2);
  });
});

describe('skipping the next run while another engine counts missed fires (late write parked)', () => {
  it('keeps a skip the late tick has not reached', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const initial = await stateOf(shared);
    const first = initial.nextFireAt!;
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared, 3 * MINUTE);
    await hold.reached;
    await engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    hold.release();
    await ticking;

    const state = await stateOf(shared);
    expect(state.missedFireCount).toBe(4);
    expect(state.nextFireAt).toBe(first + 4 * MINUTE);
    expect(state.skippedOccurrences).toEqual([first + 4 * MINUTE]);
  });
});

describe('an interval update that keeps the interval while another engine ticks its occurrence', () => {
  it('keeps the timer the update armed for the occurrence the parked tick stood aside from', async () => {
    const { clock, shared, a, engineA, engineB } = await openEngines();
    await engineA.updateSchedule(SCHEDULE_ID, { every: '5m' });
    const before = await stateOf(shared);
    const occurrence = before.nextFireAt!;
    const hold = a.holdScheduleWrite();

    // Engine A's tick has read the schedule for the occurrence and is about to start it.
    clock.now = occurrence;
    const ticking = engineA.scheduler.tick(clock.now);
    await hold.reached;
    // Engine B's update keeps the interval, so it keeps the anchor and the occurrence, and arms
    // the timer again under the key the tick is about to delete.
    await engineB.updateSchedule(SCHEDULE_ID, { every: '5m' }, { description: 'renamed' });
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.nextFireAt).toBe(occurrence);
    expect(state.lastFireAt).toBeUndefined();
    // Without the timer nothing would fire the occurrence until an engine booted.
    expect(await nextTimerArmed(shared)).toBe(true);
    expect(await shared.get(KEYS.scheduleTick(occurrence, SCHEDULE_ID))).not.toBeNull();

    // The entry the tick kept is delivered again, and that delivery starts the occurrence once and
    // lets the timer go: keeping it does not park the schedule.
    await engineA.scheduler.tick(clock.now);
    await drainEngine();
    const fired = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(1);
    expect(fired.lastFireAt).toBe(occurrence);
    expect(fired.nextFireAt).toBe(occurrence + 5 * MINUTE);
    expect(await shared.get(KEYS.scheduleTick(occurrence, SCHEDULE_ID))).toBeNull();
    expect(await nextTimerArmed(shared)).toBe(true);
  });

  it('starts the occurrence once and drops its timer when nothing else touched the schedule', async () => {
    const { clock, shared, engineA } = await openEngines();
    await engineA.updateSchedule(SCHEDULE_ID, { every: '5m' });
    const armed = await stateOf(shared);
    const occurrence = armed.nextFireAt!;

    clock.now = occurrence;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(1);
    expect(state.lastFireAt).toBe(occurrence);
    expect(state.nextFireAt).toBe(occurrence + 5 * MINUTE);
    expect(await shared.get(KEYS.scheduleTick(occurrence, SCHEDULE_ID))).toBeNull();
    expect(await nextTimerArmed(shared)).toBe(true);
  });
});

describe('a retained schedule timer delivered again after a tick stood aside from it (COR-1998)', () => {
  const EVERY_FIVE_MINUTES = { every: '5m' } as const;
  // One poll interval and a second: how late a tick may reach an occurrence and still run it.
  const LATE_LIMIT = DEFAULT_POLL_INTERVAL_MS + 1000;

  /**
   * Engine A ticks `occurrence + lateBy` and is parked at its write; engine B's update keeps the
   * interval and the occurrence, so A's write loses and A keeps the timer it fired.
   */
  async function standAside(
    opened: Awaited<ReturnType<typeof openEngines>>,
    occurrence: number,
    lateBy: number,
  ): Promise<void> {
    const { clock, a, engineA, engineB } = opened;
    const hold = a.holdScheduleWrite();
    clock.now = occurrence + lateBy;
    const ticking = engineA.scheduler.tick(clock.now);
    await hold.reached;
    await engineB.updateSchedule(SCHEDULE_ID, EVERY_FIVE_MINUTES, { description: 'renamed' });
    hold.release();
    await ticking;
    await drainEngine();
  }

  async function armedOccurrence(opened: Awaited<ReturnType<typeof openEngines>>): Promise<number> {
    await opened.engineA.updateSchedule(SCHEDULE_ID, EVERY_FIVE_MINUTES);
    const { nextFireAt } = await stateOf(opened.shared);
    return nextFireAt!;
  }

  it('runs the occurrence when the delivery is a poll interval after the tick that stood aside, though that is past the limit counted from the occurrence', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA } = opened;
    const occurrence = await armedOccurrence(opened);
    const firstLateBy = 1500;
    expect(firstLateBy + DEFAULT_POLL_INTERVAL_MS).toBeGreaterThan(LATE_LIMIT);

    await standAside(opened, occurrence, firstLateBy);
    const stoodAside = await stateOf(shared);
    expect(stoodAside.lastFireAt).toBeUndefined();
    clock.now += DEFAULT_POLL_INTERVAL_MS;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(1);
    expect(state.lastFireAt).toBe(occurrence);
    expect(state.missedFireCount).toBe(0);
    expect(state.lastMissedFireAt).toBeUndefined();
    expect(state.nextFireAt).toBe(occurrence + 5 * MINUTE);
    expect(await shared.get(KEYS.scheduleTick(occurrence, SCHEDULE_ID))).toBeNull();
  });

  it('keeps counting from the latest delivery that stood aside when it stands aside again', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA } = opened;
    const occurrence = await armedOccurrence(opened);

    await standAside(opened, occurrence, 1500);
    await standAside(opened, occurrence, 1500 + DEFAULT_POLL_INTERVAL_MS);
    clock.now += DEFAULT_POLL_INTERVAL_MS;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(1);
    expect(state.lastFireAt).toBe(occurrence);
    expect(state.missedFireCount).toBe(0);
  });

  it('records the occurrence missed when the delivery comes more than the limit after the tick that stood aside (the engine was down)', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA } = opened;
    const occurrence = await armedOccurrence(opened);

    await standAside(opened, occurrence, 1500);
    clock.now += LATE_LIMIT + 1;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(0);
    expect(state.lastFireAt).toBeUndefined();
    expect(state.missedFireCount).toBe(1);
    expect(state.lastMissedFireAt).toBe(occurrence);
  });

  it('records the occurrence missed when the first tick to reach it is already past the limit', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA } = opened;
    const occurrence = await armedOccurrence(opened);

    clock.now = occurrence + LATE_LIMIT + 1;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(0);
    expect(state.missedFireCount).toBe(1);
    expect(state.lastMissedFireAt).toBe(occurrence);
  });

  it('counts a tick that stood aside already past the limit as late when the delivery comes', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA } = opened;
    const occurrence = await armedOccurrence(opened);

    await standAside(opened, occurrence, LATE_LIMIT + 1);
    clock.now += DEFAULT_POLL_INTERVAL_MS;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(0);
    expect(state.lastFireAt).toBeUndefined();
    expect(state.missedFireCount).toBe(1);
    expect(state.lastMissedFireAt).toBe(occurrence);
  });

  it('documents that the other engine, which has not delivered the timer before, counts from the occurrence (the sighting is memory only)', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA, engineB } = opened;
    const occurrence = await armedOccurrence(opened);

    await standAside(opened, occurrence, 1500);
    clock.now += DEFAULT_POLL_INTERVAL_MS;
    await engineB.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(0);
    expect(state.missedFireCount).toBe(1);
    expect(state.lastMissedFireAt).toBe(occurrence);
  });

  it('starts the occurrence of a backfilling schedule however long after the delivery that stood aside', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA } = opened;
    await engineA.updateSchedule(SCHEDULE_ID, EVERY_FIVE_MINUTES, { backfill: true });
    const { nextFireAt } = await stateOf(shared);
    const occurrence = nextFireAt!;

    await standAside(opened, occurrence, 1500);
    clock.now += 2 * MINUTE;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(1);
    expect(state.lastFireAt).toBe(occurrence);
    expect(state.missedFireCount).toBe(0);
  });

  it('leaves a schedule the other engine paused alone when the timer comes again', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA, engineB } = opened;
    const occurrence = await armedOccurrence(opened);

    await standAside(opened, occurrence, 1500);
    await engineB.pauseSchedule(SCHEDULE_ID);
    clock.now += DEFAULT_POLL_INTERVAL_MS;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    const state = await stateOf(shared);
    expect(await listRunningWorkflowIds(engineA)).toHaveLength(0);
    expect(state.status).toBe('paused');
    expect(state.missedFireCount).toBe(0);
    expect(await shared.get(KEYS.scheduleTick(occurrence, SCHEDULE_ID))).toBeNull();
  });

  it('leaves a schedule the other engine cancelled alone when the timer comes again', async () => {
    const opened = await openEngines();
    const { clock, shared, engineA, engineB } = opened;
    const occurrence = await armedOccurrence(opened);

    await standAside(opened, occurrence, 1500);
    await engineB.cancelSchedule(SCHEDULE_ID);
    clock.now += DEFAULT_POLL_INTERVAL_MS;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();

    expect(await listRunningWorkflowIds(engineA)).toHaveLength(0);
    const state = await stateOf(shared);
    expect(state.status).toBe('cancelled');
    expect(state.missedFireCount).toBe(0);
    expect(await shared.get(KEYS.scheduleTick(occurrence, SCHEDULE_ID))).toBeNull();
  });

  it('scales the limit with the poll interval of two engines under a workflow lease', async () => {
    const pollIntervalMs = 5000;
    const clock = { now: START };
    const shared = new BunSQLiteStorage(':memory:');
    const a = engineStorage(shared);
    const b = engineStorage(shared);
    const create = (storage: ReturnType<typeof engineStorage>['storage']) =>
      Engine.create({
        recover: false,
        storage,
        getNow: () => clock.now,
        schedulerPollIntervalMs: pollIntervalMs,
        ownership: 'workflow-lease',
        backgroundTasks: 'manual',
        resolveWorkflowServices: async () => ({ status: 'available', services: {} }),
      });
    const engineA = await create(a.storage);
    const engineB = await create(b.storage);
    try {
      for (const engine of [engineA, engineB]) {
        registerWorkflow(engine, 'across-workflow', async function* (ctx) {
          yield* ctx.waitForSignal('release');
          return 'done';
        });
      }
      await engineA.schedule('across-workflow', null, EVERY_FIVE_MINUTES, { id: SCHEDULE_ID });
      const { nextFireAt } = await stateOf(shared);
      const occurrence = nextFireAt!;
      const hold = a.holdScheduleWrite();
      // Past one poll interval from the occurrence by the time the timer comes again, but on time
      // for each tick counted from the one before.
      clock.now = occurrence + pollIntervalMs - 2000;
      const ticking = engineA.scheduler.tick(clock.now);
      await hold.reached;
      await engineB.updateSchedule(SCHEDULE_ID, EVERY_FIVE_MINUTES, { description: 'renamed' });
      hold.release();
      await ticking;
      await drainEngine();
      clock.now += pollIntervalMs;
      expect(clock.now - occurrence).toBeGreaterThan(pollIntervalMs + 1000);
      await engineA.scheduler.tick(clock.now);
      await drainEngine();

      const state = await stateOf(shared);
      expect(state.lastFireAt).toBe(occurrence);
      expect(state.missedFireCount).toBe(0);
    } finally {
      engineA[Symbol.dispose]();
      engineB[Symbol.dispose]();
    }
  });
});
