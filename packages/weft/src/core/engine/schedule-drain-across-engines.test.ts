/**
 * COR-1925: the two drains outside a tick's occurrence start the queued run under the read
 * condition a tick's start has, so an engine that changed the schedule while a drain was parked
 * is not overwritten, and a queued run another engine already started is not started again. A
 * drain's batch is parked while the other engine acts.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import {
  closeOpenedEngines,
  openEngines,
  parkResumedSectionDrain,
  SCHEDULE_ID,
  stateOf,
} from './schedule-across-engines.test-support.ts';
import { drainEngine, listRunningWorkflowIds, MINUTE } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

describe('the end of a run drains the queue while another engine changes the schedule', () => {
  it('keeps the skip the other engine recorded and starts the queued run once', async () => {
    const { shared, a, engineA, engineB } = await openEngines({ overlap: 'queue' });
    const current = await engineA.triggerSchedule(SCHEDULE_ID);
    const queued = await engineA.triggerSchedule(SCHEDULE_ID);
    if (current.outcome !== 'started' || queued.outcome !== 'queued') {
      throw new Error('The run now should start one run and queue the other.');
    }
    const hold = a.holdScheduleWrite();

    // The first run ends, and the terminal handler's drain of the queued run is parked.
    await engineA.signal(current.workflowId, 'release');
    await hold.reached;
    await engineB.skipNextScheduleOccurrence(SCHEDULE_ID);
    const skippedState = await stateOf(shared);
    const skipped = skippedState.skippedOccurrences?.[0];
    expect(skipped).toBeDefined();
    hold.release();
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.skippedOccurrences).toEqual([skipped!]);
    expect(state.currentWorkflowId).toBe(queued.workflowId);
    expect(state.queuedRuns).toEqual([]);
    expect(await listRunningWorkflowIds(engineB)).toEqual([queued.workflowId]);
  });
});

describe('a resumed backfill drains the queue while another engine changes the schedule', () => {
  it('keeps the skip the other engine recorded and starts the queued run once', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { shared, engineB, first, tickingA, draining } = await parkResumedSectionDrain();
      await engineB.skipNextScheduleOccurrence(SCHEDULE_ID);
      const skippedState = await stateOf(shared);
      expect(skippedState.skippedOccurrences).toEqual([first + MINUTE]);
      draining.release();
      await tickingA;
      await drainEngine();

      const state = await stateOf(shared);
      // The skip landed while the drain was parked: the drain was decided again with it carried in,
      // so the second occurrence was skipped, the third queued, and the queued run started once.
      expect(state.status).toBe('active');
      expect(state.lastFireAt).toBe(first + 2 * MINUTE);
      expect(state.skippedOccurrences).toBeUndefined();
      expect(state.skippedCount).toBe(0);
      expect(state.queuedRuns.map((run) => run.occurrence)).toEqual([first + 2 * MINUTE]);
      expect(await listRunningWorkflowIds(engineB)).toEqual([state.currentWorkflowId!]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
