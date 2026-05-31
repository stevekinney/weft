import { describe, expect, it } from 'bun:test';

import {
  confirmDestructive,
  formatDuration,
  formatTimestamp,
  ndjson,
  prettyJson,
  supportsColor,
  truncateToWidth,
} from './output.ts';

describe('supportsColor', () => {
  it('FORCE_COLOR=0 does not enable color (per FORCE_COLOR spec)', () => {
    const priorForceColor = Bun.env['FORCE_COLOR'];
    const priorNoColor = Bun.env['NO_COLOR'];
    Bun.env['FORCE_COLOR'] = '0';
    delete Bun.env['NO_COLOR'];
    try {
      expect(supportsColor({ isTTY: false })).toBe(false);
    } finally {
      if (priorForceColor === undefined) delete Bun.env['FORCE_COLOR'];
      else Bun.env['FORCE_COLOR'] = priorForceColor;
      if (priorNoColor === undefined) delete Bun.env['NO_COLOR'];
      else Bun.env['NO_COLOR'] = priorNoColor;
    }
  });

  it('FORCE_COLOR=1 enables color', () => {
    const priorForceColor = Bun.env['FORCE_COLOR'];
    const priorNoColor = Bun.env['NO_COLOR'];
    Bun.env['FORCE_COLOR'] = '1';
    delete Bun.env['NO_COLOR'];
    try {
      expect(supportsColor({ isTTY: false })).toBe(true);
    } finally {
      if (priorForceColor === undefined) delete Bun.env['FORCE_COLOR'];
      else Bun.env['FORCE_COLOR'] = priorForceColor;
      if (priorNoColor === undefined) delete Bun.env['NO_COLOR'];
      else Bun.env['NO_COLOR'] = priorNoColor;
    }
  });
});

describe('output helpers', () => {
  it('serializes NDJSON one object per line', () => {
    const text = ndjson([{ a: 1 }, { b: 2 }]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 });
  });

  it('ndjson skips undefined entries so output is always valid NDJSON', () => {
    const text = ndjson([{ a: 1 }, undefined, { b: 2 }]);
    const lines = text.split('\n');
    // undefined is filtered out — only the two objects remain
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 });
  });

  it('prettyJson returns valid JSON string (including for undefined/void values)', () => {
    expect(prettyJson({ ok: true })).toBe(JSON.stringify({ ok: true }, null, 2));
    // JSON.stringify(undefined) returns undefined; prettyJson must return a string.
    expect(prettyJson(undefined)).toBe('null');
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

  it('formatDuration does not produce invalid strings at bucket boundaries', () => {
    // 119.6s has 119 whole seconds = 1m 59s, NOT 1m 60s
    expect(formatDuration(119_600)).toBe('1m 59s');
    // 59.999s has 59 whole seconds — must stay as "59s", NOT "60s"
    expect(formatDuration(59_999)).toBe('59s');
    // 60s exactly enters the minutes bucket
    expect(formatDuration(60_000)).toBe('1m 0s');
    // 9.999s has 9 whole seconds — must stay as "9.9s", NOT "10.0s"
    expect(formatDuration(9_999)).toBe('9.9s');
    // 10s exactly enters the whole-seconds display
    expect(formatDuration(10_000)).toBe('10s');
    // 999.5ms has 999 whole ms — must stay as "999ms", NOT "1000ms"
    expect(formatDuration(999.5)).toBe('999ms');
    // 1000ms exactly enters the seconds bucket
    expect(formatDuration(1000)).toBe('1.0s');
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
