import { MemoryStorage, type BatchOperation, type Storage } from "../../embedded/storage/src/index.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import type { Engine } from '../engine.ts';
import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import {
  createEngine,
  MINUTE,
  registerWorkflow,
  START,
  tickEngine,
  type Clock,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

// A schedule keeps a row for each occurrence it missed, so a person can read the history of what
// did not run (COR-1829). Every test here drives the engine's injected clock; nothing waits.
//
// COR-1820's review found that a backfilled tick writes what it missed with its first run, before
// the schedule's `nextFireAt` moves, so a crash between that write and the last one replayed the
// same miss and counted it twice (COR-1829). A write that fails here stands for that crash.

const LOS_ANGELES = 'America/Los_Angeles';

function at(iso: string): number {
  return Date.parse(iso);
}

/**
 * A storage whose Nth write of the schedule's own key (counted from `after`) rejects, and so does
 * every schedule write after it until `recover()`: the process is gone, so the pause its failure
 * handler would write never lands either.
 */
function failingScheduleWrites(shared: Storage, scheduleId: string) {
  let remaining: number | undefined;
  let crashed = false;
  // A tick's write of the schedule, as opposed to the clearing of a finished run's slot, which
  // deletes the run's metadata in the same batch.
  const putsSchedule = (operations: readonly BatchOperation[]) =>
    operations.some(
      (operation) => operation.type === 'put' && operation.key === KEYS.schedule(scheduleId),
    ) && !operations.some((operation) => operation.type === 'delete');
  const storage = new Proxy(shared, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function' || typeof property !== 'string') return member;
      return (...args: unknown[]) => {
        if (property === 'batch' || property === 'conditionalBatch') {
          const operations = (property === 'batch' ? args[0] : args[1]) as BatchOperation[];
          if (crashed && putsSchedule(operations)) {
            return Promise.reject(new Error('simulated crash'));
          }
          if (remaining !== undefined && putsSchedule(operations)) {
            remaining -= 1;
            if (remaining < 0) {
              remaining = undefined;
              crashed = true;
              return Promise.reject(new Error('simulated crash'));
            }
          }
        }
        return (member as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    storage,
    /** The schedule write after the next `writes` ones fails. */
    failAfter(writes: number): void {
      remaining = writes;
    },
    /** The process is back: schedule writes land again. */
    recover(): void {
      crashed = false;
    },
  };
}

describe('a schedule that misses occurrences', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  function openEngine(start: number, storage?: Storage): { engine: Engine; clock: Clock } {
    const clock: Clock = { now: start };
    const opened = createEngine(clock, storage);
    engine = opened;
    registerWorkflow(opened, 'report', async function* () {
      return 'done';
    });
    return { engine: opened, clock };
  }

  it('records one row for a late miss', async () => {
    const opened = openEngine(at('2026-03-05T20:00:00.000Z'));
    const handle = await opened.engine.schedule('report', null, '0 9 * * *', { id: 'late' });
    const described = await handle.describe();
    const dueAt = described.nextFireAt!;

    await tickEngine(opened.engine, opened.clock, dueAt + 10 * MINUTE);

    expect(await opened.engine.listScheduleMissedFires('late')).toEqual([
      {
        scheduleId: 'late',
        occurrence: dueAt,
        reason: 'late',
        count: 1,
        recordedAt: dueAt + 10 * MINUTE,
      },
    ]);
  });

  it('records one row for a dst-gap miss, at the instant the gap ends', async () => {
    const opened = openEngine(at('2026-03-07T11:00:00.000Z'));
    await opened.engine.schedule('report', null, '30 2 * * *', {
      id: 'daily',
      timeZone: LOS_ANGELES,
    });

    await tickEngine(opened.engine, opened.clock, at('2026-03-08T10:00:00.000Z'));

    expect(await opened.engine.listScheduleMissedFires('daily')).toEqual([
      {
        scheduleId: 'daily',
        occurrence: at('2026-03-08T10:00:00.000Z'),
        reason: 'dst-gap',
        count: 1,
        recordedAt: at('2026-03-08T10:00:00.000Z'),
      },
    ]);
  });

  it('keeps a late miss and a dst-gap miss of one instant as two rows', async () => {
    const opened = openEngine(at('2026-03-06T20:00:00.000Z'));
    await opened.engine.schedule('report', null, '30 2 * * *', {
      id: 'both',
      timeZone: LOS_ANGELES,
    });

    await tickEngine(opened.engine, opened.clock, at('2026-03-09T18:00:00.000Z'));

    const rows = await opened.engine.listScheduleMissedFires('both');
    expect(rows?.map((row) => [row.reason, row.occurrence, row.count])).toEqual([
      ['late', at('2026-03-09T09:30:00.000Z'), 1],
      ['dst-gap', at('2026-03-08T10:00:00.000Z'), 1],
      ['late', at('2026-03-07T10:30:00.000Z'), 1],
    ]);
  });

  it('keeps 100 rows, the 101st evicting the oldest, and counts every miss', async () => {
    const opened = openEngine(START);
    await opened.engine.schedule('report', null, { every: '1m' }, { id: 'minutely' });

    // Down for 100 minutes: the occurrences at minutes 1 through 100 are all missed.
    await tickEngine(opened.engine, opened.clock, START + 100 * MINUTE);
    let rows = await opened.engine.listScheduleMissedFires('minutely');
    expect(rows).toHaveLength(100);
    expect(rows?.at(-1)?.occurrence).toBe(START + MINUTE);

    // Down again until minute 111: eleven more, so the eleven oldest go.
    await tickEngine(opened.engine, opened.clock, START + 111 * MINUTE);
    rows = await opened.engine.listScheduleMissedFires('minutely');
    expect(rows).toHaveLength(100);
    expect(rows?.[0]?.occurrence).toBe(START + 111 * MINUTE);
    expect(rows?.at(-1)?.occurrence).toBe(START + 12 * MINUTE);
    const counted = await opened.engine.getSchedule('minutely');
    expect(counted?.missedFireCount).toBe(111);
  });

  it('keeps only the newest 100 of a single window longer than that', async () => {
    const opened = openEngine(START);
    await opened.engine.schedule('report', null, { every: '1m' }, { id: 'minutely' });

    await tickEngine(opened.engine, opened.clock, START + 150 * MINUTE);

    const rows = await opened.engine.listScheduleMissedFires('minutely', { limit: 1000 });
    expect(rows).toHaveLength(100);
    expect(rows?.[0]?.occurrence).toBe(START + 150 * MINUTE);
    expect(rows?.at(-1)?.occurrence).toBe(START + 51 * MINUTE);
    const counted = await opened.engine.getSchedule('minutely');
    expect(counted?.missedFireCount).toBe(150);
  });

  it('limits a read to the newest rows asked for', async () => {
    const opened = openEngine(START);
    await opened.engine.schedule('report', null, { every: '1m' }, { id: 'minutely' });
    await tickEngine(opened.engine, opened.clock, START + 10 * MINUTE);

    const rows = await opened.engine.listScheduleMissedFires('minutely', { limit: 3 });

    expect(rows?.map((row) => row.occurrence)).toEqual([
      START + 10 * MINUTE,
      START + 9 * MINUTE,
      START + 8 * MINUTE,
    ]);
  });

  it('skips a stored row it cannot read', async () => {
    const shared = new MemoryStorage();
    const opened = openEngine(START, shared);
    await opened.engine.schedule('report', null, { every: '1m' }, { id: 'minutely' });
    await tickEngine(opened.engine, opened.clock, START + 2 * MINUTE);
    const unreadable: unknown[] = [
      'not a record',
      { occurrence: 'soon', reason: 'late', count: 1, recordedAt: 1 },
      { occurrence: 1, reason: 'sleepy', count: 1, recordedAt: 1 },
    ];
    for (const [index, value] of unreadable.entries()) {
      await shared.put(KEYS.scheduleMissed('minutely', index + 1, 'late'), encode(value));
    }
    await shared.put(KEYS.scheduleMissed('minutely', 9, 'late'), new Uint8Array([0xc1]));

    const rows = await opened.engine.listScheduleMissedFires('minutely');

    expect(rows?.map((row) => row.occurrence)).toEqual([START + 2 * MINUTE, START + MINUTE]);
  });

  it('refuses a limit that is not a positive integer', async () => {
    const opened = openEngine(START);
    await opened.engine.schedule('report', null, { every: '1m' }, { id: 'quiet' });

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const failure = await opened.engine.listScheduleMissedFires('quiet', { limit }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain('options.limit must be a positive integer');
    }
  });

  it('reads no rows for a schedule that missed nothing, and null for one that does not exist', async () => {
    const opened = openEngine(START);
    await opened.engine.schedule('report', null, { every: '1m' }, { id: 'quiet' });

    expect(await opened.engine.listScheduleMissedFires('quiet')).toEqual([]);
    expect(await opened.engine.listScheduleMissedFires('nope')).toBeNull();
  });

  it('keeps the rows of one schedule apart from another, and across a restart', async () => {
    const shared = new MemoryStorage();
    const first = openEngine(START, shared);
    await first.engine.schedule('report', null, { every: '1m' }, { id: 'one' });
    await first.engine.schedule('report', null, { every: '1m' }, { id: 'one-more' });
    await tickEngine(first.engine, first.clock, START + 3 * MINUTE);
    first.engine[Symbol.dispose]();

    const second = openEngine(START + 3 * MINUTE, shared);
    const rows = await second.engine.listScheduleMissedFires('one');
    expect(rows?.map((row) => row.occurrence)).toEqual([
      START + 3 * MINUTE,
      START + 2 * MINUTE,
      START + MINUTE,
    ]);
    expect(rows?.every((row) => row.scheduleId === 'one')).toBe(true);
  });
});

describe('a tick replayed after a crash mid-backfill', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('counts a dst-gap miss once', async () => {
    const clock: Clock = { now: at('2026-03-08T09:30:00.000Z') };
    const shared = new MemoryStorage();
    const faulty = failingScheduleWrites(shared, 'hourly');
    const opened = createEngine(clock, faulty.storage);
    engine = opened;
    registerWorkflow(opened, 'report', async function* () {
      return 'done';
    });
    const missed: ScheduleMissedFireEvent[] = [];
    opened.addEventListener(ScheduleMissedFireEvent.type, (event) => {
      missed.push(event);
    });
    const failure = spyOn(console, 'error').mockImplementation(() => {});
    await opened.schedule('report', null, '0 * * * *', {
      id: 'hourly',
      timeZone: LOS_ANGELES,
      backfill: true,
    });

    // Down until 12:00Z: the 10:00Z, 11:00Z and 12:00Z occurrences are due, and the first of them
    // is where the clock leaves the hour it skipped.
    clock.now = at('2026-03-08T12:00:00.000Z');
    faulty.failAfter(1);
    await opened.scheduler.tick(clock.now).catch(() => undefined);
    const afterCrash = decodeScheduleState((await shared.get(KEYS.schedule('hourly')))!)!;
    expect(afterCrash.missedFireCount).toBe(1);
    expect(afterCrash.nextFireAt).toBe(at('2026-03-08T10:00:00.000Z'));

    expect(failure).toHaveBeenCalledTimes(1);
    failure.mockRestore();
    faulty.recover();
    await opened.scheduler.tick(clock.now);

    const summary = await opened.getSchedule('hourly');
    expect(summary?.missedFireCount).toBe(1);
    expect(missed.map((event) => [event.reason, event.missedCount])).toEqual([['dst-gap', 1]]);
    const rows = await opened.listScheduleMissedFires('hourly');
    expect(rows?.map((row) => [row.reason, row.count])).toEqual([['dst-gap', 1]]);
  });
});
