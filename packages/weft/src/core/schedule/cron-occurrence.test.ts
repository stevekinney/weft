import { describe, expect, it } from 'bun:test';

import { getNextCronOccurrence, searchNextCronOccurrence } from './cron-occurrence.ts';

const START = Date.UTC(2026, 0, 1);

describe('searchNextCronOccurrence', () => {
  it('gives up with a diagnostic once the search bound is spent on an expression that never matches', () => {
    // 31 April parses but no date satisfies it. The production bound makes that search take
    // seconds, so the slow lane covers it; a small bound reaches the same give-up path quickly.
    expect(() => searchNextCronOccurrence('0 0 31 4 *', START, { timeZone: 'UTC' }, 5)).toThrow(
      'Could not find the next cron occurrence for "0 0 31 4 *"',
    );
  });

  it('gives up immediately when the bound allows no steps, even for an expression that matches', () => {
    expect(() => searchNextCronOccurrence('* * * * * *', START, { timeZone: 'UTC' }, 0)).toThrow(
      'Could not find the next cron occurrence for "* * * * * *"',
    );
  });

  it('returns the match when it falls on the last step the bound allows', () => {
    // The very next second matches on the first step, so a one-step bound is exactly enough.
    expect(searchNextCronOccurrence('* * * * * *', START, { timeZone: 'UTC' }, 1)).toBe(
      START + 1000,
    );
  });

  it('agrees with getNextCronOccurrence, which searches with the production bound', () => {
    const expected = Date.UTC(2026, 0, 1, 0, 1, 0);
    expect(getNextCronOccurrence('0 * * * * *', START, { timeZone: 'UTC' })).toBe(expected);
    expect(searchNextCronOccurrence('0 * * * * *', START, { timeZone: 'UTC' }, 100_000)).toBe(
      expected,
    );
  });

  it('searches in UTC when no options are given', () => {
    expect(searchNextCronOccurrence('0 * * * * *', START, undefined, 100_000)).toBe(
      Date.UTC(2026, 0, 1, 0, 1, 0),
    );
  });
});
