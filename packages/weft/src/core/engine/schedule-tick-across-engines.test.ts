/**
 * COR-1925: a schedule tick commits the run it starts together with the schedule that names it,
 * under its read condition, as a run now does (COR-1829). Two engines that share a store and tick
 * one schedule start one run between them, and the loser leaves no task admission (a services
 * resolution) and no `schedule:fired` event for a run that never starts. Engine A's start batch is
 * parked while engine B commits its own.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { ScheduleFiredEvent } from '../events.ts';
import {
  closeOpenedEngines,
  openEngines,
  SCHEDULE_ID,
  stateOf,
  tickB,
} from './schedule-across-engines.test-support.ts';
import { drainEngine, listRunningWorkflowIds, MINUTE } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

/** The workflow ids of the `schedule:fired` events an engine dispatched. */
function recordFired(engine: { addEventListener: EventTarget['addEventListener'] }): string[] {
  const fired: string[] = [];
  engine.addEventListener('schedule:fired', (event) => {
    if (event instanceof ScheduleFiredEvent) fired.push(event.workflowId);
  });
  return fired;
}

/** The workflow ids that have `schedule-run` metadata, which only a started scheduled run writes. */
async function scheduledRunIds(shared: {
  scan(prefix: string): AsyncIterable<[string, Uint8Array]>;
}): Promise<string[]> {
  const ids: string[] = [];
  const prefix = KEYS.scheduleRun('');
  for await (const [key] of shared.scan(prefix)) ids.push(key.slice(prefix.length));
  return ids.toSorted();
}

describe('two engines tick one schedule', () => {
  for (const overlap of ['skip', 'allow', 'queue', 'cancel-running'] as const) {
    it(`${overlap}: start exactly one run, and the loser records no admission and no audit`, async () => {
      const { clock, shared, a, engineA, engineB, resolved } = await openEngines({ overlap });
      const firedByA = recordFired(engineA);
      const firedByB = recordFired(engineB);
      const hold = a.holdScheduleWrite();
      const { nextFireAt } = await stateOf(shared);

      // Engine A has decided to start the occurrence and is about to commit it.
      clock.now = nextFireAt!;
      const tickingA = engineA.scheduler.tick(clock.now);
      await hold.reached;
      // Engine B ticks the same occurrence to the end.
      await tickB(clock, engineB, shared);
      await drainEngine();
      hold.release();
      await tickingA;
      await drainEngine();

      const running = await listRunningWorkflowIds(engineB);
      expect(running).toHaveLength(1);
      expect(await scheduledRunIds(shared)).toEqual(running);
      const state = await stateOf(shared);
      if (overlap !== 'allow') expect(state.currentWorkflowId).toBe(running[0]);
      expect(state.lastFireAt).toBe(nextFireAt!);
      expect(state.nextFireAt).toBe(nextFireAt! + MINUTE);
      expect(resolved.b).toEqual(running);
      expect(resolved.a).toEqual([]);
      expect(firedByB).toEqual(running);
      expect(firedByA).toEqual([]);
    });
  }

  it('lets the engine whose batch commits first win, whichever engine it is', async () => {
    const { clock, shared, b, engineA, engineB, resolved } = await openEngines();
    const hold = b.holdScheduleWrite();
    const { nextFireAt } = await stateOf(shared);

    clock.now = nextFireAt!;
    const tickingB = engineB.scheduler.tick(clock.now);
    await hold.reached;
    await engineA.scheduler.tick(clock.now);
    await drainEngine();
    hold.release();
    await tickingB;
    await drainEngine();

    const running = await listRunningWorkflowIds(engineA);
    expect(running).toHaveLength(1);
    expect(resolved.a).toEqual(running);
    expect(resolved.b).toEqual([]);
    const final = await stateOf(shared);
    expect(final.nextFireAt).toBe(nextFireAt! + MINUTE);
  });

  it('backfill: the engine that loses the first occurrence starts none of the others', async () => {
    const { clock, shared, a, engineA, engineB, resolved } = await openEngines({
      backfill: true,
      overlap: 'allow',
    });
    const hold = a.holdScheduleWrite();
    const { nextFireAt } = await stateOf(shared);

    clock.now = nextFireAt! + 2 * MINUTE;
    const tickingA = engineA.scheduler.tick(clock.now);
    await hold.reached;
    await engineB.scheduler.tick(clock.now);
    await drainEngine();
    hold.release();
    await tickingA;
    await drainEngine();

    const running = await listRunningWorkflowIds(engineB);
    expect(running).toHaveLength(3);
    expect(await scheduledRunIds(shared)).toEqual(running);
    expect(resolved.a).toEqual([]);
    expect(resolved.b.toSorted()).toEqual(running);
    const final = await stateOf(shared);
    expect(final.lastFireAt).toBe(nextFireAt! + 2 * MINUTE);
  });
});

