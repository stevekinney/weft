import { MemoryStorage, type Storage } from "../../embedded/storage/src/index.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import {
  SCHEDULE_SKIPPED_OCCURRENCE_LIMIT,
  type ScheduleSummary,
  type WorkflowServicesResolverScheduleInfo,
} from '../types.ts';
import { ScheduleOccurrenceNotNextError } from './schedule-occurrence-not-next-error.ts';
import {
  drainEngine,
  registerWorkflow,
  releaseRunningWorkflows,
  tickEngine,
  type Clock,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

// A person can skip any upcoming run of a schedule, take a skip back, and start one now (COR-1829,
// COR-2018). Every test drives the engine's injected clock; nothing waits.

const LOS_ANGELES = 'America/Los_Angeles';

function at(iso: string): number {
  return Date.parse(iso);
}

function isoOf(timestamp: number | null | undefined): string | null {
  return timestamp === null || timestamp === undefined ? null : new Date(timestamp).toISOString();
}

type Opened = {
  engine: Engine;
  clock: Clock;
  /** When each run began, in start order. */
  runs: string[];
  /** The schedule info the services resolver was given for each scheduled run. */
  resolved: Array<WorkflowServicesResolverScheduleInfo | undefined>;
};

/** An engine whose clock starts at `start`; its `report` workflow records when it began. */
function open(start: string, options: { hold?: boolean; storage?: Storage } = {}): Opened {
  const clock: Clock = { now: at(start) };
  const runs: string[] = [];
  const resolved: Array<WorkflowServicesResolverScheduleInfo | undefined> = [];
  const engine = new Engine({
    storage: options.storage ?? new MemoryStorage(),
    getNow: () => clock.now,
    resolveWorkflowServices: async (info) => {
      resolved.push(info.schedule);
      return { status: 'available', services: {} };
    },
  });
  registerWorkflow(engine, 'report', async function* (ctx) {
    runs.push(new Date(clock.now).toISOString());
    if (options.hold === true) yield* ctx.waitForSignal('release');
    return 'done';
  });
  return { engine, clock, runs, resolved };
}

/** One field of a schedule's current summary. */
async function fieldOf<K extends keyof ScheduleSummary>(
  engine: Engine,
  id: string,
  key: K,
): Promise<ScheduleSummary[K]> {
  const summary = await engine.getSchedule(id);
  if (summary === null) throw new Error(`Schedule "${id}" does not exist`);
  return summary[key];
}

async function summaryOf(engine: Engine, id: string): Promise<ScheduleSummary> {
  const summary = await engine.getSchedule(id);
  if (summary === null) throw new Error(`Schedule "${id}" does not exist`);
  return summary;
}

/** The occurrences a schedule skips now, as its current summary lists them. */
async function skipsOf(engine: Engine, id: string): Promise<number[] | undefined> {
  const summary = await summaryOf(engine, id);
  return summary.skippedOccurrences;
}

/** {@link skipsOf} as ISO 8601 instants, which a failure reads more easily. */
async function isoSkipsOf(engine: Engine, id: string): Promise<Array<string | null> | undefined> {
  const skips = await skipsOf(engine, id);
  return skips?.map(isoOf);
}

/** `error`, which must be the refusal of an occurrence that is not an upcoming run. */
function failure(error: unknown): ScheduleOccurrenceNotNextError {
  expect(error).toBeInstanceOf(ScheduleOccurrenceNotNextError);
  return error as ScheduleOccurrenceNotNextError;
}

/** The one occurrence a schedule skips, or `undefined` when it skips none; fails when it skips more. */
function onlySkip(summary: Pick<ScheduleSummary, 'skippedOccurrences'>): number | undefined {
  expect((summary.skippedOccurrences ?? []).length).toBeLessThanOrEqual(1);
  return summary.skippedOccurrences?.[0];
}

/** {@link onlySkip} of a schedule's current summary. */
async function skipOf(engine: Engine, id: string): Promise<number | undefined> {
  return onlySkip(await summaryOf(engine, id));
}

describe('skipping the next occurrence', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  it('skips exactly one fire and runs the one after it', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    await engine.skipNextScheduleOccurrence('daily');
    const skipped = await summaryOf(engine, 'daily');
    expect(isoOf(onlySkip(skipped))).toBe('2026-01-01T09:00:00.000Z');
    // A skip is bookkeeping, as a fire is: the schedule's own revision stays where it was.
    expect(skipped.revision).toBe(1);

    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual([]);
    const afterSkip = await summaryOf(engine, 'daily');
    expect(onlySkip(afterSkip)).toBeUndefined();
    expect(afterSkip.lastFireAt).toBeUndefined();
    expect(afterSkip.missedFireCount).toBe(0);
    expect(isoOf(afterSkip.nextFireAt)).toBe('2026-01-02T09:00:00.000Z');

    await tickEngine(engine, clock, at('2026-01-02T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-02T09:00:00.000Z']);
  });

  it('skips an interval schedule’s next fire', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });

    await engine.skipNextScheduleOccurrence('hourly');
    await tickEngine(engine, clock, at('2026-01-01T01:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-01T02:00:00.000Z'));

    expect(runs).toEqual(['2026-01-01T02:00:00.000Z']);
  });

  it('skips the following actual fire when nextFireAt is the end of a gap that fires nothing', async () => {
    opened = open('2026-03-07T11:00:00.000Z');
    const { engine, clock, runs } = opened;
    const missed: ScheduleMissedFireEvent[] = [];
    engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
      missed.push(event);
    });
    await engine.schedule('report', null, '30 2 * * *', { id: 'daily', timeZone: LOS_ANGELES });
    expect(isoOf(await fieldOf(engine, 'daily', 'nextFireAt'))).toBe('2026-03-08T10:00:00.000Z');

    await engine.skipNextScheduleOccurrence('daily');
    const skipped = await summaryOf(engine, 'daily');
    expect(isoOf(onlySkip(skipped))).toBe('2026-03-09T09:30:00.000Z');
    expect(isoOf(skipped.nextFireAt)).toBe('2026-03-08T10:00:00.000Z');

    // The gap's end is not a fire, so it neither spends the skip nor starts a run.
    await tickEngine(engine, clock, at('2026-03-08T10:00:00.000Z'));
    expect(runs).toEqual([]);
    expect(missed.map((event) => event.reason)).toEqual(['dst-gap']);
    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-03-09T09:30:00.000Z');

    await tickEngine(engine, clock, at('2026-03-09T09:30:00.000Z'));
    expect(runs).toEqual([]);
    expect(await skipOf(engine, 'daily')).toBeUndefined();

    await tickEngine(engine, clock, at('2026-03-10T09:30:00.000Z'));
    expect(runs).toEqual(['2026-03-10T09:30:00.000Z']);
  });

  it('changes nothing when the next fire is already skipped', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    await engine.skipNextScheduleOccurrence('daily');
    clock.now += 60_000;
    await engine.skipNextScheduleOccurrence('daily');

    const summary = await summaryOf(engine, 'daily');
    // The second skip wrote nothing: the record is as the first one left it.
    expect(isoOf(summary.updatedAt)).toBe('2026-01-01T00:00:00.000Z');
    expect(isoOf(onlySkip(summary))).toBe('2026-01-01T09:00:00.000Z');
  });

  it('refuses a skip naming an occurrence a fire has passed, writing nothing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const occurrence = await fieldOf(engine, 'daily', 'nextFireAt');
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T09:00:00.000Z']);
    const before = await summaryOf(engine, 'daily');

    const failure = await engine
      .skipNextScheduleOccurrence('daily', { occurrence: occurrence! })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    expect((failure as ScheduleOccurrenceNotNextError).occurrence).toBe(occurrence!);
    expect((failure as ScheduleOccurrenceNotNextError).nextOccurrence).toBe(
      at('2026-01-02T09:00:00.000Z'),
    );
    const after = await summaryOf(engine, 'daily');
    expect(onlySkip(after)).toBeUndefined();
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('skips the occurrence it names when that is the next real one', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const occurrence = (await fieldOf(engine, 'daily', 'nextFireAt'))!;

    await engine.skipNextScheduleOccurrence('daily', { occurrence });
    await tickEngine(engine, clock, occurrence);
    await tickEngine(engine, clock, occurrence + 24 * 60 * 60_000);

    expect(runs).toEqual(['2026-01-02T09:00:00.000Z']);
  });

  it('skips an occurrence later than the next one, and runs the ones around it', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    await engine.skipNextScheduleOccurrence('daily', {
      occurrence: at('2026-01-02T09:00:00.000Z'),
    });
    await engine.skipNextScheduleOccurrence('daily', {
      occurrence: at('2026-01-04T09:00:00.000Z'),
    });
    const skipped = await summaryOf(engine, 'daily');
    expect(skipped.skippedOccurrences?.map(isoOf)).toEqual([
      '2026-01-02T09:00:00.000Z',
      '2026-01-04T09:00:00.000Z',
    ]);
    expect(skipped.revision).toBe(1);
    expect(isoOf(skipped.nextFireAt)).toBe('2026-01-01T09:00:00.000Z');

    for (const day of ['01', '02', '03', '04', '05']) {
      await tickEngine(engine, clock, at(`2026-01-${day}T09:00:00.000Z`));
    }

    expect(runs).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
      '2026-01-05T09:00:00.000Z',
    ]);
    expect(await skipsOf(engine, 'daily')).toBeUndefined();
  });

  it('refuses an occurrence the cadence starts no run at, writing nothing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });

    for (const [id, occurrence] of [
      ['daily', at('2026-01-02T09:30:00.000Z')],
      ['daily', at('2026-01-02T09:00:00.001Z')],
      ['hourly', at('2026-01-01T01:30:00.000Z')],
    ] as const) {
      const failure = await engine.skipNextScheduleOccurrence(id, { occurrence }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
      expect(await skipOf(engine, id)).toBeUndefined();
    }
  });

  it('refuses nextFireAt when it is the end of a gap that fires nothing, and accepts the real run', async () => {
    opened = open('2026-03-07T11:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '30 2 * * *', { id: 'daily', timeZone: LOS_ANGELES });
    const gapEnd = (await fieldOf(engine, 'daily', 'nextFireAt'))!;
    expect(isoOf(gapEnd)).toBe('2026-03-08T10:00:00.000Z');

    const failure = await engine.skipNextScheduleOccurrence('daily', { occurrence: gapEnd }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    expect(await skipOf(engine, 'daily')).toBeUndefined();

    await engine.skipNextScheduleOccurrence('daily', {
      occurrence: at('2026-03-09T09:30:00.000Z'),
    });
    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-03-09T09:30:00.000Z');
  });

  it('refuses an overdue nextFireAt that a late tick counts missed, and names the one after now', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const overdue = (await fieldOf(engine, 'daily', 'nextFireAt'))!;
    clock.now = at('2026-01-03T12:00:00.000Z');

    const failure = await engine.skipNextScheduleOccurrence('daily', { occurrence: overdue }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);

    await engine.skipNextScheduleOccurrence('daily', {
      occurrence: at('2026-01-04T09:00:00.000Z'),
    });
    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-01-04T09:00:00.000Z');
  });

  it('changes nothing when it names the occurrence already skipped, and skips the run after it too', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const first = at('2026-01-01T09:00:00.000Z');
    await engine.skipNextScheduleOccurrence('daily', { occurrence: first });
    clock.now += 60_000;

    await engine.skipNextScheduleOccurrence('daily', { occurrence: first });
    // The second skip of the same run wrote nothing: the record is as the first one left it.
    const unchanged = await summaryOf(engine, 'daily');
    expect(isoOf(unchanged.updatedAt)).toBe('2026-01-01T00:00:00.000Z');
    await engine.skipNextScheduleOccurrence('daily', { occurrence: first + 24 * 60 * 60_000 });

    expect(await skipsOf(engine, 'daily')).toEqual([first, first + 24 * 60 * 60_000]);
  });

  it('checks expectedRevision before the occurrence', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    const failure = await engine
      .skipNextScheduleOccurrence('daily', {
        expectedRevision: 7,
        occurrence: at('2026-01-05T09:00:00.000Z'),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).name).toBe('ScheduleStaleRevisionError');
  });

  it('rejects an occurrence that is not a non-negative integer', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    for (const occurrence of [-1, 1.5, Number.NaN, '1' as unknown as number]) {
      const failure = await engine.skipNextScheduleOccurrence('daily', { occurrence }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain('options.occurrence must be');
    }
    expect(await skipOf(engine, 'daily')).toBeUndefined();
  });

  it('is refused for a stale expectedRevision, writing nothing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    const failure = await engine.skipNextScheduleOccurrence('daily', { expectedRevision: 7 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('ScheduleStaleRevisionError');
    expect(await skipOf(engine, 'daily')).toBeUndefined();
  });

  it('is refused for a schedule that is cancelled or missing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'gone' });
    await engine.cancelSchedule('gone');

    for (const [id, expected] of [
      ['gone', 'cancelled and has no next occurrence'],
      ['nope', 'not found'],
    ] as const) {
      const failure = await engine.skipNextScheduleOccurrence(id).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain(expected);
    }
  });

  it('skips a paused schedule’s runs from the first after now, and a resume honors them', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'held' });
    await engine.pauseSchedule('held');
    clock.now = at('2026-01-02T12:00:00.000Z');

    // The schedule's stored next run (Jan 1) has passed while it was paused; a resume now would
    // start from Jan 3, so that is the first run it can skip.
    const passed = await engine
      .skipNextScheduleOccurrence('held', { occurrence: at('2026-01-02T09:00:00.000Z') })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure(passed).nextOccurrence).toBe(at('2026-01-03T09:00:00.000Z'));
    await engine.skipNextScheduleOccurrence('held');
    await engine.skipNextScheduleOccurrence('held', { occurrence: at('2026-01-04T09:00:00.000Z') });
    expect(await isoSkipsOf(engine, 'held')).toEqual([
      '2026-01-03T09:00:00.000Z',
      '2026-01-04T09:00:00.000Z',
    ]);

    await engine.resumeSchedule('held');
    for (const day of ['03', '04', '05']) {
      await tickEngine(engine, clock, at(`2026-01-${day}T09:00:00.000Z`));
    }
    expect(runs).toEqual(['2026-01-05T09:00:00.000Z']);
  });

  it('is kept by a pause, spent by a resume that slept past it, and ended by a new cadence', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'paused' });
    await engine.schedule('report', null, '0 9 * * *', { id: 'updated' });
    await engine.skipNextScheduleOccurrence('paused');
    await engine.skipNextScheduleOccurrence('paused', {
      occurrence: at('2026-01-03T09:00:00.000Z'),
    });
    await engine.skipNextScheduleOccurrence('updated');

    await engine.pauseSchedule('paused');
    await engine.updateSchedule('updated', '0 10 * * *');

    expect(await isoSkipsOf(engine, 'paused')).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
    ]);
    expect(await skipOf(engine, 'updated')).toBeUndefined();

    clock.now = at('2026-01-02T12:00:00.000Z');
    await engine.resumeSchedule('paused');
    expect(await isoSkipsOf(engine, 'paused')).toEqual(['2026-01-03T09:00:00.000Z']);
  });

  it('ends every skip when the schedule is cancelled', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.skipNextScheduleOccurrence('daily');

    await engine.cancelSchedule('daily');

    expect(await skipsOf(engine, 'daily')).toBeUndefined();
  });

  it('keeps the skips an update leaves on the cadence and ends the others', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    // Jan 2 2026 is a Friday and Jan 3 a Saturday.
    for (const day of ['02', '03']) {
      await engine.skipNextScheduleOccurrence('daily', {
        occurrence: at(`2026-01-${day}T09:00:00.000Z`),
      });
    }

    await engine.updateSchedule('daily', '0 9 * * 1-5');

    expect(await isoSkipsOf(engine, 'daily')).toEqual(['2026-01-02T09:00:00.000Z']);
  });

  it(`refuses a skip past ${String(SCHEDULE_SKIPPED_OCCURRENCE_LIMIT)} skipped runs, writing nothing`, async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });
    for (let hour = 1; hour <= SCHEDULE_SKIPPED_OCCURRENCE_LIMIT; hour += 1) {
      await engine.skipNextScheduleOccurrence('hourly', {
        occurrence: hour * 60 * 60_000 + at('2026-01-01T00:00:00.000Z'),
      });
    }

    const refused = await engine
      .skipNextScheduleOccurrence('hourly', {
        occurrence:
          (SCHEDULE_SKIPPED_OCCURRENCE_LIMIT + 1) * 60 * 60_000 + at('2026-01-01T00:00:00.000Z'),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((refused as Error).message).toContain('occurrences, the most it keeps');
    expect(await skipsOf(engine, 'hourly')).toHaveLength(SCHEDULE_SKIPPED_OCCURRENCE_LIMIT);
  });

  it('survives an update that leaves the next run where it was', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.schedule('report', null, '0 9 * * *', { id: 'weekdays' });
    await engine.skipNextScheduleOccurrence('daily');
    await engine.skipNextScheduleOccurrence('weekdays');

    // Only a description and a policy change; and an expression whose next run is the same one.
    await engine.updateSchedule('daily', '0 9 * * *', { description: 'edited', overlap: 'queue' });
    await engine.updateSchedule('weekdays', '0 9 * * 1-5');

    for (const id of ['daily', 'weekdays']) {
      expect(isoOf(await skipOf(engine, id))).toBe('2026-01-01T09:00:00.000Z');
      expect(await fieldOf(engine, id, 'revision')).toBe(2);
    }
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual([]);
  });

  it('survives an update when the next wake-up is the end of a gap that fires nothing', async () => {
    opened = open('2026-03-07T11:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '30 2 * * *', { id: 'daily', timeZone: LOS_ANGELES });
    await engine.skipNextScheduleOccurrence('daily');

    await engine.updateSchedule('daily', '30 2 * * *', { description: 'edited' });

    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-03-09T09:30:00.000Z');
  });

  it('ends when an update moves the next run, or the time zone', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'zone' });
    await engine.skipNextScheduleOccurrence('zone');

    await engine.updateSchedule('zone', '0 9 * * *', { timeZone: LOS_ANGELES });

    expect(await skipOf(engine, 'zone')).toBeUndefined();
  });

  it('ends when an update switches to an interval whose runs miss it, and survives one that keeps it', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'switched' });
    await engine.schedule('report', null, '0 9 * * *', { id: 'hourly' });
    await engine.skipNextScheduleOccurrence('switched');
    await engine.skipNextScheduleOccurrence('hourly');

    // Re-anchored at midnight, every two hours runs at 8:00 and 10:00, and every hour at 9:00.
    await engine.updateSchedule('switched', { every: '2h' });
    await engine.updateSchedule('hourly', { every: '1h' });

    expect(await skipOf(engine, 'switched')).toBeUndefined();
    expect(await skipOf(engine, 'hourly')).toBe(at('2026-01-01T09:00:00.000Z'));
  });

  it('keeps the anchor and the skip of an interval schedule updated without changing the interval', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });
    clock.now = at('2026-01-01T00:20:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');

    await engine.updateSchedule('hourly', { every: '1h' }, { description: 'edited' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T01:00:00.000Z');
    expect(isoOf(onlySkip(summary))).toBe('2026-01-01T01:00:00.000Z');
    expect(isoOf(summary.createdAt)).toBe('2026-01-01T00:00:00.000Z');
    await tickEngine(engine, clock, at('2026-01-01T01:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-01T02:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T02:00:00.000Z']);
  });

  it('keeps the skip of an overdue interval schedule, which names the run after now, not nextFireAt', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });
    // Nothing ticked, so the schedule still waits for 01:00; a tick now would count the hours up
    // to 03:30 missed, and the next run is 04:00.
    clock.now = at('2026-01-01T03:30:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');
    expect(isoOf(await skipOf(engine, 'hourly'))).toBe('2026-01-01T04:00:00.000Z');

    await engine.updateSchedule('hourly', { every: '1h' }, { description: 'edited' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T01:00:00.000Z');
    expect(isoOf(onlySkip(summary))).toBe('2026-01-01T04:00:00.000Z');
    await tickEngine(engine, clock, at('2026-01-01T04:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-01T05:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T05:00:00.000Z']);
  });

  it('keeps the skip of a backfilled interval schedule that is catching up, which names the run after lastFireAt', async () => {
    const storage = new MemoryStorage();
    opened = open('2026-01-01T00:00:00.000Z', { storage });
    const { engine, clock } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly', backfill: true });
    // A catch-up that has started the 01:00 and 02:00 runs and not yet moved nextFireAt.
    const stored = decodeScheduleState((await storage.get(KEYS.schedule('hourly')))!);
    await storage.put(
      KEYS.schedule('hourly'),
      encode({ ...stored, lastFireAt: at('2026-01-01T02:00:00.000Z') }),
    );
    clock.now = at('2026-01-01T02:30:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');
    expect(isoOf(await skipOf(engine, 'hourly'))).toBe('2026-01-01T03:00:00.000Z');

    await engine.updateSchedule('hourly', { every: '1h' }, { description: 'edited' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T01:00:00.000Z');
    expect(isoOf(onlySkip(summary))).toBe('2026-01-01T03:00:00.000Z');
  });

  it('keeps the skip of an overdue cron schedule, which names the run after now', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    clock.now = at('2026-01-03T12:00:00.000Z');
    await engine.skipNextScheduleOccurrence('daily');
    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-01-04T09:00:00.000Z');

    await engine.updateSchedule('daily', '0 9 * * *', { description: 'edited' });

    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-01-04T09:00:00.000Z');
  });

  it('keeps the skip of a backfilled cron schedule that is catching up when an update leaves the same run next', async () => {
    const storage = new MemoryStorage();
    opened = open('2026-01-01T00:00:00.000Z', { storage });
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 * * * *', { id: 'hourly', backfill: true });
    const stored = decodeScheduleState((await storage.get(KEYS.schedule('hourly')))!);
    await storage.put(
      KEYS.schedule('hourly'),
      encode({ ...stored, lastFireAt: at('2026-01-01T02:00:00.000Z') }),
    );
    clock.now = at('2026-01-01T02:30:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');
    expect(isoOf(await skipOf(engine, 'hourly'))).toBe('2026-01-01T03:00:00.000Z');

    // A cron update computes its next run from now, which ends the catch-up the skip belonged to.
    await engine.updateSchedule('hourly', '0 * * * *', { description: 'edited' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T03:00:00.000Z');
    expect(isoOf(onlySkip(summary))).toBe('2026-01-01T03:00:00.000Z');
  });

  it('re-anchors an interval schedule whose interval changes, and ends the skip', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });
    clock.now = at('2026-01-01T00:20:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');

    await engine.updateSchedule('hourly', { every: '2h' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T02:20:00.000Z');
    expect(onlySkip(summary)).toBeUndefined();
  });

  it('does not queue the skipped occurrence behind a running one', async () => {
    opened = open('2026-01-01T00:00:00.000Z', { hold: true });
    const { engine, clock } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'queued', overlap: 'queue' });
    await tickEngine(engine, clock, at('2026-01-01T01:00:00.000Z'));
    await engine.skipNextScheduleOccurrence('queued');

    await tickEngine(engine, clock, at('2026-01-01T02:00:00.000Z'));

    expect(await fieldOf(engine, 'queued', 'queuedRuns')).toEqual([]);
    await releaseRunningWorkflows(engine);
  });
});

