import { describe, expect, it } from 'bun:test';

import { collectDueIntervalOccurrences, getNextIntervalOccurrence } from './interval-occurrence.ts';

const HOUR = 3_600_000;

describe('getNextIntervalOccurrence', () => {
  it('returns the first occurrence one interval after the anchor when asked at the anchor', () => {
    expect(getNextIntervalOccurrence(0, HOUR, 0)).toBe(HOUR);
  });

  it('walks forward one interval at a time when fed its own result', () => {
    const first = getNextIntervalOccurrence(0, HOUR, 0);
    const second = getNextIntervalOccurrence(0, HOUR, first);
    const third = getNextIntervalOccurrence(0, HOUR, second);
    expect([first, second, third]).toEqual([HOUR, 2 * HOUR, 3 * HOUR]);
  });

  it('snaps to the next interval boundary from an arbitrary point inside a period', () => {
    // 90 minutes past the anchor with a 1-hour interval → next boundary is 2h.
    expect(getNextIntervalOccurrence(0, HOUR, 90 * 60_000)).toBe(2 * HOUR);
  });

  it('respects a non-zero anchor so occurrences are phase-aligned to creation time', () => {
    const anchor = Date.UTC(2026, 0, 1, 0, 0, 30);
    expect(getNextIntervalOccurrence(anchor, HOUR, anchor)).toBe(anchor + HOUR);
    expect(getNextIntervalOccurrence(anchor, HOUR, anchor + HOUR)).toBe(anchor + 2 * HOUR);
  });

  it('returns the first occurrence when the query point precedes the anchor', () => {
    expect(getNextIntervalOccurrence(10_000, HOUR, 0)).toBe(10_000 + HOUR);
  });

  it('rejects a non-positive interval', () => {
    expect(() => getNextIntervalOccurrence(0, 0, 0)).toThrow(
      'Interval schedule period must be a positive safe integer of milliseconds',
    );
    expect(() => getNextIntervalOccurrence(0, -1, 0)).toThrow(
      'Interval schedule period must be a positive safe integer of milliseconds',
    );
  });
});

describe('collectDueIntervalOccurrences', () => {
  it('collects every occurrence in the inclusive window', () => {
    expect(collectDueIntervalOccurrences(0, HOUR, HOUR, 3 * HOUR)).toEqual([
      HOUR,
      2 * HOUR,
      3 * HOUR,
    ]);
  });

  it('caps the result at maxOccurrences for a long backfill window', () => {
    expect(collectDueIntervalOccurrences(0, HOUR, HOUR, 100 * HOUR, { maxOccurrences: 2 })).toEqual(
      [HOUR, 2 * HOUR],
    );
  });

  it('returns an empty list when the first due time is past the window', () => {
    expect(collectDueIntervalOccurrences(0, HOUR, 4 * HOUR, 3 * HOUR)).toEqual([]);
  });

  it('rejects a non-positive maxOccurrences', () => {
    expect(() =>
      collectDueIntervalOccurrences(0, HOUR, HOUR, 3 * HOUR, { maxOccurrences: 0 }),
    ).toThrow('Interval occurrence maxOccurrences must be a positive safe integer');
  });
});
