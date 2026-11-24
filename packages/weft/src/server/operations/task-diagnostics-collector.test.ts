/**
 * COR-2009 — a diagnostic's evidence says a duration in words a person reads, never as a count of
 * milliseconds: "no heartbeat for 128905ms" reads "for 2 minutes".
 */
import { describe, expect, it } from 'bun:test';

import { durationInWords } from './task-diagnostics-collector.ts';

describe('durationInWords', () => {
  it.each([
    [0, 'less than a second'],
    [953, 'less than a second'],
    [1_000, '1 second'],
    [45_500, '45 seconds'],
    [60_000, '1 minute'],
    [128_905, '2 minutes'],
    [3_600_000, '1 hour'],
    [7_260_000, '2 hours'],
    [86_400_000, '1 day'],
    [3 * 86_400_000 + 5_000, '3 days'],
  ])('says %p milliseconds as %p', (milliseconds, words) => {
    expect(durationInWords(milliseconds)).toBe(words);
  });
});