describe('taking a skip back', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  it('runs the occurrence after all and keeps the other skips', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    for (const day of ['01', '02']) {
      await engine.skipNextScheduleOccurrence('daily', {
        occurrence: at(`2026-01-${day}T09:00:00.000Z`),
      });
    }
    clock.now += 60_000;

    await engine.unskipScheduleOccurrence('daily', { occurrence: at('2026-01-01T09:00:00.000Z') });
    const summary = await summaryOf(engine, 'daily');
    expect(summary.skippedOccurrences?.map(isoOf)).toEqual(['2026-01-02T09:00:00.000Z']);
    // An unskip is bookkeeping, as a skip is: the revision stays, the record's time moves.
    expect(summary.revision).toBe(1);
    expect(isoOf(summary.updatedAt)).toBe('2026-01-01T00:01:00.000Z');

    for (const day of ['01', '02', '03']) {
      await tickEngine(engine, clock, at(`2026-01-${day}T09:00:00.000Z`));
    }
    expect(runs).toEqual(['2026-01-01T09:00:00.000Z', '2026-01-03T09:00:00.000Z']);
  });

  it('changes nothing for an upcoming occurrence that is not skipped', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.skipNextScheduleOccurrence('daily');
    clock.now += 60_000;

    await engine.unskipScheduleOccurrence('daily', { occurrence: at('2026-01-02T09:00:00.000Z') });

    const summary = await summaryOf(engine, 'daily');
    expect(isoOf(summary.updatedAt)).toBe('2026-01-01T00:00:00.000Z');
    expect(onlySkip(summary)).toBe(at('2026-01-01T09:00:00.000Z'));
  });

  it('refuses an occurrence that has passed, writing nothing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.skipNextScheduleOccurrence('daily');
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual([]);

    const refused = await engine
      .unskipScheduleOccurrence('daily', { occurrence: at('2026-01-01T09:00:00.000Z') })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure(refused).nextOccurrence).toBe(at('2026-01-02T09:00:00.000Z'));
  });

  it('takes back a paused schedule’s skip, which a resume then runs', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'held' });
    await engine.pauseSchedule('held');
    await engine.skipNextScheduleOccurrence('held');

    await engine.unskipScheduleOccurrence('held', { occurrence: at('2026-01-01T09:00:00.000Z') });
    expect(await skipOf(engine, 'held')).toBeUndefined();

    await engine.resumeSchedule('held');
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T09:00:00.000Z']);
  });

  it('is refused for a stale revision, a cancelled or missing schedule, and a bad occurrence', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.skipNextScheduleOccurrence('daily');
    await engine.schedule('report', null, '0 9 * * *', { id: 'gone' });
    await engine.cancelSchedule('gone');
    const occurrence = at('2026-01-01T09:00:00.000Z');

    const reasons = await Promise.all(
      [
        engine.unskipScheduleOccurrence('daily', { occurrence, expectedRevision: 7 }),
        engine.unskipScheduleOccurrence('gone', { occurrence }),
        engine.unskipScheduleOccurrence('nope', { occurrence }),
        engine.unskipScheduleOccurrence('daily', { occurrence: -1 }),
        engine.unskipScheduleOccurrence('daily', {} as { occurrence: number }),
      ].map((call) =>
        call.then(
          () => 'resolved',
          (error: unknown) => (error as Error).message,
        ),
      ),
    );

    expect(reasons[0]).toContain('revision');
    expect(reasons[1]).toContain('cancelled and has no next occurrence');
    expect(reasons[2]).toContain('not found');
    expect(reasons[3]).toContain('options.occurrence must be');
    expect(reasons[4]).toContain('options.occurrence must be');
    expect(await skipOf(engine, 'daily')).toBe(occurrence);
  });
});