describe('two engines catch up one backfilled schedule', () => {
  it('the engine that joins after the first occurrence committed starts only the ones left', async () => {
    const { clock, shared, a, engineA, engineB, resolved } = await openEngines({
      backfill: true,
      overlap: 'allow',
    });
    const first = a.holdScheduleWrite();
    const { nextFireAt } = await stateOf(shared);

    clock.now = nextFireAt! + 2 * MINUTE;
    const tickingA = engineA.scheduler.tick(clock.now);
    await first.reached;
    // Armed in the same turn as the release, so it parks A's second occurrence and not B's.
    first.release();
    const second = a.holdScheduleWrite();
    await second.reached;
    const afterFirst = await stateOf(shared);
    expect(afterFirst.lastFireAt).toBe(nextFireAt!);
    // The first occurrence's timer is still the schedule's, as it is until the catch-up ends.
    expect(afterFirst.nextFireAt).toBe(nextFireAt);

    await engineB.scheduler.tick(clock.now);
    await drainEngine();
    second.release();
    await tickingA;
    await drainEngine();

    const running = await listRunningWorkflowIds(engineB);
    expect(running).toHaveLength(3);
    expect(await scheduledRunIds(shared)).toEqual(running);
    expect(resolved.a).toHaveLength(1);
    expect(resolved.b).toHaveLength(2);
    const final = await stateOf(shared);
    expect(final.lastFireAt).toBe(nextFireAt! + 2 * MINUTE);
    expect(final.nextFireAt).toBe(nextFireAt! + 3 * MINUTE);
  });
});

describe('running a schedule now while another engine ticks it', () => {
  it('records no admission for the run now that loses to the tick', async () => {
    const { clock, shared, a, engineA, engineB, resolved } = await openEngines();
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await tickB(clock, engineB, shared);
    await drainEngine();
    hold.release();
    const result = await triggered;
    await drainEngine();

    // The tick started a run, so the run now was skipped by the overlap policy and started none:
    // the only services resolved are the tick's.
    expect(result.outcome).toBe('skipped');
    const running = await listRunningWorkflowIds(engineA);
    expect(running).toHaveLength(1);
    expect(resolved.b).toEqual(running);
    expect(resolved.a).toEqual([]);
  });

  it('resolves services once, for the run now that commits after it lost its first batch', async () => {
    const { clock, shared, a, engineA, engineB, resolved } = await openEngines({
      overlap: 'allow',
    });
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await tickB(clock, engineB, shared);
    await drainEngine();
    hold.release();
    const result = await triggered;
    await drainEngine();

    // Both runs started, and the lost first batch resolved nothing: one resolution each.
    expect(result.outcome).toBe('started');
    const running = await listRunningWorkflowIds(engineA);
    expect(running).toHaveLength(2);
    expect(resolved.a).toEqual([result.outcome === 'started' ? result.workflowId : '']);
    expect(resolved.b).toHaveLength(1);
    expect(await scheduledRunIds(shared)).toEqual(running);
  });
});
