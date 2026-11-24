import { describe, expect, it } from 'bun:test';

import { isValidTimeZone } from './cron-formatter.ts';
import { collectDueCronTicks, getNextCronOccurrence, getNextCronTick } from './cron-occurrence.ts';
import { nextZonedCronTick } from './cron-zoned.ts';

const LOS_ANGELES = { timeZone: 'America/Los_Angeles' } as const;

/** Walk `count` firing occurrences of `expression` in Los Angeles, starting after `after`. */
function walk(expression: string, after: string, count: number): string[] {
  const occurrences: string[] = [];
  let cursor = Date.parse(after);
  for (let index = 0; index < count; index += 1) {
    cursor = getNextCronOccurrence(expression, cursor, LOS_ANGELES);
    occurrences.push(new Date(cursor).toISOString());
  }
  return occurrences;
}

describe('zoned cron occurrences', () => {
  it('leaves a schedule without a zone, or in UTC, on the UTC calendar', () => {
    const after = Date.parse('2026-03-07T00:00:00.000Z');
    expect(getNextCronOccurrence('0 9 * * *', after)).toBe(Date.parse('2026-03-07T09:00:00.000Z'));
    expect(getNextCronTick('0 9 * * *', after, { timeZone: 'UTC' })).toEqual({
      at: Date.parse('2026-03-07T09:00:00.000Z'),
      fires: true,
      dstGapSkipped: 0,
    });
  });

  it('keeps a weekday 09:00 schedule at 09:00 local across the spring-forward change', () => {
    expect(walk('0 9 * * 1-5', '2026-03-05T00:00:00.000Z', 4)).toEqual([
      '2026-03-05T17:00:00.000Z',
      '2026-03-06T17:00:00.000Z',
      '2026-03-09T16:00:00.000Z',
      '2026-03-10T16:00:00.000Z',
    ]);
  });

  it('keeps a weekday 09:00 schedule at 09:00 local across the fall-back change', () => {
    expect(walk('0 9 * * 1-5', '2026-10-29T00:00:00.000Z', 4)).toEqual([
      '2026-10-29T16:00:00.000Z',
      '2026-10-30T16:00:00.000Z',
      '2026-11-02T17:00:00.000Z',
      '2026-11-03T17:00:00.000Z',
    ]);
  });

  it('reports the nonexistent 02:30 of the spring-forward day as a gap tick, then resumes next day', () => {
    const before = Date.parse('2026-03-07T10:30:00.000Z');
    const gapTick = getNextCronTick('30 2 * * *', before, LOS_ANGELES);
    expect(gapTick).toEqual({
      at: Date.parse('2026-03-08T10:00:00.000Z'),
      fires: false,
      dstGapSkipped: 1,
    });
    expect(getNextCronTick('30 2 * * *', gapTick.at, LOS_ANGELES)).toEqual({
      at: Date.parse('2026-03-09T09:30:00.000Z'),
      fires: true,
      dstGapSkipped: 0,
    });
  });

  it('never fires the nonexistent time: the numeric search steps over the gap', () => {
    expect(walk('30 2 * * *', '2026-03-07T10:30:00.000Z', 2)).toEqual([
      '2026-03-09T09:30:00.000Z',
      '2026-03-10T09:30:00.000Z',
    ]);
  });

  it('counts every expression match inside the gap', () => {
    const tick = getNextCronTick('0,30 2 * * *', Date.parse('2026-03-07T10:30:00.000Z'), {
      timeZone: 'America/Los_Angeles',
    });
    expect(tick).toEqual({
      at: Date.parse('2026-03-08T10:00:00.000Z'),
      fires: false,
      dstGapSkipped: 2,
    });
  });

  it('fires the first instant after the gap when the expression also matches it', () => {
    const tick = getNextCronTick('0 * * * *', Date.parse('2026-03-08T09:30:00.000Z'), LOS_ANGELES);
    expect(tick).toEqual({
      at: Date.parse('2026-03-08T10:00:00.000Z'),
      fires: true,
      dstGapSkipped: 1,
    });
  });

  it('fires the repeated 01:30 of the fall-back day once', () => {
    expect(walk('30 1 * * *', '2026-10-31T12:00:00.000Z', 3)).toEqual([
      '2026-11-01T08:30:00.000Z',
      '2026-11-02T09:30:00.000Z',
      '2026-11-03T09:30:00.000Z',
    ]);
  });

  it('skips the repeated hour even when the search starts inside its second pass', () => {
    // 09:10Z is 01:10 PST, after the clock fell back. The 01:30 that follows already ran once.
    expect(walk('30 1 * * *', '2026-11-01T09:10:00.000Z', 1)).toEqual(['2026-11-02T09:30:00.000Z']);
  });

  it('re-derives a tick from a bare timestamp when the due window is collected', () => {
    const gap = Date.parse('2026-03-08T10:00:00.000Z');
    expect(
      collectDueCronTicks('30 2 * * *', gap, Date.parse('2026-03-09T10:00:00.000Z'), LOS_ANGELES),
    ).toEqual([
      { at: gap, fires: false, dstGapSkipped: 1 },
      { at: Date.parse('2026-03-09T09:30:00.000Z'), fires: true, dstGapSkipped: 0 },
    ]);
    // A second-pass instant of a repeated hour, such as an old schedule computed under the
    // previous rule might carry, neither fires nor skips anything.
    const secondPass = Date.parse('2026-11-01T09:30:00.000Z');
    expect(collectDueCronTicks('30 1 * * *', secondPass, secondPass, LOS_ANGELES)).toEqual([
      { at: secondPass, fires: false, dstGapSkipped: 0 },
    ]);
  });

  it('leaves a zone with no transition on its fixed offset', () => {
    expect(
      getNextCronOccurrence('0 9 * * *', Date.parse('2026-03-07T00:00:00.000Z'), {
        timeZone: 'Asia/Tokyo',
      }),
    ).toBe(Date.parse('2026-03-08T00:00:00.000Z'));
  });
});

describe('nextZonedCronTick', () => {
  it('gives up when a repeated hour holds more second-pass matches than the search will skip', () => {
    // Every second matches, so a search that starts inside the fall-back hour's second pass keeps
    // landing on times that already ran once. A bound of two spends itself on the first two.
    const everySecond = (afterLocal: number): number => afterLocal + 1000;
    const insideSecondPass = Date.parse('2026-11-01T09:10:00.000Z');
    expect(() =>
      nextZonedCronTick(everySecond, insideSecondPass, 'America/Los_Angeles', 2),
    ).toThrow('Could not find the next cron occurrence after a repeated hour');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and UTC, and rejects the rest', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone(5)).toBe(false);
  });
});