describe('running a schedule now', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  it('starts one run, marked manual, and leaves the cadence alone', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs, resolved } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'allow' });
    const before = await summaryOf(engine, 'daily');
    clock.now = at('2026-01-01T03:00:00.000Z');

    const result = await engine.triggerSchedule('daily');
    await drainEngine();

    expect(result.outcome).toBe('started');
    expect(runs).toEqual(['2026-01-01T03:00:00.000Z']);
    expect(resolved).toEqual([{ id: 'daily', manual: true }]);
    const after = await summaryOf(engine, 'daily');
    expect(after.nextFireAt).toBe(before.nextFireAt);
    expect(after.lastFireAt).toBeUndefined();
    expect(after.revision).toBe(before.revision);
    if (result.outcome === 'started') {
      expect(await engine.getScheduleProvenance(result.workflowId)).toEqual({
        scheduleId: 'daily',
        manual: true,
      });
    }

    // The cadence goes on as if nothing had happened.
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T03:00:00.000Z', '2026-01-01T09:00:00.000Z']);
    expect(resolved.at(-1)).toEqual({ id: 'daily', occurrence: at('2026-01-01T09:00:00.000Z') });
  });

  it('reports skipped while a run is going and the policy is skip', async () => {
    opened = open('2026-01-01T00:00:00.000Z', { hold: true });
    const { engine, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'skip' });

    const first = await engine.triggerSchedule('daily');
    await drainEngine();
    const second = await engine.triggerSchedule('daily');

    expect(first.outcome).toBe('started');
    expect(second).toEqual({
      outcome: 'skipped',
      blockingWorkflowId: first.outcome === 'started' ? first.workflowId : '',
    });
    expect(runs).toHaveLength(1);
    const summary = await summaryOf(engine, 'daily');
    expect(summary.skippedCount).toBe(1);
    expect(summary.currentWorkflowId).toBe(first.outcome === 'started' ? first.workflowId : '');

    await releaseRunningWorkflows(engine);
    const again = await engine.triggerSchedule('daily');
    expect(again.outcome).toBe('started');
    await releaseRunningWorkflows(engine);
  });

  it('queues the run behind the running one under the queue policy, and starts it manual', async () => {
    opened = open('2026-01-01T00:00:00.000Z', { hold: true });
    const { engine, resolved } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'queue' });
    await engine.triggerSchedule('daily');
    await drainEngine();

    const queued = await engine.triggerSchedule('daily');
    const queuedAgain = await engine.triggerSchedule('daily');

    expect(queued.outcome).toBe('queued');
    expect(queuedAgain.outcome).toBe('queued');
    const queuedIds = [queued, queuedAgain].map((result) =>
      result.outcome === 'queued' ? result.workflowId : '',
    );
    expect(new Set(queuedIds).size).toBe(2);
    expect(await fieldOf(engine, 'daily', 'queuedRuns')).toMatchObject([
      { workflowId: queuedIds[0], manual: true },
      { workflowId: queuedIds[1], manual: true },
    ]);
    await releaseRunningWorkflows(engine);
    await releaseRunningWorkflows(engine);
    await releaseRunningWorkflows(engine);
    expect(await fieldOf(engine, 'daily', 'queuedRuns')).toEqual([]);
    expect(resolved).toEqual([
      { id: 'daily', manual: true },
      { id: 'daily', manual: true },
      { id: 'daily', manual: true },
    ]);
  });

  it('runs a paused schedule, and refuses a cancelled or missing one', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'paused' });
    await engine.pauseSchedule('paused');
    await engine.schedule('report', null, '0 9 * * *', { id: 'gone' });
    await engine.cancelSchedule('gone');

    const ran = await engine.triggerSchedule('paused');
    expect(ran.outcome).toBe('started');
    await drainEngine();
    expect(runs).toHaveLength(1);
    expect(await fieldOf(engine, 'paused', 'status')).toBe('paused');
    for (const [id, expected] of [
      ['gone', 'cancelled and cannot be run'],
      ['nope', 'not found'],
    ] as const) {
      const failure = await engine.triggerSchedule(id).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain(expected);
    }
  });
});

