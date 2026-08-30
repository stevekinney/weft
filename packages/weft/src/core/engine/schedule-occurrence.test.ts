import { describe, expect, it } from 'bun:test';

import { getNextCronOccurrence } from '../schedule.ts';
import {
  collectDueScheduleOccurrences,
  getNextScheduleOccurrence,
  resolveScheduleCadence,
} from './schedule-occurrence.ts';

const HOUR = 3_600_000;
const ANCHOR = Date.UTC(2026, 0, 1, 0, 0, 0);

describe('resolveScheduleCadence', () => {
  it('resolves an interval cadence anchored at createdAt', () => {
    expect(resolveScheduleCadence({ intervalMs: HOUR, createdAt: ANCHOR })).toEqual({
      kind: 'interval',
      intervalMs: HOUR,
      anchor: ANCHOR,
    });
  });

  it('resolves a cron cadence', () => {
    expect(resolveScheduleCadence({ cronExpression: '0 * * * *', createdAt: ANCHOR })).toEqual({
      kind: 'cron',
      cronExpression: '0 * * * *',
    });
  });

  it('throws when neither cadence is present', () => {
    expect(() => resolveScheduleCadence({ createdAt: ANCHOR })).toThrow(
      'Schedule state must define either a cron expression or an interval',
    );
  });
});

describe('getNextScheduleOccurrence', () => {
  it('dispatches interval cadence anchored at createdAt', () => {
    expect(getNextScheduleOccurrence({ intervalMs: HOUR, createdAt: ANCHOR }, ANCHOR)).toBe(
      ANCHOR + HOUR,
    );
  });

  it('dispatches cron cadence identically to the cron engine', () => {
    const state = { cronExpression: '0 * * * *', createdAt: ANCHOR };
    expect(getNextScheduleOccurrence(state, ANCHOR)).toBe(
      getNextCronOccurrence('0 * * * *', ANCHOR),
    );
  });
});

describe('collectDueScheduleOccurrences', () => {
  it('collects interval occurrences within the window up to the cap', () => {
    expect(
      collectDueScheduleOccurrences(
        { intervalMs: HOUR, createdAt: ANCHOR },
        ANCHOR + HOUR,
        ANCHOR + 100 * HOUR,
        2,
      ),
    ).toEqual([ANCHOR + HOUR, ANCHOR + 2 * HOUR]);
  });
});
