/**
 * COR-1902: every run a schedule fire starts carries the tag `origin:schedule`, whichever way the
 * fire reached the engine (a cadence tick, a backfilled occurrence, a queued run drained later, a
 * run now), and a run that is not a schedule's does not. The tag rides in the start options, so it
 * is written in the batch that commits the run with its schedule: a process that dies right after
 * that commit leaves the run tagged.
 */
import { BunSQLiteStorage } from "../../embedded/storage-bun-sqlite/src/index.ts";
import { afterEach, describe, expect, it } from 'bun:test';

import type { Engine } from '../engine.ts';
import { SCHEDULE_ID, stateOf } from './schedule-across-engines.test-support.ts';
import { SCHEDULE_ORIGIN_TAG } from './schedule-run.ts';
import {
  createEngine,
  drainEngine,
  listRunningWorkflowIds,
  MINUTE,
  registerWorkflow,
  releaseRunningWorkflows,
  requireNextFireAt,
  START,
  tickEngine,
} from './schedule.test-support.ts';

/** The ids of every run, settled or not, that carries `origin:schedule`, sorted. */
async function scheduleOriginRunIds(engine: Engine): Promise<string[]> {
  const result = await engine.list({ tags: [SCHEDULE_ORIGIN_TAG] });
  return result.items.map((item) => item.id).toSorted();
}

function openHeldEngine(clock: { now: number }) {
  const engine = createEngine(clock);
  registerWorkflow(engine, 'report', async function* (ctx) {
    yield* ctx.waitForSignal('release');
    return 'done';
  });
  return engine;
}

describe('the origin:schedule tag', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('is spelled the way Bureau spells a task origin', () => {
    expect(SCHEDULE_ORIGIN_TAG).toBe('origin:schedule');
  });

  it('is on a run a cadence tick started, and not on a run that is not a schedule’s', async () => {
    const clock = { now: START };
    const opened = openHeldEngine(clock);
    engine = opened;
    const handle = await opened.schedule('report', null, '* * * * *', { id: 'cadence' });
    const plain = await opened.start('report', null);
    await tickEngine(opened, clock, requireNextFireAt(await handle.describe()));

    const summary = await opened.getSchedule('cadence');
    const fired = summary?.currentWorkflowId;
    expect(fired).toBeDefined();
    expect(await scheduleOriginRunIds(opened)).toEqual([fired!]);
    expect(await listRunningWorkflowIds(opened)).toEqual([fired!, plain.id].toSorted());
  });

  it('is on every occurrence a backfill starts', async () => {
    const clock = { now: START };
    const opened = openHeldEngine(clock);
    engine = opened;
    const handle = await opened.schedule('report', null, '* * * * *', {
      id: 'backfilled',
      backfill: true,
      overlap: 'allow',
    });
    const first = requireNextFireAt(await handle.describe());

    // Down for two cadences: the tick starts each missed occurrence.
    await tickEngine(opened, clock, first + 2 * MINUTE);

    const running = await listRunningWorkflowIds(opened);
    expect(running.length).toBeGreaterThanOrEqual(2);
    expect(await scheduleOriginRunIds(opened)).toEqual(running);
  });

  it('is on a queued run the end of its predecessor drains later', async () => {
    const clock = { now: START };
    const opened = openHeldEngine(clock);
    engine = opened;
    await opened.schedule('report', null, '0 9 * * *', { id: 'queued', overlap: 'queue' });
    const first = await opened.triggerSchedule('queued');
    await drainEngine();
    const second = await opened.triggerSchedule('queued');
    expect(first.outcome).toBe('started');
    expect(second.outcome).toBe('queued');
    const queuedId = second.outcome === 'queued' ? second.workflowId : '';

    // The queued run has no workflow yet, so it cannot carry the tag until it starts.
    expect(await scheduleOriginRunIds(opened)).toEqual([
      first.outcome === 'started' ? first.workflowId : '',
    ]);

    await opened.signal(first.outcome === 'started' ? first.workflowId : '', 'release');
    await drainEngine();
    await releaseRunningWorkflows(opened);

    expect(await scheduleOriginRunIds(opened)).toContain(queuedId);
    expect(await scheduleOriginRunIds(opened)).toHaveLength(2);
  });

  it('is in the launch options the services resolver sees, as it is when recovery rebuilds them', async () => {
    const clock = { now: START };
    const launches: unknown[] = [];
    const opened = createEngine(clock, undefined, {
      resolveWorkflowServices: (info) => {
        launches.push(info.launchOptions);
        return { status: 'available', services: {} };
      },
    });
    engine = opened;
    registerWorkflow(opened, 'report', async function* (ctx) {
      yield* ctx.waitForSignal('release');
      return 'done';
    });
    await opened.schedule('report', null, '0 9 * * *', { id: 'resolver' });

    const result = await opened.triggerSchedule('resolver');
    await drainEngine();

    expect(launches).toEqual([
      { id: result.outcome === 'started' ? result.workflowId : '', tags: [SCHEDULE_ORIGIN_TAG] },
    ]);
  });

  it('is on a run now', async () => {
    const clock = { now: START };
    const opened = openHeldEngine(clock);
    engine = opened;
    await opened.schedule('report', null, '0 9 * * *', { id: 'now', overlap: 'allow' });

    const result = await opened.triggerSchedule('now');
    await drainEngine();

    expect(result.outcome).toBe('started');
    expect(await scheduleOriginRunIds(opened)).toEqual([
      result.outcome === 'started' ? result.workflowId : '',
    ]);
  });

  it('survives a process that dies right after the tick committed', async () => {
    const clock = { now: START };
    const shared = new BunSQLiteStorage(':memory:');
    const reached = Promise.withResolvers<void>();
    const dying = createEngine(clock, shared, {
      resolveWorkflowServices: () => {
        reached.resolve();
        return new Promise(() => {});
      },
    });
    registerWorkflow(dying, 'across-workflow', async function* (ctx) {
      yield* ctx.waitForSignal('release');
      return 'done';
    });
    await dying.schedule('across-workflow', null, '* * * * *', { id: SCHEDULE_ID });
    const { nextFireAt } = await stateOf(shared);
    clock.now = nextFireAt!;
    void dying.scheduler.tick(clock.now);
    await reached.promise;
    const committed = await stateOf(shared);
    const runId = committed.currentWorkflowId!;
    dying[Symbol.dispose]();

    // A fresh engine on the same store lists the run by its tag without recovering anything.
    const reader = createEngine(clock, shared);
    engine = reader;
    expect(await scheduleOriginRunIds(reader)).toEqual([runId]);
  });
});