describe('a persisted schedule record and its skip', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  async function persistedRecord(): Promise<Record<string, unknown>> {
    opened = open('2026-01-01T00:00:00.000Z');
    await opened.engine.schedule('report', null, '0 9 * * *', { id: 'stored' });
    await opened.engine.skipNextScheduleOccurrence('stored');
    const bytes = await opened.engine.storage.get(KEYS.schedule('stored'));
    return decode(bytes!) as Record<string, unknown>;
  }

  it('reads a record written before schedules could be skipped as not skipped', async () => {
    const { skippedOccurrences: _dropped, ...legacy } = await persistedRecord();
    const state = decodeScheduleState(encode(legacy));
    expect(state).not.toBeNull();
    expect(state && 'skippedOccurrences' in state).toBe(false);
  });

  it('keeps the skips it was written with', async () => {
    expect(decodeScheduleState(encode(await persistedRecord()))?.skippedOccurrences).toEqual([
      at('2026-01-01T09:00:00.000Z'),
    ]);
  });

  it('reads the single skip a record written before the set (skipUntil) carries as a set of one', async () => {
    const { skippedOccurrences: _replaced, ...record } = await persistedRecord();
    const legacy = { ...record, skipUntil: at('2026-01-02T09:00:00.000Z') };
    const state = decodeScheduleState(encode(legacy));
    expect(state?.skippedOccurrences).toEqual([at('2026-01-02T09:00:00.000Z')]);
    expect(state && 'skipUntil' in state).toBe(false);
  });

  it('reads a stored set ascending and without repeats', async () => {
    const record = await persistedRecord();
    const later = at('2026-01-03T09:00:00.000Z');
    const earlier = at('2026-01-02T09:00:00.000Z');
    const state = decodeScheduleState(
      encode({ ...record, skippedOccurrences: [later, earlier, later] }),
    );
    expect(state?.skippedOccurrences).toEqual([earlier, later]);
  });

  it('rejects a record whose skips are not timestamps', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { skippedOccurrences: _replaced, ...record } = await persistedRecord();
      for (const skippedOccurrences of ['soon', -1, ['soon'], [1, -1]]) {
        expect(decodeScheduleState(encode({ ...record, skippedOccurrences }))).toBeNull();
      }
      expect(warn).toHaveBeenCalledWith(
        '[weft] Ignoring malformed schedule "stored" with invalid skippedOccurrences.',
      );
      expect(decodeScheduleState(encode({ ...record, skipUntil: 'soon' }))).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[weft] Ignoring malformed schedule "stored" with invalid skipUntil.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a queued run’s manual mark, and rejects one that is not true', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const record = await persistedRecord();
      const queuedRuns = [{ workflowId: 'w', queuedAt: 1, manual: true as const }];
      expect(decodeScheduleState(encode({ ...record, queuedRuns }))?.queuedRuns).toEqual(
        queuedRuns,
      );
      expect(
        decodeScheduleState(
          encode({ ...record, queuedRuns: [{ workflowId: 'w', queuedAt: 1, manual: false }] }),
        ),
      ).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a schedule control before the workflow catalog is ready', () => {
  it('waits for the catalog, then skips and runs', async () => {
    const clock: Clock = { now: at('2026-01-01T00:00:00.000Z') };
    await using engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      backgroundTasks: 'manual',
    });
    registerWorkflow(engine, 'report', async function* () {
      return 'done';
    });
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'allow' });

    // A workflow registered after the catalog drained leaves it pending again.
    registerWorkflow(engine, 'later', async function* () {
      return 'done';
    });
    await engine.skipNextScheduleOccurrence('daily');
    registerWorkflow(engine, 'latest', async function* () {
      return 'done';
    });
    const result = await engine.triggerSchedule('daily');

    expect(result.outcome).toBe('started');
    expect(isoOf(await skipOf(engine, 'daily'))).toBe('2026-01-01T09:00:00.000Z');

    registerWorkflow(engine, 'last', async function* () {
      return 'done';
    });
    await engine.unskipScheduleOccurrence('daily', { occurrence: at('2026-01-01T09:00:00.000Z') });
    expect(await skipOf(engine, 'daily')).toBeUndefined();
  });
});
