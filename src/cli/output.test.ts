import { describe, expect, it } from 'bun:test';

import {
  confirmDestructive,
  formatDuration,
  formatTimestamp,
  ndjson,
  truncateToWidth,
} from './output.ts';

describe('output helpers', () => {
  it('serializes NDJSON one object per line', () => {
    const text = ndjson([{ a: 1 }, { b: 2 }]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 });
  });

  it('formats timestamps as ISO and falls back to a dash', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatTimestamp(undefined)).toBe('-');
    expect(formatTimestamp('nope')).toBe('-');
  });

  it('formats durations across magnitudes', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(-1)).toBe('-');
  });

  it('truncates to terminal width with an ellipsis', () => {
    expect(truncateToWidth('short', 80)).toBe('short');
    expect(truncateToWidth('abcdefghij', 5)).toBe('abcd…');
    expect(truncateToWidth('abcdef', 0)).toBe('abcdef');
  });
});

describe('confirmDestructive', () => {
  it('bypasses the prompt when assumeYes is set', async () => {
    const decision = await confirmDestructive({ prompt: 'go?', assumeYes: true });
    expect(decision).toBe('confirmed');
  });

  it('returns non-interactive on a non-TTY without yes', async () => {
    const decision = await confirmDestructive({ prompt: 'go?', assumeYes: false, isTty: false });
    expect(decision).toBe('non-interactive');
  });

  it('confirms when an interactive reply starts with y', async () => {
    const decision = await confirmDestructive({
      prompt: 'go?',
      assumeYes: false,
      isTty: true,
      readLine: async () => 'yes',
    });
    expect(decision).toBe('confirmed');
  });

  it('denies when an interactive reply is anything else', async () => {
    const decision = await confirmDestructive({
      prompt: 'go?',
      assumeYes: false,
      isTty: true,
      readLine: async () => '',
    });
    expect(decision).toBe('denied');
  });
});
