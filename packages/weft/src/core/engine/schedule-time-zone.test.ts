import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import type { Engine } from '../engine.ts';
import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import type { ScheduleSummary } from '../types.ts';
import {
  createEngine,
  registerWorkflow,
  requireNextFireAt,
  tickEngine,
  type Clock,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

// A schedule's wall-clock times are read in its time zone, and a daylight-saving transition
// moves them: the hour the clock skips is missed, and the hour it repeats runs once. Every test
// here drives the engine's injected clock across a 2026 transition; nothing waits.

const LOS_ANGELES = 'America/Los_Angeles';

function at(iso: string): number {
  return Date.parse(iso);
}

function isoOf(timestamp: number | null | undefined): string | null {
  return timestamp === null || timestamp === undefined ? null : new Date(timestamp).toISOString();
}

type Describable = { describe(): Promise<ScheduleSummary | null> };

/** One field of a schedule's current summary. */
async function fieldOf<K extends keyof ScheduleSummary>(
  handle: Describable,
  key: K,
): Promise<ScheduleSummary[K]> {
  const summary = await handle.describe();
  if (summary === null) throw new Error('Schedule no longer exists');
  return summary[key];
}

/** When the schedule is next due. */
async function nextFireOf(handle: Describable): Promise<number> {
  const summary = await handle.describe();
  if (summary === null) throw new Error('Schedule no longer exists');
  return requireNextFireAt(summary);
}

/** The time zone a stored schedule is read in. */
async function zoneOf(engine: Engine, scheduleId: string): Promise<string | undefined> {
  const summary = await engine.getSchedule(scheduleId);
  return summary?.timeZone;
}

function recordMissedFires(engine: Engine): ScheduleMissedFireEvent[] {
  const missed: ScheduleMissedFireEvent[] = [];
  engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
    missed.push(event);
  });
  return missed;
}

/** An engine whose clock starts at `start`, with a workflow that records when each run began. */
function openEngine(start: string): { engine: Engine; clock: Clock; runs: string[] } {
  const clock: Clock = { now: at(start) };
  const engine = createEngine(clock);
  const runs: string[] = [];
  registerWorkflow(engine, 'report', async function* () {
    runs.push(new Date(clock.now).toISOString());
    return 'done';
  });
  return { engine, clock, runs };
}

