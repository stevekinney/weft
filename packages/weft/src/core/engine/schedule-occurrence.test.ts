import { describe, expect, it } from 'bun:test';

import { getNextCronOccurrence } from '../schedule.ts';
import {
  collectDueScheduleTicks,
  getNextScheduleOccurrence,
  resolveScheduleCadence,
} from './schedule-occurrence.ts';

const HOUR = 3_600_000;
const ANCHOR = Date.UTC(2026, 0, 1, 0, 0, 0);

describe('resolveScheduleCadence', () => {
  it('resolves an interval cadence anchored at createdAt', () => {
    expect(
      resolveScheduleCadence({ intervalMs: HOUR, createdAt: ANCHOR, timeZone: 'UTC' }),
    ).toEqual({
      kind: 'interval',
      intervalMs: HOUR,
      anchor: ANCHOR,
    });
  });

  it('resolves a cron cadence', () => {
    expect(
      resolveScheduleCadence({ cronExpression: '0 * * * *', createdAt: ANCHOR, timeZone: 'UTC' }),
    ).toEqual({
      kind: 'cron',
      cronExpression: '0 * * * *',
      timeZone: 'UTC',
    });
  });

  it('throws when neither cadence is present', () => {
    expect(() => resolveScheduleCadence({ createdAt: ANCHOR, timeZone: 'UTC' })).toThrow(
      'Schedule state must define either a cron expression or an interval',
    );
  });
});

describe('getNextScheduleOccurrence', () => {
  it('dispatches interval cadence anchored at createdAt', () => {
    expect(
      getNextScheduleOccurrence({ intervalMs: HOUR, createdAt: ANCHOR, timeZone: 'UTC' }, ANCHOR),
    ).toBe(ANCHOR + HOUR);
  });

  it('dispatches cron cadence identically to the cron engine', () => {
    const state = { cronExpression: '0 * * * *', createdAt: ANCHOR, timeZone: 'UTC' };
    expect(getNextScheduleOccurrence(state, ANCHOR)).toBe(
      getNextCronOccurrence('0 * * * *', ANCHOR),
    );
  });
});

describe('collectDueScheduleTicks', () => {
  it('collects interval occurrences within the window up to the cap', () => {
    expect(
      collectDueScheduleTicks(
        { intervalMs: HOUR, createdAt: ANCHOR, timeZone: 'UTC' },
        ANCHOR + HOUR,
        ANCHOR + 100 * HOUR,
        2,
      ),
    ).toEqual([
      { at: ANCHOR + HOUR, fires: true, dstGapSkipped: 0 },
      { at: ANCHOR + 2 * HOUR, fires: true, dstGapSkipped: 0 },
    ]);
  });
});
