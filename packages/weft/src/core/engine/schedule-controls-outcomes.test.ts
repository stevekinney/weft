/**
 * COR-1829 review, round 1: what skipping the next run and running a schedule now do in every
 * state a schedule can be in when the person asks. Skip next skips exactly one fire that would
 * have started a run, wherever the cadence stands; run now answers with its own run, never with a
 * run it dequeued on the way. Every test drives the engine's injected clock; nothing waits.
 */
import { MemoryStorage, type Storage } from "../../embedded/storage/src/index.ts";
import { afterEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { ScheduleOverlapPolicy, ScheduleState } from '../types.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import { engineStorage } from './schedule-across-engines.test-support.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import {
  drainEngine,
  listRunningWorkflowIds,
  MINUTE,
  registerWorkflow,
  releaseRunningWorkflows,
  START,
  tickEngine,
  type Clock,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

const HOUR = 60 * MINUTE;

function at(iso: string): number {
  return Date.parse(iso);
}

type Opened = { engine: Engine; clock: Clock; storage: Storage; runs: number[] };

const opened: Opened[] = [];

afterEach(() => {
  for (const { engine } of opened.splice(0)) engine[Symbol.dispose]();
});

/**
 * An engine over a fresh store whose `report` workflow records when it began. A run whose input
 * is `'hold'` waits for the `release` signal, so it stays the schedule's current run.
 */
function open(start: number, storage: Storage = new MemoryStorage()): Opened {
  const clock: Clock = { now: start };
  const runs: number[] = [];
  const engine = new Engine({ storage, getNow: () => clock.now });
  registerWorkflow(engine, 'report', async function* (ctx, input: unknown) {
    runs.push(clock.now);
    if (input === 'hold') yield* ctx.waitForSignal('release');
    return 'done';
  });
  const result = { engine, clock, storage, runs };
  opened.push(result);
  return result;
}

async function stored(storage: Storage, id: string): Promise<ScheduleState> {
  const bytes = await storage.get(KEYS.schedule(id));
  const state = bytes === null ? null : decodeScheduleState(bytes);
  if (state === null) throw new Error(`Schedule "${id}" is missing`);
  return state;
}

async function fieldOf<K extends keyof ScheduleState>(
  storage: Storage,
  id: string,
  key: K,
): Promise<ScheduleState[K]> {
  const state = await stored(storage, id);
  return state[key];
}

describe('skipping the next run, wherever the cadence stands', () => {
  it('skips the next fire when it is still ahead, and runs the one after it', async () => {
    const { engine, clock, storage, runs } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    await engine.skipNextScheduleOccurrence('daily');
    const skipped = await stored(storage, 'daily');
    expect(skipped.skippedOccurrences).toEqual([at('2026-01-01T09:00:00.000Z')]);
    expect(skipped.nextFireAt).toBe(at('2026-01-01T09:00:00.000Z'));

    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-02T09:00:00.000Z'));

    expect(runs).toEqual([at('2026-01-02T09:00:00.000Z')]);
    expect(await fieldOf(storage, 'daily', 'missedFireCount')).toBe(0);
    expect(await engine.listScheduleMissedFires('daily')).toEqual([]);
  });

  for (const [name, skipAt] of [
    ['before the nominal time', at('2026-01-01T08:00:00.000Z')],
    ['between the nominal time and the jittered fire', at('2026-01-01T09:00:01.000Z')],
  ] as const) {
    it(`skips the jittered fire that is due but has not started a run, asked ${name}`, async () => {
      const { engine, clock, storage, runs } = open(at('2026-01-01T00:00:00.000Z'));
      await engine.schedule('report', null, '0 9 * * *', { id: 'daily', jitter: '1h' });
      const effective = (iso: string) =>
        resolveEffectiveScheduleFireAt({ id: 'daily', jitterMs: HOUR }, at(iso));
      const firstFire = effective('2026-01-01T09:00:00.000Z');
      expect(firstFire).toBeGreaterThan(skipAt);

      clock.now = skipAt;
      await engine.skipNextScheduleOccurrence('daily');
      const skipped = await stored(storage, 'daily');
      expect(skipped.nextFireAt).toBe(at('2026-01-01T09:00:00.000Z'));
      expect(skipped.skippedOccurrences).toEqual([at('2026-01-01T09:00:00.000Z')]);

      for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
        await tickEngine(engine, clock, effective(`${day}T09:00:00.000Z`));
      }

      expect(runs).toEqual([
        effective('2026-01-02T09:00:00.000Z'),
        effective('2026-01-03T09:00:00.000Z'),
      ]);
      expect(await fieldOf(storage, 'daily', 'missedFireCount')).toBe(0);
      expect(await engine.listScheduleMissedFires('daily')).toEqual([]);
    });
  }

  it('skips the fire that is due inside the poll window and has not started a run', async () => {
    const { engine, clock, storage, runs } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    clock.now = at('2026-01-01T09:00:00.500Z');
    await engine.skipNextScheduleOccurrence('daily');
    expect(await fieldOf(storage, 'daily', 'nextFireAt')).toBe(at('2026-01-01T09:00:00.000Z'));

    await tickEngine(engine, clock, at('2026-01-01T09:00:00.500Z'));
    await tickEngine(engine, clock, at('2026-01-02T09:00:00.000Z'));

    expect(runs).toEqual([at('2026-01-02T09:00:00.000Z')]);
    expect(await fieldOf(storage, 'daily', 'missedFireCount')).toBe(0);
  });

  it('skips the first fire after now when the overdue ones will be counted missed', async () => {
    const { engine, clock, storage, runs } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    // The engine was not ticking: two days are overdue, and the next tick counts them missed.
    clock.now = at('2026-01-03T08:00:00.000Z');
    await engine.skipNextScheduleOccurrence('daily');
    expect(await fieldOf(storage, 'daily', 'skippedOccurrences')).toEqual([
      at('2026-01-03T09:00:00.000Z'),
    ]);

    await tickEngine(engine, clock, at('2026-01-03T08:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-03T09:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-04T09:00:00.000Z'));

    expect(runs).toEqual([at('2026-01-04T09:00:00.000Z')]);
    expect(await fieldOf(storage, 'daily', 'missedFireCount')).toBe(2);
  });

  it('does not count a fire it skipped as missed when the tick that reaches it is late', async () => {
    const { engine, clock, storage, runs } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.skipNextScheduleOccurrence('daily');

    // The tick that reaches the skipped fire comes a day and a half late.
    await tickEngine(engine, clock, at('2026-01-02T20:00:00.000Z'));

    const state = await stored(storage, 'daily');
    expect(state.missedFireCount).toBe(1);
    expect(state.skippedOccurrences).toBeUndefined();
    const rows = await engine.listScheduleMissedFires('daily');
    expect(rows?.map((row) => row.occurrence)).toEqual([at('2026-01-02T09:00:00.000Z')]);
    expect(runs).toEqual([]);
  });

  it('skips the next backfilled fire when asked while a catch-up run is going, and runs the rest', async () => {
    const { engine, clock, storage, runs } = open(START);
    const handle = await engine.schedule('report', null, '* * * * *', {
      id: 'backfill',
      backfill: true,
      overlap: 'skip',
    });
    const described = await handle.describe();
    const first = described.nextFireAt!;
    // Asked as the first catch-up run starts: the skip waits for the tick's section to end, and
    // lands while the tick waits for that run, before it starts the next occurrence.
    let skipping: Promise<void> | undefined;
    engine.addEventListener('schedule:fired', () => {
      skipping ??= engine.skipNextScheduleOccurrence('backfill');
    });

    // Three occurrences are overdue.
    clock.now = first + 2 * MINUTE;
    await engine.scheduler.tick(clock.now);
    await drainEngine();
    await skipping;

    expect(runs).toEqual([first + 2 * MINUTE, first + 2 * MINUTE]);
    const afterCatchUp = await stored(storage, 'backfill');
    expect(afterCatchUp.lastFireAt).toBe(first + 2 * MINUTE);
    expect(afterCatchUp.nextFireAt).toBe(first + 3 * MINUTE);
    expect(afterCatchUp.skippedOccurrences).toBeUndefined();
    expect(afterCatchUp.skippedCount).toBe(0);

    for (const minute of [3, 4, 5]) {
      await tickEngine(engine, clock, first + minute * MINUTE);
    }
    expect(runs).toHaveLength(5);
    const end = await stored(storage, 'backfill');
    expect(end.lastFireAt).toBe(first + 5 * MINUTE);
    expect(end.missedFireCount).toBe(0);
  });

  it('leaves the revision alone, so a backfill tick it lands in keeps going', async () => {
    const { engine, storage } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const before = await stored(storage, 'daily');

    await engine.skipNextScheduleOccurrence('daily');

    expect(await fieldOf(storage, 'daily', 'revision')).toBe(before.revision);
  });
});

type RunNowCase = {
  readonly slot: 'idle' | 'running' | 'finished, not yet cleared' | 'an earlier run-now queued';
  readonly overlap: Extract<ScheduleOverlapPolicy, 'skip' | 'queue' | 'allow'>;
  readonly outcome: 'started' | 'queued' | 'skipped';
};

const RUN_NOW_CASES: readonly RunNowCase[] = [
  { slot: 'idle', overlap: 'skip', outcome: 'started' },
  { slot: 'idle', overlap: 'queue', outcome: 'started' },
  { slot: 'idle', overlap: 'allow', outcome: 'started' },
  { slot: 'running', overlap: 'skip', outcome: 'skipped' },
  { slot: 'running', overlap: 'queue', outcome: 'queued' },
  { slot: 'running', overlap: 'allow', outcome: 'started' },
  { slot: 'finished, not yet cleared', overlap: 'skip', outcome: 'started' },
  { slot: 'finished, not yet cleared', overlap: 'queue', outcome: 'started' },
  { slot: 'finished, not yet cleared', overlap: 'allow', outcome: 'started' },
  // The run queued ahead starts first and takes the slot; the new one meets it.
  { slot: 'an earlier run-now queued', overlap: 'skip', outcome: 'skipped' },
  { slot: 'an earlier run-now queued', overlap: 'queue', outcome: 'queued' },
  { slot: 'an earlier run-now queued', overlap: 'allow', outcome: 'started' },
];

const EARLIER = 'earlier-manual-run';

/** Puts the schedule in `slot`: what its current run is, and what waits behind it. */
async function arrange(
  { engine, storage }: Opened,
  slot: RunNowCase['slot'],
): Promise<string | undefined> {
  if (slot === 'idle') return undefined;
  const run = await engine.start('report', slot === 'running' ? 'hold' : null);
  if (slot !== 'running') await run.result();
  await drainEngine();
  const state = await stored(storage, 'daily');
  await storage.put(
    KEYS.schedule('daily'),
    encode({
      ...state,
      currentWorkflowId: run.id,
      queuedRuns:
        slot === 'an earlier run-now queued'
          ? [{ workflowId: EARLIER, queuedAt: state.createdAt, manual: true }]
          : [],
    }),
  );
  return run.id;
}

describe('running a schedule now answers with its own run', () => {
  for (const { slot, overlap, outcome } of RUN_NOW_CASES) {
    it(`${overlap}, ${slot}: ${outcome}`, async () => {
      const harness = open(at('2026-01-01T00:00:00.000Z'));
      const { engine, storage } = harness;
      await engine.schedule('report', 'hold', '0 9 * * *', { id: 'daily', overlap });
      const current = await arrange(harness, slot);
      const runningBefore = await listRunningWorkflowIds(engine);

      const result = await engine.triggerSchedule('daily');
      await drainEngine();

      expect(result.outcome).toBe(outcome);
      const after = await stored(storage, 'daily');
      if (result.outcome === 'skipped') {
        expect(result.blockingWorkflowId).toBe(after.currentWorkflowId);
        expect(after.skippedCount).toBe(1);
      } else {
        expect([current, EARLIER]).not.toContain(result.workflowId);
      }
      if (result.outcome === 'queued') {
        expect(after.queuedRuns.at(-1)).toMatchObject({
          workflowId: result.workflowId,
          manual: true,
        });
        expect(after.queuedRuns).toHaveLength(1);
      }
      if (result.outcome === 'started') {
        expect(await engine.getScheduleProvenance(result.workflowId)).toEqual({
          scheduleId: 'daily',
          manual: true,
        });
        if (overlap !== 'allow') expect(after.currentWorkflowId).toBe(result.workflowId);
      }
      if (slot === 'an earlier run-now queued') {
        expect(after.currentWorkflowId).toBe(EARLIER);
        expect(after.queuedRuns.map((run) => run.workflowId)).not.toContain(EARLIER);
      }
      if (slot === 'running') {
        expect(await listRunningWorkflowIds(engine)).toEqual(
          outcome === 'started' && result.outcome === 'started'
            ? [...runningBefore, result.workflowId].toSorted()
            : runningBefore,
        );
      }
      await releaseRunningWorkflows(engine);
      await releaseRunningWorkflows(engine);
    });
  }
});

describe('running a paused schedule now under the queue policy', () => {
  it('starts the run it queued when the run ahead of it ends, though the cadence is paused', async () => {
    const harness = open(at('2026-01-01T00:00:00.000Z'));
    const { engine, storage } = harness;
    await engine.schedule('report', 'hold', '0 9 * * *', { id: 'daily', overlap: 'queue' });
    await engine.pauseSchedule('daily');

    const first = await engine.triggerSchedule('daily');
    await drainEngine();
    const second = await engine.triggerSchedule('daily');
    expect(first.outcome).toBe('started');
    expect(second.outcome).toBe('queued');

    if (first.outcome === 'started') await engine.signal(first.workflowId, 'release');
    await drainEngine();

    const state = await stored(storage, 'daily');
    expect(state.status).toBe('paused');
    expect(state.queuedRuns).toEqual([]);
    expect(state.currentWorkflowId).toBe(second.outcome === 'queued' ? second.workflowId : '');
    expect(await listRunningWorkflowIds(engine)).toEqual([state.currentWorkflowId!]);
    await releaseRunningWorkflows(engine);
  });
});

describe('running a schedule now under cancel-running', () => {
  it('cancels the run that holds the slot and starts its own in its place', async () => {
    const { engine, storage } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', 'hold', '0 9 * * *', {
      id: 'daily',
      overlap: 'cancel-running',
    });
    const first = await engine.triggerSchedule('daily');
    await drainEngine();

    const second = await engine.triggerSchedule('daily');
    await drainEngine();

    expect(first.outcome).toBe('started');
    expect(second.outcome).toBe('started');
    const replaced = first.outcome === 'started' ? first.workflowId : '';
    const own = second.outcome === 'started' ? second.workflowId : '';
    expect(own).not.toBe(replaced);
    expect(await fieldOf(storage, 'daily', 'currentWorkflowId')).toBe(own);
    expect(await listRunningWorkflowIds(engine)).toEqual([own]);
    await releaseRunningWorkflows(engine);
  });
});