describe('schedule time zones', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('runs a schedule without a zone in UTC', async () => {
    const opened = openEngine('2026-03-07T00:00:00.000Z');
    engine = opened.engine;
    const handle = await engine.schedule('report', null, '0 9 * * *', { id: 'utc' });

    const summary = await handle.describe();
    expect(summary?.timeZone).toBe('UTC');
    expect(isoOf(summary?.nextFireAt)).toBe('2026-03-07T09:00:00.000Z');
  });

  it('fires a weekday 09:00 Los Angeles schedule at 09:00 local on both sides of spring-forward', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    const handle = await engine.schedule('report', null, '0 9 * * 1-5', {
      id: 'weekdays',
      timeZone: LOS_ANGELES,
    });
    expect(await fieldOf(handle, 'timeZone')).toBe(LOS_ANGELES);

    await tickEngine(engine, opened.clock, await nextFireOf(handle));
    await tickEngine(engine, opened.clock, await nextFireOf(handle));
    await tickEngine(engine, opened.clock, await nextFireOf(handle));

    expect(opened.runs).toEqual([
      '2026-03-06T17:00:00.000Z',
      '2026-03-09T16:00:00.000Z',
      '2026-03-10T16:00:00.000Z',
    ]);
  });

  it('fires a weekday 09:00 Los Angeles schedule at 09:00 local on both sides of fall-back', async () => {
    const opened = openEngine('2026-10-29T20:00:00.000Z');
    engine = opened.engine;
    const handle = await engine.schedule('report', null, '0 9 * * 1-5', {
      id: 'weekdays',
      timeZone: LOS_ANGELES,
    });

    await tickEngine(engine, opened.clock, await nextFireOf(handle));
    await tickEngine(engine, opened.clock, await nextFireOf(handle));
    await tickEngine(engine, opened.clock, await nextFireOf(handle));

    expect(opened.runs).toEqual([
      '2026-10-30T16:00:00.000Z',
      '2026-11-02T17:00:00.000Z',
      '2026-11-03T17:00:00.000Z',
    ]);
  });

  it('skips a daily 02:30 on spring-forward day and records it as a dst-gap miss', async () => {
    const opened = openEngine('2026-03-07T11:00:00.000Z');
    engine = opened.engine;
    const missed = recordMissedFires(engine);
    const handle = await engine.schedule('report', null, '30 2 * * *', {
      id: 'daily',
      timeZone: LOS_ANGELES,
    });
    // The schedule wakes where the clock passes the skipped time, so it can record the miss.
    expect(isoOf(await nextFireOf(handle))).toBe('2026-03-08T10:00:00.000Z');

    await tickEngine(engine, opened.clock, at('2026-03-08T10:00:00.000Z'));

    expect(opened.runs).toEqual([]);
    const afterGap = await handle.describe();
    expect(afterGap?.missedFireCount).toBe(1);
    expect(isoOf(afterGap?.lastMissedFireAt)).toBe('2026-03-08T10:00:00.000Z');
    expect(afterGap?.lastFireAt).toBeUndefined();
    expect(isoOf(afterGap?.nextFireAt)).toBe('2026-03-09T09:30:00.000Z');
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      scheduleId: 'daily',
      missedCount: 1,
      windowStart: at('2026-03-08T10:00:00.000Z'),
      windowEnd: at('2026-03-08T10:00:00.000Z'),
      reason: 'dst-gap',
    });

    await tickEngine(engine, opened.clock, at('2026-03-09T09:30:00.000Z'));
    expect(opened.runs).toEqual(['2026-03-09T09:30:00.000Z']);
    expect(await fieldOf(handle, 'missedFireCount')).toBe(1);
    expect(missed).toHaveLength(1);
  });

  it('fires an hourly Los Angeles schedule at the end of the gap and counts the hour it lost', async () => {
    const opened = openEngine('2026-03-08T09:30:00.000Z');
    engine = opened.engine;
    const missed = recordMissedFires(engine);
    const handle = await engine.schedule('report', null, '0 * * * *', {
      id: 'hourly',
      timeZone: LOS_ANGELES,
    });

    await tickEngine(engine, opened.clock, at('2026-03-08T10:00:00.000Z'));

    expect(opened.runs).toEqual(['2026-03-08T10:00:00.000Z']);
    const summary = await handle.describe();
    expect(summary?.missedFireCount).toBe(1);
    expect(isoOf(summary?.lastFireAt)).toBe('2026-03-08T10:00:00.000Z');
    expect(isoOf(summary?.nextFireAt)).toBe('2026-03-08T11:00:00.000Z');
    expect(missed.map((event) => event.reason)).toEqual(['dst-gap']);
  });

  it('fires a daily 01:30 on fall-back day once', async () => {
    const opened = openEngine('2026-10-31T12:00:00.000Z');
    engine = opened.engine;
    const missed = recordMissedFires(engine);
    const handle = await engine.schedule('report', null, '30 1 * * *', {
      id: 'daily',
      timeZone: LOS_ANGELES,
    });
    expect(isoOf(await nextFireOf(handle))).toBe('2026-11-01T08:30:00.000Z');

    await tickEngine(engine, opened.clock, at('2026-11-01T08:30:00.000Z'));
    const afterFirst = await handle.describe();
    expect(isoOf(afterFirst?.nextFireAt)).toBe('2026-11-02T09:30:00.000Z');

    // The clock passes the repeated 01:30 (09:30Z) and nothing starts.
    await tickEngine(engine, opened.clock, at('2026-11-01T09:30:00.000Z'));
    await tickEngine(engine, opened.clock, at('2026-11-02T09:30:00.000Z'));

    expect(opened.runs).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-02T09:30:00.000Z']);
    expect(await fieldOf(handle, 'missedFireCount')).toBe(0);
    expect(missed).toHaveLength(0);
  });

  it('keeps reporting a tick reached too late as late, not as a gap', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    const missed = recordMissedFires(engine);
    const handle = await engine.schedule('report', null, '0 9 * * *', {
      id: 'late',
      timeZone: LOS_ANGELES,
    });
    const dueAt = await nextFireOf(handle);

    await tickEngine(engine, opened.clock, dueAt + 10 * 60_000);

    expect(opened.runs).toEqual([]);
    expect(missed.map((event) => [event.reason, event.missedCount])).toEqual([['late', 1]]);
    expect(await fieldOf(handle, 'missedFireCount')).toBe(1);
  });

  it('records both the late fire and the gap when a late tick spans a spring-forward change', async () => {
    const opened = openEngine('2026-03-06T20:00:00.000Z');
    engine = opened.engine;
    const missed = recordMissedFires(engine);
    const handle = await engine.schedule('report', null, '30 2 * * *', {
      id: 'down-over-gap',
      timeZone: LOS_ANGELES,
    });

    // The engine was down from the first 02:30 PST (10:30Z on 3/7) until 3/9 18:00Z.
    await tickEngine(engine, opened.clock, at('2026-03-09T18:00:00.000Z'));

    expect(opened.runs).toEqual([]);
    expect(missed.map((event) => [event.reason, event.missedCount])).toEqual([
      ['late', 2],
      ['dst-gap', 1],
    ]);
    const summary = await handle.describe();
    expect(summary?.missedFireCount).toBe(3);
    expect(isoOf(summary?.lastMissedFireAt)).toBe('2026-03-09T09:30:00.000Z');
    expect(isoOf(summary?.nextFireAt)).toBe('2026-03-10T09:30:00.000Z');
  });

  it('rejects a zone the runtime does not know, on create and on update', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    for (const timeZone of ['Mars/Olympus', '']) {
      const created = await engine
        .schedule('report', null, '0 9 * * *', { id: 'bad', timeZone })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(created).toBeInstanceOf(Error);
      expect((created as Error).message).toContain(
        'options.timeZone must be a valid IANA time zone',
      );
    }
    expect(await engine.getSchedule('bad')).toBeNull();

    await engine.schedule('report', null, '0 9 * * *', { id: 'good', timeZone: LOS_ANGELES });
    const updated = await engine
      .updateSchedule('good', '0 9 * * *', { timeZone: 'Mars/Olympus' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(updated).toBeInstanceOf(Error);
    expect(await zoneOf(engine, 'good')).toBe(LOS_ANGELES);
  });

  it('stores the canonical spelling of a zone the runtime reads case-insensitively', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    await engine.schedule('report', null, '0 9 * * *', { id: 'lower', timeZone: 'utc' });
    await engine.schedule('report', null, '0 9 * * *', {
      id: 'mixed',
      timeZone: 'america/los_angeles',
    });
    expect(await zoneOf(engine, 'lower')).toBe('UTC');
    expect(await zoneOf(engine, 'mixed')).toBe(LOS_ANGELES);
  });

  it('refuses a zone on an interval schedule, which counts elapsed time', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    const created = await engine
      .schedule('report', null, { every: '1h' }, { id: 'interval', timeZone: LOS_ANGELES })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((created as Error).message).toContain(
      'options.timeZone applies only to a cron schedule',
    );
    await engine.schedule('report', null, { every: '1h' }, { id: 'plain' });
    expect(await zoneOf(engine, 'plain')).toBe('UTC');
  });

  it('accepts UTC, in any spelling, on an interval schedule so its reported zone round-trips', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    await engine.schedule('report', null, { every: '1h' }, { id: 'utc', timeZone: 'utc' });
    expect(await zoneOf(engine, 'utc')).toBe('UTC');
    await engine.updateSchedule('utc', { every: '2h' }, { timeZone: 'UTC' });
    expect(await zoneOf(engine, 'utc')).toBe('UTC');
  });

  it('keeps the zone through an update that omits it, and changes it when given', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    const handle = await engine.schedule('report', null, '0 9 * * *', {
      id: 'zoned',
      timeZone: LOS_ANGELES,
    });

    await engine.updateSchedule('zoned', '0 10 * * *');
    let summary = await handle.describe();
    expect(summary?.timeZone).toBe(LOS_ANGELES);
    expect(isoOf(summary?.nextFireAt)).toBe('2026-03-06T18:00:00.000Z');

    await engine.updateSchedule('zoned', '0 10 * * *', { timeZone: 'Asia/Tokyo' });
    summary = await handle.describe();
    expect(summary?.timeZone).toBe('Asia/Tokyo');
    expect(isoOf(summary?.nextFireAt)).toBe('2026-03-06T01:00:00.000Z');

    await engine.updateSchedule('zoned', { every: '1h' });
    expect(await fieldOf(handle, 'timeZone')).toBe('UTC');
  });

  it('computes the first occurrence of a definition-form schedule in its zone', async () => {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    const handle = await engine.schedule({
      workflow: 'report',
      cron: '0 9 * * *',
      input: null,
      timeZone: LOS_ANGELES,
    });
    expect(isoOf(await nextFireOf(handle))).toBe('2026-03-06T17:00:00.000Z');
  });
});

describe('a persisted schedule record and its time zone', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  async function persistedRecord(): Promise<Record<string, unknown>> {
    const opened = openEngine('2026-03-05T20:00:00.000Z');
    engine = opened.engine;
    await engine.schedule('report', null, '0 9 * * *', { id: 'stored', timeZone: LOS_ANGELES });
    const bytes = await engine.storage.get(KEYS.schedule('stored'));
    return decode(bytes!) as Record<string, unknown>;
  }

  it('reads a record written before schedules had a zone as UTC', async () => {
    const { timeZone: _dropped, ...legacy } = await persistedRecord();
    expect(decodeScheduleState(encode(legacy))?.timeZone).toBe('UTC');
  });

  it('keeps the zone it was written with', async () => {
    expect(decodeScheduleState(encode(await persistedRecord()))?.timeZone).toBe(LOS_ANGELES);
  });

  it('rejects a record whose zone is not one the runtime knows', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const record = await persistedRecord();
      expect(decodeScheduleState(encode({ ...record, timeZone: 'Mars/Olympus' }))).toBeNull();
      expect(decodeScheduleState(encode({ ...record, timeZone: 5 }))).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[weft] Ignoring malformed schedule "stored" with invalid timeZone.',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
