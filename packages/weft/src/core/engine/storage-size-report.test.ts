import { describe, expect, it } from 'bun:test';
import { MAX_TIMER_DELAY_MS } from '../application-primitive-guards.ts';
import { normalizeStorageSizeReportInterval } from './storage-size-report.ts';

describe('normalizeStorageSizeReportInterval', () => {
  it('accepts the default, zero, and the largest schedulable delay', () => {
    expect(normalizeStorageSizeReportInterval(undefined, 'interval', 60_000)).toBe(60_000);
    expect(normalizeStorageSizeReportInterval(0, 'interval', 60_000)).toBe(0);
    expect(normalizeStorageSizeReportInterval(MAX_TIMER_DELAY_MS, 'interval', 60_000)).toBe(
      MAX_TIMER_DELAY_MS,
    );
  });

  it('rejects a delay the host timer would clamp to one millisecond', () => {
    // 30 days: a timer given this delay fires every millisecond instead.
    expect(() => normalizeStorageSizeReportInterval(2_592_000_000, 'interval', 60_000)).toThrow(
      'interval must be a non-negative safe integer of at most 2147483647 milliseconds',
    );
  });

  it('rejects negative, fractional, and non-numeric values', () => {
    for (const value of [-1, 1.5, '100']) {
      expect(() => normalizeStorageSizeReportInterval(value, 'interval', 60_000)).toThrow(
        'interval must be a non-negative safe integer',
      );
    }
  });
});