describe('running a schedule now when storage refuses it', () => {
  it('rejects with the fault when its run cannot start, and records nothing', async () => {
    const faulty = engineStorage(new MemoryStorage());
    const { engine, storage } = open(at('2026-01-01T00:00:00.000Z'), faulty.storage);
    await engine.schedule('report', 'hold', '0 9 * * *', { id: 'daily', overlap: 'skip' });
    const before = await stored(storage, 'daily');
    faulty.failRunStarts();

    const failure = await engine.triggerSchedule('daily').catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: 'simulated schedule start failure' });
    expect(await stored(storage, 'daily')).toEqual(before);
  });

  it('rejects with the fault when its queued run cannot be written', async () => {
    const faulty = engineStorage(new MemoryStorage());
    const { engine, storage } = open(at('2026-01-01T00:00:00.000Z'), faulty.storage);
    await engine.schedule('report', 'hold', '0 9 * * *', { id: 'daily', overlap: 'queue' });
    await engine.triggerSchedule('daily');
    await drainEngine();
    const before = await stored(storage, 'daily');
    faulty.failScheduleWrites();

    const failure = await engine.triggerSchedule('daily').catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: 'simulated schedule write failure' });
    expect(await stored(storage, 'daily')).toEqual(before);
    await releaseRunningWorkflows(engine);
  });

  it('rejects when the run queued ahead already exists and the schedule has not moved', async () => {
    const { engine, storage } = open(at('2026-01-01T00:00:00.000Z'));
    await engine.schedule('report', 'hold', '0 9 * * *', { id: 'daily', overlap: 'queue' });
    const existing = await engine.start('report', 'hold');
    await drainEngine();
    const state = await stored(storage, 'daily');
    await storage.put(
      KEYS.schedule('daily'),
      encode({
        ...state,
        queuedRuns: [{ workflowId: existing.id, queuedAt: state.createdAt, manual: true }],
      }),
    );

    const failure = await engine.triggerSchedule('daily').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowAlreadyExistsError);
    await releaseRunningWorkflows(engine);
  });
});
