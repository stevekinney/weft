/**
 * COR-1925: a tick that commits part of an occurrence and then faults pauses the schedule from what
 * it committed, not from what it read before. The pause is built from the section's latest state
 * and conditioned on the bytes the schedule key last held for it, so the two must advance together:
 * a pause from an older state under newer bytes writes over the records in between.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import {
  closeOpenedEngines,
  openEngines,
  SCHEDULE_ID,
  stateOf,
} from './schedule-across-engines.test-support.ts';
import { drainEngine, listRunningWorkflowIds, START } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

const QUEUED = 'queued-before-the-update';

describe('a tick whose own start faults after it started the queued run ahead of it', () => {
  for (const overlap of ['allow', 'cancel-running'] as const) {
    it(`${overlap}: pauses without the queued run queued, and resumes without starting it again`, async () => {
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { clock, shared, a, engineA, engineB } = await openEngines({ overlap });
        const before = await stateOf(shared);
        // An update moved the policy off `queue` while a run was still queued behind a free slot.
        await shared.put(
          KEYS.schedule(SCHEDULE_ID),
          encode({ ...before, queuedRuns: [{ workflowId: QUEUED, queuedAt: START }] }),
        );
        const hold = a.holdScheduleWrite();
        clock.now = before.nextFireAt!;
        const ticking = engineA.scheduler.tick(clock.now);
        // The drain's batch is parked; the occurrence's own start is the one that faults.
        await hold.reached;
        a.failRunStarts();
        hold.release();
        await ticking;
        await drainEngine();

        const paused = await stateOf(shared);
        expect(paused.status).toBe('paused');
        expect(paused.queuedRuns).toEqual([]);
        if (overlap === 'allow') {
          expect(paused.currentWorkflowId).toBe(QUEUED);
          expect(await listRunningWorkflowIds(engineB)).toContain(QUEUED);
        }

        // Resuming and ticking starts the occurrence; the queued run is not started a second time.
        errors.mockClear();
        await engineB.resumeSchedule(SCHEDULE_ID);
        const resumedState = await stateOf(shared);
        clock.now = resumedState.nextFireAt!;
        await engineB.scheduler.tick(clock.now);
        await drainEngine();

        const resumed = await stateOf(shared);
        expect(resumed.status).toBe('active');
        expect(resumed.lastFireAt).toBe(clock.now);
        expect(errors).not.toHaveBeenCalled();
        if (overlap === 'allow') {
          const running = await listRunningWorkflowIds(engineB);
          expect(running.filter((id) => id === QUEUED)).toHaveLength(1);
        }
      } finally {
        errors.mockRestore();
      }
    });
  }
});

describe('a tick that decides an occurrence again after losing its start, and then faults', () => {
  it('pauses with what the other engine recorded in between, which the retry carried in', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { clock, shared, a, engineA, engineB } = await openEngines({ overlap: 'allow' });
      const before = await stateOf(shared);
      const hold = a.holdScheduleWrite();
      clock.now = before.nextFireAt!;
      const ticking = engineA.scheduler.tick(clock.now);
      await hold.reached;
      // Another engine records a skipped fire without moving the cadence, so the tick's start
      // loses its condition and decides the occurrence again with that carried in.
      await shared.put(
        KEYS.schedule(SCHEDULE_ID),
        encode({ ...before, skippedCount: 3, lastSkippedAt: START }),
      );
      a.failRunStarts();
      hold.release();
      await ticking;
      await drainEngine();

      const paused = await stateOf(shared);
      expect(paused.status).toBe('paused');
      expect(paused.skippedCount).toBe(3);
      expect(paused.lastSkippedAt).toBe(START);
      expect(paused.lastFireAt).toBeUndefined();
      expect(await listRunningWorkflowIds(engineB)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
